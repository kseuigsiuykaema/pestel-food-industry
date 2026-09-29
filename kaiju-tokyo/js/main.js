// Runtime: renderer, lighting, post-processing, captions, realtime player + deterministic frame API.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Creature } from './kaiju/creature.js';
import { City, LAYOUT } from './city.js';
import { Sky } from './sky.js';
import { TokyoTower, Skytree } from './landmarks.js';
import { FX, Beam } from './fx.js';
import { Story, DURATION } from './story.js';
import { clamp, sstep, lerp } from './util.js';

const q = new URLSearchParams(location.search);
const W = +(q.get('w') || innerWidth), H = +(q.get('h') || innerHeight);
const RENDER_MODE = q.has('render');
const status = (m) => { const el = document.getElementById('status'); if (el) el.textContent = m; };

export async function boot() {
  await document.fonts.ready.catch(() => {});
  try { await Promise.all([document.fonts.load('800 40px "Shippori Mincho B1"'), document.fonts.load('600 20px "Cinzel"')]); } catch (e) {}
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: RENDER_MODE });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, !RENDER_MODE);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('stage').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(0x0b0d17, 0.00034);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(45, W / H, 2, 30000);

  // Environment for metallic reflections: night sky above, warm light-polluted city below.
  {
    const env = new THREE.Scene();
    const sph = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; void main(){ float y = vP.y;
        vec3 c = mix(vec3(0.5, 0.28, 0.14), vec3(0.03, 0.04, 0.08), smoothstep(-0.2, 0.5, y));
        c += vec3(1.2, 0.55, 0.2) * exp(-abs(y) * 10.0);
        gl_FragColor = vec4(c, 1.0); }`,
    }));
    env.add(sph);
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * Math.PI * 2;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(18, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(i % 3 ? 3 : 1.5, i % 3 ? 1.6 : 1.8, i % 3 ? 0.7 : 2.2), side: THREE.DoubleSide }));
      p.position.set(Math.cos(a) * 80, -8 + (i % 4) * 6, Math.sin(a) * 80); p.lookAt(0, 0, 0); env.add(p);
    }
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(env, 0.02).texture;
    scene.environmentIntensity = 0.35;
  }
  const hemi = new THREE.HemisphereLight(0x2a3552, 0x3a2414, 0.28);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x9fb2e0, 0.35);
  moon.position.set(-3500, 4200, -8400);
  scene.add(moon);
  const warmKey = new THREE.DirectionalLight(0xff9a55, 0.0); // fire-glow fill, rises as the city burns
  warmKey.position.set(300, 150, 600);
  scene.add(warmKey);

  status('building city…');
  const city = new City(scene);
  const sky = new Sky(scene);
  const tower = new TokyoTower(scene, LAYOUT.towerPos, new THREE.Vector3(0.62, 0, 0.78));
  const skytree = new Skytree(scene, new THREE.Vector3(3900, 0, -2200));
  status('growing kaiju…');
  const sol = new Creature('solearon');
  const ter = new Creature('teranox');
  scene.add(sol.group, ter.group);
  const fx = new FX(scene);
  const beam = new Beam(scene);
  const world = { scene, city, fx, beam, tower, sol, ter, sky, camera };
  const story = new Story(world);
  status('choreographing destruction…');
  const pre = story.precompute();
  fx.finalize();
  window.info = { buildings: city.buildings.length, sprites: fx.count, pre, sol: sol.stats, ter: ter.stats };

  // ---------- post ----------
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType }));
  composer.setPixelRatio(1);
  composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  // keep extreme HDR values (lights grazing geometry) from exploding the bloom chain
  composer.addPass(new ShaderPass({ uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); c.rgb = clamp(c.rgb, 0.0, 1e4); float m = max(c.r, max(c.g, c.b)); c.rgb *= m > 12.0 ? 12.0 / m : 1.0; gl_FragColor = c; }' }));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.55, 0.45, 1.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uFlash: { value: 0 }, uFade: { value: 0 }, uRes: { value: new THREE.Vector2(W, H) }, uWarm: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform float uFlash; uniform float uFade; uniform vec2 uRes; uniform float uWarm; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        vec2 c = vUv - 0.5;
        float ca = 0.0016 + 0.004 * dot(c, c);
        vec3 col;
        col.r = texture2D(tDiffuse, vUv + c * ca).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - c * ca).b;
        // split-tone: teal shadows, amber highlights
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        col += (vec3(-0.012, 0.004, 0.02) * (1.0 - l) + vec3(0.03, 0.01, -0.02) * l) * (1.0 + uWarm);
        col = mix(vec3(l), col, 1.08);
        col += vec3(1.0, 0.85, 0.7) * uFlash;
        float vig = smoothstep(0.95, 0.3, length(c * vec2(1.0, 0.8)));
        col *= mix(0.62, 1.0, vig);
        float g = h(vUv * uRes + fract(uTime * 7.13) * 100.0) - 0.5;
        col += g * 0.035;
        col *= 1.0 - uFade;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  composer.addPass(grade);

  // ---------- captions (2D overlay, composited into captured frames) ----------
  const cap = document.createElement('canvas'); cap.width = W; cap.height = H;
  cap.id = 'captions';
  document.getElementById('stage').appendChild(cap);
  const cg = cap.getContext('2d');
  const S = H / 1080;
  function drawCaptions(t) {
    cg.clearRect(0, 0, W, H);
    for (const c of story.captions) {
      if (t < c.t0 - 0.1 || t > c.t1 + 0.1) continue;
      const a = sstep(c.t0, c.t0 + 0.6, t) * (1 - sstep(c.t1 - 0.6, c.t1, t));
      if (a <= 0) continue;
      cg.save(); cg.globalAlpha = a;
      cg.shadowColor = 'rgba(0,0,0,0.85)'; cg.shadowBlur = 14 * S;
      if (c.kind === 'place') {
        const n = Math.floor(clamp((t - c.t0) / 1.6, 0, 1) * [...c.text].length);
        cg.font = `800 ${34 * S}px "Shippori Mincho B1", serif`; cg.fillStyle = '#f2ece2';
        cg.fillText([...c.text].slice(0, n).join(''), 90 * S, H - 110 * S);
        cg.fillStyle = 'rgba(242,236,226,0.7)'; cg.fillRect(90 * S, H - 92 * S, 380 * S * clamp((t - c.t0) / 1.2, 0, 1), 1.5 * S);
      } else if (c.kind === 'name') {
        const left = c.side === 'left';
        const x = left ? 110 * S : W - 110 * S;
        cg.textAlign = left ? 'left' : 'right';
        const slide = (1 - sstep(c.t0, c.t0 + 1.0, t)) * 30 * S * (left ? -1 : 1);
        cg.font = `800 ${86 * S}px "Shippori Mincho B1", serif`;
        const gr = cg.createLinearGradient(0, 120 * S, 0, 230 * S);
        gr.addColorStop(0, '#fff4dc'); gr.addColorStop(1, left ? '#ffc76a' : '#ff9a55');
        cg.fillStyle = gr;
        cg.fillText(c.jp, x + slide, 200 * S);
        cg.shadowBlur = 0;
        cg.fillStyle = 'rgba(255,240,220,0.8)';
        const lw = 520 * S * sstep(c.t0 + 0.2, c.t0 + 1.2, t);
        cg.fillRect(left ? x : x - lw, 228 * S, lw, 2 * S);
        cg.font = `600 ${30 * S}px "Cinzel", serif`;
        cg.letterSpacing = `${12 * S}px`;
        cg.fillStyle = '#efe6d6';
        cg.fillText(c.en, x + slide * 0.5, 278 * S);
      } else if (c.kind === 'title') {
        cg.textAlign = 'center';
        cg.font = `800 ${62 * S}px "Shippori Mincho B1", serif`;
        const gr = cg.createLinearGradient(0, H / 2 - 60 * S, 0, H / 2 + 10 * S);
        gr.addColorStop(0, '#fff6e2'); gr.addColorStop(1, '#ffb450');
        cg.fillStyle = gr;
        cg.fillText(c.jp, W / 2, H / 2 - 10 * S);
        cg.shadowBlur = 0;
        cg.fillStyle = 'rgba(255,236,210,0.75)'; cg.fillRect(W / 2 - 330 * S, H / 2 + 18 * S, 660 * S, 1.5 * S);
        cg.font = `600 ${28 * S}px "Cinzel", serif`; cg.letterSpacing = `${14 * S}px`; cg.fillStyle = '#efe2cc';
        cg.fillText(c.en, W / 2, H / 2 + 68 * S);
      }
      cg.restore();
    }
  }

  // ---------- one frame ----------
  function frame(t) {
    story.pose(t);
    const shot = story.camera(t, camera);
    const mood = story.mood(t);
    for (const k of [sol, ter]) {
      const d = camera.position.distanceTo(k.haloSprite.getWorldPosition(new THREE.Vector3()));
      k.haloSprite.material.opacity *= sstep(70, 260, d);
      k.coreSprite.material.opacity *= sstep(30, 120, d);
    }
    fog.color.setRGB(lerp(0.043, 0.075, mood.haze), lerp(0.05, 0.045, mood.haze), lerp(0.09, 0.055, mood.haze));
    fog.density = lerp(0.00032, 0.00042, mood.haze);
    warmKey.intensity = mood.fire * 0.12;
    hemi.intensity = 0.28 + mood.fire * 0.1;
    hemi.groundColor.setRGB(0.23 + mood.fire * 0.12, 0.14, 0.08);
    city.update(t, fog);
    sky.update(t, fog);
    sky.uniforms.uFireAmt.value = mood.fire;
    // Solearon lights the clouds from within as it descends, and punches a hole through them
    const sc = sol.boneWorld('chest');
    sky.uniforms.uGlowPos.value.copy(sc);
    sky.uniforms.uGlowAmt.value = 1.0 + (t > story.T.sTakeoff ? 0.6 : 0);
    const holeK = sstep(story.T.sDescent - 0.5, story.T.sDescent + 2.5, t);
    sky.setHole(760, 180, 260, holeK);
    tower.update(t);
    skytree.update(t, fog);
    // beam
    const firing = story.firing || 0;
    if (firing > 0.001) beam.set(t, sol.mouthWorld(), story.beamTarget(t), firing);
    else beam.set(t, sol.mouthWorld(), sol.mouthWorld(), 0);
    fx.update(t, camera, fog, new THREE.Color(0.02 + mood.fire * 0.04, 0.02 + mood.fire * 0.015, 0.03));
    grade.uniforms.uTime.value = t;
    grade.uniforms.uFlash.value = Math.min(0.8, fx.flashAt(t) + firing * 0.06);
    grade.uniforms.uFade.value = Math.max(1 - sstep(0.0, 1.2, t), sstep(DURATION - 1.4, DURATION, t) * 1);
    grade.uniforms.uWarm.value = mood.fire;
    composer.render();
    drawCaptions(t);
    return shot;
  }

  // ---------- capture API ----------
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const og = out.getContext('2d');
  window.renderFrame = (t, quality = 0.93) => {
    frame(t);
    og.drawImage(renderer.domElement, 0, 0);
    og.drawImage(cap, 0, 0);
    return out.toDataURL('image/jpeg', quality);
  };
  window.DURATION = DURATION;
  window.W = world; window.story = story; window.bloom = bloom; window.renderer = renderer; window.hemi = hemi; window.moon = moon;
  window.shots = story.shots();

  if (RENDER_MODE) { window.ready = true; status(''); return; }

  // ---------- realtime player ----------
  const ui = document.getElementById('ui');
  ui.style.display = 'flex';
  const seek = document.getElementById('seek'), play = document.getElementById('play'), time = document.getElementById('time');
  seek.max = DURATION;
  let playing = true, t0 = performance.now() / 1000, tNow = +(q.get('t') || 0);
  t0 -= tNow;
  play.onclick = () => { playing = !playing; play.textContent = playing ? '❚❚' : '▶'; t0 = performance.now() / 1000 - tNow; };
  seek.oninput = () => { tNow = +seek.value; t0 = performance.now() / 1000 - tNow; };
  addEventListener('keydown', (e) => { if (e.code === 'Space') play.onclick(); });
  addEventListener('resize', () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  });
  status('');
  function loop() {
    if (playing) { tNow = performance.now() / 1000 - t0; if (tNow > DURATION) { tNow = 0; t0 = performance.now() / 1000; } }
    frame(tNow);
    seek.value = tNow; time.textContent = tNow.toFixed(1) + ' / ' + DURATION + 's';
    requestAnimationFrame(loop);
  }
  loop();
  window.ready = true;
}
