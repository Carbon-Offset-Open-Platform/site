// Hero globe: realistic Earth with the real sun position, a slow eased spin,
// drag to rotate, and the live ISS position. Falls back to the GIF without WebGL.
import * as THREE from './three.module.min.js';

const canvas = document.getElementById('globe');
const fallback = document.getElementById('globe-fallback');
const chip = document.getElementById('globe-live');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const D = Math.PI / 180;

function fail() { if (canvas) canvas.remove(); if (fallback) fallback.hidden = false; }

// lat/lon (degrees) -> point on a sphere, matching SphereGeometry's equirectangular UVs
function ll(lat, lon, r = 1) {
  const phi = (90 - lat) * D, theta = (lon + 180) * D;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

// Subsolar point for a date (low-precision NOAA approximation, good to ~1 degree)
function subsolar(date) {
  const day = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5;
  const g = 2 * Math.PI / 365 * (day - 1 + (date.getUTCHours() - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  return { lat: decl / D, lon: -((minutes + eqt) / 4 - 180) };
}

function start() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (e) { fail(); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // textures are used as-is (sRGB in, sRGB out)

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 0, 4.6);

  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const tex = (f) => { const t = loader.load('assets/earth/' + f); t.anisotropy = Math.min(8, maxAniso); return t; };

  const uniforms = {
    dayMap: { value: tex('day.jpg') },
    nightMap: { value: tex('night.jpg') },
    dataMap: { value: tex('bump_roughness_clouds.jpg') }, // g: roughness, b: clouds
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
  };

  const earthMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform sampler2D dayMap, nightMap, dataMap; uniform vec3 sunDir;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        vec3 n = normalize(vN), v = normalize(vView);
        float d = dot(n, sunDir);
        vec4 data = texture2D(dataMap, vUv);
        float clouds = smoothstep(0.2, 1.0, data.b);
        vec3 day = mix(texture2D(dayMap, vUv).rgb, vec3(1.0), clouds * 0.85);
        vec3 night = texture2D(nightMap, vUv).rgb * (1.0 - clouds) * 1.3;
        float lit = smoothstep(-0.12, 0.25, d);
        vec3 col = mix(night, day * (0.12 + 1.05 * max(d, 0.0)), lit);
        // sun glint on water (low roughness), hidden under clouds
        float spec = pow(max(dot(reflect(-sunDir, n), v), 0.0), 28.0) * (1.0 - data.g) * (1.0 - clouds) * lit;
        col += vec3(1.0, 0.95, 0.85) * spec * 0.55;
        // atmospheric scattering at the limb and a warm terminator
        float fres = pow(1.0 - max(dot(n, v), 0.0), 2.5);
        col = mix(col, vec3(0.32, 0.62, 1.0), fres * smoothstep(-0.25, 0.6, d) * 0.75);
        col += vec3(1.0, 0.45, 0.2) * smoothstep(0.18, 0.0, abs(d)) * 0.06;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });

  const atmoMat = new THREE.ShaderMaterial({
    uniforms: { sunDir: uniforms.sunDir },
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: `
      varying vec3 vN; varying vec3 vView;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 sunDir; varying vec3 vN; varying vec3 vView;
      void main() {
        // back faces of the shell: brightest just outside the planet's limb, fading outward
        float x = clamp(-dot(normalize(vN), normalize(vView)), 0.0, 1.0);
        float edge = pow(x, 1.4) * 3.2;
        float sun = smoothstep(-0.4, 0.5, dot(normalize(vN), sunDir));
        gl_FragColor = vec4(vec3(0.3, 0.6, 1.0) * edge * (0.2 + sun), 1.0);
      }`,
  });

  const earth = new THREE.Group();
  earth.rotation.x = 0.36; // gentle axial tilt toward the viewer
  scene.add(earth);
  const spin = new THREE.Group();
  earth.add(spin);
  spin.add(new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), earthMat));
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.09, 64, 48), atmoMat));

  // Live ISS marker
  const iss = new THREE.Group();
  const issDot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: 0x34d399 }));
  const issHalo = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.04, 32), new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
  iss.add(issDot, issHalo); iss.visible = false; spin.add(iss);

  // Start facing the evening side, so both daylight and city lights are in view
  const viewLon = subsolar(new Date()).lon + 65;
  let angle = -(viewLon + 90) * D, vel = 0, auto = 0, dragging = false, lastX = 0, visible = true;
  const AUTO = reduce ? 0 : 0.045; // radians per second: one turn every ~2.3 minutes

  // Drag to rotate, with inertia
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX; lastX = e.clientX;
    angle += dx * 0.006; vel = dx * 0.006 * 60;
  });
  const end = () => { dragging = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);

  new IntersectionObserver((es) => { visible = es[0].isIntersecting; }, { threshold: 0 }).observe(canvas);

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  const sunLocal = new THREE.Vector3();
  function updateSun() { const s = subsolar(new Date()); sunLocal.copy(ll(s.lat, s.lon)).normalize(); }
  updateSun(); setInterval(updateSun, 60000);

  let t0 = performance.now();
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!visible) return;
    const ease = Math.min(1, (performance.now() - t0) / 4000); // ease in over 4 s
    auto = AUTO * (ease * ease * (3 - 2 * ease));
    if (!dragging) { angle += (auto + vel) * dt; vel *= Math.pow(0.04, dt); }
    spin.rotation.y = angle;
    spin.updateMatrixWorld();
    uniforms.sunDir.value.copy(sunLocal).applyMatrix4(new THREE.Matrix4().extractRotation(spin.matrixWorld)).normalize();
    const pulse = 1 + 0.35 * Math.sin(performance.now() / 400);
    issHalo.scale.setScalar(pulse); issHalo.lookAt(camera.position);
    renderer.render(scene, camera);
  });

  // Free, no-key APIs. Failures just leave the static label in place.
  async function pollISS() {
    try {
      const r = await fetch('https://api.wheretheiss.at/v1/satellites/25544');
      if (!r.ok) throw 0;
      const j = await r.json();
      iss.position.copy(ll(j.latitude, j.longitude, 1 + j.altitude / 6371 * 1.6));
      iss.visible = true;
    } catch (e) { /* offline or blocked: hide nothing, just skip */ }
  }
  pollISS(); setInterval(pollISS, 5000);

  async function pollGrid() {
    if (!chip) return;
    try {
      const r = await fetch('https://api.carbonintensity.org.uk/intensity');
      if (!r.ok) throw 0;
      const d = (await r.json()).data[0].intensity;
      const v = d.actual ?? d.forecast;
      chip.textContent = 'live · UK grid ' + v + ' gCO₂/kWh · ' + d.index;
    } catch (e) { /* keep default label */ }
  }
  pollGrid(); setInterval(pollGrid, 5 * 60000);
}

if (!canvas) { /* nothing to do */ }
else if (!window.WebGLRenderingContext) fail();
else start();
