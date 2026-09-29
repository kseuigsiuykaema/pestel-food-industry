// Deterministic helpers shared by every module (seeded RNG, easing, keyframe tracks).
import * as THREE from 'three';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed) { this.r = mulberry32(seed); }
  next() { return this.r(); }
  range(a, b) { return a + (b - a) * this.r(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.r() * arr.length)]; }
  chance(p) { return this.r() < p; }
  sign() { return this.r() < 0.5 ? -1 : 1; }
  gauss() { let u = 0, v = 0; while (u === 0) u = this.r(); v = this.r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
}

export function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Tileable value noise (period p) for texture synthesis.
export function vnoise(x, y, p) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const m = (a) => ((a % p) + p) % p;
  const a = hash2(m(xi), m(yi)), b = hash2(m(xi + 1), m(yi));
  const c = hash2(m(xi), m(yi + 1)), d = hash2(m(xi + 1), m(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, p, oct = 5) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, y * f, p * f); amp *= 0.5; f *= 2; }
  return s;
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const smoother = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sstep = (a, b, x) => smooth((x - a) / (b - a));
export const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeIn = (t) => Math.pow(clamp(t, 0, 1), 3);
export const pulse = (t, a, b, fadeIn, fadeOut) => sstep(a - fadeIn, a, t) * (1 - sstep(b, b + fadeOut, t));

// Keyframe track: [[time, value], ...] with smoothstep interpolation (value may be number or array).
export function track(keys, ease = smooth) {
  return function (t) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
      if (t <= t1) {
        const k = ease((t - t0) / (t1 - t0));
        if (Array.isArray(v0)) return v0.map((x, j) => x + (v1[j] - x) * k);
        return v0 + (v1 - v0) * k;
      }
    }
    return keys[keys.length - 1][1];
  };
}

// 1D smooth noise for camera shake / flicker.
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const a = hash2(i, seed) * 2 - 1, b = hash2(i + 1, seed) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Shared GLSL snippets.
export const GLSL_NOISE = /* glsl */`
float h11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vn2(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
float fbm2(vec2 p){ float s = 0., a = .5; for(int i=0;i<5;i++){ s += a*vn2(p); p = p*2.03 + 17.1; a *= .5; } return s; }
float fbm3o(vec2 p){ float s = 0., a = .5; for(int i=0;i<3;i++){ s += a*vn2(p); p = p*2.03 + 17.1; a *= .5; } return s; }
float h31(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vn3(vec3 p){ vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.-2.*f);
  return mix(mix(mix(h31(i), h31(i+vec3(1,0,0)), u.x), mix(h31(i+vec3(0,1,0)), h31(i+vec3(1,1,0)), u.x), u.y),
             mix(mix(h31(i+vec3(0,0,1)), h31(i+vec3(1,0,1)), u.x), mix(h31(i+vec3(0,1,1)), h31(i+vec3(1,1,1)), u.x), u.y), u.z); }
float fbm3(vec3 p){ float s = 0., a = .5; for(int i=0;i<4;i++){ s += a*vn3(p); p = p*2.02 + 11.7; a *= .5; } return s; }
`;
