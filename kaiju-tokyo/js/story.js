// The film: choreography of both kaiju, camera shots, captions and every destruction event.
import * as THREE from 'three';
import { RNG, clamp, lerp, smooth, sstep, track, noise1, easeOut, easeIn, pulse, V3 } from './util.js';
import { PT } from './fx.js';
import { LAYOUT } from './city.js';

export const DURATION = 64;

// key places
const SL = V3(0, 0, 0);            // Solearon's landing spot
const TP2 = V3(330, 0, 330);          // Teranox's arrival (scramble crossing)
const PUSH = TP2.clone().sub(SL).setY(0).normalize();
const TP3 = TP2.clone().addScaledVector(PUSH, 52); // after the beam knocks it back
const TOWER = LAYOUT.towerPos.clone();
const yawTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a, b, k) => a + wrap(b - a) * k;

// ------------------------------------------------------------------------------------------
class Walker {
  constructor({ pts, t0, t1, S = 30, halfW = 14, accel = 0.18, backwards = false, lift = 12 }) {
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.L = this.curve.getLength();
    this.n = Math.max(1, Math.round(this.L / S)); this.S = this.L / this.n;
    Object.assign(this, { t0, t1, halfW, accel, backwards, lift });
  }
  ease(u) {
    const a = this.accel, v = 1 / (1 - a);
    if (u <= 0) return 0; if (u >= 1) return 1;
    if (u < a) return v * u * u / (2 * a);
    if (u < 1 - a) return v * (a / 2 + (u - a));
    return 1 - v * (1 - u) * (1 - u) / (2 * a);
  }
  dist(t) { return this.L * this.ease((t - this.t0) / (this.t1 - this.t0)); }
  point(d) {
    if (d < 0) return this.curve.getPointAt(0).addScaledVector(this.curve.getTangentAt(0), d);
    if (d > this.L) return this.curve.getPointAt(1).addScaledVector(this.curve.getTangentAt(1), d - this.L);
    return this.curve.getPointAt(d / this.L);
  }
  tangent(d) { return this.curve.getTangentAt(clamp(d / this.L, 0, 1)); }
  yawAt(d) { const tg = this.tangent(d); return Math.atan2(tg.x, tg.z) + (this.backwards ? Math.PI : 0); }
  moving(t) { return t > this.t0 && t < this.t1; }
  // foot state: stance on plant n, or swing between plants
  foot(t, side) {
    const S = this.S, d = this.dist(t);
    const off = side === 'L' ? 0.5 * S : 1.5 * S;
    const n = Math.floor((d - off + 0.6 * S) / (2 * S));
    const Q = off + 2 * S * n;
    const plant = (q) => {
      const p = this.point(q), tg = this.tangent(q);
      const fwd = this.backwards ? tg.clone().negate() : tg.clone();
      const right = V3(-fwd.z, 0, fwd.x); // right-hand side of the facing direction
      const sgn = side === 'L' ? -1 : 1;
      return { p: p.addScaledVector(right, sgn * this.halfW).addScaledVector(fwd, 4), fwd };
    };
    if (d <= Q + 0.6 * S) { const a = plant(Q); return { ball: a.p.setY(3), fwd: a.fwd, lift: 0 }; }
    const u = clamp((d - (Q + 0.6 * S)) / (0.8 * S), 0, 1);
    const a = plant(Q), b = plant(Q + 2 * S);
    const k = smooth(u);
    const ball = a.p.clone().lerp(b.p, k); ball.y = 3 + Math.sin(Math.PI * u) * this.lift;
    return { ball, fwd: a.fwd.clone().lerp(b.fwd, k).normalize(), lift: Math.sin(Math.PI * u) };
  }
  // world times at which each foot lands (for dust, shake and crushing)
  footfalls() {
    const out = [];
    const S = this.S;
    for (const side of ['L', 'R']) {
      const off = side === 'L' ? 0.5 * S : 1.5 * S;
      for (let n = 0; n < this.n + 2; n++) {
        const land = off + 2 * S * n - 0.6 * S; // distance at which the foot touches down
        if (land <= 0.01 || land > this.L + 1e-3) continue;
        // invert dist(t)
        let lo = this.t0, hi = this.t1;
        for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (this.dist(m) < land) lo = m; else hi = m; }
        out.push({ t: hi, side, pos: this.foot(hi + 1e-3, side).ball.clone().setY(0) });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }
  bob(t) { const d = this.dist(t); return this.moving(t) ? 1 : 0; }
}

// ------------------------------------------------------------------------------------------
export class Story {
  constructor(w) {
    this.w = w; // {scene, city, fx, beam, tower, sol, ter, sky, camera}
    const Wt = 1.12;
    // Teranox: approach from the north, down the avenue, to the crossing
    this.tWalk = new Walker({ pts: [V3(385, 0, 840), V3(350, 0, 600), V3(338, 0, 440), TP2.clone()], t0: 3.5, t1: 21.0, S: 32, halfW: 13.5 * Wt, accel: 0.08, lift: 14 });
    // knocked back by the beam (walking backwards, stumbling)
    this.tStag = new Walker({ pts: [TP2.clone(), TP2.clone().lerp(TP3, 0.5), TP3.clone()], t0: 34.1, t1: 36.4, S: 26, halfW: 13.5 * Wt, accel: 0.1, backwards: true, lift: 8 });
    // advance on Solearon
    const TP4 = TP3.clone().addScaledVector(PUSH, -70);
    this.tAdv = new Walker({ pts: [TP3.clone(), TP4], t0: 48.3, t1: 52.0, S: 35, halfW: 13.5 * Wt, accel: 0.2, lift: 14 });
    // Solearon: two steps forward during the stand-off
    this.SL2 = SL.clone().addScaledVector(PUSH, 45);
    this.sWalk = new Walker({ pts: [SL.clone(), this.SL2.clone()], t0: 43.2, t1: 46.0, S: 23, halfW: 13.5, accel: 0.25, lift: 11 });
    // Solearon descent curve
    this.descent = new THREE.CatmullRomCurve3([V3(760, 1350, 180), V3(520, 900, 120), V3(260, 420, 60), V3(80, 120, 10), SL.clone().setY(0)], false, 'centripetal');
    this.flight = new THREE.CatmullRomCurve3([this.SL2.clone(), this.SL2.clone().add(V3(-10, 90, -15)), this.SL2.clone().add(V3(-40, 260, -60)), V3(-20, 330, -80), V3(120, 360, -40), V3(240, 380, 60)], false, 'centripetal');
    this.captions = [
      { t0: 0.8, t1: 5.3, kind: 'place', text: '東京都港区　午後11時47分' },
      { t0: 11.4, t1: 14.6, kind: 'name', jp: '光翼獣　ソレアロン', en: 'SOLEARON', side: 'left' },
      { t0: 17.2, t1: 20.9, kind: 'name', jp: '陽砕獣　テラノクス', en: 'TERANOX', side: 'right' },
      { t0: 59.6, t1: 64.5, kind: 'title', jp: '光翼獣 ソレアロン　×　陽砕獣 テラノクス', en: 'SOLEARON  vs  TERANOX' },
    ];
    this.T = {
      sDescent: 5.4, sLand: 11.0,
      tSlamUp: 21.3, tSlam: 23.35, tRoar1: 25.9,
      sRoar: 28.0, sCharge: 30.3, sBeam0: 31.9, beamHit: 34.0, sBeam1: 35.2,
      towerFall: 35.75, tRoar2: 40.6, tRoar3: 44.6, sRoar2: 46.4, sTakeoff: 52.2, tRoarSky: 58.8,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Teranox pose at time t
  teranox(t) {
    const T = this.T, W = this.tWalk;
    const st = { time: t, glow: 1, coreGlow: 1, haloGlow: 1, tailAmp: 0.05, tailPhase: t * 1.1 };
    let pos, yaw, feet, bobK = 0, walkD = 0, S = 32;
    if (t < W.t1 + 0.01) {
      const d = W.dist(t); walkD = d; S = W.S;
      pos = W.point(d); yaw = W.yawAt(d);
      feet = { L: W.foot(t, 'L'), R: W.foot(t, 'R') };
      bobK = W.moving(t) ? 1 : 0;
    } else if (t < this.tStag.t0) {
      pos = W.point(W.L); yaw = W.yawAt(W.L);
      feet = { L: W.foot(W.t1, 'L'), R: W.foot(W.t1, 'R') };
    } else if (t < this.tAdv.t0) {
      const G = this.tStag; const d = G.dist(t); walkD = d; S = G.S;
      pos = G.point(d); yaw = G.yawAt(d);
      feet = { L: G.foot(t, 'L'), R: G.foot(t, 'R') };
      bobK = G.moving(t) ? 1 : 0;
    } else {
      const G = this.tAdv; const d = G.dist(t); walkD = d; S = G.S;
      pos = G.point(d); yaw = G.yawAt(d);
      feet = { L: G.foot(t, 'L'), R: G.foot(t, 'R') };
      bobK = G.moving(t) ? 1 : 0;
    }
    // turn to face Solearon after arriving (body twist; feet stay planted)
    const face = yawTo(pos, this.solPos(t));
    const faceK = t > 19.5 ? sstep(19.5, 22.5, t) : 0;
    if (t < this.tStag.t0 || t > this.tAdv.t0) yaw = lerpAngle(yaw, face, t > this.tAdv.t0 ? 0.6 : faceK);
    else yaw = lerpAngle(yaw, face, 0.5);
    st.pos = pos; st.yaw = yaw; st.feet = feet;
    const ph = Math.PI * walkD / S;
    st.hipDrop = 0.12 + bobK * 0.14 * Math.abs(Math.cos(ph));
    st.hipRoll = bobK * Math.sin(ph) * 0.05;
    st.lean = 0.14 + bobK * 0.05;
    st.armL = [0.15 + bobK * 0.3 * Math.sin(ph), 0, 0.28]; st.armR = [0.15 - bobK * 0.3 * Math.sin(ph), 0, 0.28];
    st.elbowL = st.elbowR = -0.7;
    st.tailAmp = 0.06 + bobK * 0.1; st.tailPhase = ph + t * 0.4;
    st.neckPitch = 0.05; st.headPitch = 0.05 + bobK * 0.04 * Math.sin(ph * 2);
    st.twist = 0; st.jaw = 0.05;
    // idle menace: tail lashes, breathing
    // --- walk-in roar (during approach, shot C)
    const r0 = pulse(t, 16.2, 17.6, 0.5, 0.7);
    st.jaw += r0 * 0.7; st.headPitch -= r0 * 0.35; st.neckPitch -= r0 * 0.1;
    // --- ground slam
    const up = pulse(t, T.tSlamUp + 0.4, T.tSlam - 0.15, 1.1, 0.12);
    const down = sstep(T.tSlam - 0.22, T.tSlam, t) * (1 - sstep(T.tSlam + 1.6, T.tSlam + 2.8, t));
    st.lean += -0.3 * up + 0.95 * down;
    st.hipDrop += 0.3 * up + 1.25 * down;
    st.pitch = 0.18 * down;
    st.armL = [lerp(lerp(st.armL[0], -2.5, up), -0.95, down), 0, lerp(0.28, 0.35, up)];
    st.armR = [lerp(lerp(st.armR[0], -2.5, up), -0.95, down), 0, lerp(0.28, 0.35, up)];
    st.elbowL = st.elbowR = lerp(lerp(-0.7, -1.2, up), -0.15, down);
    st.headPitch += -0.4 * up + 0.2 * down; st.jaw += 0.6 * up + 0.3 * down;
    st.tailLift = 0.6 * up;
    st.haloGlow += 1.4 * up + 0.8 * down; st.coreGlow += 1.2 * up + 0.6 * down;
    // --- roar at Solearon
    for (const [a, b] of [[T.tRoar1, T.tRoar1 + 1.9], [T.tRoar2, T.tRoar2 + 1.9], [T.tRoar3, T.tRoar3 + 2.0], [T.tRoarSky, T.tRoarSky + 2.4]]) {
      const r = pulse(t, a + 0.35, b, 0.35, 0.6);
      st.jaw += r * 0.75; st.headPitch -= r * 0.4; st.neckPitch -= r * 0.15; st.lean -= r * 0.12;
      st.armL = [st.armL[0] - r * 0.4, 0, st.armL[2] + r * 0.55]; st.armR = [st.armR[0] - r * 0.4, 0, st.armR[2] + r * 0.55];
      st.haloGlow += r * 1.2; st.coreGlow += r * 0.8; st.tailAmp += r * 0.12;
    }
    // --- braced during Solearon's charge, then hit by the beam
    const brace = pulse(t, T.sCharge + 0.5, T.beamHit, 0.8, 0.1);
    st.lean += brace * 0.12; st.armL[0] -= brace * 0.6; st.armR[0] -= brace * 0.6; st.elbowL -= brace * 0.5; st.elbowR -= brace * 0.5;
    const hit = pulse(t, T.beamHit, T.beamHit + 2.6, 0.12, 1.4);
    st.lean -= hit * 0.42; st.headPitch -= hit * 0.35; st.jaw += hit * 0.55; st.neckPitch -= hit * 0.2;
    st.armL = [st.armL[0] - hit * 0.9, 0, st.armL[2] + hit * 0.9]; st.armR = [st.armR[0] - hit * 0.7, 0, st.armR[2] + hit * 1.0];
    st.twist += hit * 0.25 * Math.sin((t - T.beamHit) * 3);
    st.tailSwipe = hit * 1.2 + pulse(t, T.towerFall - 0.2, T.towerFall + 1.2, 0.3, 0.8) * 1.4;
    st.bodyRoll = hit * 0.08 * Math.sin((t - T.beamHit) * 5);
    // --- after the tower falls: looks back at it, then turns to Solearon
    const look = pulse(t, T.towerFall + 1.0, T.tRoar2 - 0.2, 0.8, 0.8);
    st.neckYaw = look * 0.55; st.headYaw = look * 0.35;
    // --- final: tracks Solearon into the sky
    const sky = sstep(T.sTakeoff, T.sTakeoff + 3, t);
    if (sky > 0) {
      const sp = this.solPos(t).clone().add(V3(0, 90, 0));
      const head = V3(pos.x, 105, pos.z);
      const el = Math.atan2(sp.y - head.y, Math.hypot(sp.x - head.x, sp.z - head.z));
      st.headPitch -= sky * el * 0.45; st.neckPitch -= sky * el * 0.35; st.lean -= sky * 0.1;
    }
    st.haloGlow = Math.min(st.haloGlow, 3); st.coreGlow = Math.min(st.coreGlow, 3);
    return st;
  }

  // Solearon root position over time (used by both kaiju)
  solPos(t) {
    const T = this.T;
    if (t < T.sDescent) return this.descent.getPoint(0);
    if (t < T.sLand) { const u = (t - T.sDescent) / (T.sLand - T.sDescent); return this.descent.getPointAt(1 - Math.pow(1 - u, 1.6)); }
    if (t < this.sWalk.t0) return SL.clone();
    if (t < T.sTakeoff) return this.sWalk.point(this.sWalk.dist(t));
    const u = clamp((t - T.sTakeoff) / (DURATION - T.sTakeoff + 2), 0, 1);
    return this.flight.getPoint(Math.pow(u, 1.25));
  }

  solearon(t) {
    const T = this.T;
    const st = { time: t, glow: 1, coreGlow: 1, haloGlow: 1, wingFold: 1, wingFlap: 0, tailAmp: 0.05, tailPhase: t * 1.0,
      armL: [0.2, 0, 0.3], armR: [0.2, 0, 0.3], headPitch: 0, neckPitch: 0, neckYaw: 0, headYaw: 0, jaw: 0.04, lean: 0.08, hipDrop: 0.1, pitch: 0 };
    const pos = this.solPos(t);
    const terPos = this.w.ter ? this.terRoot(t) : TP2;
    let yaw = yawTo(pos, terPos);
    st.pos = pos;
    const flying = t < T.sLand || t > T.sTakeoff + 0.6;
    const standK = sstep(T.sLand - 0.4, T.sLand + 0.3, t) * (1 - sstep(T.sTakeoff + 0.2, T.sTakeoff + 1.0, t));
    // --- flight (descent & takeoff): wings open, powerful beats
    if (t < T.sLand + 1.8) {
      const u = clamp((t - T.sDescent) / (T.sLand - T.sDescent), 0, 1);
      const tg = this.descent.getTangent(clamp(u, 0.01, 0.99));
      yaw = lerpAngle(Math.atan2(tg.x, tg.z), yawTo(pos, TP2), sstep(T.sLand - 2.5, T.sLand + 1.5, t));
      const flare = sstep(T.sLand - 1.6, T.sLand - 0.2, t);
      st.wingFold = sstep(T.sLand + 0.3, T.sLand + 2.6, t);
      const beat = Math.sin((t - T.sDescent) * 2.6 * Math.PI * 0.5);
      st.wingFlap = beat * lerp(0.42, 0.25, flare) * (1 - st.wingFold) + flare * 0.35;
      st.wingSpread = 1;
      st.pitch = (1 - flare) * 0.35;
      st.lean = (1 - flare) * 0.1 - flare * 0.15;
      st.legFK = { L: [0.25 + flare * 0.6, 0, 0.1], R: [0.1 + flare * 0.7, 0, -0.1] };
      st.tailAmp = 0.12; st.tailLift = -0.4;
      st.armL = [0.2 + flare * -0.5, 0, 0.5]; st.armR = [0.2 + flare * -0.5, 0, 0.5];
      st.headPitch = -0.1 + flare * 0.2;
      st.glow = 1.1;
    }
    // --- standing: planted feet (with landing crouch)
    if (standK > 0 && !(t < T.sLand)) {
      const w = this.sWalk;
      let feet;
      if (t < w.t0) feet = this.standFeet(SL, yawTo(SL, TP2), 13.5);
      else feet = { L: w.foot(t, 'L'), R: w.foot(t, 'R') };
      st.feet = feet; st.legFK = null;
      const crouch = pulse(t, T.sLand, T.sLand + 0.6, 0.02, 1.2);
      st.hipDrop = 0.1 + crouch * 1.1; st.lean = (st.lean || 0) + crouch * 0.35 + 0.08;
      st.pitch = 0; st.tailLift = 0;
      if (t > T.sLand + 1.8) { st.armL = [0.2, 0, 0.3]; st.armR = [0.2, 0, 0.3]; st.headPitch = 0; st.glow = 1; }
      if (t >= w.t0 && t <= w.t1) { const ph = Math.PI * w.dist(t) / w.S; st.hipDrop += 0.12 * Math.abs(Math.cos(ph)); st.tailPhase = ph; st.tailAmp = 0.12; }
    }
    // --- roar (shot E1)
    const r = pulse(t, T.sRoar + 0.35, T.sCharge - 0.1, 0.35, 0.5);
    st.jaw = (st.jaw || 0.04) + r * 0.85; st.headPitch = (st.headPitch || 0) - r * 0.5; st.neckPitch = (st.neckPitch || 0) - r * 0.15;
    st.wingFold = Math.min(st.wingFold, 1 - r * 0.45); st.wingFlap += r * -0.25;
    st.armL = [st.armL[0] - r * 0.3, 0, st.armL[2] + r * 0.7]; st.armR = [st.armR[0] - r * 0.3, 0, st.armR[2] + r * 0.7];
    st.haloGlow += r * 0.8; st.coreGlow += r * 0.5; st.glow += r * 0.25;
    const r2 = pulse(t, T.sRoar2 + 0.3, T.sRoar2 + 2.1, 0.3, 0.6);
    st.jaw += r2 * 0.8; st.headPitch -= r2 * 0.45; st.haloGlow += r2 * 1.2; st.wingFold = Math.min(st.wingFold, 1 - r2 * 0.5);
    st.armL[2] += r2 * 0.6; st.armR[2] += r2 * 0.6;
    // --- charge & beam
    const ch = pulse(t, T.sCharge, T.sBeam1, 0.6, 0.8);
    st.mouthGlow = ch * (1.5 + 2.5 * sstep(T.sCharge, T.sBeam0, t));
    st.coreGlow += ch * 2.0; st.haloGlow += ch * 1.6; st.glow += ch * 0.8;
    st.wingFold = Math.min(st.wingFold, 1 - ch * 0.35);
    st.lean = (st.lean || 0) + ch * 0.15;
    st.armL = [st.armL[0] + ch * 0.2, 0, st.armL[2] + ch * 0.25]; st.armR = [st.armR[0] + ch * 0.2, 0, st.armR[2] + ch * 0.25];
    const firing = pulse(t, T.sBeam0, T.sBeam1, 0.08, 0.3);
    if (ch > 0.01) {
      // aim head at the beam target
      const tgt = this.beamTarget(t);
      const head = pos.clone().add(V3(0, 104, 0)).addScaledVector(V3(Math.sin(yaw), 0, Math.cos(yaw)), 14);
      const d = tgt.clone().sub(head);
      const relYaw = wrap(Math.atan2(d.x, d.z) - yaw);
      const el = Math.atan2(d.y, Math.hypot(d.x, d.z));
      st.neckYaw = relYaw * 0.55 * ch; st.headYaw = relYaw * 0.45 * ch;
      st.neckPitch = lerp(st.neckPitch, -el * 0.5, ch); st.headPitch = lerp(st.headPitch, -el * 0.5 + 0.05, ch);
      st.jaw = lerp(st.jaw, 0.45 + firing * 0.15, ch);
    }
    this.firing = firing;
    // --- idle life
    if (!flying && ch < 0.01 && r < 0.01) {
      const ter = this.terRoot(t);
      const d = V3(ter.x, 100, ter.z).sub(pos.clone().add(V3(0, 104, 0)));
      const relYaw = wrap(Math.atan2(d.x, d.z) - yaw);
      st.neckYaw = (st.neckYaw || 0) + relYaw * 0.4; st.headYaw = (st.headYaw || 0) + relYaw * 0.3;
      st.headPitch += Math.sin(t * 0.7) * 0.03;
    }
    // --- takeoff: crouch, wings unfurl, launch
    const prep = sstep(T.sTakeoff - 3.0, T.sTakeoff - 0.8, t);
    if (prep > 0) {
      st.wingFold = Math.min(st.wingFold, 1 - prep);
      st.wingSpread = 1;
      const launch = t - T.sTakeoff;
      const beat = launch > -0.8 ? Math.sin((launch + 0.8) * Math.PI * 1.25) : 0;
      st.wingFlap = beat * 0.55 * prep;
      if (!flying) { st.hipDrop = (st.hipDrop || 0) + prep * 0.6 * (1 - sstep(T.sTakeoff - 0.2, T.sTakeoff + 0.3, t)); st.lean = (st.lean || 0) + prep * 0.2; }
      st.glow += prep * 0.8; st.haloGlow += prep * 0.8; st.coreGlow += prep * 0.6;
    }
    if (t > T.sTakeoff + 0.2) {
      const k = sstep(T.sTakeoff + 0.2, T.sTakeoff + 1.2, t);
      st.feet = k > 0.5 ? null : st.feet;
      if (!st.feet) st.legFK = { L: [0.4 + 0.1 * Math.sin(t), 0, 0.08], R: [0.2 + 0.1 * Math.cos(t), 0, -0.08] };
      const tg = this.flight.getTangent(clamp((t - T.sTakeoff) / (DURATION - T.sTakeoff + 2), 0.01, 0.99));
      const fy = Math.atan2(tg.x, tg.z);
      yaw = lerpAngle(yaw, fy, sstep(T.sTakeoff + 2, T.sTakeoff + 6, t));
      const beat = Math.sin((t - T.sTakeoff + 0.8) * Math.PI * lerp(1.25, 0.8, sstep(T.sTakeoff + 2, T.sTakeoff + 5, t)));
      st.wingFlap = beat * lerp(0.55, 0.4, sstep(T.sTakeoff + 2, T.sTakeoff + 5, t));
      st.pitch = sstep(T.sTakeoff + 2, T.sTakeoff + 6, t) * 0.4;
      st.tailLift = -0.4 * k; st.tailAmp = 0.15;
      st.armL = [0.1, 0, 0.6]; st.armR = [0.1, 0, 0.6];
      st.glow = 1.5 + 0.3 * Math.sin(t * 2); st.haloGlow = 2.2; st.coreGlow = 2.0;
      // sky roar at the end
      const rs = pulse(t, 60.2, 62.4, 0.4, 0.6);
      st.jaw = 0.05 + rs * 0.8; st.headPitch = -0.1 - rs * 0.4; st.haloGlow += rs; st.wingFlap += rs * 0.2;
    }
    st.yaw = yaw;
    st.haloGlow = Math.min(st.haloGlow, 3.2); st.coreGlow = Math.min(st.coreGlow, 3.5);
    return st;
  }
  standFeet(pos, yaw, hw) {
    const fwd = V3(Math.sin(yaw), 0, Math.cos(yaw)), right = V3(-fwd.z, 0, fwd.x);
    return {
      L: { ball: pos.clone().addScaledVector(right, -hw).addScaledVector(fwd, 12).setY(3), fwd, lift: 0 },
      R: { ball: pos.clone().addScaledVector(right, hw).addScaledVector(fwd, -4).setY(3), fwd, lift: 0 },
    };
  }
  terRoot(t) {
    if (t < this.tWalk.t1) return this.tWalk.point(this.tWalk.dist(t));
    if (t < this.tStag.t0) return TP2.clone();
    if (t < this.tAdv.t0) return this.tStag.point(this.tStag.dist(t));
    return this.tAdv.point(this.tAdv.dist(t));
  }
  // beam sweeps the street toward Teranox, then locks onto its chest
  beamTarget(t) {
    const T = this.T;
    const ter = this.terRoot(t);
    const chest = ter.clone().add(V3(0, 82, 0)).addScaledVector(PUSH, -12);
    const start = SL.clone().lerp(TP2, 0.3).add(V3(-30, 0, 60));
    const u = sstep(T.sBeam0, T.beamHit, t);
    if (t < T.beamHit) {
      const g = start.clone().lerp(TP2.clone().addScaledVector(PUSH, -35), u);
      g.y = 0;
      const k = sstep(T.beamHit - 0.45, T.beamHit, t);
      return g.lerp(chest, k);
    }
    return chest;
  }

  // ---------------------------------------------------------------------------------------
  // Camera: 9 shots
  shots() {
    return [
      { t0: 0, t1: 5.8, name: 'establish' },
      { t0: 5.8, t1: 14.0, name: 'descent' },
      { t0: 14.0, t1: 21.0, name: 'approach' },
      { t0: 21.0, t1: 27.9, name: 'slam' },
      { t0: 27.9, t1: 30.5, name: 'roarClose' },
      { t0: 30.5, t1: 35.2, name: 'beam' },
      { t0: 35.2, t1: 43.0, name: 'tower' },
      { t0: 43.0, t1: 51.6, name: 'orbit' },
      { t0: 51.6, t1: 57.6, name: 'takeoff' },
      { t0: 57.6, t1: DURATION, name: 'finale' },
    ];
  }
  camera(t, cam) {
    const sh = this.shots().find((s) => t >= s.t0 && t < s.t1) || this.shots()[this.shots().length - 1];
    const u = (t - sh.t0) / (sh.t1 - sh.t0);
    const w = this.w;
    let pos, tgt, fov = 40, roll = 0;
    const solHead = w.sol.boneWorld('head'), terHead = w.ter.boneWorld('head');
    switch (sh.name) {
      case 'establish': {
        pos = V3(-900, 330, 1150).lerp(V3(-620, 270, 900), smooth(u));
        tgt = V3(TOWER.x, 150, TOWER.z).lerp(V3(TOWER.x - 60, 190, TOWER.z - 60), smooth(u));
        fov = 38; roll = -0.02;
        break;
      }
      case 'descent': {
        // on a street, looking up as the sun-beast breaks through the clouds and lands
        pos = V3(-330, 10, 6).lerp(V3(-360, 8, 2), u);
        const sp = w.sol.boneWorld('chest');
        const k = sstep(0.0, 0.3, u);
        tgt = V3(700, 1150, 160).lerp(sp, k);
        tgt.y = Math.max(tgt.y, 60);
        fov = lerp(52, 38, sstep(0.55, 1, u));
        break;
      }
      case 'approach': {
        // at the scramble crossing, low and wide, Teranox coming down the avenue
        pos = V3(292, 6, 250).lerp(V3(286, 4.5, 222), smooth(u));
        const tr = this.terRoot(t);
        tgt = V3(tr.x, 70 + 10 * u, tr.z).lerp(V3(300, 40, 320), 0.15);
        fov = lerp(44, 50, u);
        roll = 0.03;
        break;
      }
      case 'slam': {
        const side = V3(PUSH.z, 0, -PUSH.x); // right of Teranox facing Solearon
        const c = TP2.clone().addScaledVector(side, -330).addScaledVector(PUSH, 60);
        pos = c.clone().add(V3(0, 150, 0)).lerp(c.clone().add(V3(40, 125, 30)), smooth(u));
        tgt = TP2.clone().add(V3(0, lerp(70, 45, sstep(0.25, 0.4, u)), 0));
        fov = 44;
        break;
      }
      case 'roarClose': {
        const fwd = V3(Math.sin(this._solYaw || 0), 0, Math.cos(this._solYaw || 0));
        const side = V3(-fwd.z, 0, fwd.x);
        pos = solHead.clone().addScaledVector(fwd, 70).addScaledVector(side, 45).add(V3(0, -6, 0));
        pos.lerp(solHead.clone().addScaledVector(fwd, 58).addScaledVector(side, 36).add(V3(0, -4, 0)), smooth(u));
        tgt = solHead.clone().add(V3(0, -8, 0));
        fov = 38;
        break;
      }
      case 'beam': {
        const fwd = PUSH.clone(); const side = V3(-fwd.z, 0, fwd.x);
        const mid = SL.clone().lerp(TP2, 0.45);
        pos = mid.clone().addScaledVector(side, -400).add(V3(0, 150, 0)).lerp(mid.clone().addScaledVector(side, -370).addScaledVector(fwd, 25).add(V3(0, 140, 0)), smooth(u));
        tgt = mid.clone().add(V3(0, 55, 0));
        fov = 46;
        break;
      }
      case 'tower': {
        const side = V3(PUSH.z, 0, -PUSH.x);
        const mid = TP3.clone().lerp(TOWER, 0.45);
        pos = mid.clone().addScaledVector(side, 520).add(V3(0, 150, 0)).lerp(mid.clone().addScaledVector(side, 540).addScaledVector(PUSH, 60).add(V3(0, 135, 0)), smooth(u));
        tgt = mid.clone().add(V3(0, 130, 0)).lerp(mid.clone().addScaledVector(PUSH, 130).add(V3(0, 50, 0)), sstep(0.1, 0.75, u));
        fov = 50;
        break;
      }
      case 'orbit': {
        const c = SL.clone().lerp(TP3, 0.5);
        const a0 = Math.atan2(PUSH.x, PUSH.z) + Math.PI / 2;
        const a = a0 - 0.2 + u * 1.25;
        pos = c.clone().add(V3(Math.sin(a) * 440, 170 - 40 * u, Math.cos(a) * 440));
        tgt = c.clone().add(V3(0, 70, 0));
        fov = 44;
        break;
      }
      case 'takeoff': {
        const s = this.SL2;
        pos = V3(-4, 6, -215).lerp(V3(-4, 5, -245), u);
        const cp = w.sol.boneWorld('chest');
        tgt = cp.clone().add(V3(0, -10, 0));
        fov = lerp(48, 58, sstep(0.3, 1, u));
        break;
      }
      case 'finale': {
        const ter = this.terRoot(t);
        const side = V3(PUSH.z, 0, -PUSH.x);
        pos = ter.clone().addScaledVector(PUSH, 170).addScaledVector(side, 95).add(V3(0, 75, 0)).lerp(ter.clone().addScaledVector(PUSH, 200).addScaledVector(side, 105).add(V3(0, 85, 0)), smooth(u));
        const sp = w.sol.boneWorld('chest');
        tgt = ter.clone().add(V3(0, 95, 0)).lerp(sp, 0.35);
        fov = 50;
        break;
      }
    }
    // camera shake
    const s = w.fx.shakeAt(t, pos);
    if (s > 0) {
      pos.add(V3(noise1(t * 22, 1) * s, noise1(t * 25, 2) * s, noise1(t * 21, 3) * s));
      tgt.add(V3(noise1(t * 19, 4) * s * 1.5, noise1(t * 23, 5) * s * 1.5, 0));
    }
    // handheld drift
    pos.add(V3(noise1(t * 0.7, 11) * 0.8, noise1(t * 0.8, 12) * 0.6, noise1(t * 0.6, 13) * 0.8));
    cam.position.copy(pos);
    cam.up.set(Math.sin(roll), Math.cos(roll), 0);
    cam.lookAt(tgt);
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    return sh;
  }

  // ---------------------------------------------------------------------------------------
  // Pose both creatures for time t
  pose(t) {
    const w = this.w;
    const ss = this.solearon(t); this._solYaw = ss.yaw;
    w.sol.pose(ss);
    const ts = this.teranox(t);
    w.ter.pose(ts);
    w.ter.group.visible = t > 3.0;
    return { ss, ts };
  }

  // ---------------------------------------------------------------------------------------
  // Precompute every destruction event by sampling the choreography.
  precompute() {
    const { city, fx, tower, sol, ter, sky } = this.w;
    const T = this.T; const rng = new RNG(2024);
    const burning = [];
    const kill = (b, t, dx, dz, style = 0, cause = 'body') => {
      if (!city.destroy(b, t, dx, dz, style)) return;
      const c = V3(b.x, 0, b.z);
      const big = Math.min(1, b.h / 120 + 0.25);
      // collapse: dust surge at the base, debris burst from the impact side
      fx.burst({ t: t + 0.3, pos: c.clone().add(V3(0, 4, 0)), type: PT.DUST, n: 7 + Math.floor(big * 10), speed: 22 + b.h * 0.15, life: [4, 8], size: [12 + b.w * 0.3, 40 + b.w * 0.9], jitter: b.w * 0.4, delay: 1.5 + b.h / 80 });
      fx.chunks({ t, pos: c.clone().add(V3(0, b.h * 0.6, 0)), n: 4 + Math.floor(big * 10), speed: 20 + (style ? 30 : 0), size: [0.8, 2.5 + b.w * 0.04], spread: b.w * 0.4, dir: V3(dx, 0.3, dz), delay: 1.0, glass: 0.35 });
      if (cause !== 'foot') fx.burst({ t: t + 0.05, pos: c.clone().add(V3(0, b.h * 0.5, 0)), type: PT.SPARK, n: 10, speed: 60, up: 0.8, life: [0.8, 1.6], size: [1.2, 0.4], drag: 0.6, grav: -25, jitter: 6 });
      if (b.h > 25 && rng.chance(0.75)) burning.push({ t: t + 1.2 + rng.range(0, 2), pos: c, b });
    };
    // --- sample the kaiju bodies ---
    const probes = [
      ['hips', 26], ['spine1', 26], ['chest', 25], ['neck1', 18], ['head', 14],
      ['tail0', 22], ['tail1', 20], ['tail2', 18], ['tail3', 16], ['tail4', 14], ['tail5', 12], ['tail6', 10], ['tail7', 9], ['tail8', 8], ['tail9', 7],
      ['shinL', 13], ['shinR', 13], ['footL', 12], ['footR', 12], ['thighL', 15], ['thighR', 15], ['handL', 10], ['handR', 10],
    ];
    const prev = {};
    const dt = 1 / 15;
    for (let t = 0; t <= DURATION; t += dt) {
      this.pose(t);
      for (const [kk, K] of [['ter', ter], ['sol', sol]]) {
        if (kk === 'ter' && t < 3.5) continue;
        if (kk === 'sol' && t < T.sLand - 0.6) continue;
        for (const [bn, R] of probes) {
          if (kk === 'sol' && t > T.sTakeoff + 0.8) continue;
          const p = K.boneWorld(bn);
          const key = kk + bn;
          const v = prev[key] ? p.clone().sub(prev[key]) : V3(0, 0, 0);
          prev[key] = p.clone();
          for (const b of city.query(p.x, p.z, R)) {
            if (b.destroyed !== undefined) continue;
            if (b.h < p.y - R) continue;
            const dir = v.lengthSq() > 0.01 ? v.clone().setY(0).normalize() : V3(b.x - p.x, 0, b.z - p.z).normalize();
            kill(b, t, dir.x, dir.z, bn.startsWith('tail') ? 1 : 0, bn.startsWith('foot') ? 'foot' : 'body');
          }
          // expressway segments
          for (const s of city.expressSegs) {
            if (s.destroyed !== undefined) continue;
            if (Math.abs(p.x - s.x) < s.w / 2 + R && Math.abs(p.z - s.z) < s.d / 2 + R && p.y - R < s.y + 3) {
              city.destroy(s, t, v.x || 0, v.z || 1, 2);
              fx.chunks({ t, pos: V3(s.x, s.y, s.z), n: 14, speed: 30, size: [1.5, 5], spread: 15 });
              fx.burst({ t: t + 0.2, pos: V3(s.x, 8, s.z), type: PT.DUST, n: 8, speed: 25, life: [4, 7], size: [15, 50], jitter: 15 });
              fx.burst({ t, pos: V3(s.x, s.y + 2, s.z), type: PT.SPARK, n: 25, speed: 70, up: 1, life: [0.8, 1.8], size: [1.5, 0.5], drag: 0.6, grav: -25, jitter: 8 });
            }
          }
        }
      }
    }
    // --- footfalls ---
    const steps = [];
    for (const [W, amp] of [[this.tWalk, 1.0], [this.tStag, 0.8], [this.tAdv, 1.0], [this.sWalk, 0.7]]) for (const f of W.footfalls()) steps.push({ ...f, amp });
    for (const f of steps) {
      fx.burst({ t: f.t, pos: f.pos.clone().add(V3(0, 3, 0)), type: PT.DUST, n: 12, speed: 40 * f.amp, up: 0.15, life: [2.5, 5], size: [8, 34], drag: 1.2, jitter: 8 });
      fx.chunks({ t: f.t, pos: f.pos.clone().add(V3(0, 2, 0)), n: 8, speed: 28, up: 1.2, size: [0.8, 3], spread: 10, hot: 0.05 });
      fx.ring({ t: f.t, pos: f.pos, radius: 70, dur: 0.9, color: [0.5, 0.35, 0.2], width: 0.1 });
      fx.shake({ t: f.t, pos: f.pos, amp: 1.1 * f.amp, dur: 0.8 });
      for (const b of city.query(f.pos.x, f.pos.z, 20)) if (b.destroyed === undefined) kill(b, f.t, 0, 1, 0, 'foot');
    }
    // Solearon landing
    {
      const t = T.sLand, p = SL.clone();
      fx.ring({ t, pos: p, radius: 420, dur: 1.8, color: [1, 0.65, 0.3], width: 0.08 });
      fx.burst({ t, pos: p.clone().add(V3(0, 4, 0)), type: PT.DUST, n: 70, speed: 110, up: 0.1, life: [3.5, 7], size: [15, 70], drag: 0.9, jitter: 30 });
      fx.burst({ t, pos: p.clone().add(V3(0, 10, 0)), type: PT.EMBER, n: 60, speed: 90, up: 0.8, life: [1.5, 3.5], size: [1.4, 0.4], drag: 0.8, grav: -8, jitter: 20 });
      fx.chunks({ t, pos: p, n: 60, speed: 60, size: [0.8, 3.5], spread: 40 });
      fx.shake({ t, pos: p, amp: 5, dur: 1.8 });
      fx.flash({ t, amt: 0.35, dur: 0.4 });
      fx.light({ t: t - 0.3, dur: 2.5, pos: p.clone().add(V3(0, 40, 0)), color: 0xffa050, intensity: 1.2e5, fade: 0.8 });
      for (const b of city.query(p.x, p.z, 110)) { const d = V3(b.x - p.x, 0, b.z - p.z); const L = d.length(); if (b.destroyed === undefined && (L < 70 || rng.chance(0.4))) kill(b, t + L / 250, d.x / L, d.z / L, 0); }
    }
    // Teranox ground slam
    {
      const t = T.tSlam;
      const p = TP2.clone().addScaledVector(V3(Math.sin(yawTo(TP2, SL)), 0, Math.cos(yawTo(TP2, SL))), 45);
      this.slamPos = p;
      city.groundUniforms.uSlam.value.set(p.x, p.z, t, 1);
      fx.ring({ t, pos: p, radius: 650, dur: 2.2, color: [1, 0.5, 0.15], width: 0.06 });
      fx.ring({ t: t + 0.1, pos: p, radius: 380, dur: 1.6, color: [1, 0.8, 0.5], width: 0.12 });
      fx.explosion({ t, pos: p.clone(), scale: 1.6, debris: 70 });
      fx.burst({ t, pos: p.clone().add(V3(0, 4, 0)), type: PT.DUST, n: 110, speed: 150, up: 0.12, life: [4, 8], size: [20, 90], drag: 0.7, jitter: 30 });
      fx.burst({ t: t + 0.1, pos: p.clone(), type: PT.FIRE, n: 45, speed: 60, up: 1.5, radial: false, life: [1.2, 2.4], size: [25, 60], drag: 1.2, grav: 8, jitter: 40 });
      fx.burst({ t, pos: p.clone(), type: PT.SPARK, n: 120, speed: 160, up: 1.4, life: [1, 2.5], size: [2, 0.6], drag: 0.5, grav: -30, jitter: 12 });
      fx.chunks({ t, pos: p.clone(), n: 140, speed: 90, up: 1.6, size: [0.8, 4], spread: 50, hot: 0.4 });
      fx.shake({ t, pos: p, amp: 9, dur: 2.4 });
      fx.flash({ t, amt: 0.6, dur: 0.5 });
      fx.light({ t, dur: 5, pos: p.clone().add(V3(0, 25, 0)), color: 0xff6a20, intensity: 1.5e6, fade: 0.8, flicker: 0.3 });
      for (const b of city.query(p.x, p.z, 280)) {
        if (b.destroyed !== undefined) continue;
        const d = V3(b.x - p.x, 0, b.z - p.z); const L = d.length() + 1e-3;
        if (L > 170 && rng.chance(0.45)) continue;
        kill(b, t + L / 170, d.x / L, d.z / L, L < 120 ? 2 : 0);
      }
      for (const s of city.expressSegs) { const L = Math.hypot(s.x - p.x, s.z - p.z); if (L < 260 && s.destroyed === undefined) city.destroy(s, t + L / 170, 0, 1, 2); }
      // lava eruptions along the cracks for a while
      for (let k = 0; k < 18; k++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(30, 230);
        const q = p.clone().add(V3(Math.cos(a) * r, 0, Math.sin(a) * r));
        const tt = t + r / 170 + rng.range(0, 0.3);
        fx.burst({ t: tt, pos: q, type: PT.FIRE, n: 6, speed: 35, up: 2, radial: false, life: [0.8, 1.6], size: [10, 25], drag: 1, grav: 5, jitter: 6 });
        fx.chunks({ t: tt, pos: q, n: 5, speed: 45, up: 2.5, size: [1.5, 5], spread: 8, hot: 0.6 });
        burning.push({ t: tt + 0.5, pos: q, b: null, small: true });
      }
    }
    // Solearon's charge: sparks converge
    for (let k = 0; k < 90; k++) {
      const tt = T.sCharge + rng.range(0, T.sBeam0 - T.sCharge - 0.2);
      this.pose(tt);
      const m = sol.mouthWorld();
      const off = V3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize().multiplyScalar(rng.range(25, 60));
      fx.particle(PT.EMBER, tt, 0.7, m.clone().add(off), off.clone().multiplyScalar(-1.35), rng.range(1.2, 2.4), 0.6, 0.01, 0);
    }
    // the beam sweep
    let lastExp = -1e9;
    for (let t = T.sBeam0; t < T.beamHit; t += 1 / 30) {
      const g = this.beamTarget(t);
      if (g.y < 2) {
        if (t - lastExp > 0.14) {
          lastExp = t;
          fx.explosion({ t, pos: g.clone(), scale: 0.9 + rng.range(0, 0.4), debris: 16, light: rng.chance(0.5) });
          fx.shake({ t, pos: g, amp: 1.2, dur: 0.6 });
          burning.push({ t: t + 0.6, pos: g.clone(), b: null, small: true });
        }
        for (const b of city.query(g.x, g.z, 30)) if (b.destroyed === undefined) kill(b, t + 0.05, PUSH.x, PUSH.z, 2, 'beam');
      }
      // buildings pierced along the beam line in 3D
      this.pose(t);
      const m = sol.mouthWorld();
      for (let k = 0.15; k < 1; k += 0.05) {
        const q = m.clone().lerp(g, k);
        for (const b of city.query(q.x, q.z, 10)) if (b.destroyed === undefined && b.h > q.y) kill(b, t, PUSH.x, PUSH.z, 2, 'beam');
      }
    }
    {
      const gs = this.beamTarget(T.sBeam0), ge = this.beamTarget(T.beamHit - 0.46);
      city.groundUniforms.uScorchA.value.set(gs.x, gs.z, ge.x, ge.z);
      city.groundUniforms.uScorchT.value.set(T.sBeam0, T.beamHit - 0.46 - T.sBeam0);
    }
    // impact on Teranox's chest
    for (let t = T.beamHit; t < T.sBeam1; t += 0.12) {
      const c = this.beamTarget(t);
      fx.burst({ t, pos: c, type: PT.SPARK, n: 22, speed: 130, up: 1, life: [0.6, 1.5], size: [2.2, 0.6], drag: 0.5, grav: -20, jitter: 4 });
      fx.burst({ t, pos: c, type: PT.FIRE, n: 3, speed: 50, up: 1, life: [0.6, 1.2], size: [20, 45], drag: 1.5, grav: 4, jitter: 6 });
    }
    fx.shake({ t: T.beamHit, pos: TP2, amp: 6, dur: 2 });
    fx.flash({ t: T.beamHit, amt: 0.45, dur: 0.35 });
    fx.shake({ t: T.sBeam0, pos: SL, amp: 2, dur: 3.4 });
    // --- Tokyo Tower falls ---
    {
      tower.fallT = T.towerFall;
      const tb = T.towerFall;
      const contact = TOWER.clone().add(V3(-20, 60, -20));
      fx.explosion({ t: tb, pos: contact, scale: 0.8, debris: 30 });
      fx.burst({ t: tb, pos: tower.pos.clone().add(V3(0, tower.breakY, 0)), type: PT.SPARK, n: 160, speed: 90, up: 1, life: [1, 3], size: [1.8, 0.5], drag: 0.4, grav: -25, jitter: 10 });
      for (let k = 0; k < 12; k++) fx.burst({ t: tb + k * 0.3, pos: tower.pos.clone().add(V3(0, tower.breakY, 0)), type: PT.SPARK, n: 10, speed: 40, up: 1, life: [1, 2], size: [1.4, 0.4], drag: 0.4, grav: -25, jitter: 8 });
      fx.shake({ t: tb, pos: TOWER, amp: 2, dur: 1.2 });
      const ti = tower.impactTime();
      // where the upper part lands
      tower.update(ti);
      const tip = tower.upperPoint(1), mid = tower.upperPoint(0.5), base = tower.upperPoint(0);
      city.groundUniforms.uFall.value.set(base.x, base.z, tip.x, tip.z);
      city.groundUniforms.uFallT.value = ti;
      for (let f = 0; f <= 1.0001; f += 0.1) {
        const q = tower.upperPoint(f); q.y = 0;
        const tt = ti - (1 - f) * 0.35;
        fx.burst({ t: tt, pos: q.clone().add(V3(0, 5, 0)), type: PT.DUST, n: 14, speed: 70, up: 0.2, life: [4, 8], size: [20, 70], drag: 0.8, jitter: 15 });
        fx.chunks({ t: tt, pos: q.clone().add(V3(0, 10, 0)), n: 12, speed: 45, up: 1.4, size: [1.5, 5], spread: 15, hot: 0.3 });
        if (f > 0.2 && Math.round(f * 10) % 2 === 0) fx.explosion({ t: tt + 0.05, pos: q.clone(), scale: 0.8, debris: 10, light: Math.round(f * 10) % 4 === 0 });
        for (const b of city.query(q.x, q.z, 32)) if (b.destroyed === undefined) kill(b, tt, tip.x - base.x, tip.z - base.z, 2);
        burning.push({ t: tt + 1, pos: q.clone(), b: null, small: false });
      }
      fx.ring({ t: ti, pos: mid.clone().setY(0), radius: 380, dur: 1.8, color: [0.9, 0.6, 0.35], width: 0.08 });
      fx.shake({ t: ti, pos: mid, amp: 5, dur: 2 });
      // the falling section is hit again and again: buildings under its arc
      for (let t = tb; t < ti; t += 0.1) {
        tower.update(t);
        for (let f = 0.3; f <= 1; f += 0.1) {
          const q = tower.upperPoint(f);
          for (const b of city.query(q.x, q.z, 16)) if (b.destroyed === undefined && b.h > q.y - 10) kill(b, t, tip.x - base.x, tip.z - base.z, 2);
        }
      }
      tower.update(0);
    }
    // Solearon's takeoff downdraft
    for (let k = 0; k < 4; k++) {
      const t = T.sTakeoff - 0.4 + k * 0.8;
      const p = this.SL2.clone();
      fx.ring({ t, pos: p, radius: 300 - k * 40, dur: 1.4, color: [1, 0.6, 0.25], width: 0.1 });
      fx.burst({ t, pos: p.clone().add(V3(0, 3, 0)), type: PT.DUST, n: 40, speed: 120 - k * 20, up: 0.08, life: [3, 6], size: [15, 60], drag: 0.9, jitter: 25 });
      fx.shake({ t, pos: p, amp: 2.5, dur: 1 });
    }
    // --- fires & smoke columns ---
    for (const f of burning) {
      const size = f.b ? Math.min(45, 14 + f.b.w * 0.35) : (f.small ? 14 : 30);
      fx.plume({ t0: f.t, t1: DURATION + 1, pos: f.pos, rate: f.small ? 0.9 : 1.3, size, fireSize: size * 0.9, spread: f.b ? f.b.w * 0.3 : 8, rise: 18 + size * 0.3 });
      fx.light({ t: f.t, dur: DURATION + 5 - f.t, pos: f.pos.clone().add(V3(0, 32, 0)), color: 0xff6a1e, intensity: (f.small ? 1.2e4 : 3e4) * (size / 30), fade: 0.05, flicker: 0.5 });
    }
    // Solearon's glow light while descending (lights up the city from above)
    fx.light({ t: T.sDescent - 1, dur: T.sLand - T.sDescent + 1.2, pos: V3(), follow: (t) => this.w.sol.boneWorld('chest').add(V3(0, -75, 0)), color: 0xffa040, intensity: 7e4, fade: 0.3 });
    this.burning = burning;
    this.pose(0);
    return { steps: steps.length, burning: burning.length };
  }

  // Global mood over time: fog/haze thickening as the city burns
  mood(t) {
    const fire = sstep(4, 40, t);
    return { fire, haze: sstep(10, 45, t) };
  }
}
