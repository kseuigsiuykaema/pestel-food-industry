// Offline renderer: headless Chromium renders every frame deterministically, then ffmpeg encodes.
// usage: node render.mjs [--w 1920] [--h 1080] [--fps 30] [--workers 3] [--from 0] [--to DURATION] [--out output/kaiju_tokyo_night.mp4]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const W = +arg('w', 1920), H = +arg('h', 1080), FPS = +arg('fps', 30), WORKERS = +arg('workers', 3);
const OUT = path.resolve(root, arg('out', 'output/kaiju_tokyo_night.mp4'));
const FRAMES = path.join(root, 'frames');
fs.mkdirSync(FRAMES, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2' };
const srv = http.createServer((q, s) => {
  const p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); s.end(d); });
}).listen(0);
const port = srv.address().port;

async function worker(id, frames) {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: W, height: H } });
  p.on('pageerror', (e) => console.log(`[w${id}] err`, e.message));
  await p.goto(`http://localhost:${port}/index.html?render&w=${W}&h=${H}`);
  await p.waitForFunction('window.ready===true || window.failed', null, { timeout: 900000 });
  const f = await p.evaluate(() => window.failed);
  if (f) throw new Error(f);
  const t0 = Date.now();
  let n = 0;
  for (const fr of frames) {
    const file = path.join(FRAMES, `f${String(fr).padStart(5, '0')}.jpg`);
    if (fs.existsSync(file)) continue;
    const url = await p.evaluate((t) => window.renderFrame(t, 0.94), fr / FPS);
    fs.writeFileSync(file + '.tmp', Buffer.from(url.split(',')[1], 'base64'));
    fs.renameSync(file + '.tmp', file);
    n++;
    if (n % 20 === 0) console.log(`[w${id}] frame ${fr} (${((Date.now() - t0) / n / 1000).toFixed(2)} s/frame)`);
  }
  await b.close();
}

const duration = await (async () => {
  const src = fs.readFileSync(path.join(root, 'js/story.js'), 'utf8');
  return +src.match(/export const DURATION = ([\d.]+)/)[1];
})();
const from = Math.round(+arg('from', 0) * FPS), to = Math.round(+arg('to', duration) * FPS);
const all = []; for (let i = from; i < to; i++) all.push(i);
// interleave frames so every worker progresses through the whole film
const lists = Array.from({ length: WORKERS }, (_, k) => all.filter((_, i) => i % WORKERS === k));
console.log(`rendering ${all.length} frames @ ${W}x${H}, ${WORKERS} workers`);
await Promise.all(lists.map((l, i) => worker(i, l)));
srv.close();

if (!process.argv.includes('--no-encode')) {
  let ff = 'ffmpeg';
  try { ff = spawnSync('python3', ['-c', 'import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())']).stdout.toString().trim() || 'ffmpeg'; } catch (e) {}
  const r = spawnSync(ff, ['-y', '-framerate', String(FPS), '-start_number', String(from), '-i', path.join(FRAMES, 'f%05d.jpg'), '-frames:v', String(all.length),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  console.log('encoded', OUT, r.status);
}
