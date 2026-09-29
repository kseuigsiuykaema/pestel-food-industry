// Solearon (光翼獣) and Teranox (陽砕獣): skeleton layout, detailed surface generation and pose solver.
import * as THREE from 'three';
import { RNG, clamp, lerp, V3 } from '../util.js';
import { makeScaleSet, makeMetalSet, makeEyeTexture, makeGlowTexture } from '../textures.js';
import {
  Rig, Chain, SkinBuilder, tubeAlong, platesOnTube, plateGeo, bladeGeo, flameGeo, ellipsoidGeo,
  torusGeo, hornGeo, loftHead, frameMatrix,
} from './builder.js';

const UP = V3(0, 1, 0);
const tbl = (pairs) => (s) => {
  if (s <= pairs[0][0]) return pairs[0][1];
  for (let i = 0; i < pairs.length - 1; i++) {
    const [a, va] = pairs[i], [b, vb] = pairs[i + 1];
    if (s <= b) { let k = (s - a) / (b - a); k = k * k * (3 - 2 * k); return Array.isArray(va) ? va.map((x, j) => x + (vb[j] - x) * k) : va + (vb - va) * k; }
  }
  return pairs[pairs.length - 1][1];
};
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const grad3 = (c0, c1, c2) => (p, u, v) => v < 0.5 ? mixc(c0, c1, v * 2) : mixc(c1, c2, (v - 0.5) * 2);

export const SPECS = {
  solearon: {
    kind: 'solearon', seed: 11, width: 1.0, limb: 1.0, bulk: 1.0,
    skin: { base: [0.9, 0.86, 0.78], edge: [0.25, 0.16, 0.1], glowTint: [1, 0.5, 0.12] },
    skinEmissive: 0xff7a1a, skinEmissiveIntensity: 0.55,
    plate: 'ivory', halo: { R: 2.25, y: 10.95, z: -1.45 }, wings: true,
  },
  teranox: {
    kind: 'teranox', seed: 23, width: 1.12, limb: 1.2, bulk: 1.15,
    skin: { base: [0.62, 0.13, 0.07], edge: [0.08, 0.02, 0.01], glowTint: [1, 0.3, 0.05] },
    skinEmissive: 0xff3a0a, skinEmissiveIntensity: 0.35,
    plate: 'gold', halo: { R: 2.75, y: 11.0, z: -1.6 }, wings: false,
  },
};

function buildRig(spec) {
  const w = spec.width;
  const r = new Rig();
  r.add('hips', null, V3(0, 5.4, -0.2));
  r.add('spine1', 'hips', V3(0, 6.7, 0.0));
  r.add('chest', 'spine1', V3(0, 8.0, 0.2));
  r.add('neck1', 'chest', V3(0, 9.2, 0.45));
  r.add('neck2', 'neck1', V3(0, 9.9, 0.75));
  r.add('head', 'neck2', V3(0, 10.45, 1.05));
  r.add('jaw', 'head', V3(0, 10.33, 0.82));
  // tail
  let prev = 'hips';
  for (let i = 0; i < 10; i++) {
    const k = i / 10;
    r.add('tail' + i, prev, V3(0, 5.0 - 4.4 * Math.pow(Math.sin(k * Math.PI / 2), 1.3), -0.9 - i * 1.08));
    prev = 'tail' + i;
  }
  for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
    r.add('thigh' + side, 'hips', V3(1.05 * w * s, 5.1, -0.1));
    r.add('shin' + side, 'thigh' + side, V3(1.25 * w * s, 3.0, 0.55));
    r.add('foot' + side, 'shin' + side, V3(1.3 * w * s, 1.0, -0.25));
    r.add('toe' + side, 'foot' + side, V3(1.35 * w * s, 0.3, 0.45));
    r.add('clav' + side, 'chest', V3(0.45 * w * s, 8.5, 0.3));
    r.add('upperArm' + side, 'clav' + side, V3(1.5 * w * s, 8.6, 0.35));
    r.add('foreArm' + side, 'upperArm' + side, V3(1.95 * w * s, 7.05, 0.45));
    r.add('hand' + side, 'foreArm' + side, V3(2.05 * w * s, 5.75, 0.95));
    if (spec.wings) {
      r.add('wingA' + side, 'chest', V3(0.55 * s, 9.1, -0.75));
      r.add('wingB' + side, 'wingA' + side, V3(2.7 * s, 9.6, -1.05));
      r.add('wingC' + side, 'wingB' + side, V3(4.9 * s, 10.1, -1.2));
    }
  }
  r.tailTip = V3(0, 0.6, -0.9 - 10 * 1.08);
  return r;
}

function makeMaterials(spec, tex) {
  const flameUniforms = { uTime: { value: 0 }, uGlow: { value: 1 } };
  const skin = new THREE.MeshStandardMaterial({
    map: tex.scale.map, normalMap: tex.scale.normalMap, roughnessMap: tex.scale.roughnessMap,
    emissiveMap: tex.scale.emissiveMap, emissive: new THREE.Color(spec.skinEmissive), emissiveIntensity: spec.skinEmissiveIntensity,
    normalScale: new THREE.Vector2(1.2, 1.2), roughness: 1, metalness: 0.05,
  });
  const ivory = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.42, metalness: 0.08, normalMap: tex.metal.normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
    emissive: new THREE.Color(0xff8a2a), emissiveIntensity: 0.0,
  });
  const gold = new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 1.0, roughness: 0.32, normalMap: tex.metal.normalMap, roughnessMap: tex.metal.roughnessMap,
    normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 1.6,
  });
  const claw = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.25, envMapIntensity: 1.2 });
  const mouth = new THREE.MeshStandardMaterial({ color: 0x3a0806, roughness: 0.55, metalness: 0, emissive: new THREE.Color(0xff5a10), emissiveIntensity: 0 });
  const eye = new THREE.MeshBasicMaterial({ map: tex.eye, color: new THREE.Color(2.2, 2.2, 2.2) });
  const core = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 4.2, 2.0) });
  const flame = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.0, emissive: 0xffffff });
  flame.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, flameUniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aux; varying float vAux; varying vec3 vWp;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvAux = aux; vWp = (modelMatrix * vec4(transformed,1.)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uGlow; varying float vAux; varying vec3 vWp;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float fl = 0.75 + 0.25*sin(uTime*9.0 + vWp.y*0.08 + vWp.x*0.05) * sin(uTime*5.3 + vWp.z*0.06);
        totalEmissiveRadiance = vColor.rgb * (0.22 + 1.5*vAux*vAux) * uGlow * fl;`);
  };
  const plate = spec.plate === 'gold' ? gold : ivory;
  // night-time readability: cool moon rim + warm burning-city bounce from below
  const rimU = { uRim: { value: new THREE.Color(0.35, 0.42, 0.62) }, uBounce: { value: new THREE.Color(0.55, 0.22, 0.07) }, uRimAmt: { value: 1 } };
  for (const m of [skin, ivory, gold, claw]) {
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev(sh, r);
      Object.assign(sh.uniforms, rimU);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uRim; uniform vec3 uBounce; uniform float uRimAmt;')
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          { vec3 Nw = inverseTransformDirection(normal, viewMatrix);
            float fr = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
            float below = saturate(-Nw.y * 0.8 + 0.2);
            reflectedLight.indirectDiffuse += diffuseColor.rgb * (uBounce * below * 0.9) * uRimAmt;
            totalEmissiveRadiance += (uRim * fr * 0.55 + uBounce * fr * below * 0.8) * uRimAmt * (0.4 + 0.6 * diffuseColor.g); }`);
    };
  }
  return { mats: { skin, plate, ivory, gold, claw, mouth, eye, core, flame }, flameUniforms, rimU };
}

// ------------------------------------------------------------------------------------------
export function buildCreature(spec) {
  const rng = new RNG(spec.seed);
  const rig = buildRig(spec);
  const tex = {
    scale: makeScaleSet({ ...spec.skin, size: 1024, cols: 10, rows: 18, seed: spec.seed }),
    metal: makeMetalSet({ size: 512, seed: spec.seed }),
    eye: spec.kind === 'solearon' ? makeEyeTexture('#fff8d0', '#ffae2a', '#b83000') : makeEyeTexture('#fff0a0', '#ff7a10', '#9a1000'),
  };
  const { mats, flameUniforms, rimU } = makeMaterials(spec, tex);
  const sb = new SkinBuilder(rig);
  const S = spec.kind === 'solearon';
  const B = spec.bulk, W = spec.width, LM = spec.limb;
  const PM = S ? 1 : 1.3; // Teranox wears fewer, larger armor plates

  // palettes
  const IV = S ? [[0.42, 0.36, 0.3], [0.82, 0.77, 0.7], [0.95, 0.78, 0.55]] : [[0.5, 0.3, 0.1], [1.0, 0.78, 0.4], [1.0, 0.86, 0.55]];
  const plateCol = grad3(...IV);
  const goldCol = grad3([0.45, 0.27, 0.08], [1.0, 0.76, 0.36], [1.0, 0.88, 0.6]);
  const clawCol = grad3([0.18, 0.14, 0.12], [0.35, 0.3, 0.26], S ? [0.95, 0.9, 0.8] : [1.0, 0.8, 0.4]);
  const flameCol = (p, u, v) => v < 0.45 ? mixc([0.9, 0.22, 0.02], [1.0, 0.55, 0.08], v / 0.45) : mixc([1.0, 0.55, 0.08], [1.0, 0.92, 0.55], (v - 0.45) / 0.55);
  const redPlate = grad3([0.25, 0.04, 0.02], [0.62, 0.14, 0.06], [0.82, 0.3, 0.1]);

  // ---------- torso ----------
  const spine = new Chain(rig, ['hips', 'spine1', 'chest', 'neck1', 'neck2'], rig.rest('head'));
  const torsoR = tbl([[0, [1.2, 0.9, 1.0]], [0.1, [1.3, 1.1, 0.95]], [0.22, [1.36, 1.2, 0.92]], [0.34, [1.46, 1.25, 0.98]], [0.44, [1.5, 1.2, 1.08]],
    [0.52, [1.28, 1.0, 1.0]], [0.62, [0.9, 0.75, 0.8]], [0.72, [0.72, 0.62, 0.66]], [0.84, [0.6, 0.55, 0.58]], [1, [0.5, 0.45, 0.46]]]);
  const torso = tubeAlong(spine, {
    radius: (s) => { const r = torsoR(s); return [r[0] * W * B * (s < 0.55 ? 1 : 0.95), r[1] * B, r[2] * B]; },
    refDir: () => V3(0, 0, 1), radial: 36, rings: 48, capStart: 0.5, capEnd: 0,
    bump: (s, a) => 0.035 * Math.sin(s * 40) * Math.max(0, Math.sin(a)) + 0.05 * Math.exp(-Math.pow((s - 0.4) / 0.08, 2)) * Math.pow(Math.max(0, Math.cos(a - Math.PI / 2)), 6),
    texScale: 1.1,
  });
  sb.add(torso.geo, 'skin', { chain: spine });
  const front = Math.PI / 2, back = -Math.PI / 2;
  // belly bands
  platesOnTube(sb, spine, torso, {
    key: S ? 'plate' : 'ivory', s0: 0.02, s1: 0.33, rows: 7, per: 4, a0: front - 0.75, a1: front + 0.75, dir: -1, tilt: 0.05, wide: 1.9,
    size: (s, a, r) => 0.5 * B, rng, color: S ? plateCol : redPlate, opts: { tip: 'round', curl: 0.35, keel: 0.05 },
  });
  // chest / pectoral armor
  platesOnTube(sb, spine, torso, {
    key: 'plate', s0: 0.33, s1: 0.56, rows: 5, per: 9, a0: front - 1.7, a1: front + 1.7, dir: -1, tilt: 0.18,
    size: (s, a, r) => (0.62 + 0.15 * Math.cos(a - front)) * B, rng, color: plateCol, skip: (s, a) => Math.abs(a - front) < 0.35 && s > 0.36 && s < 0.5,
    opts: { tip: S ? 'point' : 'angular', curl: 0.3, keel: 0.3 },
  });
  // back and flanks
  platesOnTube(sb, spine, torso, {
    key: 'plate', s0: 0.03, s1: 0.62, rows: S ? 11 : 9, per: S ? 11 : 8, a0: front + 1.05, a1: front + 2 * Math.PI - 1.05, dir: -1, tilt: 0.15,
    size: (s, a, r) => (0.55 + 0.2 * Math.max(0, -Math.sin(a))) * B * PM * (s > 0.5 ? 0.8 : 1), rng, color: plateCol,
    opts: { tip: S ? 'point' : 'angular', curl: 0.25, keel: 0.35 },
  });
  // neck scales
  platesOnTube(sb, spine, torso, {
    key: 'plate', s0: 0.6, s1: 0.97, rows: 9, per: 10, dir: -1, tilt: 0.3, rng, color: plateCol,
    size: (s, a, r) => 0.4 * B * (Math.sin(a) > 0.3 ? 0.75 : 1), opts: { tip: 'point', curl: 0.3, keel: 0.3 },
  });
  // dorsal spikes
  for (let i = 0; i < 16; i++) {
    const s = 0.04 + i * 0.058;
    const smp = torso.sample(s, back);
    const L = (S ? 1.05 : 1.45) * (0.7 + 0.6 * Math.sin(Math.PI * Math.min(1, s * 1.4))) * B;
    const dir = smp.n.clone().multiplyScalar(1).addScaledVector(smp.T, -0.55).normalize();
    const m = frameMatrix(smp.p.clone().addScaledVector(smp.n, -0.12), dir, smp.T.clone().negate());
    sb.addAt(bladeGeo(L, L * (S ? 0.32 : 0.55), L * 0.12, { bend: -0.18, serr: S ? 0 : 0.25 }), m, S ? 'flame' : 'gold', { chain: spine, anchor: smp.p, color: S ? flameCol : goldCol, aux: (p, u, v) => v });
    // side rows
    if (i % 2 === 0 && s < 0.6) for (const sd of [-1, 1]) {
      const sm2 = torso.sample(s + 0.02, back + sd * 0.55);
      const d2 = sm2.n.clone().addScaledVector(sm2.T, -0.6).normalize();
      sb.addAt(bladeGeo(L * 0.6, L * 0.25, L * 0.08, { bend: -0.2 }), frameMatrix(sm2.p.clone().addScaledVector(sm2.n, -0.08), d2, sm2.T.clone().negate()),
        'gold', { chain: spine, anchor: sm2.p, color: goldCol });
    }
  }
  // chest core with sun-emblem setting
  {
    const smp = torso.sample(0.415, front);
    const n = smp.n.clone().normalize();
    const c = smp.p.clone().addScaledVector(n, 0.02);
    const coreR = S ? 0.34 : 0.3;
    const cm = frameMatrix(c, smp.T, n);
    sb.addAt(ellipsoidGeo(coreR, coreR, coreR * 0.75, 20, 14), cm, 'core', { chain: spine, anchor: c });
    const ringM = cm.clone().multiply(new THREE.Matrix4().makeRotationX(0));
    const tor = torusGeo(coreR * 1.18, coreR * 0.16, 8, 40); // lies in XY plane, normal Z
    sb.addAt(tor, ringM, 'gold', { chain: spine, anchor: c, color: [1, 0.8, 0.45] });
    const rays = S ? 16 : 8;
    for (let k = 0; k < rays; k++) {
      const a = (k / rays) * Math.PI * 2;
      const dirL = V3(Math.cos(a), Math.sin(a), 0);
      const L = (k % 2 === 0 ? 0.62 : 0.36) * (S ? 1 : 1.35);
      const local = frameMatrix(dirL.clone().multiplyScalar(coreR * 1.25), dirL, V3(0, 0, 1));
      sb.addAt(bladeGeo(L, 0.16, 0.06, { bend: 0.05 }), cm.clone().multiply(local), 'gold', { chain: spine, anchor: c, color: goldCol });
    }
    rig.coreLocal = { bone: 'chest', pos: c.clone().sub(rig.rest('chest')), normal: n.clone() };
  }

  // ---------- head ----------
  buildHead(sb, rig, spec, { plateCol, goldCol, clawCol, flameCol, rng });

  // ---------- tail ----------
  const tailNames = []; for (let i = 0; i < 10; i++) tailNames.push('tail' + i);
  const tailChain = new Chain(rig, tailNames, rig.tailTip);
  const tailR = (s) => { const k = Math.pow(1 - s, 1.15); return [(1.05 * k + 0.06) * B * W, (1.0 * k + 0.06) * B, (0.85 * k + 0.05) * B]; };
  const tail = tubeAlong(tailChain, { radius: tailR, refDir: () => UP.clone(), radial: 26, rings: 60, capEnd: 1.5, texScale: 0.9 });
  sb.add(tail.geo, 'skin', { chain: tailChain });
  platesOnTube(sb, tailChain, tail, {
    key: 'plate', s0: 0.0, s1: 0.93, rows: 30, per: 9, a0: -0.45, a1: Math.PI + 0.45, dir: 1, tilt: 0.3, rng, color: plateCol,
    size: (s, a, r) => r * 0.62 + 0.05, opts: { tip: S ? 'point' : 'angular', curl: 0.3, keel: 0.35 },
  });
  if (!S) platesOnTube(sb, tailChain, tail, {
    key: 'ivory', s0: 0.02, s1: 0.85, rows: 22, per: 3, a0: -Math.PI / 2 - 0.6, a1: -Math.PI / 2 + 0.6, dir: 1, tilt: 0.05, rng, color: redPlate, wide: 1.8,
    size: (s, a, r) => r * 0.5, opts: { tip: 'round', curl: 0.4, keel: 0.05 },
  });
  for (let i = 0; i < 24; i++) {
    const s = 0.02 + i * 0.04;
    const smp = tail.sample(s, Math.PI / 2);
    const L = (S ? 0.95 : 1.3) * Math.pow(1 - s, 0.7) * B + 0.15;
    const d = smp.n.clone().addScaledVector(smp.T, 0.9).normalize();
    sb.addAt(bladeGeo(L, L * (S ? 0.3 : 0.55), L * 0.12, { bend: 0.15, serr: S ? 0 : 0.2 }), frameMatrix(smp.p.clone().addScaledVector(smp.n, -0.1), d, smp.T),
      S ? 'flame' : 'gold', { chain: tailChain, anchor: smp.p, color: S ? flameCol : goldCol, aux: (p, u, v) => v });
    if (i % 2 === 1 && s < 0.8) for (const sd of [-1, 1]) {
      const sm2 = tail.sample(s, Math.PI / 2 + sd * 0.9);
      const d2 = sm2.n.clone().addScaledVector(sm2.T, 1.1).normalize();
      sb.addAt(bladeGeo(L * 0.55, L * 0.22, L * 0.08, { bend: 0.2 }), frameMatrix(sm2.p.clone().addScaledVector(sm2.n, -0.06), d2, sm2.T), 'gold', { chain: tailChain, anchor: sm2.p, color: goldCol });
    }
  }
  // tail tip fan
  {
    const tip = rig.tailTip;
    for (let k = 0; k < (S ? 9 : 5); k++) {
      const a = (k / ((S ? 9 : 5) - 1) - 0.5) * (S ? 2.2 : 1.6);
      const d = V3(Math.sin(a) * 0.8, Math.cos(a) * 0.5 + 0.1, -1).normalize();
      const L = S ? 1.6 - Math.abs(a) * 0.35 : 1.2;
      const g = S ? flameGeo(L, 0.34, { seed: k, bend: 0.1 }) : bladeGeo(L, 0.3, 0.12, { bend: 0.1 });
      sb.addAt(g, frameMatrix(tip.clone().add(V3(0, 0.05, 0.25)), d, UP), S ? 'flame' : 'gold', { bone: 'tail9', color: S ? flameCol : goldCol, aux: (p, u, v) => v });
    }
  }

  // ---------- legs ----------
  for (const [sd, side] of [[1, 'L'], [-1, 'R']]) {
    const legChain = new Chain(rig, ['thigh' + side, 'shin' + side, 'foot' + side], rig.rest('toe' + side));
    const legR = tbl([[0, [0.98, 1.02, 0.98]], [0.14, [1.0, 1.08, 1.0]], [0.3, [0.62, 0.66, 0.6]], [0.38, [0.52, 0.52, 0.58]],
      [0.52, [0.56, 0.5, 0.66]], [0.64, [0.36, 0.36, 0.42]], [0.72, [0.34, 0.34, 0.38]], [1, [0.4, 0.26, 0.3]]]);
    const leg = tubeAlong(legChain, {
      radius: (s) => legR(s).map((x) => x * LM), refDir: () => V3(0, 0, 1), radial: 28, rings: 44, capStart: 0.6, capEnd: 0.6, texScale: 0.95,
      bump: (s, a) => 0.06 * Math.exp(-Math.pow((s - 0.12) / 0.08, 2)) * Math.cos(a * 2),
    });
    sb.add(leg.geo, 'skin', { chain: legChain });
    platesOnTube(sb, legChain, leg, {
      key: 'plate', s0: 0.0, s1: 0.3, rows: S ? 6 : 5, per: S ? 11 : 8, dir: 1, tilt: 0.1, rng, color: plateCol,
      size: (s, a, r) => 0.55 * LM * PM, opts: { tip: S ? 'point' : 'angular', curl: 0.3, keel: 0.3 },
    });
    platesOnTube(sb, legChain, leg, {
      key: S ? 'plate' : 'gold', s0: 0.36, s1: 0.66, rows: S ? 6 : 4, per: S ? 9 : 7, dir: 1, tilt: 0.1, rng, color: S ? plateCol : goldCol,
      size: (s, a, r) => 0.42 * LM * PM, opts: { tip: S ? 'point' : 'angular', curl: 0.35, keel: 0.3 },
    });
    platesOnTube(sb, legChain, leg, {
      key: 'plate', s0: 0.68, s1: 0.97, rows: 5, per: 7, dir: 1, tilt: 0.15, rng, color: plateCol,
      size: (s, a, r) => 0.3 * LM, opts: { tip: 'point', curl: 0.3, keel: 0.2 },
    });
    // hip armor covering the thigh socket
    for (let k = 0; k < 4; k++) {
      const hp = rig.rest('thigh' + side).add(V3(sd * (0.55 + k * 0.08), 0.35 - k * 0.32, 0.25 - k * 0.12));
      const g = plateGeo((1.5 - k * 0.15) * LM, (1.1 - k * 0.1) * LM, 0.16, { tip: S ? 'round' : 'angular', curl: 0.7, keel: 0.25 });
      sb.addAt(g, frameMatrix(hp, V3(sd * 0.25, -1, 0.1).normalize(), V3(sd, 0.15, 0.25).normalize()), k % 2 && !S ? 'gold' : 'plate', { bone: 'thigh' + side, color: k % 2 && !S ? goldCol : plateCol });
    }
    // knee spike & greave
    {
      const smp = leg.sample(0.33, Math.PI / 2);
      const d = smp.n.clone().add(V3(0, 0.7, 0)).normalize();
      sb.addAt(bladeGeo(0.9 * LM, 0.42 * LM, 0.2, { bend: -0.1 }), frameMatrix(smp.p.clone().addScaledVector(smp.n, -0.1), d, V3(0, 1, 0)), 'gold', { chain: legChain, anchor: smp.p, color: goldCol });
      for (const off of [-0.6, 0.6]) {
        const s2 = leg.sample(0.3, Math.PI / 2 + off);
        const d2 = s2.n.clone().add(V3(0, 0.4, 0)).normalize();
        sb.addAt(bladeGeo(0.55 * LM, 0.3, 0.12), frameMatrix(s2.p.clone().addScaledVector(s2.n, -0.08), d2, V3(0, 1, 0)), 'gold', { chain: legChain, anchor: s2.p, color: goldCol });
      }
      // thigh outer spikes (like the reference's flaring hip armor)
      for (let k = 0; k < 3; k++) {
        const s3 = leg.sample(0.06 + k * 0.07, Math.PI / 2 + sd * (Math.PI / 2 + 0.2));
        const d3 = s3.n.clone().add(V3(0, -0.2, -0.5)).normalize();
        const L = (S ? 1.0 : 1.2) * LM * (1 - k * 0.2);
        sb.addAt(bladeGeo(L, 0.34, 0.12, { bend: 0.2 }), frameMatrix(s3.p.clone().addScaledVector(s3.n, -0.1), d3, V3(0, 1, 0)), S ? 'flame' : 'gold', { chain: legChain, anchor: s3.p, color: S ? flameCol : goldCol, aux: (p, u, v) => v });
      }
      // heel spur
      const sh = leg.sample(0.66, -Math.PI / 2);
      sb.addAt(bladeGeo(0.7 * LM, 0.25, 0.14, { bend: 0.2 }), frameMatrix(sh.p.clone().addScaledVector(sh.n, -0.08), sh.n.clone().add(V3(0, 0.3, 0)).normalize(), V3(0, 1, 0)), 'claw', { chain: legChain, anchor: sh.p, color: clawCol });
    }
    // toes
    const toeBase = rig.rest('toe' + side);
    for (let k = 0; k < 3; k++) {
      const spread = (k - 1) * 0.42;
      const dir = V3(Math.sin(spread) + sd * 0.05, -0.05, Math.cos(spread)).normalize();
      const p0 = toeBase.clone().add(V3((k - 1) * 0.26 * LM, 0.02, 0.05));
      const L = (k === 1 ? 1.0 : 0.85) * LM;
      const p1 = p0.clone().addScaledVector(dir, L * 0.5).add(V3(0, 0.05, 0));
      const p2 = p0.clone().addScaledVector(dir, L).add(V3(0, -0.12, 0));
      sb.add(hornGeo([p0, p1, p2], 0.2 * LM, 0.12 * LM, { radial: 10, seg: 8 }), 'skin', { bone: 'toe' + side });
      // toe scute plates
      for (let j = 0; j < 3; j++) {
        const pp = p0.clone().lerp(p2, 0.15 + j * 0.3).add(V3(0, 0.13 * LM, 0));
        sb.addAt(plateGeo(0.3 * LM, 0.32 * LM, 0.05, { tip: 'round' }), frameMatrix(pp, dir, UP), 'plate', { bone: 'toe' + side, color: plateCol });
      }
      const cm = frameMatrix(p2.clone().addScaledVector(dir, -0.05), dir.clone().add(V3(0, -0.5, 0)).normalize(), V3(0, -1, 0));
      sb.addAt(bladeGeo(0.55 * LM, 0.2 * LM, 0.2 * LM, { bend: 0.35, power: 1.1 }), cm, 'claw', { bone: 'toe' + side, color: clawCol });
    }
    // dew claw
    const dc = rig.rest('foot' + side).lerp(rig.rest('toe' + side), 0.75);
    sb.addAt(bladeGeo(0.45 * LM, 0.16, 0.16, { bend: 0.3 }), frameMatrix(dc.clone().add(V3(0, -0.1, -0.25)), V3(0, -0.6, -1).normalize(), V3(0, -1, 0)), 'claw', { bone: 'foot' + side, color: clawCol });

    // ---------- arms ----------
    const armChain = new Chain(rig, ['upperArm' + side, 'foreArm' + side], rig.rest('hand' + side));
    const armR = tbl([[0, [0.6, 0.58, 0.58]], [0.2, [0.52, 0.5, 0.5]], [0.45, [0.36, 0.38, 0.36]], [0.6, [0.44, 0.42, 0.46]], [0.95, [0.28, 0.26, 0.26]], [1, [0.26, 0.24, 0.24]]]);
    const arm = tubeAlong(armChain, { radius: (s) => armR(s).map((x) => x * LM), refDir: () => V3(0, 0, 1), radial: 22, rings: 30, capStart: 0.8, capEnd: 0.3, texScale: 0.85 });
    sb.add(arm.geo, 'skin', { chain: armChain });
    platesOnTube(sb, armChain, arm, {
      key: 'plate', s0: 0.02, s1: 0.95, rows: S ? 12 : 9, per: S ? 8 : 6, dir: 1, tilt: 0.1, rng, color: plateCol,
      size: (s, a, r) => (r * 0.8 + 0.08) * PM, opts: { tip: S ? 'point' : 'angular', curl: 0.3, keel: 0.3 },
    });
    // forearm blades trailing backwards (flame for Solearon)
    for (let k = 0; k < (S ? 6 : 4); k++) {
      const s = 0.52 + k * (S ? 0.075 : 0.1);
      const smp = arm.sample(s, -Math.PI / 2 + sd * 0.4);
      const d = smp.n.clone().addScaledVector(smp.T, -0.9).add(V3(0, 0.2, 0)).normalize();
      const L = S ? 1.5 + k * 0.25 : 1.1 - k * 0.1;
      const g = S ? flameGeo(L * LM, 0.42, { seed: k * 1.7 + sd, bend: -0.1 }) : bladeGeo(L * LM, 0.45, 0.16, { bend: -0.15, serr: 0.2 });
      sb.addAt(g, frameMatrix(smp.p.clone().addScaledVector(smp.n, -0.1), d, V3(sd, 0, 0)), S ? 'flame' : 'gold', { chain: armChain, anchor: smp.p, color: S ? flameCol : goldCol, aux: (p, u, v) => v });
    }
    // shoulder pauldron: layered plates + radiating spikes
    {
      const sp = rig.rest('upperArm' + side).add(V3(0.05 * sd, 0.25, 0));
      for (let k = 0; k < 7; k++) {
        const a = -1.2 + k * 0.4;
        const d = V3(sd * Math.cos(a) * 0.9, 0.35 + Math.sin(a) * 0.5, Math.sin(a) * -0.6).normalize();
        const L = (S ? 1.25 : 1.6) * (1 - Math.abs(k - 3) * 0.1) * W;
        const g = bladeGeo(L, L * 0.34, L * 0.12, { bend: 0.2, serr: S ? 0 : 0.2 });
        sb.addAt(g, frameMatrix(sp.clone().addScaledVector(d, 0.3), d, V3(0, 1, 0)), 'gold', { bone: 'clav' + side, color: goldCol });
      }
      for (let k = 0; k < 3; k++) {
        const pp = sp.clone().add(V3(sd * (0.1 + k * 0.22), 0.25 - k * 0.12, 0));
        const g = plateGeo(1.45 * W * LM, 1.25 * LM, 0.16, { tip: S ? 'round' : 'angular', curl: 0.7, keel: 0.2 });
        sb.addAt(g, frameMatrix(pp, V3(sd * 0.6, -1, 0).normalize(), V3(sd * 0.7, 0.5, 0.1).normalize()), 'plate', { bone: 'upperArm' + side, color: plateCol });
      }
      if (S) for (let k = 0; k < 5; k++) {
        const a = -0.6 + k * 0.3;
        const d = V3(sd * 0.55, 0.25 + a * 0.5, -1).normalize();
        sb.addAt(flameGeo(2.2 - Math.abs(a), 0.5, { seed: k + sd * 3 }), frameMatrix(sp.clone().add(V3(0, 0, -0.3)), d, V3(0, 1, 0)), 'flame', { bone: 'clav' + side, color: flameCol, aux: (p, u, v) => v });
      }
    }
    // hand
    buildHand(sb, rig, side, sd, LM, { plateCol, clawCol });

    // ---------- wings ----------
    if (spec.wings) buildWing(sb, rig, side, sd, { flameCol, goldCol, plateCol });
  }

  // ---------- halo ----------
  buildHalo(sb, rig, spec, goldCol);

  const built = sb.build(mats);
  const mesh = new THREE.SkinnedMesh(built.geometry, built.materials);
  mesh.frustumCulled = false;
  mesh.add(rig.bones[0]);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(rig.bones);
  mesh.bind(skeleton);
  return { mesh, rig, mats, flameUniforms, rimU, stats: built.stats, tex };
}

function buildHead(sb, rig, spec, { plateCol, goldCol, clawCol, flameCol, rng }) {
  const S = spec.kind === 'solearon';
  const H = rig.rest('head');
  const toW = (x, y, z) => V3(x, y, z).add(H);
  const hs = S ? 1 : 1.08;
  const z0 = -0.5, z1 = S ? 1.6 : 1.45;
  const Wf = tbl([[0, 0.4], [0.15, 0.5], [0.32, 0.53], [0.48, 0.44], [0.64, 0.34], [0.82, 0.29], [0.95, 0.22], [1, 0.05]]);
  const Tf = tbl([[0, 0.45], [0.16, 0.56], [0.36, 0.6], [0.5, 0.46], [0.7, 0.35], [0.9, 0.3], [0.985, 0.18], [1, 0.03]]);
  const Yc = (s) => -0.05 - 0.13 * s;
  const shape = (s) => ({ w: Wf(s) * hs, top: Tf(s) * hs, bot: 0.1, yc: Yc(s) });
  const disp = (s, th, x, y, z) => {
    // brow ridge + nasal ridge + cheek bulge
    const brow = Math.exp(-Math.pow((s - 0.38) / 0.07, 2)) * Math.pow(Math.max(0, Math.sin(th)), 0.5) * Math.pow(Math.abs(Math.cos(th)), 0.6) * 0.1;
    const nasal = Math.exp(-Math.pow(Math.cos(th) / 0.18, 2)) * (s > 0.5 ? 0.04 : 0) * Math.max(0, Math.sin(th));
    const cheek = Math.exp(-Math.pow((s - 0.22) / 0.1, 2)) * Math.pow(Math.max(0, Math.cos(th) * Math.sign(x || 1) * Math.sign(Math.cos(th))), 2) * 0.05;
    return [Math.sign(x) * (brow * 0.6 + cheek), brow + nasal, 0];
  };
  const place = (g) => { g.translate(H.x, H.y, H.z); return g; };
  sb.add(place(loftHead({ z0, z1, shape, th0: 0, th1: Math.PI, n: 2.6, disp, radial: 30, seg: 42 })), 'skin', { bone: 'head', uvScale: 0.7 });
  sb.add(place(loftHead({ z0, z1: z1 - 0.02, shape: (s) => ({ ...shape(s), w: shape(s).w * 0.97 }), th0: Math.PI, th1: Math.PI * 2, n: 2.6, radial: 16, seg: 30 })), 'mouth', { bone: 'head' });
  // back of skull
  sb.add(place(ellipsoidGeo(0.42 * hs, 0.5 * hs, 0.42, 18, 12).translate(0, 0.08, -0.45)), 'skin', { bone: 'head' });
  // lower jaw (hinge at jaw bone)
  const Jw = tbl([[0, 0.4], [0.25, 0.43], [0.6, 0.3], [0.9, 0.22], [1, 0.04]]);
  const Jb = tbl([[0, 0.42], [0.3, 0.33], [0.75, 0.22], [0.95, 0.16], [1, 0.03]]);
  const jz0 = -0.3, jz1 = z1 - 0.12;
  const jshape = (s) => { const z = jz0 + (jz1 - jz0) * s; const su = (z - z0) / (z1 - z0); return { w: Jw(s) * hs, top: 0.06, bot: Jb(s) * hs, yc: Yc(su) - 0.035 }; };
  sb.add(place(loftHead({ z0: jz0, z1: jz1, shape: jshape, th0: Math.PI, th1: Math.PI * 2, n: 2.4, radial: 24, seg: 30 })), 'skin', { bone: 'jaw', uvScale: 0.7 });
  sb.add(place(loftHead({ z0: jz0, z1: jz1, shape: jshape, th0: 0, th1: Math.PI, n: 2.4, radial: 14, seg: 24 })), 'mouth', { bone: 'jaw' });
  // tongue
  sb.add(place(ellipsoidGeo(0.2, 0.07, 0.6, 12, 8).translate(0, Yc(0.4) + 0.02, 0.35)), 'mouth', { bone: 'jaw' });
  // teeth
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 10; i++) {
      const s = 0.3 + i * 0.068;
      const z = z0 + (z1 - z0) * s;
      const x = side * Wf(s) * hs * 0.88;
      const big = i === 7 ? 1.7 : 1;
      const L = (0.12 + 0.04 * Math.sin(i * 2.1)) * big * hs;
      const pU = toW(x, Yc(s) + 0.02, z);
      sb.addAt(bladeGeo(L, 0.07 * big, 0.07 * big, { bend: -0.1, power: 1.2 }), frameMatrix(pU, V3(-side * 0.15, -1, 0.1).normalize(), V3(0, 0, 1)), 'claw', { bone: 'head', color: [0.95, 0.9, 0.8] });
      const js = (z - jz0) / (jz1 - jz0);
      if (js < 0.97) {
        const pL = toW(side * Jw(js) * hs * 0.85, Yc(s) - 0.02, z - 0.03);
        sb.addAt(bladeGeo(L * 0.9, 0.065 * big, 0.065 * big, { bend: 0.1, power: 1.2 }), frameMatrix(pL, V3(-side * 0.15, 1, -0.05).normalize(), V3(0, 0, 1)), 'claw', { bone: 'jaw', color: [0.95, 0.9, 0.8] });
      }
    }
    // eye
    const se = 0.42, ze = z0 + (z1 - z0) * se;
    const ep = toW(side * Wf(se) * hs * 0.93, Yc(se) + Tf(se) * hs * 0.5, ze);
    const eg = ellipsoidGeo(0.075, 0.065, 0.12, 16, 12);
    eg.rotateY(side > 0 ? 0 : Math.PI);
    eg.rotateY(side * -0.35);
    eg.translate(ep.x, ep.y, ep.z);
    sb.add(eg, 'eye', { bone: 'head' });
    if (side === 1) rig.eyeLocal = ep.clone().sub(H);
    // brow plate (heavy)
    const bp = toW(side * Wf(se) * hs * 0.82, Yc(se) + Tf(se) * hs * 0.86, ze + 0.2);
    sb.addAt(plateGeo(0.34, 0.55, 0.08, { tip: 'point', curl: 0.4 }), frameMatrix(bp, V3(side * 0.35, 0.25, -1).normalize(), V3(side * 0.5, 1, 0).normalize()), S ? 'plate' : 'gold', { bone: 'head', color: S ? plateCol : goldCol });
    // cheek spikes
    for (let k = 0; k < 3; k++) {
      const cp = toW(side * (Wf(0.2) * hs * 0.95), Yc(0.2) - 0.02 + k * 0.12, -0.1 - k * 0.05);
      const d = V3(side * (0.6 + k * 0.1), 0.05 + k * 0.25, -1).normalize();
      sb.addAt(bladeGeo((0.8 - k * 0.15) * hs, 0.14, 0.06, { bend: 0.15 }), frameMatrix(cp, d, UP), S ? 'plate' : 'gold', { bone: 'head', color: S ? plateCol : goldCol });
    }
    // jaw spikes
    for (let k = 0; k < 2; k++) {
      const jp = toW(side * Jw(0.15) * hs * 0.9, Yc(0.1) - 0.25 - k * 0.08, -0.15 + k * 0.2);
      sb.addAt(bladeGeo(0.45, 0.1, 0.05, { bend: 0.1 }), frameMatrix(jp, V3(side * 0.5, -0.4, -1).normalize(), UP), S ? 'plate' : 'gold', { bone: 'jaw', color: S ? plateCol : goldCol });
    }
    // horns
    const hp = [toW(side * 0.28, 0.42, -0.22), toW(side * 0.48, 0.75, -0.75), toW(side * 0.58, 1.15, -1.2), toW(side * 0.52, 1.5, -1.5)];
    sb.add(hornGeo(hp, 0.13 * hs, 0.012, { radial: 10, seg: 16, power: 0.9 }), 'gold', { bone: 'head', color: goldCol });
    // nostril
    const np = toW(side * 0.12, Yc(0.95) + Tf(0.95) * 0.7, z0 + (z1 - z0) * 0.95);
    sb.add(ellipsoidGeo(0.045, 0.03, 0.06, 8, 6).translate(np.x, np.y, np.z), 'mouth', { bone: 'head' });
  }
  // nasal ridge & head scales
  for (let i = 0; i < 7; i++) {
    const s = 0.92 - i * 0.1;
    const z = z0 + (z1 - z0) * s;
    for (const off of [-1, 0, 1]) {
      if (off !== 0 && s < 0.4) continue;
      const pp = toW(off * Wf(s) * 0.45, Yc(s) + Tf(s) * hs * (off === 0 ? 0.98 : 0.85), z);
      const sz = (0.3 + (0.92 - s) * 0.25) * (off === 0 ? 1 : 0.8);
      sb.addAt(plateGeo(sz, sz * 1.2, 0.05, { tip: 'point', curl: 0.3 }), frameMatrix(pp, V3(off * 0.2, 0.05, -1).normalize(), V3(off * 0.4, 1, 0).normalize()), off === 0 && !S ? 'gold' : 'plate', { bone: 'head', color: off === 0 && !S ? goldCol : plateCol });
    }
  }
  if (!S) {
    // nose horn
    const np = toW(0, Yc(0.8) + Tf(0.8) * 1.0, z0 + (z1 - z0) * 0.8);
    sb.addAt(bladeGeo(0.5, 0.22, 0.14, { bend: -0.15 }), frameMatrix(np, V3(0, 1, 0.35).normalize(), V3(0, 0, -1)), 'gold', { bone: 'head', color: goldCol });
  }
  // crown / mane of blades
  const N = S ? 19 : 11;
  for (let ring = 0; ring < 2; ring++) {
    for (let k = 0; k < N; k++) {
      const phi = (k / (N - 1) - 0.5) * (S ? 3.6 : 3.0);
      const base = toW(Math.sin(phi) * 0.36, 0.25 + Math.cos(phi) * 0.32, -0.35 - ring * 0.15);
      const d = V3(Math.sin(phi) * (0.9 + ring * 0.2), Math.cos(phi) * 0.75 + 0.15, -1.05).normalize();
      const L = (S ? 1.6 : 1.45) * (ring ? 1.25 : 0.85) * (1 - Math.abs(phi) * 0.12) * (0.9 + rng.next() * 0.2);
      const g = bladeGeo(L, (S ? 0.18 : 0.32) * (ring ? 1 : 0.8), 0.07, { bend: 0.12, serr: S ? 0 : 0.2 });
      const key = S ? (ring ? 'plate' : 'gold') : 'gold';
      sb.addAt(g, frameMatrix(base, d, UP), key, { bone: 'head', color: key === 'gold' ? goldCol : plateCol });
    }
  }
  // Solearon: fiery mane behind the crown
  if (S) for (let k = 0; k < 11; k++) {
    const phi = (k / 10 - 0.5) * 3.2;
    const base = toW(Math.sin(phi) * 0.3, 0.2 + Math.cos(phi) * 0.25, -0.5);
    const d = V3(Math.sin(phi) * 1.1, Math.cos(phi) * 0.6 + 0.1, -1).normalize();
    sb.addAt(flameGeo(2.0 - Math.abs(phi) * 0.25, 0.45, { seed: k }), frameMatrix(base, d, UP), 'flame', { bone: 'head', color: flameCol, aux: (p, u, v) => v });
  }
}

function buildHand(sb, rig, side, sd, LM, { plateCol, clawCol }) {
  const h = rig.rest('hand' + side);
  const down = V3(0.05 * sd, -1, 0.45).normalize();
  sb.add(ellipsoidGeo(0.24 * LM, 0.34 * LM, 0.14 * LM, 14, 10).translate(0, 0.1, 0).applyMatrix4(frameMatrix(h, down, V3(sd, 0, 0.25).normalize())), 'skin', { bone: 'hand' + side });
  // back-of-hand plate
  sb.addAt(plateGeo(0.55 * LM, 0.6 * LM, 0.08, { tip: 'round', curl: 0.4 }), frameMatrix(h.clone().add(V3(sd * 0.1, -0.05, -0.12)), down, V3(sd, 0, -0.3).normalize()), 'plate', { bone: 'hand' + side, color: plateCol });
  for (let f = 0; f < 5; f++) {
    const thumb = f === 4;
    const spreadAng = thumb ? -0.9 : (f - 1.5) * 0.28;
    const baseOff = thumb ? V3(-sd * 0.05, -0.2, 0.3) : V3(sd * 0.0, -0.35, 0.1 + (f - 1.5) * 0.15);
    const p0 = h.clone().add(baseOff.multiplyScalar(LM));
    const dir = thumb ? V3(-sd * 0.3, -0.6, 0.8).normalize() : V3(sd * 0.1 + Math.sin(spreadAng) * 0.3, -1, 0.35 + Math.sin(spreadAng) * 0.6).normalize();
    const L = (thumb ? 0.55 : 0.8 - Math.abs(f - 1.5) * 0.07) * LM;
    const p1 = p0.clone().addScaledVector(dir, L * 0.55).add(V3(0, 0, 0.12 * LM));
    const p2 = p0.clone().addScaledVector(dir, L).add(V3(0, -0.02, 0.08 * LM));
    sb.add(hornGeo([p0, p1, p2], 0.11 * LM, 0.075 * LM, { radial: 8, seg: 8 }), 'skin', { bone: 'hand' + side });
    const cd = p2.clone().sub(p1).normalize();
    sb.addAt(bladeGeo(0.5 * LM, 0.12 * LM, 0.12 * LM, { bend: 0.35, power: 1.1 }), frameMatrix(p2, cd, V3(0, 0, -1)), 'claw', { bone: 'hand' + side, color: clawCol });
  }
}

function buildWing(sb, rig, side, sd, { flameCol, goldCol, plateCol }) {
  const pA = rig.rest('wingA' + side), pB = rig.rest('wingB' + side), pC = rig.rest('wingC' + side);
  const pEnd = V3(6.9 * sd, 10.4, -1.3);
  const chain = new Chain(rig, ['wingA' + side, 'wingB' + side, 'wingC' + side], pEnd);
  // bony leading edge
  const edge = tubeAlong(chain, { radius: (s) => [0.22 - s * 0.14, 0.2 - s * 0.13, 0.2 - s * 0.13], refDir: () => UP.clone(), radial: 12, rings: 24, capStart: 0.5, capEnd: 1, texScale: 0.8 });
  sb.add(edge.geo, 'skin', { chain });
  platesOnTube(sb, chain, edge, { key: 'plate', rows: 10, per: 5, a0: -0.5, a1: Math.PI + 0.5, dir: 1, tilt: 0.3, size: (s, a, r) => r * 1.3 + 0.08, color: plateCol, opts: { tip: 'point' } });
  const pts = [pA, pB, pC, pEnd];
  const along = (t) => {
    const x = t * 3; const i = Math.min(2, Math.floor(x)); return pts[i].clone().lerp(pts[i + 1], x - i);
  };
  const out = V3(sd, 0, 0);
  const layers = [
    { n: 26, len: (t) => 2.2 + 4.2 * Math.pow(t, 0.75), w: 0.62, yo: -0.05, glow: 1.0 },
    { n: 20, len: (t) => 1.5 + 2.4 * Math.pow(t, 0.8), w: 0.55, yo: 0.08, glow: 0.9 },
    { n: 16, len: (t) => 0.9 + 1.2 * t, w: 0.45, yo: 0.18, glow: 0.7 },
  ];
  layers.forEach((L, li) => {
    for (let k = 0; k < L.n; k++) {
      const t = (k + 0.5) / L.n;
      const p = along(t).add(V3(0, L.yo, -0.05 * li));
      const d = V3(0, -0.28, -1).addScaledVector(out, Math.pow(t, 1.6) * 1.9).normalize();
      const len = L.len(t) * (0.92 + 0.16 * Math.sin(k * 3.7 + li));
      const g = flameGeo(len, L.w * (0.8 + 0.4 * t), { seed: k * 1.3 + li * 5 + sd, bend: -0.05 - 0.05 * li, waves: 2 + (k % 3) });
      const boneName = t < 0.34 ? 'wingA' + side : t < 0.67 ? 'wingB' + side : 'wingC' + side;
      sb.addAt(g, frameMatrix(p, d, UP), 'flame', { bone: boneName, color: flameCol, aux: (pp, u, v) => v * L.glow });
    }
  });
  // gold claw at wrist
  sb.addAt(bladeGeo(0.8, 0.2, 0.14, { bend: 0.3 }), frameMatrix(pC.clone().add(V3(0, 0.15, 0)), V3(sd * 0.3, 1, 0.3).normalize(), V3(0, 0, 1)), 'gold', { bone: 'wingC' + side, color: goldCol });
}

function buildHalo(sb, rig, spec, goldCol) {
  const S = spec.kind === 'solearon';
  const c = V3(0, spec.halo.y, spec.halo.z);
  const R = spec.halo.R;
  const tilt = new THREE.Matrix4().makeRotationX(0.12);
  const M = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(tilt);
  const add = (g, m) => sb.addAt(g, M.clone().multiply(m || new THREE.Matrix4()), 'gold', { bone: 'chest', color: goldCol });
  add(torusGeo(R, S ? 0.075 : 0.11, 10, 96));
  add(torusGeo(R * 0.9, 0.035, 6, 96));
  if (!S) add(torusGeo(R * 1.12, 0.04, 6, 96));
  const n = S ? 32 : 24;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const d = V3(Math.cos(a), Math.sin(a), 0);
    let L, w;
    if (S) { L = k % 4 === 0 ? 1.5 : k % 2 === 0 ? 0.95 : 0.5; w = k % 4 === 0 ? 0.2 : 0.13; }
    else { const card = k % 6 === 0; L = card ? 2.6 : k % 2 === 0 ? 1.0 : 0.55; w = card ? 0.34 : 0.18; }
    add(bladeGeo(L, w, w * 0.4, { bend: 0 }), frameMatrix(d.clone().multiplyScalar(R + 0.05), d, V3(0, 0, 1)));
    if (!S && k % 6 === 0) add(bladeGeo(1.0, 0.26, 0.1), frameMatrix(d.clone().multiplyScalar(R * 0.88), d.clone().negate(), V3(0, 0, 1)));
  }
  // mounting struts to the back
  for (const sx of [-1, 1]) {
    const a = V3(sx * 0.35, 9.35, -0.75), b = c.clone().add(V3(sx * R * 0.55, -R * 0.75, 0));
    sb.add(hornGeo([a, a.clone().lerp(b, 0.5).add(V3(0, 0, -0.2)), b], 0.09, 0.05, { radial: 6, seg: 6 }), 'gold', { bone: 'chest', color: goldCol });
  }
  rig.haloLocal = c.clone().sub(rig.rest('chest'));
}

// ------------------------------------------------------------------------------------------
// Runtime creature: glow sprites, lights, pose solver.
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4();

let glowTex = null;
export class Creature {
  constructor(kind) {
    this.spec = SPECS[kind];
    const built = buildCreature(this.spec);
    Object.assign(this, built);
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.scale = 10;
    this.group.scale.setScalar(this.scale);
    this.b = this.rig.byName;
    this.rest = {};
    for (const bn of this.rig.bones) this.rest[bn.name] = bn.position.clone();
    glowTex = glowTex || makeGlowTexture();
    const S = this.spec.kind === 'solearon';
    // chest core glow + light
    const cl = this.rig.coreLocal;
    this.coreSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: S ? 0xffc060 : 0xff7a30, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.coreSprite.position.copy(cl.pos).addScaledVector(cl.normal, 0.25);
    this.coreSprite.scale.setScalar(2.2);
    this.b[cl.bone].add(this.coreSprite);
    this.coreLight = new THREE.PointLight(S ? 0xffa040 : 0xff6a20, 0, 900, 2);
    this.coreLight.position.copy(cl.pos).addScaledVector(cl.normal, 6).add(V3(0, -1.5, 0));
    this.b[cl.bone].add(this.coreLight);
    // halo sun disc
    this.haloSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: S ? 0xffb040 : 0xff8a30, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }));
    this.haloSprite.position.copy(this.rig.haloLocal).add(V3(0, 0, -0.3));
    this.haloSprite.scale.setScalar(S ? 7.5 : 6.5);
    this.b.chest.add(this.haloSprite);
    // mouth glow (beam charge)
    this.mouthSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffd080, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    this.mouthSprite.position.set(0, -0.15, 1.7);
    this.mouthSprite.scale.setScalar(1.5);
    this.b.head.add(this.mouthSprite);
    this.eyeSprites = [];
    for (const s of [1, -1]) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff9030, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 }));
      sp.position.copy(this.rig.eyeLocal).multiply(V3(s, 1, 1)).add(V3(s * 0.05, 0, 0));
      sp.scale.setScalar(0.45);
      this.b.head.add(sp); this.eyeSprites.push(sp);
    }
    // measure limb lengths (world)
    const d = (a, b) => this.rig.rest(a).distanceTo(this.rig.rest(b)) * this.scale;
    this.len = { thigh: d('thighL', 'shinL'), shin: d('shinL', 'footL'), foot: d('footL', 'toeL') };
    this.restDir = {};
    for (const bn of this.rig.bones) {
      const child = bn.children.find((c) => c.isBone);
      if (child) this.restDir[bn.name] = child.position.clone().normalize();
    }
    this.restDir.toeL = V3(0.05, -0.15, 1).normalize(); this.restDir.toeR = V3(-0.05, -0.15, 1).normalize();
  }

  // Rotate a bone so its child joint points toward targetWorld, with pole (world) for twist.
  aim(name, targetWorld, poleWorld) {
    const bone = this.b[name];
    bone.parent.getWorldQuaternion(_q1);
    bone.getWorldPosition(_a);
    const dW = _b.copy(targetWorld).sub(_a).normalize();
    const inv = _q1.clone().invert();
    const d1 = dW.clone().applyQuaternion(inv);
    const p1 = poleWorld.clone().applyQuaternion(inv);
    const d0 = this.restDir[name];
    const p0 = V3(0, 0, 1);
    const basis = (x, pz) => {
      const X = x.clone().normalize();
      const Z = pz.clone().addScaledVector(X, -pz.dot(X));
      if (Z.lengthSq() < 1e-6) Z.set(0, 1, 0).addScaledVector(X, -X.y);
      Z.normalize();
      const Y = new THREE.Vector3().crossVectors(Z, X);
      return new THREE.Matrix4().makeBasis(X, Y, Z);
    };
    const M0 = basis(d0, p0), M1 = basis(d1, p1);
    _m0.copy(M1).multiply(M0.transpose());
    bone.quaternion.setFromRotationMatrix(_m0);
    bone.updateWorldMatrix(false, true);
  }

  solveLeg(side, foot) {
    // foot: {ball: Vector3 world, fwd: Vector3 world (horizontal), lift (0..1 swing), toeBend}
    const up = V3(0, 1, 0);
    const f = foot.fwd.clone().normalize();
    const H = this.b['thigh' + side].getWorldPosition(new THREE.Vector3());
    const metaDir = f.clone().multiplyScalar(0.7 + foot.lift * -0.35).addScaledVector(up, -0.7 - foot.lift * 0.3).normalize();
    const A = foot.ball.clone().addScaledVector(metaDir, -this.len.foot);
    const L1 = this.len.thigh, L2 = this.len.shin;
    const HA = A.clone().sub(H); let dist = HA.length();
    const maxD = (L1 + L2) * 0.995, minD = Math.abs(L1 - L2) + 1;
    if (dist > maxD) { A.copy(H).addScaledVector(HA.normalize(), maxD); dist = maxD; HA.copy(A).sub(H); }
    dist = Math.max(dist, minD);
    const u = HA.clone().normalize();
    const pole = f.clone().add(V3(side === 'L' ? 0.15 : -0.15, 0, 0).applyQuaternion(this.group.quaternion));
    const v = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
    const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const K = H.clone().addScaledVector(u, L1 * cosA).addScaledVector(v, L1 * sinA);
    this.aim('thigh' + side, K, f);
    this.aim('shin' + side, A, f.clone().negate());
    this.aim('foot' + side, foot.ball, f);
    const toeT = foot.ball.clone().addScaledVector(f, 10).addScaledVector(up, -foot.lift * 4 - (foot.toeBend || 0) * 6);
    this.aim('toe' + side, toeT, up);
  }

  /**
   * Apply a full pose. st fields (all optional):
   * pos, yaw, pitch, roll, hipDrop, lean, twist, neckPitch, neckYaw, headPitch, headYaw, headRoll, jaw,
   * armL/armR: [x,y,z] shoulder euler, elbowL/R, wristL/R, tailAmp, tailPhase, tailLift, tailSwipe,
   * wingFold, wingFlap, wingSpread, feet: {L, R} or null for FK legs, legFK: {L:[x,y,z],...}, time, glow
   */
  pose(st) {
    const b = this.b, R = this.rest;
    const t = st.time || 0;
    for (const bn of this.rig.bones) { bn.position.copy(R[bn.name]); bn.quaternion.identity(); }
    this.group.position.copy(st.pos);
    this.group.rotation.set(st.pitch || 0, st.yaw || 0, st.roll || 0, 'YXZ');
    const breath = Math.sin(t * 1.3) * 0.02;
    b.hips.position.y -= (st.hipDrop || 0);
    b.hips.position.z += (st.hipFwd || 0);
    b.hips.rotation.set((st.hipPitch || 0), (st.twist || 0) * 0.5, (st.hipRoll || 0));
    b.spine1.rotation.set((st.lean || 0) * 0.45 + breath, (st.twist || 0) * 0.25, (st.bodyRoll || 0) * 0.5);
    b.chest.rotation.set((st.lean || 0) * 0.55 - breath, (st.twist || 0) * 0.35, (st.bodyRoll || 0) * 0.5);
    b.neck1.rotation.set((st.neckPitch || 0) * 0.5, (st.neckYaw || 0) * 0.5, 0);
    b.neck2.rotation.set((st.neckPitch || 0) * 0.5, (st.neckYaw || 0) * 0.5, 0);
    b.head.rotation.set(st.headPitch || 0, st.headYaw || 0, st.headRoll || 0);
    b.jaw.rotation.set(st.jaw || 0, 0, 0);
    for (const [side, sd] of [['L', 1], ['R', -1]]) {
      const arm = st['arm' + side] || [0, 0, 0];
      b['clav' + side].rotation.set(0, 0, sd * (arm[3] || 0));
      b['upperArm' + side].rotation.set(arm[0], arm[1] * sd, arm[2] * sd, 'YXZ');
      const el = st['elbow' + side] ?? -0.5;
      b['foreArm' + side].rotation.set(el, 0, 0);
      const wr = st['wrist' + side] || [0, 0, 0];
      b['hand' + side].rotation.set(wr[0], wr[1] * sd, wr[2] * sd);
      if (this.spec.wings) {
        const fold = st.wingFold ?? 1, flap = st.wingFlap || 0, spread = st.wingSpread ?? 0;
        const o = 1 - fold;
        b['wingA' + side].rotation.set(lerp(0.45, 0.05 + spread * 0.1, o), lerp(-0.4, -0.1, o) * sd, lerp(-1.62, 0.2 + flap, o) * sd, 'YXZ');
        b['wingB' + side].rotation.set(0, lerp(0.05, 0.05, o) * sd, lerp(0.12, flap * 0.5, o) * sd);
        b['wingC' + side].rotation.set(0, 0, lerp(0.1, flap * 0.45 + 0.05, o) * sd);
      }
    }
    const amp = st.tailAmp ?? 0.05, ph = st.tailPhase ?? t * 1.2, lift = st.tailLift || 0, swipe = st.tailSwipe || 0;
    for (let i = 0; i < 10; i++) {
      const k = (i + 1) / 10;
      b['tail' + i].rotation.set(-lift * 0.12 * (1 - k * 0.3), Math.sin(ph - i * 0.45) * amp * (0.4 + k) + swipe * 0.16 * (0.6 + k), 0);
    }
    this.group.updateMatrixWorld(true);
    if (st.feet) { this.solveLeg('L', st.feet.L); this.solveLeg('R', st.feet.R); }
    else {
      const fk = st.legFK || { L: [0.5, 0, 0], R: [0.3, 0, 0] };
      for (const side of ['L', 'R']) {
        const a = fk[side];
        b['thigh' + side].rotation.set(-a[0], 0, a[2] || 0);
        b['shin' + side].rotation.set(a[0] * 1.3 + 0.4, 0, 0);
        b['foot' + side].rotation.set(0.6, 0, 0);
        b['toe' + side].rotation.set(0.5, 0, 0);
      }
      this.group.updateMatrixWorld(true);
    }
    // glow
    const g = st.glow ?? 1, cg = st.coreGlow ?? 1;
    const S = this.spec.kind === 'solearon';
    this.flameUniforms.uTime.value = t; this.flameUniforms.uGlow.value = g * (S ? 0.8 : 0.8);
    this.coreLight.intensity = (S ? 3.5e4 : 2e4) * cg;
    this.coreSprite.scale.setScalar((S ? 2.4 : 2.0) * (0.85 + 0.15 * Math.sin(t * 3)) * (0.6 + 0.6 * cg));
    this.coreSprite.material.opacity = Math.min(1, 0.7 * cg);
    this.mats.core.color.setRGB(6 * cg + 1, 4.2 * cg + 0.6, 2 * cg + 0.3);
    this.haloSprite.material.opacity = (S ? 0.5 : 0.35) * Math.min(st.haloGlow ?? 1, 1.6) * (st.camNear ?? 1);
    this.haloSprite.scale.setScalar((S ? 7.5 : 6.2) * (0.9 + 0.25 * (st.haloGlow ?? 1)));
    this.mats.skin.emissiveIntensity = this.spec.skinEmissiveIntensity * (0.7 + 0.5 * cg);
    this.mats.mouth.emissiveIntensity = st.mouthGlow || 0;
    this.mouthSprite.material.opacity = Math.min(1, (st.mouthGlow || 0) * 0.5);
    this.mouthSprite.scale.setScalar(1 + (st.mouthGlow || 0) * 1.5);
  }

  boneWorld(name, out = new THREE.Vector3()) { return this.b[name].getWorldPosition(out); }
  mouthWorld(out = new THREE.Vector3()) { return this.mouthSprite.getWorldPosition(out); }
  headDir(out = new THREE.Vector3()) {
    const q = this.b.head.getWorldQuaternion(new THREE.Quaternion());
    return out.set(0, -0.12, 1).normalize().applyQuaternion(q);
  }
}
