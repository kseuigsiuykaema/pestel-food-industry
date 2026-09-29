// usage: node still.mjs out_prefix t1,t2,... [w h]  -> renders stills from index.html?render
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
const types = {'.html':'text/html','.js':'text/javascript','.woff2':'font/woff2'};
const srv = http.createServer((q,s)=>{ const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p,(e,d)=>{ if(e){s.writeHead(404);s.end();return;} s.writeHead(200,{'content-type':types[path.extname(p)]||'application/octet-stream'}); s.end(d);});}).listen(0);
const [prefix, ts, w='1280', h='720'] = process.argv.slice(2);
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage({viewport:{width:+w,height:+h}});
p.on('console', m=>{ if (m.type()==='error' || m.type()==='warning') console.log('[page]', m.type(), m.text().slice(0,400)); }); p.on('pageerror', e=>console.log('[err]', e.message));
let t0=Date.now();
await p.goto(`http://localhost:${srv.address().port}/index.html?render&w=${w}&h=${h}`);
await p.waitForFunction('window.ready===true || window.failed', null, {timeout: 900000});
const f = await p.evaluate(()=>window.failed); if (f) { console.log('FAILED', f); process.exit(1); }
console.log('init ms', Date.now()-t0, JSON.stringify(await p.evaluate(()=>window.info)));
const variants = (process.env.VARS||'').split('|||');
for (const [vi, code] of variants.entries()) {
if (code) await p.evaluate(code);
for (const t of ts.split(',').map(Number)) {
  t0 = Date.now();
  const url = await p.evaluate((t)=>window.renderFrame(t), t);
  fs.writeFileSync(`${prefix}${variants.length>1?'v'+vi:''}_${String(t).replace('.','_')}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
  console.log('t', t, 'ms', Date.now()-t0);
}}
await b.close(); srv.close();
