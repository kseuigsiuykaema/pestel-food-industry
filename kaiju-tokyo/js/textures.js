// Procedural canvas textures: dragon scales, hammered gold, eyes, neon signage.
import * as THREE from 'three';
import { hash2, fbm, RNG, clamp } from './util.js';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function heightToNormal(hgt, W, H, strength) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const xl = (x - 1 + W) % W, xr = (x + 1) % W, yu = (y - 1 + H) % H, yd = (y + 1) % H;
      const dx = (hgt[y * W + xr] - hgt[y * W + xl]) * strength;
      const dy = (hgt[yd * W + x] - hgt[yu * W + x]) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * W + x) * 4;
      out[i] = (-dx / len * 0.5 + 0.5) * 255;
      out[i + 1] = (dy / len * 0.5 + 0.5) * 255;
      out[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function toTexture(data, W, H, srgb, repeat = true) {
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(data, W, H), 0, 0);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/**
 * Overlapping shingled reptile scales, seamlessly tiling.
 * Every pixel decides which scale is on top (upper rows overlap lower rows), then derives
 * height (for the normal map), crevice darkness (albedo/roughness) and a crevice glow mask.
 */
export function makeScaleSet({ size = 1024, cols = 10, rows = 18, base, edge, varAmt = 0.18, glowTint = [1, 0.45, 0.1], seed = 1, keel = 0.2 }) {
  const W = size, H = size;
  const sw = W / cols, rh = H / rows;
  const hgt = new Float32Array(W * H);
  const alb = new Uint8ClampedArray(W * H * 4);
  const rough = new Uint8ClampedArray(W * H * 4);
  const glow = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const yr = y / rh;
    const k0 = Math.floor(yr) - 2;
    for (let x = 0; x < W; x++) {
      let found = false, hv = 0, rid = 0, crev = 1, sid = 0;
      for (let k = k0; k <= k0 + 3 && !found; k++) {
        const cy = k * rh;
        const dy = y - cy;
        const top = -rh * 0.35, bot = rh * 1.75;
        if (dy < top || dy > bot) continue;
        const odd = ((k % 2) + 2) % 2;
        const ci = Math.round((x / sw) - 0.5 * odd);
        for (let i = ci - 1; i <= ci + 1; i++) {
          const kk = ((k % rows) + rows) % rows, ii = ((i % cols) + cols) % cols;
          const jitter = (hash2(ii * 7 + 3, kk * 13 + seed) - 0.5) * sw * 0.12;
          const cx = (i + 0.5 * odd) * sw + jitter;
          let dx = x - cx; dx = ((dx + W * 1.5) % W) - W * 0.5;
          const t = (dy - top) / (bot - top); // 0 at root, 1 at free edge
          const halfW = sw * 0.62 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.18 + t * 0.9)), 0.55) * (1 - Math.pow(t, 6) * 0.35);
          if (Math.abs(dx) < halfW) {
            const u = dx / halfW;
            const edgeD = Math.min((halfW - Math.abs(dx)) / (sw * 0.09), (bot - dy) / (rh * 0.18));
            const e = clamp(edgeD, 0, 1);
            hv = (0.25 + 0.75 * Math.pow(t, 0.8)) * Math.sqrt(Math.max(0, 1 - u * u * 0.85)) * (0.35 + 0.65 * Math.sqrt(e));
            hv += keel * (1 - Math.abs(u)) * t;
            crev = 1 - e;
            rid = hash2(ii + 31, kk + seed * 3);
            sid = kk * 1000 + ii;
            found = true;
            break;
          }
        }
      }
      if (!found) { hv = 0; crev = 1; }
      // fine surface grain
      const g = fbm(x / 23, y / 23, W / 23, 4);
      hv += (g - 0.5) * 0.12;
      hgt[y * W + x] = hv;
      const shade = clamp(0.55 + hv * 0.65, 0, 1.15);
      const v = 1 + (rid - 0.5) * 2 * varAmt;
      const cr = Math.pow(crev, 1.5);
      const i4 = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const col = (base[c] * v * shade) * (1 - cr) + edge[c] * cr;
        alb[i4 + c] = clamp(col * (0.92 + g * 0.16), 0, 1) * 255;
      }
      alb[i4 + 3] = 255;
      const r = clamp(0.42 + cr * 0.45 + (g - 0.5) * 0.2, 0, 1) * 255;
      rough[i4] = rough[i4 + 1] = rough[i4 + 2] = r; rough[i4 + 3] = 255;
      const gl = Math.pow(cr, 2.2);
      glow[i4] = glowTint[0] * gl * 255; glow[i4 + 1] = glowTint[1] * gl * 255; glow[i4 + 2] = glowTint[2] * gl * 255; glow[i4 + 3] = 255;
    }
  }
  return {
    map: toTexture(alb, W, H, true),
    normalMap: toTexture(heightToNormal(hgt, W, H, 5.5), W, H, false),
    roughnessMap: toTexture(rough, W, H, false),
    emissiveMap: toTexture(glow, W, H, true),
  };
}

// Hammered / engraved metal normal+roughness for the golden armor.
export function makeMetalSet({ size = 512, seed = 3 }) {
  const W = size, H = size;
  const hgt = new Float32Array(W * H);
  const rough = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const n = fbm(x / 40, y / 40, W / 40, 5);
    // dimples
    const cx = Math.floor(x / 32), cy = Math.floor(y / 32);
    const px = (cx + hash2(cx, cy + seed)) * 32, py = (cy + hash2(cx + 9, cy)) * 32;
    const d = Math.hypot(x - px, y - py) / 22;
    const dimple = d < 1 ? -(1 - d * d) * 0.25 : 0;
    // engraved grooves
    const groove = Math.pow(Math.abs(Math.sin((x + y * 0.35 + n * 60) / 18)), 18) * -0.3;
    hgt[y * W + x] = n * 0.6 + dimple + groove;
    const r = clamp(0.22 + (n - 0.5) * 0.3 + (groove < -0.1 ? 0.3 : 0), 0.05, 1) * 255;
    const i4 = (y * W + x) * 4; rough[i4] = rough[i4 + 1] = rough[i4 + 2] = r; rough[i4 + 3] = 255;
  }
  return { normalMap: toTexture(heightToNormal(hgt, W, H, 3), W, H, false), roughnessMap: toTexture(rough, W, H, false) };
}

// Glowing reptile eye with slit pupil (used as emissive map).
export function makeEyeTexture(c1 = '#fff3b0', c2 = '#ff8a1a', c3 = '#a81e00') {
  const c = canvas(256, 256), g = c.getContext('2d');
  const rg = g.createRadialGradient(128, 128, 5, 128, 128, 128);
  rg.addColorStop(0, c1); rg.addColorStop(0.35, c2); rg.addColorStop(0.85, c3); rg.addColorStop(1, '#200400');
  g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
  // iris striations
  const rng = new RNG(4);
  g.globalAlpha = 0.35;
  for (let i = 0; i < 160; i++) {
    const a = rng.range(0, Math.PI * 2), r0 = rng.range(20, 50), r1 = rng.range(80, 125);
    g.strokeStyle = rng.chance(0.5) ? '#ffe28a' : '#6a1200'; g.lineWidth = rng.range(1, 3);
    g.beginPath(); g.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0); g.lineTo(128 + Math.cos(a) * r1, 128 + Math.sin(a) * r1); g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = '#050000';
  g.beginPath(); g.ellipse(128, 128, 13, 92, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function makeGlowTexture() {
  const c = canvas(128, 128), g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  rg.addColorStop(0.5, 'rgba(255,255,255,0.12)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Neon signs / billboards with Japanese copy.
const SIGNS = [
  { t: 'ラーメン', bg: '#1a0006', fg: '#ff3355', v: true },
  { t: 'カラオケ', bg: '#12001f', fg: '#ff4dff', v: true },
  { t: '居酒屋', bg: '#1f0a00', fg: '#ffaa22', v: true },
  { t: '薬', bg: '#001a10', fg: '#33ff99', v: true },
  { t: 'ホテル', bg: '#00121f', fg: '#33ccff', v: true },
  { t: '焼肉', bg: '#1f0000', fg: '#ff5522', v: true },
  { t: 'パチンコ', bg: '#10001a', fg: '#ffee33', v: true },
  { t: '寿司', bg: '#001018', fg: '#88eeff', v: true },
  { t: 'BAR', bg: '#150015', fg: '#ff66cc', v: false },
  { t: 'CAFE 24H', bg: '#001515', fg: '#66ffee', v: false },
  { t: '牛丼', bg: '#1a0f00', fg: '#ffcc33', v: true },
  { t: 'ゲーム', bg: '#000d1f', fg: '#5588ff', v: true },
];
export function makeSignTexture(i) {
  const s = SIGNS[i % SIGNS.length];
  const W = s.v ? 128 : 512, H = s.v ? 512 : 160;
  const c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = s.bg; g.fillRect(0, 0, W, H);
  g.strokeStyle = s.fg; g.lineWidth = 6; g.strokeRect(8, 8, W - 16, H - 16);
  g.fillStyle = s.fg; g.shadowColor = s.fg; g.shadowBlur = 18;
  g.font = `bold ${s.v ? 92 : 100}px "IPAGothic", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (s.v) {
    const chars = [...s.t];
    const step = (H - 60) / chars.length;
    chars.forEach((ch, k) => g.fillText(ch, W / 2, 30 + step * (k + 0.5)));
  } else g.fillText(s.t, W / 2, H / 2 + 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return { tex: t, vertical: s.v, color: s.fg };
}

// Big street screens broadcasting the emergency warning (Shibuya-style).
export function makeScreenTexture(kind) {
  const W = 1024, H = 576;
  const c = canvas(W, H), g = c.getContext('2d');
  if (kind === 0) {
    g.fillStyle = '#b00010'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffffff'; g.fillRect(0, 150, W, 8); g.fillRect(0, 430, W, 8);
    g.font = 'bold 120px "IPAGothic"'; g.textAlign = 'center'; g.fillStyle = '#fff';
    g.fillText('緊急警報', W / 2, 125);
    g.font = 'bold 96px "IPAGothic"'; g.fillStyle = '#ffee00';
    g.fillText('巨大生物出現', W / 2, 270);
    g.font = 'bold 70px "IPAGothic"'; g.fillStyle = '#fff';
    g.fillText('直ちに避難してください', W / 2, 390);
    g.font = 'bold 52px "IPAGothic"'; g.fillText('EMERGENCY  EVACUATE NOW', W / 2, 520);
  } else if (kind === 1) {
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#ff2d95'); gr.addColorStop(1, '#3a0bff');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.font = 'bold 150px "IPAGothic"'; g.textAlign = 'center'; g.fillStyle = '#fff';
    g.fillText('TOKYO', W / 2, 250); g.font = 'bold 90px "IPAGothic"'; g.fillText('NIGHT  LIVE', W / 2, 400);
  } else {
    g.fillStyle = '#001a33'; g.fillRect(0, 0, W, H);
    g.font = 'bold 84px "IPAGothic"'; g.textAlign = 'center'; g.fillStyle = '#ffe600';
    g.fillText('臨時ニュース', W / 2, 150);
    g.fillStyle = '#fff'; g.font = 'bold 66px "IPAGothic"';
    g.fillText('港区に巨大生物　2体目を確認', W / 2, 300);
    g.fillStyle = '#ff3b3b'; g.fillText('政府 緊急事態を宣言', W / 2, 430);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
