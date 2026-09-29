// Night Tokyo: procedural blocks, window-lit towers, roads, traffic, street lamps, neon, expressway.
// All destruction is evaluated in shaders from per-instance (destroyTime, direction) attributes so the
// whole city is a pure function of time.
import * as THREE from 'three';
import { RNG, GLSL_NOISE, hash2 } from './util.js';
import { makeSignTexture, makeScreenTexture } from './textures.js';

export const LAYOUT = {
  P: 100, road: 11, avenueEvery: 6, avenueOffset: 3, avenueHalf: 19,
  nearR: 1500, cityR: 3600, shoreX: 1250,
  crossing: new THREE.Vector3(300, 0, 300),
  towerPos: new THREE.Vector3(440, 0, 440),
  expresswayZ: 600,
};

const isAvenue = (k) => ((k % LAYOUT.avenueEvery) + LAYOUT.avenueEvery) % LAYOUT.avenueEvery === LAYOUT.avenueOffset;
export const roadHalf = (k) => (isAvenue(k) ? LAYOUT.avenueHalf : LAYOUT.road);

// ---------------------------------------------------------------------------------------------
// Shared collapse GLSL. aParent = (baseX, baseZ, height, footprintRadius), aDestroy = (t, dirX, dirZ, style)
export const COLLAPSE_GLSL = /* glsl */`
uniform float uTime;
attribute vec4 aParent;
attribute vec4 aDestroy;
varying float vCollapse;
varying float vBurn;
vec3 collapseWorld(vec3 wp, float seed){
  vCollapse = 0.0; vBurn = 0.0;
  if (aDestroy.x <= 0.0) return wp;
  float age = uTime - aDestroy.x;
  if (age < 0.0) return wp;
  float H = max(aParent.z, 1.0);
  float dur = 2.2 + H / 55.0;
  float c = clamp(age / dur, 0.0, 1.0);
  vCollapse = c; vBurn = clamp(age / 1.5, 0.0, 1.0);
  vec3 base = vec3(aParent.x, 0.0, aParent.y);
  vec3 rel = wp - base;
  float hf = clamp(rel.y / H, 0.0, 1.2);
  vec2 dir = normalize(aDestroy.yz + 1e-4);
  float style = aDestroy.w;
  // initial shock: jolt away from the impact
  float jolt = smoothstep(0.0, 0.25, age) * (1.0 - c) * 0.02 * H;
  rel.xz += dir * jolt * hf;
  // crumple noise grows with collapse
  float n1 = h31(floor(wp * 0.11) + seed) - 0.5, n2 = h31(floor(wp * 0.13) + seed + 7.0) - 0.5;
  rel.xz += vec2(n1, n2) * c * (6.0 + 0.08 * H) * hf;
  rel.y += (n1 + n2) * c * 4.0 * hf;
  // tilt around the base, then sink (free fall-ish) into its own dust
  float tilt = (style > 1.5 ? 1.25 : 0.35 + 0.25 * fract(seed * 7.3)) * pow(c, 1.6);
  vec3 axis = normalize(vec3(-dir.y, 0.0, dir.x));
  float ct = cos(tilt), st = sin(tilt);
  rel = rel * ct + cross(axis, rel) * st + axis * dot(axis, rel) * (1.0 - ct);
  float sink = (style > 1.5 ? 0.35 : 0.88) * H * c * c;
  rel.y -= sink;
  return base + rel;
}
`;

function collapseMaterial(base, { windows = false, extraVertex = '', extraFrag = '' } = {}) {
  const m = base;
  m.userData.uniforms = { uTime: { value: 0 } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, m.userData.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL_NOISE}\n${COLLAPSE_GLSL}\nattribute vec4 aInfo; varying vec4 vInfo; varying vec3 vLocalP; varying vec3 vObjN; varying vec3 vWorldP;`)
      .replace('#include <project_vertex>', `
        vec4 wpos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpos = instanceMatrix * wpos;
        #endif
        wpos = modelMatrix * wpos;
        vec3 scl = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vLocalP = position * scl; vObjN = normal; vInfo = aInfo;
        wpos.xyz = collapseWorld(wpos.xyz, aInfo.x * 13.1);
        vWorldP = wpos.xyz;
        ${extraVertex}
        vec4 mvPosition = viewMatrix * wpos;
        gl_Position = projectionMatrix * mvPosition;`)
      .replace('#include <worldpos_vertex>', '')
      .replace('#include <shadowmap_vertex>', '');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_NOISE}\nuniform float uTime; varying float vCollapse; varying float vBurn; varying vec4 vInfo; varying vec3 vLocalP; varying vec3 vObjN; varying vec3 vWorldP;`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n if (vWorldP.y < -0.5) discard;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${extraFrag}`);
  };
  return m;
}

// Window grid: floors & bays in metres; anti-aliased to its average when sub-pixel.
const WINDOW_FRAG = /* glsl */`
{
  vec3 an = abs(vObjN);
  float seed = vInfo.x; float kind = vInfo.y; float litP = vInfo.z;
  if (an.y < 0.5) {
    vec2 fc = an.x > 0.5 ? vec2(vLocalP.z * sign(vObjN.x), vLocalP.y) : vec2(vLocalP.x * sign(vObjN.z) , vLocalP.y);
    float floorH = (kind < 0.5 ? 3.9 : (kind < 1.5 ? 3.1 : 3.5)) * mix(0.9, 1.15, fract(seed * 13.7));
    float bayW = (kind < 0.5 ? 1.8 : (kind < 1.5 ? 2.6 : 2.2)) * mix(0.8, 1.35, fract(seed * 7.3));
    vec2 cell = fc / vec2(bayW, floorH);
    vec2 id = floor(cell); vec2 f = fract(cell);
    float band = kind < 0.5 ? step(0.16, f.y) * step(f.y, 0.86) * step(0.04, f.x) : step(0.18, f.x) * step(f.x, 0.82) * step(0.22, f.y) * step(f.y, 0.8);
    float rnd = h21(id + seed * 17.3 + an.x * 91.0);
    float rnd2 = h21(id.yx * 1.7 + seed * 3.1);
    float lit = step(rnd, litP);
    if (kind < 0.5) lit = step(h21(vec2(id.y, seed * 5.0 + an.x)), litP) * step(0.08, h21(id + 3.0));
    // warm homes, cool offices, some colour
    vec3 wc = kind < 0.5 ? mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.95, 0.85), rnd2) :
              (kind < 1.5 ? mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.86, 0.65), rnd2) : mix(vec3(1.0, 0.8, 0.55), vec3(0.7, 0.85, 1.0), step(0.6, rnd2)));
    float bright = (0.12 + 0.95 * rnd2 * rnd2) * (kind < 0.5 ? 1.15 : 1.0);
    // street-level shopfronts
    float shop = step(fc.y, 4.2) * step(0.6, fc.y) * step(0.12, fract(fc.x / 7.0));
    vec3 shopC = mix(vec3(1.0, 0.85, 0.6), vec3(0.8, 0.9, 1.0), h21(vec2(floor(fc.x / 7.0), seed))) * 1.3;
    // power loss and fire once destroyed
    float dead = step(0.01, vCollapse);
    float flick = step(0.5, h21(vec2(floor(uTime * 12.0), seed))) ;
    lit *= 1.0 - dead * (flick * 0.5 + smoothstep(0.0, 0.25, vCollapse) * 0.5);
    float fire = dead * step(0.55, rnd) * (0.6 + 0.4 * sin(uTime * 13.0 + rnd * 40.0)) * vBurn;
    float blind = mix(0.55, 1.0, smoothstep(0.2, 0.9, f.y)) * mix(1.0, 0.35, step(0.8, rnd2) * step(f.y, 0.5));
    vec3 wem = band * (lit * wc * bright * blind + fire * vec3(3.0, 0.9, 0.15));
    wem += (1.0 - band) * wc * litP * 0.02 * (1.0 - dead); // faint spill on the wall
    wem += shop * shopC * (1.0 - dead);
    // anti-alias: collapse to average when the grid gets smaller than ~2px
    vec2 fw = fwidth(cell);
    float aa = smoothstep(0.55, 1.3, max(fw.x, fw.y));
    vec3 avg = (kind < 0.5 ? 0.2 : 0.13) * litP * wc * (0.45 + 1.1 * h21(vec2(floor(fc.y / 11.0), seed * 9.0 + floor(fc.x / 13.0)))) * (1.0 - dead * 0.9) + dead * vBurn * vec3(0.9, 0.25, 0.04) * 0.25;
    totalEmissiveRadiance += mix(wem, avg, aa) * vInfo.w;
    // glass darker/shinier than wall
    diffuseColor.rgb *= mix(1.0, 0.35, band * (1.0 - aa));
  } else {
    // rooftops: dim, with occasional warm spill
    diffuseColor.rgb *= 0.8;
  }
  // scorched after collapse
  diffuseColor.rgb *= 1.0 - vCollapse * 0.6;
}
`;

// ---------------------------------------------------------------------------------------------
export class City {
  constructor(scene) {
    this.scene = scene;
    this.rng = new RNG(1234);
    this.buildings = []; // {x,z,w,d,h,kind,near,inst}
    this.collapsers = []; // materials with uTime
    this.group = new THREE.Group();
    scene.add(this.group);
    this.generateLots();
    this.makeBuildings();
    this.makeGround();
    this.makeFarLights();
    this.makeLamps();
    this.makeTraffic();
    this.makeExpressway();
    this.makeSigns();
    this.makeRubble();
  }

  // ---- layout ----
  generateLots() {
    const { P } = LAYOUT;
    const rng = this.rng;
    const K = Math.ceil(LAYOUT.cityR / P);
    const T = LAYOUT.towerPos;
    for (let i = -K; i < K; i++) for (let j = -K; j < K; j++) {
      const x0 = i * P + roadHalf(i) + 3, x1 = (i + 1) * P - roadHalf(i + 1) - 3;
      const z0 = j * P + roadHalf(j) + 3, z1 = (j + 1) * P - roadHalf(j + 1) - 3;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const r = Math.hypot(cx, cz);
      if (r > LAYOUT.cityR) continue;
      if (x1 > LAYOUT.shoreX - 20) continue; // bay
      // Shiba park around Tokyo Tower
      if (Math.abs(cx - T.x) < 140 && Math.abs(cz - T.z) < 140) { this.parkBlock = this.parkBlock || []; this.parkBlock.push([x0, x1, z0, z1]); continue; }
      const near = r < LAYOUT.nearR;
      // subdivide the block
      const splitsX = rng.pick([1, 2, 2, 3]), splitsZ = rng.pick([1, 2, 2, 3]);
      const wx = (x1 - x0) / splitsX, wz = (z1 - z0) / splitsZ;
      // tall cluster weighting: west (Shinjuku-like far skyline), and a mid-rise core near the action
      const west = cx < -1800 ? 1 : 0;
      for (let a = 0; a < splitsX; a++) for (let b = 0; b < splitsZ; b++) {
        if (rng.chance(0.08)) continue; // parking lot / gap
        const inset = rng.range(1.5, 4);
        const w = wx - inset * 2, d = wz - inset * 2;
        if (w < 8 || d < 8) continue;
        const bx = x0 + wx * (a + 0.5), bz = z0 + wz * (b + 0.5);
        let h;
        const u = rng.next();
        if (u < 0.55) h = rng.range(12, 38);
        else if (u < 0.85) h = rng.range(35, 75);
        else if (u < 0.96) h = rng.range(70, 130);
        else h = rng.range(130, 210);
        if (west) h *= rng.range(1.2, 2.2);
        if (r > 2500) h *= 0.75;
        // battle zone: keep the skyline below the kaiju so they dominate the frame
        const dz = Math.hypot(bx - 165, bz - 165);
        if (dz < 750) h = Math.min(h, 38 + dz * 0.09 + rng.range(0, 12));
        const kind = h > 90 ? 0 : rng.pick([0, 1, 1, 2, 2, 3]);
        this.buildings.push({ x: bx, z: bz, w, d, h, kind, near, seed: rng.next(), litP: rng.range(0.25, 0.75) });
      }
    }
  }

  makeBuildings() {
    const near = this.buildings.filter((b) => b.near), far = this.buildings.filter((b) => !b.near);
    const mat = () => collapseMaterial(new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 0.7, metalness: 0.15, emissive: 0x000000 }), { extraFrag: WINDOW_FRAG });
    const geoNear = new THREE.BoxGeometry(1, 1, 1, 3, 12, 3).translate(0, 0.5, 0);
    const geoFar = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const tint = [new THREE.Color(0x7d8894), new THREE.Color(0x8a8378), new THREE.Color(0x6f6a66), new THREE.Color(0x9a9690), new THREE.Color(0x5c6470)];
    const make = (list, geo, name) => {
      // tall buildings get a setback crown: extra instance
      const parts = [];
      for (const b of list) {
        parts.push({ b, x: b.x, z: b.z, w: b.w, d: b.d, y: 0, h: b.h });
        if (b.h > 80 && b.w > 20 && b.d > 20 && hash2(b.x | 0, b.z | 0) < 0.6) {
          const k = 0.62;
          parts[parts.length - 1].h = b.h * 0.78;
          parts.push({ b, x: b.x, z: b.z, w: b.w * k, d: b.d * k, y: b.h * 0.78, h: b.h * 0.22 });
        }
      }
      const m = mat();
      const im = new THREE.InstancedMesh(geo, m, parts.length);
      im.name = name;
      const aParent = new Float32Array(parts.length * 4), aDestroy = new Float32Array(parts.length * 4), aInfo = new Float32Array(parts.length * 4);
      const mtx = new THREE.Matrix4(); const col = new THREE.Color();
      parts.forEach((p, i) => {
        mtx.makeScale(p.w, p.h, p.d).setPosition(p.x, p.y, p.z);
        im.setMatrixAt(i, mtx);
        col.copy(tint[Math.floor(p.b.seed * tint.length)]).multiplyScalar(0.8 + p.b.seed * 0.4);
        im.setColorAt(i, col);
        aParent.set([p.b.x, p.b.z, p.b.h, Math.max(p.b.w, p.b.d) / 2], i * 4);
        aInfo.set([p.b.seed, p.b.kind === 3 ? 1 : p.b.kind, p.b.kind === 3 ? p.b.litP * 0.5 : p.b.litP, 1], i * 4);
        (p.b.inst = p.b.inst || []).push({ mesh: im, i });
      });
      geo = geo.clone();
      im.geometry = geo;
      geo.setAttribute('aParent', new THREE.InstancedBufferAttribute(aParent, 4));
      geo.setAttribute('aDestroy', new THREE.InstancedBufferAttribute(aDestroy, 4));
      geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 4));
      im.frustumCulled = false;
      this.group.add(im);
      this.collapsers.push(m);
      return im;
    };
    this.nearMesh = make(near, geoNear, 'buildingsNear');
    this.farMesh = make(far, geoFar, 'buildingsFar');
    // rooftop clutter + aviation lights for near buildings
    const props = [], blink = [];
    const rng = new RNG(99);
    for (const b of near) {
      const n = b.w * b.d > 900 ? rng.int(1, 4) : rng.int(0, 2);
      for (let k = 0; k < n; k++) {
        const w = rng.range(3, Math.min(10, b.w * 0.4)), d = rng.range(3, Math.min(10, b.d * 0.4)), h = rng.range(2, 6);
        props.push({ b, x: b.x + rng.range(-0.3, 0.3) * b.w, z: b.z + rng.range(-0.3, 0.3) * b.d, y: b.h, w, d, h });
      }
      if (b.h > 60) {
        props.push({ b, x: b.x, z: b.z, y: b.h, w: 1.2, d: 1.2, h: rng.range(8, 22) });
        blink.push({ b, x: b.x, z: b.z, y: b.h + props[props.length - 1].h });
        if (b.h > 100) for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) blink.push({ b, x: b.x + sx * b.w * 0.45, z: b.z + sz * b.d * 0.45, y: b.h + 0.5 });
      }
    }
    {
      const m = collapseMaterial(new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 0.8 }));
      const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const im = new THREE.InstancedMesh(geo, m, props.length);
      const aParent = new Float32Array(props.length * 4), aDestroy = new Float32Array(props.length * 4), aInfo = new Float32Array(props.length * 4);
      const mtx = new THREE.Matrix4();
      props.forEach((p, i) => {
        mtx.makeScale(p.w, p.h, p.d).setPosition(p.x, p.y, p.z); im.setMatrixAt(i, mtx);
        aParent.set([p.b.x, p.b.z, p.b.h, 1], i * 4); aInfo.set([p.b.seed, 0, 0, 0], i * 4);
        (p.b.inst = p.b.inst || []).push({ mesh: im, i });
      });
      geo.setAttribute('aParent', new THREE.InstancedBufferAttribute(aParent, 4));
      geo.setAttribute('aDestroy', new THREE.InstancedBufferAttribute(aDestroy, 4));
      geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 4));
      im.frustumCulled = false; this.group.add(im); this.collapsers.push(m); this.propMesh = im;
    }
    {
      const m = collapseMaterial(new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.2, 0.1) }), {});
      m.onBeforeCompile = ((orig) => (sh) => {
        orig(sh);
        sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
          float bl = step(0.55, fract(uTime * 0.75)); diffuseColor.rgb *= mix(0.08, 1.0, bl) * (1.0 - step(0.01, vCollapse));`);
      })(m.onBeforeCompile);
      const geo = new THREE.SphereGeometry(1.1, 6, 4);
      const im = new THREE.InstancedMesh(geo, m, blink.length);
      const aParent = new Float32Array(blink.length * 4), aDestroy = new Float32Array(blink.length * 4), aInfo = new Float32Array(blink.length * 4);
      const mtx = new THREE.Matrix4();
      blink.forEach((p, i) => {
        mtx.makeTranslation(p.x, p.y, p.z); im.setMatrixAt(i, mtx);
        aParent.set([p.b.x, p.b.z, p.b.h, 1], i * 4); aInfo.set([p.b.seed, 0, 0, 0], i * 4);
        (p.b.inst = p.b.inst || []).push({ mesh: im, i });
      });
      geo.setAttribute('aParent', new THREE.InstancedBufferAttribute(aParent, 4));
      geo.setAttribute('aDestroy', new THREE.InstancedBufferAttribute(aDestroy, 4));
      geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 4));
      im.frustumCulled = false; this.group.add(im); this.collapsers.push(m);
    }
  }

  // Ground: roads, markings, crossings, sidewalks and street-light pools, all procedural.
  makeGround() {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.0 });
    this.groundUniforms = {
      uTime: { value: 0 },
      uSlam: { value: new THREE.Vector4(0, 0, -100, 0) }, // x,z,time,radius scale
      uScorchA: { value: new THREE.Vector4(0, 0, 0, 0) }, // beam path start (x,z) end (x,z)
      uScorchT: { value: new THREE.Vector2(-100, -100) },
      uFall: { value: new THREE.Vector4(0, 0, 0, 0) }, // tower impact line
      uFallT: { value: -100 },
      uShore: { value: LAYOUT.shoreX },
    };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.groundUniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${GLSL_NOISE}
        varying vec3 vGW; uniform float uTime; uniform vec4 uSlam; uniform vec4 uScorchA; uniform vec2 uScorchT; uniform vec4 uFall; uniform float uFallT; uniform float uShore;
        float roadHalf(float k){ float m = mod(k - ${LAYOUT.avenueOffset}.0, ${LAYOUT.avenueEvery}.0); return m < 0.5 ? ${LAYOUT.avenueHalf}.0 : ${LAYOUT.road}.0; }
        float segDist(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
        vec2 vor(vec2 x){ vec2 n = floor(x), f = fract(x); float md = 8.0, md2 = 8.0; for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g = vec2(float(i), float(j)); vec2 o = h22(n + g); vec2 r = g + o - f; float d = dot(r, r); if(d < md){ md2 = md; md = d; } else if (d < md2) md2 = d; } return vec2(sqrt(md), sqrt(md2)); }
      `).replace('#include <color_fragment>', `#include <color_fragment>
        vec2 p = vGW.xz;
        const float P = ${LAYOUT.P}.0;
        vec2 k = floor((p + P * 0.5) / P);
        vec2 lc = p - k * P; // local to nearest road centre line
        float hx = roadHalf(k.x), hz = roadHalf(k.y);
        float onX = step(abs(lc.x), hx), onZ = step(abs(lc.y), hz);
        float road = max(onX, onZ);
        float side = max(step(abs(lc.x), hx + 3.0), step(abs(lc.y), hz + 3.0)) * (1.0 - road);
        vec3 asphalt = vec3(0.075, 0.078, 0.085) * (0.8 + 0.4 * fbm3o(p * 0.15));
        vec3 block = vec3(0.14, 0.14, 0.135) * (0.8 + 0.4 * vn2(p * 0.05));
        vec3 col = mix(block, asphalt, road);
        col = mix(col, vec3(0.22, 0.21, 0.2), side);
        float mark = 0.0;
        // lane dashes along X-roads (running along z) and Z-roads
        float inter = onX * onZ;
        float lanesX = onX * (1.0 - inter) * step(abs(fract(lc.x / 5.5 + 0.5) - 0.5) * 5.5, 0.15) * step(fract(p.y / 12.0), 0.5) * step(1.0, abs(lc.x));
        float lanesZ = onZ * (1.0 - inter) * step(abs(fract(lc.y / 5.5 + 0.5) - 0.5) * 5.5, 0.15) * step(fract(p.x / 12.0), 0.5) * step(1.0, abs(lc.y));
        float centre = (onX * (1.0 - inter) * step(abs(abs(lc.x) - 0.35), 0.12)) + (onZ * (1.0 - inter) * step(abs(abs(lc.y) - 0.35), 0.12));
        // zebra crossings at intersection edges
        float zx = onX * step(hz, abs(lc.y)) * step(abs(lc.y), hz + 5.0) * step(0.5, fract(lc.x / 1.6));
        float zz = onZ * step(hx, abs(lc.x)) * step(abs(lc.x), hx + 5.0) * step(0.5, fract(lc.y / 1.6));
        // scramble crossing diagonals
        vec2 cr = p - vec2(${LAYOUT.crossing.x.toFixed(1)}, ${LAYOUT.crossing.z.toFixed(1)});
        float scr = inter * step(length(cr), 40.0) * (step(abs(cr.x - cr.y), 3.0) + step(abs(cr.x + cr.y), 3.0)) * step(0.5, fract((cr.x + cr.y) / 1.6));
        mark = clamp(lanesX + lanesZ + zx + zz + scr, 0.0, 1.0);
        col = mix(col, vec3(0.55, 0.55, 0.52), mark * 0.8);
        col = mix(col, vec3(0.6, 0.45, 0.1), centre * 0.7);
        // bay water
        float water = step(uShore, p.x);
        col = mix(col, vec3(0.01, 0.015, 0.03), water);
        diffuseColor.rgb = col;
      `).replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(mix(0.8, 0.35, road), 0.08, water);
      `).replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // street-light pools along every road edge
        float lx = mod(p.y, 30.0) - 15.0, lz = mod(p.x, 30.0) - 15.0;
        float dX = abs(abs(lc.x) - hx + 1.0), dZ = abs(abs(lc.y) - hz + 1.0);
        float poolX = exp(-(dX * dX + lx * lx) / 140.0) * step(abs(lc.x), hx + 6.0);
        float poolZ = exp(-(dZ * dZ + lz * lz) / 140.0) * step(abs(lc.y), hz + 6.0);
        float pool = max(poolX, poolZ) * (1.0 - water);
        vec3 lampC = mix(vec3(1.0, 0.78, 0.5), vec3(0.85, 0.9, 1.0), step(0.5, h21(k)));
        totalEmissiveRadiance += lampC * pool * 0.12;
        totalEmissiveRadiance += vec3(0.9, 0.85, 0.7) * mark * pool * 0.25;
        // shop light spill on sidewalks
        totalEmissiveRadiance += vec3(1.0, 0.8, 0.55) * side * 0.05 * (0.5 + vn2(p * 0.2));
        // --- scars of battle ---
        float sA = uTime - uSlam.z;
        if (sA > 0.0) {
          vec2 d = p - uSlam.xy; float r = length(d);
          float R = min(sA * 170.0, 330.0) * uSlam.w;
          vec2 vv = vor(vec2(atan(d.y, d.x) * 7.0, r * 0.045));
          float crack = smoothstep(0.08, 0.0, vv.y - vv.x) * step(r, R) * smoothstep(R, R * 0.2, r);
          float heat = exp(-sA * 0.12) * 0.8 + 0.2;
          totalEmissiveRadiance += vec3(3.5, 0.8, 0.12) * crack * heat * (0.7 + 0.3 * sin(uTime * 7.0 + r * 0.1));
          diffuseColor.rgb *= 1.0 - 0.7 * step(r, R) * smoothstep(R * 1.1, 0.0, r);
        }
        float bA = uTime - uScorchT.x;
        if (bA > 0.0) {
          float prog = clamp(bA / max(uScorchT.y, 0.01), 0.0, 1.0);
          vec2 A = uScorchA.xy, B = mix(uScorchA.xy, uScorchA.zw, prog);
          float dd = segDist(p, A, B);
          float trench = smoothstep(14.0, 0.0, dd + (vn2(p * 0.15) - 0.5) * 8.0);
          totalEmissiveRadiance += vec3(4.0, 1.1, 0.2) * trench * (0.35 + 0.65 * exp(-bA * 0.25)) * (0.75 + 0.25 * sin(uTime * 9.0 + p.x * 0.3));
          diffuseColor.rgb *= 1.0 - smoothstep(40.0, 0.0, dd) * 0.8;
        }
        float fA = uTime - uFallT;
        if (fA > 0.0) {
          float dd = segDist(p, uFall.xy, uFall.zw);
          diffuseColor.rgb *= 1.0 - smoothstep(35.0, 0.0, dd) * 0.8;
          totalEmissiveRadiance += vec3(3.0, 0.8, 0.15) * smoothstep(12.0, 0.0, dd + (vn2(p * 0.2) - 0.5) * 10.0) * exp(-fA * 0.2);
        }
      `);
    };
    const g = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), m);
    g.rotation.x = -Math.PI / 2;
    this.group.add(g);
    this.ground = g;
    // park (Shiba park) grass + trees
    if (this.parkBlock) {
      const trees = [];
      const rng = new RNG(5);
      for (const [x0, x1, z0, z1] of this.parkBlock) {
        const grass = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + 6, z1 - z0 + 6), new THREE.MeshStandardMaterial({ color: 0x0c140c, roughness: 1 }));
        grass.rotation.x = -Math.PI / 2; grass.position.set((x0 + x1) / 2, 0.15, (z0 + z1) / 2); this.group.add(grass);
        for (let k = 0; k < 60; k++) trees.push([rng.range(x0, x1), rng.range(z0, z1), rng.range(3, 5.5)]);
      }
      const tg = new THREE.IcosahedronGeometry(1, 1);
      const tm = new THREE.InstancedMesh(tg, new THREE.MeshStandardMaterial({ color: 0x1d3a1c, roughness: 1, flatShading: true }), trees.length);
      const mtx = new THREE.Matrix4();
      trees.forEach(([x, z, s], i) => { mtx.makeScale(s, s * 1.2, s).setPosition(x, s * 1.1, z); tm.setMatrixAt(i, mtx); });
      this.group.add(tm);
    }
  }

  // Beyond the modelled city: a carpet of lights to the horizon.
  makeFarLights() {
    const N = 60000, rng = new RNG(77);
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sz = new Float32Array(N);
    const palette = [[1, 0.75, 0.45], [1, 0.85, 0.65], [0.8, 0.88, 1], [1, 0.6, 0.3], [1, 1, 1]];
    let n = 0;
    while (n < N) {
      const a = rng.range(0, Math.PI * 2), r = LAYOUT.cityR * 0.9 + Math.pow(rng.next(), 0.7) * 9000;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (x > LAYOUT.shoreX && z > -2500 && z < 6000) continue;
      // cluster along grid lines like real streets
      const gx = Math.round(x / 120) * 120, gz = Math.round(z / 120) * 120;
      const px = rng.chance(0.5) ? gx + rng.range(-3, 3) : x, pz = rng.chance(0.5) ? z : gz + rng.range(-3, 3);
      pos.set([px, rng.range(0.5, rng.chance(0.1) ? 60 : 12), pz], n * 3);
      const c = rng.pick(palette), b = rng.range(0.5, 1.6);
      col.set([c[0] * b, c[1] * b, c[2] * b], n * 3);
      sz[n] = rng.range(1.5, 4.0);
      n++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sz, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 } },
      vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; varying float vFog; uniform float uTime; uniform float fogDensity;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          float d = -mv.z; gl_PointSize = clamp(size * 900.0 / d, 1.0, 6.0);
          float tw = 0.8 + 0.2 * sin(uTime * 3.0 + position.x * 0.37 + position.z * 0.11);
          vC = color * tw; vFog = 1.0 - exp(-pow(fogDensity * d * 0.55, 2.0)); }`,
      fragmentShader: `varying vec3 vC; varying float vFog; uniform vec3 fogColor;
        void main(){ vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.1, length(c)); gl_FragColor = vec4(mix(vC * 1.6, fogColor, vFog) * a, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.farLightMat = m;
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  makeLamps() {
    // street lamps near the action (poles + glowing heads)
    const rng = new RNG(8);
    const lamps = [];
    const R = 900, P = LAYOUT.P;
    for (let k = -Math.ceil(R / P); k <= Math.ceil(R / P); k++) {
      const h = roadHalf(k) + 1.5;
      for (let s = -R; s <= R; s += 30) {
        for (const sd of [-1, 1]) {
          const x1 = k * P + sd * h, z1 = s + 8;
          if (Math.hypot(x1, z1) < R && x1 < LAYOUT.shoreX) lamps.push([x1, z1, sd, 0]);
          const x2 = s + 8, z2 = k * P + sd * h;
          if (Math.hypot(x2, z2) < R && x2 < LAYOUT.shoreX) lamps.push([x2, z2, sd, 1]);
        }
      }
    }
    const pole = new THREE.CylinderGeometry(0.18, 0.25, 9, 5).translate(0, 4.5, 0);
    const head = new THREE.BoxGeometry(1.8, 0.35, 0.7).translate(0, 9.1, 0);
    const pm = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6, metalness: 0.5 }), lamps.length);
    const hm = new THREE.InstancedMesh(head, new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.2, 1.3) }), lamps.length);
    const m = new THREE.Matrix4();
    lamps.forEach(([x, z, sd, ax], i) => { m.makeRotationY(ax ? Math.PI / 2 : 0).setPosition(x, 0, z); pm.setMatrixAt(i, m); hm.setMatrixAt(i, m); });
    this.group.add(pm, hm);
    this.lampList = lamps;
  }

  // Cars as analytic light pairs moving along roads; they stop in panic once the attack begins.
  makeTraffic() {
    const rng = new RNG(31);
    const cars = [];
    const R = 1400, P = LAYOUT.P;
    for (let k = -Math.ceil(R / P); k <= Math.ceil(R / P); k++) {
      const hw = roadHalf(k);
      const lanes = hw > 15 ? 3 : 1;
      for (const axis of [0, 1]) for (const dir of [-1, 1]) for (let l = 0; l < lanes; l++) {
        const n = Math.floor(rng.range(10, 22) * (lanes > 1 ? 1.4 : 1));
        const lane = dir * (2.2 + l * 3.4);
        for (let c = 0; c < n; c++) cars.push({ axis, k, lane, dir, off: rng.range(-R, R), speed: rng.range(8, 16), seed: rng.next() });
      }
    }
    const N = cars.length;
    const box = new THREE.BoxGeometry(1.9, 1.5, 4.4).translate(0, 0.75, 0);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = box.index; ig.attributes.position = box.attributes.position; ig.attributes.normal = box.attributes.normal;
    const aCar = new Float32Array(N * 4), aCar2 = new Float32Array(N * 4);
    cars.forEach((c, i) => { aCar.set([c.axis, c.k * P + c.lane, c.dir, c.off], i * 4); aCar2.set([c.speed, c.seed, 0, 0], i * 4); });
    ig.setAttribute('aCar', new THREE.InstancedBufferAttribute(aCar, 4));
    ig.setAttribute('aCar2', new THREE.InstancedBufferAttribute(aCar2, 4));
    ig.instanceCount = N;
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uStop: { value: 10.5 }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, uR: { value: R } },
      vertexShader: /* glsl */`
        attribute vec4 aCar; attribute vec4 aCar2; uniform float uTime; uniform float uStop; uniform float uR; uniform float fogDensity;
        varying vec3 vCol; varying float vFog; varying vec3 vN; varying vec3 vLp;
        void main(){
          float t = uTime; float ts = uStop + aCar2.y * 2.0;
          float s = aCar.w + aCar.z * aCar2.x * (min(t, ts) + 1.8 * (1.0 - exp(-max(t - ts, 0.0) / 1.8)));
          s = mod(s + uR, 2.0 * uR) - uR;
          vec3 p = position; vLp = position;
          vec3 wp;
          if (aCar.x < 0.5) { if (aCar.z < 0.0) p.z = -p.z; wp = vec3(aCar.y, 0.0, s) + p; }
          else { vec3 q = vec3(p.z, p.y, -p.x); if (aCar.z < 0.0) q.x = -q.x; wp = vec3(s, 0.0, aCar.y) + q; }
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          vN = normal;
          vec3 body = mix(vec3(0.05), vec3(0.25, 0.25, 0.28), aCar2.y);
          vCol = body;
          float d = -mv.z; vFog = 1.0 - exp(-pow(fogDensity * d * 0.55, 2.0));
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol; varying float vFog; varying vec3 vN; varying vec3 vLp; uniform vec3 fogColor;
        void main(){
          vec3 c = vCol * (0.4 + 0.6 * max(vN.y, 0.0));
          // headlights at +z face, tail lights at -z face
          float lamp = step(0.55, vLp.y) * step(vLp.y, 1.0) * step(0.45, abs(vLp.x));
          if (vN.z > 0.5) c += vec3(6.0, 5.6, 4.8) * lamp;
          if (vN.z < -0.5) c += vec3(5.0, 0.15, 0.1) * lamp;
          gl_FragColor = vec4(mix(c, fogColor, vFog), 1.0);
        }`,
    });
    const mesh = new THREE.Mesh(ig, m);
    mesh.frustumCulled = false;
    this.trafficMat = m;
    this.group.add(mesh);
  }

  // Elevated Shuto expressway crossing the city east-west (destructible deck segments).
  makeExpressway() {
    const Z = LAYOUT.expresswayZ, y = 17, segL = 40;
    const segs = [];
    for (let x = -2400; x < LAYOUT.shoreX + 400; x += segL) segs.push({ x: x + segL / 2, z: Z, w: segL, d: 24, h: 2.2, y });
    const m = collapseMaterial(new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.7 }), {
      extraFrag: `totalEmissiveRadiance += vec3(1.0, 0.7, 0.35) * 0.6 * step(abs(vObjN.z), 0.5) * step(0.5, vObjN.y) * 0.0;`,
    });
    const deck = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const pier = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const all = [];
    for (const s of segs) {
      s.inst = [];
      all.push({ s, x: s.x, z: s.z, y: s.y, w: s.w + 0.2, d: s.d, h: s.h, part: 0 });
      all.push({ s, x: s.x, z: s.z - s.d / 2 + 0.5, y: s.y + s.h, w: s.w, d: 1, h: 1.2, part: 1 });
      all.push({ s, x: s.x, z: s.z + s.d / 2 - 0.5, y: s.y + s.h, w: s.w, d: 1, h: 1.2, part: 1 });
      all.push({ s, x: s.x - s.w / 2 + 1.5, z: s.z, y: 0, w: 3, d: 8, h: s.y, part: 2 });
    }
    const im = new THREE.InstancedMesh(deck, m, all.length);
    const aParent = new Float32Array(all.length * 4), aDestroy = new Float32Array(all.length * 4), aInfo = new Float32Array(all.length * 4);
    const mtx = new THREE.Matrix4();
    all.forEach((p, i) => {
      mtx.makeScale(p.w, p.h, p.d).setPosition(p.x, p.y, p.z); im.setMatrixAt(i, mtx);
      aParent.set([p.s.x, p.s.z, p.s.y + 3, 20], i * 4); aInfo.set([hash2(i, 3), 0, 0, 0], i * 4);
      p.s.inst.push({ mesh: im, i });
    });
    deck.setAttribute('aParent', new THREE.InstancedBufferAttribute(aParent, 4));
    deck.setAttribute('aDestroy', new THREE.InstancedBufferAttribute(aDestroy, 4));
    deck.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 4));
    im.frustumCulled = false;
    this.group.add(im); this.collapsers.push(m);
    this.expressSegs = segs;
    // orange sodium lights along the barriers
    const lights = [];
    for (const s of segs) for (let k = 0; k < 2; k++) for (const sd of [-1, 1]) lights.push([s.x - s.w / 2 + k * 20 + 10, y + 5, Z + sd * 11.5, s]);
    const lm = collapseMaterial(new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.2, 0.8) }));
    const lg = new THREE.BoxGeometry(1.6, 0.4, 0.8);
    const li = new THREE.InstancedMesh(lg, lm, lights.length);
    const a2 = new Float32Array(lights.length * 4), d2 = new Float32Array(lights.length * 4), i2 = new Float32Array(lights.length * 4);
    lights.forEach(([x, yy, z, s], i) => { mtx.makeTranslation(x, yy, z); li.setMatrixAt(i, mtx); a2.set([s.x, s.z, s.y + 3, 20], i * 4); s.inst.push({ mesh: li, i }); });
    lg.setAttribute('aParent', new THREE.InstancedBufferAttribute(a2, 4));
    lg.setAttribute('aDestroy', new THREE.InstancedBufferAttribute(d2, 4));
    lg.setAttribute('aInfo', new THREE.InstancedBufferAttribute(i2, 4));
    li.frustumCulled = false; this.group.add(li); this.collapsers.push(lm);
    // lamp posts on the deck
    const pg = new THREE.CylinderGeometry(0.15, 0.15, 5, 4).translate(0, 2.5, 0);
    const pmI = collapseMaterial(new THREE.MeshStandardMaterial({ color: 0x444444 }));
    const pi = new THREE.InstancedMesh(pg, pmI, lights.length);
    lights.forEach(([x, yy, z, s], i) => { mtx.makeTranslation(x, y + 2.2, z); pi.setMatrixAt(i, mtx); s.inst.push({ mesh: pi, i }); });
    pg.setAttribute('aParent', new THREE.InstancedBufferAttribute(a2.slice(), 4));
    pg.setAttribute('aDestroy', new THREE.InstancedBufferAttribute(d2.slice(), 4));
    pg.setAttribute('aInfo', new THREE.InstancedBufferAttribute(i2.slice(), 4));
    pi.frustumCulled = false; this.group.add(pi); this.collapsers.push(pmI);
  }

  // Neon signs and giant screens around the scramble crossing.
  makeSigns() {
    const C = LAYOUT.crossing;
    const cand = this.buildings.filter((b) => b.near && Math.hypot(b.x - C.x, b.z - C.z) < 420 && b.h > 18);
    const rng = new RNG(4242);
    const texes = []; for (let i = 0; i < 12; i++) texes.push(makeSignTexture(i));
    const screens = [0, 1, 2].map((k) => makeScreenTexture(k));
    const planes = [];
    for (const b of cand) {
      // which faces look at a road? use all four, pick 1-3 signs
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        const face = rng.int(0, 3);
        const tex = texes[rng.int(0, 11)];
        const vertical = tex.vertical;
        const sw = vertical ? 3.2 : Math.min(16, b.w * 0.6), sh = vertical ? 13 : 4.5;
        const y = vertical ? rng.range(6, Math.min(b.h - sh / 2 - 1, 30)) : rng.range(5, Math.min(b.h - 3, 22));
        if (y < sh / 2 + 3) continue;
        planes.push({ b, face, tex: tex.tex, sw, sh, y, along: rng.range(-0.35, 0.35), vertical, jut: vertical ? 2.2 : 0.3 });
      }
    }
    // big screens: three buildings facing the crossing
    const byDist = cand.slice().sort((a, b) => Math.hypot(a.x - C.x, a.z - C.z) - Math.hypot(b.x - C.x, b.z - C.z));
    for (let i = 0; i < 3 && i < byDist.length; i++) {
      const b = byDist[i];
      const dx = C.x - b.x, dz = C.z - b.z;
      const face = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 0 : 1) : (dz > 0 ? 2 : 3);
      const sw = Math.min(26, (face < 2 ? b.d : b.w) * 0.85);
      planes.push({ b, face, tex: screens[i], sw, sh: sw * 0.5625, y: Math.min(b.h - sw * 0.3 - 2, 28), along: 0, vertical: false, jut: 0.4, screen: true });
    }
    this.signMeshes = [];
    const groups = new Map();
    for (const p of planes) { if (!groups.has(p.tex)) groups.set(p.tex, []); groups.get(p.tex).push(p); }
    const mtx = new THREE.Matrix4();
    for (const [tex, list] of groups) {
      const m = collapseMaterial(new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(list[0].screen ? 1.6 : 2.4, list[0].screen ? 1.6 : 2.4, list[0].screen ? 1.6 : 2.4), side: THREE.DoubleSide }));
      const geo = new THREE.PlaneGeometry(1, 1);
      const im = new THREE.InstancedMesh(geo, m, list.length);
      const aP = new Float32Array(list.length * 4), aD = new Float32Array(list.length * 4), aI = new Float32Array(list.length * 4);
      list.forEach((p, i) => {
        const b = p.b;
        const nrm = [[1, 0], [-1, 0], [0, 1], [0, -1]][p.face];
        const half = p.face < 2 ? b.w / 2 : b.d / 2;
        const tan = p.face < 2 ? [0, 1] : [1, 0];
        const span = p.face < 2 ? b.d : b.w;
        let x = b.x + nrm[0] * (half + p.jut) + tan[0] * p.along * span;
        let z = b.z + nrm[1] * (half + p.jut) + tan[1] * p.along * span;
        const rotY = Math.atan2(nrm[0], nrm[1]);
        let rot = rotY;
        if (p.vertical) rot = rotY + Math.PI / 2; // blade signs stick out perpendicular
        mtx.makeRotationY(rot).scale(new THREE.Vector3(p.sw, p.sh, 1)).setPosition(x, p.y, z);
        im.setMatrixAt(i, mtx);
        aP.set([b.x, b.z, b.h, 1], i * 4); aI.set([b.seed, 0, 0, 0], i * 4);
        (b.inst = b.inst || []).push({ mesh: im, i });
      });
      geo.setAttribute('aParent', new THREE.InstancedBufferAttribute(aP, 4));
      geo.setAttribute('aDestroy', new THREE.InstancedBufferAttribute(aD, 4));
      geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aI, 4));
      im.frustumCulled = false;
      this.group.add(im); this.collapsers.push(m); this.signMeshes.push(im);
    }
  }

  // Rubble mounds that rise where a building collapsed (inverse of the collapse curve).
  makeRubble() {
    const list = this.buildings.filter((b) => b.near);
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const n = 0.75 + 0.5 * hash2(Math.round(x * 50), Math.round(z * 50 + y * 30));
      pa.setXYZ(i, x * n, Math.max(y, -0.1) * n, z * n);
    }
    geo.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 0.95, flatShading: true });
    m.userData.uniforms = { uTime: { value: 0 } };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, m.userData.uniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\nuniform float uTime; attribute vec4 aDestroy; attribute vec4 aParent; varying float vHot; varying vec3 vRp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float age = uTime - aDestroy.x;
          float g = aDestroy.x > 0.0 ? smoothstep(0.3, 2.5 + aParent.z / 60.0, age) : 0.0;
          transformed.y *= g; transformed.xz *= mix(0.4, 1.0, g);
          vHot = aDestroy.x > 0.0 ? exp(-max(age, 0.0) * 0.05) : 0.0; vRp = position;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${GLSL_NOISE}\nuniform float uTime; varying float vHot; varying vec3 vRp;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float hs = step(0.72, vn3(vRp * 6.0 + 3.0)) * vHot;
          totalEmissiveRadiance += vec3(3.0, 0.7, 0.1) * hs * (0.6 + 0.4 * sin(uTime * 8.0 + vRp.x * 20.0));`);
    };
    const im = new THREE.InstancedMesh(geo, m, list.length);
    const aD = new Float32Array(list.length * 4), aP = new Float32Array(list.length * 4);
    const mtx = new THREE.Matrix4();
    list.forEach((b, i) => {
      const hh = Math.min(b.h * 0.18, 22) + 3;
      mtx.makeScale(b.w * 0.7, hh, b.d * 0.7).setPosition(b.x, 0, b.z);
      im.setMatrixAt(i, mtx);
      aP.set([b.x, b.z, b.h, 1], i * 4);
      b.rubble = { mesh: im, i };
    });
    geo.setAttribute('aDestroy', new THREE.InstancedBufferAttribute(aD, 4));
    geo.setAttribute('aParent', new THREE.InstancedBufferAttribute(aP, 4));
    im.frustumCulled = false;
    this.group.add(im); this.collapsers.push(m);
  }

  // ---- destruction API ----
  destroy(b, t, dirX, dirZ, style = 0) {
    if (b.destroyed !== undefined && b.destroyed <= t) return false;
    b.destroyed = t; b.dir = [dirX, dirZ]; b.style = style;
    const all = (b.inst || []).slice(); if (b.rubble) all.push(b.rubble);
    for (const { mesh, i } of all) {
      const a = mesh.geometry.attributes.aDestroy;
      a.setXYZW(i, t, dirX, dirZ, style); a.needsUpdate = true;
    }
    return true;
  }
  // buildings (near) whose footprint intersects a circle
  query(x, z, r) {
    const out = [];
    for (const b of this.buildings) {
      if (!b.near) continue;
      const dx = Math.max(Math.abs(x - b.x) - b.w / 2, 0), dz = Math.max(Math.abs(z - b.z) - b.d / 2, 0);
      if (dx * dx + dz * dz < r * r) out.push(b);
    }
    return out;
  }
  update(t, fog) {
    for (const m of this.collapsers) m.userData.uniforms.uTime.value = t;
    this.groundUniforms.uTime.value = t;
    for (const m of [this.farLightMat, this.trafficMat]) {
      m.uniforms.uTime.value = t;
      if (fog) { m.uniforms.fogColor.value.copy(fog.color); m.uniforms.fogDensity.value = fog.density; }
    }
  }
}
