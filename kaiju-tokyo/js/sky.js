// Night sky dome (light-polluted horizon, stars, moon) and a volumetric-looking cloud deck lit from below.
import * as THREE from 'three';
import { GLSL_NOISE } from './util.js';

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uTime: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(-0.35, 0.42, -0.84).normalize() },
      uGlowPos: { value: new THREE.Vector3(0, -1e5, 0) }, // Solearon's light in the clouds
      uGlowAmt: { value: 0 },
      uFireAmt: { value: 0 },
    };
    const dome = new THREE.Mesh(new THREE.SphereGeometry(20000, 48, 24), new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: `${GLSL_NOISE}
        varying vec3 vDir; uniform vec3 uMoonDir; uniform float uTime; uniform float uFireAmt;
        void main(){
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 zen = vec3(0.004, 0.007, 0.018);
          vec3 mid = vec3(0.018, 0.022, 0.05);
          vec3 hor = vec3(0.075, 0.06, 0.07);
          vec3 c = mix(hor, mid, smoothstep(0.0, 0.12, h));
          c = mix(c, zen, smoothstep(0.12, 0.7, h));
          // orange glow of the burning city
          c += vec3(0.35, 0.1, 0.02) * uFireAmt * exp(-h * 9.0);
          // stars (few, the city is bright)
          vec3 sd = d * 300.0;
          float st = step(0.9985, h31(floor(sd))) * smoothstep(0.08, 0.3, h);
          c += vec3(0.8, 0.85, 1.0) * st * (0.5 + 0.5 * sin(uTime * 3.0 + h31(floor(sd) + 3.0) * 50.0));
          // moon + halo
          float md = dot(d, uMoonDir);
          c += vec3(1.0, 0.97, 0.9) * smoothstep(0.99955, 0.9997, md) * 3.0;
          c += vec3(0.25, 0.28, 0.36) * pow(max(md, 0.0), 180.0) * 0.8;
          c += vec3(0.05, 0.06, 0.09) * pow(max(md, 0.0), 12.0);
          if (d.y < 0.0) c = hor * 0.6;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    scene.add(dome);
    this.dome = dome;

    // cloud deck: two layers
    this.cloudMats = [];
    for (const [y, dens, scale] of [[1150, 1.0, 1.0], [1450, 0.7, 1.6]]) {
      const m = new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uY: { value: y }, uDens: { value: dens }, uScale: { value: scale }, uHole: { value: new THREE.Vector4(0, 0, 0, 0) }, fogColor: { value: new THREE.Color() } },
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `${GLSL_NOISE}
          varying vec3 vW; uniform float uTime; uniform vec3 uGlowPos; uniform float uGlowAmt; uniform float uFireAmt; uniform float uDens; uniform float uScale; uniform vec4 uHole; uniform vec3 fogColor;
          void main(){
            vec2 p = vW.xz / (1400.0 * uScale) + vec2(uTime * 0.004, uTime * 0.002);
            float n = fbm2(p * 1.0) * 0.65 + fbm2(p * 3.1 + 7.0) * 0.35;
            float a = smoothstep(0.42, 0.78, n) * uDens;
            // hole punched by Solearon's descent
            float hd = length(vW.xz - uHole.xy);
            a *= mix(1.0, smoothstep(uHole.z * 0.6, uHole.z * 1.4, hd), uHole.w);
            // lit from below by the city (orange sodium) + fires, and by Solearon's glow
            vec3 base = vec3(0.05, 0.045, 0.06) + vec3(0.1, 0.055, 0.03) * (1.0 - n);
            base += vec3(0.35, 0.1, 0.02) * uFireAmt * (1.0 - n * 0.7) * exp(-length(vW.xz) / 2500.0);
            float gd = length(vW - uGlowPos);
            base += vec3(1.6, 0.8, 0.25) * uGlowAmt * exp(-gd / 330.0) * (1.2 - n * 0.6) * 0.9;
            float dist = length(vW.xz - cameraPosition.xz);
            a *= smoothstep(16000.0, 5000.0, dist);
            vec3 col = mix(base, fogColor * 0.9, smoothstep(2000.0, 12000.0, dist) * 0.6);
            gl_FragColor = vec4(col, a * 0.92);
          }`,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), m);
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = y;
      mesh.renderOrder = -5;
      scene.add(mesh);
      this.cloudMats.push(m);
    }
  }
  update(t, fog) {
    this.uniforms.uTime.value = t;
    for (const m of this.cloudMats) if (fog) m.uniforms.fogColor.value.copy(fog.color);
  }
  setHole(x, z, r, amt) { for (const m of this.cloudMats) m.uniforms.uHole.value.set(x, z, r, amt); }
}
