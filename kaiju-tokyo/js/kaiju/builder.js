// Procedural creature construction kit.
// A creature is ONE SkinnedMesh (one draw call per material) driven by a programmatic skeleton.
// Every surface piece (body tubes, armor plates, spikes, claws, feathers, head) is generated in
// rest pose, weighted to its bones and merged into per-material buckets.
import * as THREE from 'three';
import { clamp } from '../util.js';

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();

export class Rig {
  constructor() {
    this.bones = []; this.byName = {}; this.restWorld = {}; this.index = {};
  }
  add(name, parent, pos) {
    const b = new THREE.Bone(); b.name = name;
    const p = pos.clone();
    if (parent) {
      b.position.copy(p).sub(this.restWorld[parent]);
      this.byName[parent].add(b);
    } else b.position.copy(p);
    this.index[name] = this.bones.length;
    this.bones.push(b); this.byName[name] = b; this.restWorld[name] = p;
    return b;
  }
  rest(name) { return this.restWorld[name].clone(); }
}

// A chain of bones used for smooth skin weighting and as a lofting spine.
export class Chain {
  constructor(rig, names, endPoint) {
    this.rig = rig; this.names = names;
    this.ids = names.map((n) => rig.index[n]);
    this.pts = names.map((n) => rig.rest(n));
    this.pts.push(endPoint.clone());
    this.curve = new THREE.CatmullRomCurve3(this.pts, false, 'centripetal', 0.5);
  }
  // Skin weights for a point: nearest segment, blended across joints.
  weights(p) {
    let best = 1e9, seg = 0, fr = 0;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i], b = this.pts[i + 1];
      const ab = _v.subVectors(b, a); const L2 = ab.lengthSq();
      let f = L2 > 0 ? (p.clone().sub(a).dot(ab)) / L2 : 0; f = clamp(f, 0, 1);
      const d = p.distanceToSquared(a.clone().addScaledVector(ab, f));
      if (d < best - 1e-9) { best = d; seg = i; fr = f; }
    }
    return this.blend(seg, fr);
  }
  weightsAtParam(t) {
    const n = this.pts.length - 1;
    let x = clamp(t, 0, 1) * n; let seg = Math.min(n - 1, Math.floor(x));
    return this.blend(seg, x - seg);
  }
  blend(seg, f) {
    const n = this.ids.length;
    const id = this.ids[seg];
    const B = 0.3;
    if (f < B && seg > 0) {
      const w = 0.5 + 0.5 * (f / B);
      return [[id, this.ids[seg - 1], 0, 0], [w, 1 - w, 0, 0]];
    }
    if (f > 1 - B && seg < n - 1) {
      const w = 0.5 + 0.5 * ((1 - f) / B);
      return [[id, this.ids[seg + 1], 0, 0], [w, 1 - w, 0, 0]];
    }
    return [[id, 0, 0, 0], [1, 0, 0, 0]];
  }
}

// ---------- geometry primitives (local space, indexed) ----------

function gridGeo(nu, nv, fn, closedU = false) {
  // fn(i/nu, j/nv) -> [x,y,z, u, v]
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const r = fn(i / nu, j / nv); pos.push(r[0], r[1], r[2]); uv.push(r[3] ?? i / nu, r[4] ?? j / nv);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (closedU) fixSeam(g, nu, nv);
  return g;
}
function fixSeam(g, nu, nv) {
  const n = g.attributes.normal;
  for (let j = 0; j <= nv; j++) {
    const a = j * (nu + 1), b = a + nu;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const L = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / L, y / L, z / L); n.setXYZ(b, x / L, y / L, z / L);
  }
}

/** Armor plate / shingle scale. Root at origin, grows along +Y, surface normal +Z. */
export function plateGeo(w, l, th, { curl = 0.25, keel = 0.25, tip = 'point', lift = 0.3, seg = 6 } = {}) {
  const width = (v) => {
    if (tip === 'round') return Math.pow(Math.sin(Math.PI * (0.25 + v * 0.75)), 0.6) * (1 - v * 0.2);
    if (tip === 'angular') return v < 0.55 ? 0.8 + v * 0.36 : Math.max(0, (1 - v) / 0.45);
    return Math.pow(Math.sin(Math.PI * Math.min(1, 0.15 + v * 0.95)), 0.7);
  };
  const top = gridGeo(seg, seg + 2, (u, v) => {
    const uu = u * 2 - 1;
    const hw = width(v) * w * 0.5;
    const x = uu * hw;
    const bow = (1 - uu * uu);
    const z = th * (Math.pow(bow, 0.6) * (0.35 + 0.65 * v) + keel * (1 - Math.abs(uu)) * v) - curl * uu * uu * w * 0.35 + lift * v * v * l * 0.15;
    return [x, v * l, z, u, v];
  });
  // under-skirt so the plate reads as a thick slab
  const skirt = gridGeo(seg * 2 + (seg + 2) * 2, 1, (u, v) => {
    // walk the outline: left edge up, right edge down
    const n = seg + 2; const t = u * 2; let uu, vv;
    if (t <= 1) { uu = -1; vv = t; } else { uu = 1; vv = 2 - t; }
    const hw = width(vv) * w * 0.5;
    const x = uu * hw;
    const z0 = -curl * w * 0.35 + lift * vv * vv * l * 0.15;
    return [x, vv * l, v === 0 ? z0 + th * 0.15 : z0 - th * 0.9, u, v];
  });
  return mergeLocal([top, skirt]);
}

/** Spike / blade with diamond cross-section. Base at origin, points along +Y; bends toward +Z. */
export function bladeGeo(len, w, th, { bend = 0.2, sideBend = 0, seg = 8, power = 0.9, serr = 0, wave = 0 } = {}) {
  const ring = 6;
  return gridGeo(ring, seg, (u, v) => {
    const a = u * Math.PI * 2;
    let r = Math.pow(1 - v, power);
    if (serr) r *= 1 - serr * Math.pow(Math.abs(Math.sin(v * Math.PI * 4)), 3);
    const cx = Math.cos(a), cz = Math.sin(a);
    const x = cx * w * 0.5 * r + sideBend * len * v * v + wave * Math.sin(v * Math.PI * 2) * w * 0.4;
    const z = cz * th * 0.5 * r + bend * len * v * v;
    return [x, v * len, z, u, v];
  }, true);
}

/** Flame feather: flat, wavy edged, glowing. Root at origin, along +Y, face normal +Z. */
export function flameGeo(len, w, { bend = 0.15, waves = 3, seed = 0, th = 0.03 } = {}) {
  const nu = 6, nv = 14;
  const prof = (v) => Math.pow(Math.sin(Math.PI * Math.pow(v, 0.55)), 0.9) * (1 - Math.pow(v, 3) * 0.2) * (1 - 0.28 * Math.pow(Math.abs(Math.sin(v * Math.PI * waves + seed)), 2.5));
  const sheet = (sgn) => gridGeo(nu, nv, (u, v) => {
    const uu = u * 2 - 1;
    const hw = prof(v) * w * 0.5 + 0.004;
    const sway = Math.sin(v * 3.2 + seed) * w * 0.25 * v;
    const x = uu * hw + sway;
    const z = sgn * th * (1 - uu * uu) * (1 - v) + bend * len * v * v - Math.abs(uu) * w * 0.08;
    return [x, v * len, z, u, v];
  });
  const a = sheet(1), b = sheet(-1);
  // flip winding of back sheet
  const ix = b.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i]; ix[i] = ix[i + 1]; ix[i + 1] = t; }
  b.computeVertexNormals();
  return mergeLocal([a, b]);
}

export function ellipsoidGeo(rx, ry, rz, ws = 16, hs = 12) {
  const g = new THREE.SphereGeometry(1, ws, hs); g.scale(rx, ry, rz); return g;
}

export function torusGeo(R, r, rs = 8, ts = 64, arc = Math.PI * 2) {
  return new THREE.TorusGeometry(R, r, rs, ts, arc);
}

/** Tapered tube along a curve (horns, fingers, toes). */
export function hornGeo(points, r0, r1, { radial = 8, seg = 12, power = 1 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points);
  const frames = curve.computeFrenetFrames(seg, false);
  return gridGeo(radial, seg, (u, v) => {
    const i = Math.round(v * seg);
    const p = curve.getPointAt(v);
    const N = frames.normals[i], B = frames.binormals[i];
    const r = r1 + (r0 - r1) * Math.pow(1 - v, power);
    const a = u * Math.PI * 2;
    return [p.x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r, p.y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r, p.z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r, u, v];
  }, true);
}

export function mergeLocal(geos) {
  let pos = [], nrm = [], uv = [], idx = [], off = 0;
  for (const g of geos) {
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i)); nrm.push(N.getX(i), N.getY(i), N.getZ(i));
      uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
    }
    if (g.index) for (const k of g.index.array) idx.push(k + off);
    else for (let i = 0; i < P.count; i++) idx.push(i + off);
    off += P.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Basis helper: build a matrix whose X,Y,Z axes are given (Y = growth, Z = face normal).
export function frameMatrix(origin, yAxis, zHint, scale = 1) {
  const Y = yAxis.clone().normalize();
  let Z = zHint.clone().addScaledVector(Y, -zHint.dot(Y));
  if (Z.lengthSq() < 1e-8) Z = Math.abs(Y.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(Y) : new THREE.Vector3(1, 0, 0).cross(Y);
  Z.normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  const m = new THREE.Matrix4().makeBasis(X, Y, Z);
  if (scale !== 1) m.scale(new THREE.Vector3(scale, scale, scale));
  m.setPosition(origin);
  return m;
}

// ---------- the builder ----------

export class SkinBuilder {
  constructor(rig) {
    this.rig = rig; this.buckets = {}; this.order = [];
  }
  bucket(key) {
    if (!this.buckets[key]) { this.buckets[key] = { pos: [], nrm: [], uv: [], col: [], si: [], sw: [], aux: [], idx: [] }; this.order.push(key); }
    return this.buckets[key];
  }
  /**
   * Append geometry already in rest-pose creature space.
   * weight: {chain} -> per-vertex (or per-piece via anchor) weights, or {bone:name} rigid.
   * color: [r,g,b] | (localPos, uv) => [r,g,b]; aux: number | fn -> custom float (glow / tip factor).
   */
  add(geo, key, { chain, bone, anchor, color = [1, 1, 1], aux = 0, uvScale = 1 } = {}) {
    const b = this.bucket(key);
    const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv;
    const base = b.pos.length / 3;
    let fixedW = null;
    if (bone) fixedW = [[this.rig.index[bone], 0, 0, 0], [1, 0, 0, 0]];
    else if (anchor && chain) fixedW = chain.weights(anchor);
    const p = new THREE.Vector3();
    const lp = geo.userData.localPos; // optional pre-transform positions for color fns
    for (let i = 0; i < P.count; i++) {
      p.set(P.getX(i), P.getY(i), P.getZ(i));
      b.pos.push(p.x, p.y, p.z); b.nrm.push(N.getX(i), N.getY(i), N.getZ(i));
      const u = U ? U.getX(i) : 0, v = U ? U.getY(i) : 0;
      b.uv.push(u * uvScale, v * uvScale);
      const c = typeof color === 'function' ? color(p, u, v, i) : color;
      b.col.push(c[0], c[1], c[2]);
      b.aux.push(typeof aux === 'function' ? aux(p, u, v) : aux);
      const w = fixedW || chain.weights(p);
      b.si.push(w[0][0], w[0][1], w[0][2], w[0][3]); b.sw.push(w[1][0], w[1][1], w[1][2], w[1][3]);
    }
    if (geo.index) for (const k of geo.index.array) b.idx.push(k + base);
    else for (let i = 0; i < P.count; i++) b.idx.push(i + base);
  }
  // transform local geometry by matrix and add
  addAt(geo, matrix, key, opts) {
    const g = geo.clone(); g.applyMatrix4(matrix); this.add(g, key, opts);
  }
  build(materials) {
    const pos = [], nrm = [], uv = [], col = [], si = [], sw = [], aux = [], idx = [];
    const groups = [], mats = [];
    let vOff = 0;
    for (const key of this.order) {
      const b = this.buckets[key];
      const start = idx.length;
      const cat = (dst, src) => { for (let i = 0; i < src.length; i++) dst.push(src[i]); };
      cat(pos, b.pos); cat(nrm, b.nrm); cat(uv, b.uv); cat(col, b.col); cat(si, b.si); cat(sw, b.sw); cat(aux, b.aux);
      for (const k of b.idx) idx.push(k + vOff);
      vOff += b.pos.length / 3;
      groups.push({ start, count: idx.length - start, materialIndex: mats.length });
      mats.push(materials[key]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aux', new THREE.Float32BufferAttribute(aux, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    for (const gr of groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.computeBoundingSphere();
    g.boundingSphere.radius *= 4; // animated poses reach far beyond rest bounds
    return { geometry: g, materials: mats, stats: { verts: pos.length / 3, tris: idx.length / 3 } };
  }
}

/**
 * Body tube lofted along a chain. radius(s) -> [side, front(+N), back(-N)].
 * refDir(s) -> reference vector defining +N for the cross-section.
 * Returns {geo, sample(s,a)} where sample gives surface point/normal/tangent for decoration.
 */
export function tubeAlong(chain, { radius, refDir, radial = 28, rings = 40, capStart = 0, capEnd = 0.6, bump = null, texScale = 1.2 }) {
  const curve = chain.curve;
  const frameAt = (s) => {
    const c = curve.getPoint(s);
    const T = curve.getTangent(Math.min(0.9999, Math.max(0.0001, s))).normalize();
    const r = refDir(s).clone();
    const N = r.addScaledVector(T, -r.dot(T)).normalize();
    const B = new THREE.Vector3().crossVectors(N, T).normalize();
    return { c, T, N, B };
  };
  const pointAt = (s, a, fr) => {
    const [rs, rf, rb] = radius(s);
    const ca = Math.cos(a), sa = Math.sin(a);
    const rn = sa >= 0 ? rf : rb;
    let k = 1; if (bump) k += bump(s, a);
    const p = fr.c.clone().addScaledVector(fr.B, rs * ca * k).addScaledVector(fr.N, rn * sa * k);
    const n = fr.B.clone().multiplyScalar(ca / Math.max(rs, 1e-3)).addScaledVector(fr.N, sa / Math.max(rn, 1e-3)).normalize();
    return { p, n, T: fr.T, r: (rs + rn) * 0.5 };
  };
  // arc length for v coordinate
  const lens = [0]; let L = 0, prev = curve.getPoint(0);
  for (let i = 1; i <= rings; i++) { const q = curve.getPoint(i / rings); L += q.distanceTo(prev); lens.push(L); prev = q; }
  const avgR = (() => { let s = 0; for (let i = 0; i <= 10; i++) { const r = radius(i / 10); s += (r[0] + (r[1] + r[2]) / 2) / 2; } return s / 11; })();
  const uRep = Math.max(1, Math.round((2 * Math.PI * avgR) / texScale));
  const capS = capStart ? 5 : 0, capE = capEnd ? 6 : 0;
  const totalRows = rings + capS + capE;
  const frames = []; for (let i = 0; i <= rings; i++) frames.push(frameAt(i / rings));
  const geo = gridGeo(radial, totalRows, (u, v) => {
    const row = Math.round(v * totalRows);
    const a = u * Math.PI * 2 - Math.PI * 0.5; // seam on the back (-N)
    if (row < capS) {
      const th = (1 - row / capS) * Math.PI * 0.5;
      const fr = frames[0]; const s0 = pointAt(0, a, fr);
      const rr = Math.cos(th);
      const p = fr.c.clone().lerp(s0.p, rr).addScaledVector(fr.T, -Math.sin(th) * s0.r * capStart);
      return [p.x, p.y, p.z, u * uRep, (-Math.sin(th) * s0.r) / texScale];
    }
    if (row > capS + rings) {
      const k = row - capS - rings;
      const th = (k / capE) * Math.PI * 0.5;
      const fr = frames[rings]; const s1 = pointAt(1, a, fr);
      const p = fr.c.clone().lerp(s1.p, Math.cos(th)).addScaledVector(fr.T, Math.sin(th) * s1.r * capEnd);
      return [p.x, p.y, p.z, u * uRep, (L + Math.sin(th) * s1.r) / texScale];
    }
    const i = row - capS;
    const sp = pointAt(i / rings, a, frames[i]);
    return [sp.p.x, sp.p.y, sp.p.z, u * uRep, lens[i] / texScale];
  }, true);
  const sample = (s, a) => pointAt(s, a, frameAt(s));
  return { geo, sample, length: L };
}

/**
 * Scatter armor plates over a tube surface in staggered rows.
 * dir: +1 plates point toward increasing s, -1 toward decreasing s.
 */
export function platesOnTube(sb, chain, tube, { key, s0 = 0, s1 = 1, rows = 10, per = 10, a0 = 0, a1 = Math.PI * 2, size, dir = 1, lift = 0.02, tilt = 0.25, rng, color, opts = {}, skip = null, aux = 0, wide = 1 }) {
  for (let r = 0; r < rows; r++) {
    const s = s0 + (s1 - s0) * ((r + 0.5) / rows);
    const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-3;
    for (let k = 0; k < per; k++) {
      const stagger = (r % 2) * 0.5;
      const a = a0 + (a1 - a0) * ((k + stagger + (full ? 0 : 0.5 - stagger)) / (full ? per : per + 0.5)) + (rng ? rng.range(-0.05, 0.05) : 0);
      if (skip && skip(s, a)) continue;
      const smp = tube.sample(s, a);
      const sz = size(s, a, smp.r) * (rng ? rng.range(0.88, 1.12) : 1);
      if (sz <= 0.001) continue;
      // true surface tangents (the tube radius varies, so the chain axis is not enough)
      const ds = 0.01, da = 0.02;
      const pS = tube.sample(Math.min(1, s + ds), a).p.sub(tube.sample(Math.max(0, s - ds), a).p);
      const pA = tube.sample(s, a + da).p.sub(tube.sample(s, a - da).p);
      const nrm = new THREE.Vector3().crossVectors(pA, pS).normalize();
      if (nrm.dot(smp.n) < 0) nrm.negate();
      smp.n.copy(nrm);
      const Y = pS.normalize().multiplyScalar(dir);
      Y.addScaledVector(smp.n, -Y.dot(smp.n)).normalize();
      // tilt tip away from body
      Y.addScaledVector(smp.n, tilt * 0.35).normalize();
      const geo = plateGeo(sz * 1.05 * wide, sz * 1.1, sz * 0.16, { lift: 0.1, ...opts });
      const m = frameMatrix(smp.p.clone().addScaledVector(smp.n, lift * sz - sz * 0.1).addScaledVector(Y, -sz * 0.45), Y, smp.n);
      sb.addAt(geo, m, key, { chain, anchor: smp.p, color, aux });
    }
  }
}

/**
 * Lofted head part along +Z. shape(s) -> {w, top, bot, yc}, theta range selects the part of the
 * cross-section (top skull vs palate). n = superellipse exponent.
 */
export function loftHead({ z0, z1, shape, radial = 30, seg = 40, n = 2.6, th0 = 0, th1 = Math.PI * 2, disp = null }) {
  const sp = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
  return gridGeo(radial, seg, (u, v) => {
    const s = v; const z = z0 + (z1 - z0) * s;
    const sh = shape(s);
    const th = th0 + (th1 - th0) * u;
    const c = Math.cos(th), si = Math.sin(th);
    let x = sh.w * sp(c, 2 / n);
    let y = sh.yc + (si >= 0 ? sh.top : sh.bot) * sp(si, 2 / n);
    let zz = z;
    if (disp) { const d = disp(s, th, x, y, z); x += d[0]; y += d[1]; zz += d[2]; }
    return [x, y, zz, u * 3, s * 3];
  }, Math.abs(th1 - th0 - Math.PI * 2) < 1e-4);
}
