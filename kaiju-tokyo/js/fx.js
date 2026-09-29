// Effects: every particle is spawned at init with a birth time, and the vertex shader evaluates its
// state analytically for any time t. This makes each frame deterministic and seekable.
import * as THREE from 'three';
import { RNG, GLSL_NOISE, clamp } from './util.js';

const T_SMOKE = 0, T_DUST = 1, T_FIRE = 2, T_SPARK = 3, T_FLASH = 4, T_EMBER = 5, T_STEAM = 6;
export const PT = { SMOKE: T_SMOKE, DUST: T_DUST, FIRE: T_FIRE, SPARK: T_SPARK, FLASH: T_FLASH, EMBER: T_EMBER, STEAM: T_STEAM };

const SPRITE_VERT = /* glsl */`
attribute vec3 aP0; attribute vec3 aV; attribute vec4 aT; attribute vec4 aS;
uniform float uTime; uniform float fogDensity;
varying vec2 vUv; varying float vAge; varying float vSeed; varying float vType; varying float vFog; varying float vHeight;
void main(){
  float age = uTime - aT.x;
  float life = aT.y;
  vType = aT.w; vSeed = aT.z;
  if (age < 0.0 || age > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = age / life; vAge = k;
  float drag = aS.z;
  vec3 disp = aV * (1.0 - exp(-drag * age)) / max(drag, 1e-3);
  disp.y += 0.5 * aS.w * age * age;
  vec3 p = aP0 + disp;
  if (vType == 3.0 || vType == 5.0) p.y = max(p.y, 0.5);
  vHeight = p.y;
  float size = mix(aS.x, aS.y, 1.0 - pow(1.0 - k, 2.0));
  if (vType == 4.0) size = aS.x * (0.4 + 0.6 * sin(min(k, 1.0) * 3.14159));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float rot = aT.z * 6.2831 + age * (aT.z - 0.5) * 0.8;
  vec2 c = position.xy;
  // sparks stretch along their screen-space velocity
  if (vType == 3.0) {
    vec3 vel = aV * exp(-drag * age); vel.y += aS.w * age;
    vec4 mv2 = viewMatrix * vec4(p + vel * 0.06, 1.0);
    vec2 dir = mv2.xy - mv.xy; float L = length(dir) + 1e-4; dir /= L;
    vec2 nrm = vec2(-dir.y, dir.x);
    mv.xy += dir * c.y * (size + L * 1.5) + nrm * c.x * size * 0.35;
  } else {
    float cs = cos(rot), sn = sin(rot);
    mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
  }
  vUv = position.xy + 0.5;
  gl_Position = projectionMatrix * mv;
  float d = -mv.z; vFog = 1.0 - exp(-pow(fogDensity * d * 0.8, 2.0));
}`;

const SPRITE_FRAG = /* glsl */`
${GLSL_NOISE}
uniform float uTime; uniform vec3 fogColor; uniform float uAdditive; uniform vec3 uAmbient;
varying vec2 vUv; varying float vAge; varying float vSeed; varying float vType; varying float vFog; varying float vHeight;
void main(){
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float t = vType;
  vec4 outc;
  if (t == 3.0 || t == 5.0) {
    float a = smoothstep(1.0, 0.0, r);
    vec3 col = mix(vec3(4.0, 2.2, 0.8), vec3(3.0, 0.8, 0.15), vAge) * (1.0 - vAge * 0.6);
    outc = vec4(col * a, a);
  } else if (t == 4.0) {
    float a = pow(max(1.0 - r, 0.0), 2.2);
    vec3 col = mix(vec3(6.0, 5.0, 3.6), vec3(4.0, 1.5, 0.3), vAge);
    outc = vec4(col * a * (1.0 - vAge), a);
  } else {
    float n = fbm2(c * 3.2 + vSeed * 17.0 + vec2(0.0, -uTime * 0.25));
    float shape = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.9);
    if (t == 2.0) {
      // fire: white core -> yellow -> orange -> deep red -> smoky
      float heat = clamp(1.0 - vAge * 1.25 + (n - 0.5) * 0.6 - r * 0.35, 0.0, 1.0);
      vec3 col = mix(vec3(0.6, 0.08, 0.01), vec3(2.8, 0.9, 0.12), smoothstep(0.1, 0.5, heat));
      col = mix(col, vec3(5.0, 3.4, 1.4), smoothstep(0.6, 0.95, heat));
      float a = shape * smoothstep(0.0, 0.08, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
      outc = vec4(col * a, a);
    } else {
      // smoke / dust / steam: lit by fires below and the city glow
      vec3 base = t == 0.0 ? vec3(0.03, 0.028, 0.027) : (t == 1.0 ? vec3(0.06, 0.052, 0.045) : vec3(0.2, 0.2, 0.22));
      float under = smoothstep(0.3, -0.6, c.y) * exp(-vHeight / 180.0);
      vec3 col = base * (0.55 + 0.9 * n) + uAmbient * (0.4 + 0.6 * n) + vec3(0.45, 0.14, 0.03) * under * (t == 0.0 ? 0.9 : 0.35);
      float a = shape * smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.5, 1.0, vAge)) * (t == 0.0 ? 0.62 : 0.6);
      outc = vec4(col, a);
    }
  }
  outc.rgb = mix(outc.rgb, fogColor * (uAdditive > 0.5 ? 0.0 : 1.0), vFog);
  if (uAdditive > 0.5) outc.rgb *= 1.0 - vFog;
  gl_FragColor = outc;
}`;

export class FX {
  constructor(scene, seed = 7) {
    this.scene = scene;
    this.rng = new RNG(seed);
    this.sprites = { add: [], alpha: [] };
    this.debris = [];
    this.rings = [];
    this.lights = [];
    this.shakes = [];
    this.flashes = [];
    this.uniforms = { uTime: { value: 0 } };
  }

  // ---------- emission (init time) ----------
  particle(type, t0, life, p, v, s0, s1, drag = 0.5, grav = 0) {
    const arr = type === T_FIRE || type === T_SPARK || type === T_FLASH || type === T_EMBER ? this.sprites.add : this.sprites.alpha;
    arr.push([p.x, p.y, p.z, v.x, v.y, v.z, t0, life, this.rng.next(), type, s0, s1, drag, grav]);
  }
  // radial burst of puffs
  burst({ t, pos, type = T_DUST, n = 20, speed = 30, up = 0.3, spread = 1, life = [3, 6], size = [10, 40], drag = 0.8, grav = 0, jitter = 5, delay = 0, radial = true }) {
    const r = this.rng;
    for (let i = 0; i < n; i++) {
      const a = r.range(0, Math.PI * 2);
      const h = radial ? r.range(-0.1, up) : r.range(0.5, 1);
      const dir = new THREE.Vector3(Math.cos(a) * spread, h, Math.sin(a) * spread).normalize();
      const sp = speed * r.range(0.4, 1.1);
      const p = pos.clone().add(new THREE.Vector3(r.range(-jitter, jitter), r.range(0, jitter * 0.5), r.range(-jitter, jitter)));
      this.particle(type, t + r.range(0, delay), r.range(life[0], life[1]), p, dir.multiplyScalar(sp), size[0] * r.range(0.7, 1.2), size[1] * r.range(0.7, 1.3), drag, grav);
    }
  }
  // rising column of smoke with fire at its base, emitted over [t0, t1]
  plume({ t0, t1, pos, rate = 2, fire = true, size = 30, rise = 22, spread = 10, fireSize = 18, smokeLife = [7, 12] }) {
    const r = this.rng;
    for (let t = t0; t < t1; t += 1 / rate) {
      const p = pos.clone().add(new THREE.Vector3(r.range(-spread, spread), r.range(0, 6), r.range(-spread, spread)));
      this.particle(T_SMOKE, t, r.range(smokeLife[0], smokeLife[1]), p, new THREE.Vector3(r.range(-2, 2) + 4, rise * r.range(0.7, 1.2), r.range(-2, 2)), size * 0.6, size * 3.2, 0.12, 0.8);
      if (fire) {
        this.particle(T_FIRE, t + r.range(0, 0.3), r.range(1.0, 2.0), p.clone().add(new THREE.Vector3(0, 2, 0)), new THREE.Vector3(r.range(-2, 2), r.range(8, 16), r.range(-2, 2)), fireSize * r.range(0.7, 1.2), fireSize * 0.4, 0.5, 5);
        if (r.chance(0.35)) this.particle(T_EMBER, t, r.range(2, 4), p.clone().add(new THREE.Vector3(0, 8, 0)), new THREE.Vector3(r.range(-8, 8), r.range(15, 35), r.range(-8, 8)), r.range(0.8, 1.6), 0.4, 0.4, -2);
      }
    }
  }
  explosion({ t, pos, scale = 1, debris = 20, smoke = true, light = true }) {
    const r = this.rng;
    this.particle(T_FLASH, t, 0.45, pos.clone().add(new THREE.Vector3(0, 8 * scale, 0)), new THREE.Vector3(), 90 * scale, 90 * scale, 1, 0);
    for (let i = 0; i < 14; i++) {
      const d = new THREE.Vector3(r.range(-1, 1), r.range(0.1, 1.2), r.range(-1, 1)).normalize();
      this.particle(T_FIRE, t + r.range(0, 0.15), r.range(1.2, 2.4), pos.clone().addScaledVector(d, 4 * scale), d.multiplyScalar(r.range(15, 45) * scale), 20 * scale, 55 * scale, 1.4, 6);
    }
    if (smoke) for (let i = 0; i < 10; i++) {
      const d = new THREE.Vector3(r.range(-1, 1), r.range(0.3, 1.2), r.range(-1, 1)).normalize();
      this.particle(T_SMOKE, t + r.range(0.3, 1.0), r.range(6, 11), pos.clone().addScaledVector(d, 10 * scale), d.multiplyScalar(r.range(8, 20) * scale), 25 * scale, 90 * scale, 0.5, 3);
    }
    for (let i = 0; i < 26; i++) {
      const d = new THREE.Vector3(r.range(-1, 1), r.range(0.2, 1.3), r.range(-1, 1)).normalize();
      this.particle(T_SPARK, t, r.range(0.8, 2.0), pos.clone(), d.multiplyScalar(r.range(50, 120) * scale), r.range(0.8, 1.8) * scale, 0.5, 0.6, -25);
    }
    if (debris) this.chunks({ t, pos, n: debris, speed: 45 * scale, size: [0.8, 3 * scale] });
    if (light) this.light({ t, dur: 1.6, pos: pos.clone().add(new THREE.Vector3(0, 15, 0)), color: 0xff8a3a, intensity: 4e5 * scale, fade: 1.2 });
  }
  chunks({ t, pos, n = 20, speed = 40, up = 0.8, size = [1, 4], spread = 6, hot = 0.25, glass = 0.2, dir = null, delay = 0 }) {
    const r = this.rng;
    for (let i = 0; i < n; i++) {
      let d = new THREE.Vector3(r.range(-1, 1), r.range(0.2, 1) * up + 0.2, r.range(-1, 1)).normalize();
      if (dir) d.addScaledVector(dir, 0.9).normalize();
      const p = pos.clone().add(new THREE.Vector3(r.range(-spread, spread), r.range(0, spread), r.range(-spread, spread)));
      const kind = r.chance(hot) ? 1 : r.chance(glass) ? 2 : 0;
      this.debris.push([p.x, p.y, p.z, d.x * speed * r.range(0.4, 1.2), d.y * speed * r.range(0.5, 1.2), d.z * speed * r.range(0.4, 1.2),
        t + r.range(0, delay), r.range(4, 9), r.next(), r.range(size[0], size[1]), kind, r.range(1, 6)]);
    }
  }
  ring({ t, pos, radius = 300, dur = 1.6, color = [1, 0.6, 0.25], width = 0.12, height = 0 }) {
    this.rings.push({ t, pos: pos.clone(), radius, dur, color, width, height });
  }
  light({ t, dur, pos, color = 0xff8a3a, intensity = 1e6, fade = 1, flicker = 0, follow = null }) {
    this.lights.push({ t, dur, pos: pos.clone(), color: new THREE.Color(color), intensity, fade, flicker, follow });
  }
  shake({ t, pos, amp = 1, dur = 1.2, freq = 18 }) { this.shakes.push({ t, pos: pos.clone(), amp, dur, freq }); }
  flash({ t, amt = 1, dur = 0.3 }) { this.flashes.push({ t, amt, dur }); }

  // ---------- build GPU buffers ----------
  finalize() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const mkSprites = (list, additive) => {
      const N = list.length;
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index; g.attributes.position = quad.attributes.position;
      const P0 = new Float32Array(N * 3), V = new Float32Array(N * 3), T = new Float32Array(N * 4), S = new Float32Array(N * 4);
      list.forEach((q, i) => { P0.set(q.slice(0, 3), i * 3); V.set(q.slice(3, 6), i * 3); T.set([q[6], q[7], q[8], q[9]], i * 4); S.set([q[10], q[11], q[12], q[13]], i * 4); });
      g.setAttribute('aP0', new THREE.InstancedBufferAttribute(P0, 3));
      g.setAttribute('aV', new THREE.InstancedBufferAttribute(V, 3));
      g.setAttribute('aT', new THREE.InstancedBufferAttribute(T, 4));
      g.setAttribute('aS', new THREE.InstancedBufferAttribute(S, 4));
      g.instanceCount = N;
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: this.uniforms.uTime, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, uAdditive: { value: additive ? 1 : 0 }, uAmbient: { value: new THREE.Color(0.02, 0.02, 0.03) } },
        vertexShader: SPRITE_VERT, fragmentShader: SPRITE_FRAG,
        transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      if (additive) { m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; }
      else { m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; }
      // premultiply for the alpha pass
      if (!additive) m.fragmentShader = m.fragmentShader.replace('gl_FragColor = outc;', 'gl_FragColor = vec4(outc.rgb * outc.a, outc.a);');
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = additive ? 20 : 10;
      this.scene.add(mesh);
      return m;
    };
    this.spriteMats = [mkSprites(this.sprites.alpha, false), mkSprites(this.sprites.add, true)];
    this.count = { alpha: this.sprites.alpha.length, add: this.sprites.add.length, debris: this.debris.length };

    // debris chunks (lit)
    {
      const base = new THREE.IcosahedronGeometry(1, 0);
      const pa = base.attributes.position; const r = new RNG(3);
      for (let i = 0; i < pa.count; i++) {
        const k = 0.65 + 0.7 * (Math.abs(Math.sin(Math.round(pa.getX(i) * 97) * 12.9898 + Math.round(pa.getY(i) * 97) * 78.233 + Math.round(pa.getZ(i) * 97) * 37.719) * 43758.5453) % 1);
        pa.setXYZ(i, pa.getX(i) * k, pa.getY(i) * k * 0.7, pa.getZ(i) * k * 1.2);
      }
      base.computeVertexNormals();
      const N = this.debris.length;
      const g = new THREE.InstancedBufferGeometry();
      g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.normal = base.attributes.normal;
      const A = new Float32Array(N * 3), B = new Float32Array(N * 3), C = new Float32Array(N * 4), D = new Float32Array(N * 2);
      this.debris.forEach((q, i) => { A.set(q.slice(0, 3), i * 3); B.set(q.slice(3, 6), i * 3); C.set([q[6], q[7], q[8], q[9]], i * 4); D.set([q[10], q[11]], i * 2); });
      g.setAttribute('aP0', new THREE.InstancedBufferAttribute(A, 3));
      g.setAttribute('aV', new THREE.InstancedBufferAttribute(B, 3));
      g.setAttribute('aT', new THREE.InstancedBufferAttribute(C, 4));
      g.setAttribute('aK', new THREE.InstancedBufferAttribute(D, 2));
      g.instanceCount = N;
      const m = new THREE.MeshStandardMaterial({ color: 0x3e3a36, roughness: 0.9, metalness: 0.05, flatShading: true });
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = this.uniforms.uTime;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
          uniform float uTime; attribute vec3 aP0; attribute vec3 aV; attribute vec4 aT; attribute vec2 aK; varying float vKind; varying float vHotA;
          mat3 rotA(vec3 ax, float a){ ax = normalize(ax); float s = sin(a), c = cos(a), oc = 1.0 - c;
            return mat3(oc*ax.x*ax.x + c, oc*ax.x*ax.y + ax.z*s, oc*ax.z*ax.x - ax.y*s, oc*ax.x*ax.y - ax.z*s, oc*ax.y*ax.y + c, oc*ax.y*ax.z + ax.x*s, oc*ax.z*ax.x + ax.y*s, oc*ax.y*ax.z - ax.x*s, oc*ax.z*ax.z + c); }`)
          .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          float age = uTime - aT.x; float G = 14.0;
          float tl = (aV.y + sqrt(aV.y * aV.y + 2.0 * G * max(aP0.y, 0.0))) / G;
          float ta = clamp(age, 0.0, tl);
          vec3 ax = vec3(fract(aT.z * 13.1) - 0.5, fract(aT.z * 7.7) - 0.5, fract(aT.z * 3.3) - 0.5) + 0.01;
          mat3 R = rotA(ax, aT.z * 20.0 + ta * aK.y);
          objectNormal = R * objectNormal;`)
          .replace('#include <begin_vertex>', `
          vec3 transformed = R * (position * aT.w);
          vec3 pp = aP0 + aV * ta + vec3(0.0, -0.5 * G * ta * ta, 0.0);
          if (age > tl) pp += vec3(aV.x, 0.0, aV.z) * 0.08 * min(age - tl, 1.0);
          transformed += pp;
          if (age < 0.0 || age > aT.y + 40.0) transformed = vec3(0.0, -1000.0, 0.0);
          vKind = aK.x; vHotA = exp(-max(age, 0.0) * 0.4);`);
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vKind; varying float vHotA;')
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            if (vKind > 0.5 && vKind < 1.5) totalEmissiveRadiance += vec3(3.0, 0.9, 0.15) * vHotA;
            if (vKind > 1.5) { totalEmissiveRadiance += vec3(1.0, 0.85, 0.6) * 0.18 * vHotA; }`);
      };
      const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; this.scene.add(mesh);
    }

    // shockwave rings
    this.ringMeshes = this.rings.map((rg) => {
      const m = new THREE.ShaderMaterial({
        uniforms: { uK: { value: 0 }, uCol: { value: new THREE.Color(...rg.color) }, uW: { value: rg.width } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uK; uniform vec3 uCol; uniform float uW; varying vec2 vUv;
          void main(){ float r = length(vUv - 0.5) * 2.0; float d = abs(r - uK); float a = smoothstep(uW, 0.0, d) * (1.0 - uK) * step(r, 1.0);
            gl_FragColor = vec4(uCol * a * 2.5, a); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
      mesh.rotation.x = -Math.PI / 2; mesh.position.copy(rg.pos).add(new THREE.Vector3(0, 2 + rg.height, 0));
      mesh.visible = false; mesh.renderOrder = 15;
      this.scene.add(mesh);
      return { mesh, m, rg };
    });

    // dynamic light pool
    this.pool = [];
    for (let i = 0; i < 5; i++) { const l = new THREE.PointLight(0xff8a3a, 0, 900, 2); this.scene.add(l); this.pool.push(l); }
  }

  // ---------- per frame ----------
  update(t, camera, fog, ambient) {
    this.uniforms.uTime.value = t;
    for (const m of this.spriteMats) {
      m.uniforms.fogColor.value.copy(fog.color); m.uniforms.fogDensity.value = fog.density;
      if (ambient) m.uniforms.uAmbient.value.copy(ambient);
    }
    for (const { mesh, m, rg } of this.ringMeshes) {
      const k = (t - rg.t) / rg.dur;
      mesh.visible = k > 0 && k < 1;
      if (mesh.visible) {
        const e = 1 - Math.pow(1 - k, 2.2);
        mesh.scale.setScalar(rg.radius * (0.05 + e));
        m.uniforms.uK.value = 0.98;
        m.uniforms.uW.value = rg.width;
        m.uniforms.uCol.value.setRGB(rg.color[0] * (1 - k), rg.color[1] * (1 - k), rg.color[2] * (1 - k));
      }
    }
    // choose the strongest active lights, weighted by distance to camera
    const act = [];
    for (const L of this.lights) {
      const a = t - L.t;
      if (a < 0 || a > L.dur) continue;
      const pos = L.follow ? L.follow(t) : L.pos;
      let I = L.intensity * (a < 0.05 ? a / 0.05 : 1) * Math.pow(1 - clamp((a - L.dur * (1 - L.fade)) / (L.dur * L.fade + 1e-3), 0, 1), 1.5);
      if (L.flicker) I *= 1 - L.flicker * 0.5 * (1 + Math.sin(t * 17 + L.t * 7) * Math.sin(t * 11.3 + L.t));
      const d = camera.position.distanceTo(pos);
      act.push({ L, I, pos, score: I / (d * d + 1e4) });
    }
    act.sort((a, b) => b.score - a.score);
    this.pool.forEach((l, i) => {
      const a = act[i];
      if (!a) { l.intensity = 0; return; }
      l.position.copy(a.pos); l.color.copy(a.L.color); l.intensity = a.I;
    });
  }
  shakeAt(t, camPos) {
    let s = 0;
    for (const sh of this.shakes) {
      const a = t - sh.t;
      if (a < 0 || a > sh.dur) continue;
      const d = camPos.distanceTo(sh.pos);
      s += sh.amp * Math.exp(-a * 3.5 / sh.dur) * (1 - a / sh.dur) * 400 / (d + 300);
    }
    return s;
  }
  flashAt(t) {
    let f = 0;
    for (const fl of this.flashes) { const a = t - fl.t; if (a >= 0 && a < fl.dur) f += fl.amt * (1 - a / fl.dur); }
    return f;
  }
}

// Solar beam: tapered additive cylinder with flowing plasma + impact glow.
export class Beam {
  constructor(scene) {
    this.uniforms = { uTime: { value: 0 }, uLen: { value: 100 }, uAmt: { value: 0 } };
    const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 32, true).translate(0, 0.5, 0).rotateX(Math.PI / 2); // along +Z, 0..1
    const mk = (radius, core) => new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uCore: { value: core } },
      vertexShader: `uniform float uLen; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ vUv = uv; vec3 p = position; float taper = mix(0.55, 1.0, smoothstep(0.0, 0.08, p.z)); p.xy *= taper;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `${GLSL_NOISE}
        uniform float uTime; uniform float uLen; uniform float uAmt; uniform float uCore; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){
          float rim = abs(dot(vN, vV));
          float flow = fbm3o(vec2(vUv.x * 6.0, vUv.y * uLen * 0.02 - uTime * 14.0));
          float body = pow(rim, uCore > 0.5 ? 0.6 : 2.2);
          vec3 c = uCore > 0.5 ? vec3(4.0, 3.4, 2.4) : mix(vec3(1.6, 0.4, 0.05), vec3(2.4, 1.2, 0.3), flow);
          float a = body * (0.45 + 0.55 * flow) * uAmt;
          gl_FragColor = vec4(c * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.outer = mk(1, 0); this.core = mk(1, 1);
    this.group = new THREE.Group(); this.group.add(this.outer, this.core);
    this.outer.renderOrder = 30; this.core.renderOrder = 31;
    this.group.visible = false;
    scene.add(this.group);
    const glowTexCanvas = document.createElement('canvas'); glowTexCanvas.width = glowTexCanvas.height = 128;
    const g2 = glowTexCanvas.getContext('2d'); const rg = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.25, 'rgba(255,220,160,0.6)'); rg.addColorStop(1, 'rgba(255,120,20,0)');
    g2.fillStyle = rg; g2.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(glowTexCanvas); tex.colorSpace = THREE.SRGBColorSpace;
    this.impact = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(3, 2, 1), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.impact.renderOrder = 32;
    scene.add(this.impact);
    this.light = new THREE.PointLight(0xffb060, 0, 1200, 2);
    scene.add(this.light);
  }
  set(t, from, to, amt) {
    this.uniforms.uTime.value = t;
    this.uniforms.uAmt.value = amt;
    const on = amt > 0.001;
    this.group.visible = on; this.impact.visible = on;
    this.light.intensity = on ? 5e5 * amt : 0;
    if (!on) return;
    const d = to.clone().sub(from); const L = d.length();
    this.group.position.copy(from);
    this.group.lookAt(to);
    const w = 1 + 0.08 * Math.sin(t * 40);
    this.outer.scale.set(7 * amt * w, 7 * amt * w, L);
    this.core.scale.set(3.2 * amt, 3.2 * amt, L);
    this.uniforms.uLen.value = L;
    this.impact.position.copy(to);
    this.impact.scale.setScalar(110 * amt * (0.9 + 0.2 * Math.sin(t * 30)));
    this.light.position.copy(to).lerp(from, 0.15);
  }
}
