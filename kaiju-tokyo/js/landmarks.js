// Tokyo Tower (lattice, landmark lighting, breakable) and Tokyo Skytree (distant glowing spire).
import * as THREE from 'three';
import { GLSL_NOISE, clamp, easeIn } from './util.js';

const hwTower = (y) => {
  const k = [[0, 46], [20, 38], [45, 27], [90, 17], [125, 12.5], [150, 10.5], [223, 5.2], [250, 3.6], [333, 0.5]];
  for (let i = 0; i < k.length - 1; i++) if (y <= k[i + 1][0]) { const f = (y - k[i][0]) / (k[i + 1][0] - k[i][0]); return k[i][1] + (k[i + 1][1] - k[i][1]) * f; }
  return 0.5;
};

export class TokyoTower {
  constructor(scene, pos, fallDir) {
    this.pos = pos.clone();
    this.fallDir = fallDir.clone().normalize();
    this.breakY = 98;
    this.root = new THREE.Group(); this.root.position.copy(pos); scene.add(this.root);
    this.lower = new THREE.Group(); this.root.add(this.lower);
    // upper part rotates about a pivot on the break line (toward the fall direction)
    const hb = hwTower(this.breakY);
    this.pivot = new THREE.Vector3(this.fallDir.x * hb, this.breakY, this.fallDir.z * hb);
    this.upperPivot = new THREE.Group(); this.upperPivot.position.copy(this.pivot); this.root.add(this.upperPivot);
    this.upper = new THREE.Group(); this.upper.position.copy(this.pivot).negate(); this.upperPivot.add(this.upper);
    this.axis = new THREE.Vector3(this.fallDir.z, 0, -this.fallDir.x).normalize();
    this.uniforms = { uGlow: { value: 1 }, uTime: { value: 0 } };
    this.fallT = 1e9;
    this.build();
  }
  bandColor(y) {
    const band = Math.floor(y / (333 / 11));
    return band % 2 === 0 ? new THREE.Color(1.0, 0.3, 0.04) : new THREE.Color(1.0, 0.92, 0.8);
  }
  build() {
    const beams = { lower: [], upper: [] };
    const push = (a, b, th) => {
      const y = (a.y + b.y) / 2;
      (y < this.breakY ? beams.lower : beams.upper).push({ a, b, th, c: this.bandColor(y) });
    };
    const corners = (y) => { const h = hwTower(y); return [[h, h], [-h, h], [-h, -h], [h, -h]].map(([x, z]) => new THREE.Vector3(x, y, z)); };
    const levels = []; for (let y = 0; y <= 250; y += y < 50 ? 6.25 : 10) levels.push(y);
    for (let i = 0; i < levels.length - 1; i++) {
      const y0 = levels[i], y1 = levels[i + 1];
      const c0 = corners(y0), c1 = corners(y1);
      const th = y0 < 60 ? 2.6 : y0 < 150 ? 1.7 : 1.1;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        push(c0[k], c1[k], th); // legs
        push(c0[k], c0[k2], th * 0.55); // ring
        push(c0[k], c1[k2], th * 0.35); // diagonals X
        push(c0[k2], c1[k], th * 0.35);
        // secondary lattice: mid-panel verticals
        const m0 = c0[k].clone().lerp(c0[k2], 0.5), m1 = c1[k].clone().lerp(c1[k2], 0.5);
        if (y0 < 150) push(m0, m1, th * 0.3);
        // legs split into twin members at the base (the arch feet)
        if (y0 < 40) { const off = c0[k].clone().multiplyScalar(0.12); off.y = 0; push(c0[k].clone().sub(off), c1[k].clone().sub(off), th * 0.8); }
      }
      // internal cross bracing
      if (i % 3 === 0) { push(c0[0], c0[2], th * 0.3); push(c0[1], c0[3], th * 0.3); }
    }
    // base arches
    for (let k = 0; k < 4; k++) {
      const a = corners(0)[k], b = corners(0)[(k + 1) % 4];
      const pts = []; for (let j = 0; j <= 10; j++) { const f = j / 10; const p = a.clone().lerp(b, f); p.y = 30 * Math.sin(Math.PI * f) * 0.9 + (1 - Math.sin(Math.PI * f)) * 0; pts.push(p); }
      for (let j = 0; j < 10; j++) push(pts[j], pts[j + 1], 1.8);
    }
    // antenna
    for (let y = 250; y < 333; y += 8) {
      const h0 = hwTower(y), h1 = hwTower(y + 8);
      for (let k = 0; k < 4; k++) {
        const ang = k * Math.PI / 2;
        const a = new THREE.Vector3(Math.cos(ang) * h0, y, Math.sin(ang) * h0), b = new THREE.Vector3(Math.cos(ang) * h1, y + 8, Math.sin(ang) * h1);
        push(a, b, 0.8);
      }
    }
    push(new THREE.Vector3(0, 300, 0), new THREE.Vector3(0, 336, 0), 0.6);

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vH;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vec4 ip = instanceMatrix * vec4(position, 1.0); vH = ip.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlow; varying float vH;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float flood = 0.55 + 0.9 * exp(-vH / 120.0) + 0.3 * smoothstep(200.0, 250.0, vH) * (1.0 - step(252.0, vH));
          totalEmissiveRadiance += vColor.rgb * vec3(1.0, 0.72, 0.42) * flood * 1.15 * uGlow;`);
    };
    const mk = (list, parent) => {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      list.forEach((bm, i) => {
        const d = bm.b.clone().sub(bm.a); const L = d.length();
        q.setFromUnitVectors(up, d.normalize());
        m.compose(bm.a.clone().lerp(bm.b, 0.5), q, new THREE.Vector3(bm.th, L + bm.th * 0.5, bm.th));
        im.setMatrixAt(i, m); im.setColorAt(i, bm.c);
      });
      im.frustumCulled = false;
      parent.add(im);
    };
    mk(beams.lower, this.lower); mk(beams.upper, this.upper);
    // decks: main observatory (145-150) and top deck (223-250)
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.6, emissive: 0xffffff, emissiveIntensity: 0 });
    deckMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vP; varying vec3 vNn;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = position; vNn = normal;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlow; varying vec3 vP; varying vec3 vNn;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float win = step(abs(vNn.y), 0.5) * step(0.2, fract(vP.y * 0.2 + 0.5)) * step(0.1, fract((vP.x + vP.z) * 0.5));
          totalEmissiveRadiance = vec3(1.4, 1.2, 0.95) * win * 1.6 * uGlow;`);
    };
    const deck = (y, h, hw, parent, rel) => {
      const g = new THREE.CylinderGeometry(hw * 1.45, hw * 1.45, h, 8, 1).translate(0, 0, 0);
      g.rotateY(Math.PI / 8);
      const m = new THREE.Mesh(g, deckMat); m.position.set(0, y + h / 2, 0); parent.add(m);
    };
    deck(140, 12, hwTower(146) + 3, this.upper);
    deck(223, 8, hwTower(226) + 1.5, this.upper);
    // Foot Town building
    const ft = new THREE.Mesh(new THREE.BoxGeometry(62, 18, 44).translate(0, 9, 0), deckMat); this.lower.add(ft);
    // aviation lights
    const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.3, 0.2) });
    this.aviation = [];
    for (const y of [150, 250, 336]) {
      const h = hwTower(y) * 1.1;
      for (const [x, z] of [[h, h], [-h, h], [h, -h], [-h, -h]]) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(y > 300 ? 1.3 : 1.6, 6, 4), lm); s.position.set(x * (y > 300 ? 0 : 1), y, z * (y > 300 ? 0 : 1));
        this.upper.add(s); this.aviation.push(s);
      }
    }
    this.aviationMat = lm;
    // floodlight glow on nearby ground
    this.light = new THREE.PointLight(0xff9a50, 3e4, 600, 2);
    this.light.position.set(0, 60, 0);
    this.root.add(this.light);
  }
  fallAngle(t) {
    const a = t - this.fallT;
    if (a <= 0) return 0;
    return Math.min(1.72, 1.72 * easeIn(a / 4.2) + 0.03 * a);
  }
  impactTime() { return this.fallT + 4.2; }
  update(t) {
    const ang = this.fallAngle(t);
    this.upperPivot.quaternion.setFromAxisAngle(this.axis, ang);
    const a = t - this.fallT;
    // lower stump bends slightly
    this.lower.quaternion.setFromAxisAngle(this.axis, a > 0 ? Math.min(0.08, a * 0.03) : 0);
    // lights fail after the break
    let glow = 1;
    if (a > 0) glow = a < 1.2 ? (Math.sin(a * 40) > 0 ? 0.9 : 0.25) : a < 4.2 ? 0.75 + 0.15 * Math.sin(a * 23) : Math.max(0.18, 0.75 - (a - 4.2) * 0.2);
    this.uniforms.uGlow.value = glow;
    this.uniforms.uTime.value = t;
    this.aviationMat.color.setRGB(Math.sin(t * 3) > 0 && a < 1 ? 6 : 0.4, 0.3, 0.2);
    this.light.intensity = 3e4 * glow;
  }
  // world point along the falling upper section (0 = break, 1 = tip)
  upperPoint(f, out = new THREE.Vector3()) {
    out.set(0, this.breakY + (333 - this.breakY) * f, 0);
    return this.upper.localToWorld(out);
  }
}

export class Skytree {
  constructor(scene, pos) {
    const g = new THREE.Group(); g.position.copy(pos); scene.add(g);
    const prof = [[0, 38], [60, 30], [340, 16], [350, 22], [365, 22], [375, 14], [445, 11], [452, 13], [460, 9], [495, 6], [634, 1.2]];
    const pts = prof.map(([y, r]) => new THREE.Vector2(r, y));
    const geo = new THREE.LatheGeometry(pts, 24);
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 } },
      vertexShader: `varying vec3 vP; varying float vD; void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vP; varying float vD; uniform float uTime; uniform vec3 fogColor; uniform float fogDensity;
        void main(){
          float a = atan(vP.z, vP.x);
          float lat = max(step(0.86, fract(a * 6.0 + vP.y * 0.05)), step(0.86, fract(a * 6.0 - vP.y * 0.05)));
          vec3 iki = vec3(0.35, 0.75, 1.3);
          vec3 c = mix(vec3(0.03, 0.05, 0.08), iki * 1.6, lat * 0.8 + 0.12);
          if (vP.y > 338.0 && vP.y < 378.0) c = vec3(1.2, 1.3, 1.6) * 1.6;
          if (vP.y > 443.0 && vP.y < 462.0) c = vec3(1.1, 1.2, 1.5) * 1.8;
          if (vP.y > 600.0) c = vec3(0.9, 0.95, 1.0) * (1.0 + step(0.5, fract(uTime * 0.6)) * 4.0);
          float f = 1.0 - exp(-pow(fogDensity * vD * 0.35, 2.0));
          gl_FragColor = vec4(mix(c, fogColor, f), 1.0);
        }`,
    });
    this.mat = m;
    g.add(new THREE.Mesh(geo, m));
  }
  update(t, fog) { this.mat.uniforms.uTime.value = t; if (fog) { this.mat.uniforms.fogColor.value.copy(fog.color); this.mat.uniforms.fogDensity.value = fog.density; } }
}
