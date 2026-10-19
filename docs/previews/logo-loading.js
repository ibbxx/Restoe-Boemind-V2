import * as THREE from './vendor/three.module.js';
import { wings } from './logo-wings.js';

export async function start() {
  const stage = document.querySelector('#stage');
  const source = document.querySelector('#source-logo');
  const toggle = document.querySelector('#toggle');
  const compare = document.querySelector('#compare');
  const phase = document.querySelector('#phase');
  const position = document.querySelector('#position');
  const note = document.querySelector('#motion-note');
  const errorPanel = document.querySelector('#error');
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const cycle = 12;
  const tau = Math.PI * 2;
  let time = 0;
  let lastFrame = null;
  let lastProgress = -Infinity;
  let playing = !preference.matches;
  let comparing = false;
  let contextLost = false;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0xffffff, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2.5, 2.5, 2.5, -2.5, .1, 30);
  camera.position.z = 8;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xa2acc4, 1.3));
  const key = new THREE.DirectionalLight(0xfff7f0, 2.7);
  key.position.set(-3, 4, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc4d4ff, 1.1);
  fill.position.set(4, -1, 3);
  scene.add(fill);

  const texture = await new THREE.TextureLoader().loadAsync(new URL('./earth-map.png', import.meta.url).href);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.MeshPhysicalMaterial({ map: texture, roughness: .65, metalness: .02, clearcoat: .3, clearcoatRoughness: .5 }),
  );
  const axis = new THREE.Group();
  axis.rotation.set(.2, 0, -.12);
  axis.add(earth);
  scene.add(axis);

  function makeWing(outlines, color, edgeColor) {
    const shapes = outlines.map(points => {
      const shape = new THREE.Shape();
      const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      shape.moveTo(...midpoint(points.at(-1), points[0]));
      points.forEach((point, index) => {
        shape.quadraticCurveTo(...point, ...midpoint(point, points[(index + 1) % points.length]));
      });
      shape.closePath();
      return shape;
    });
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: .035, steps: 1, bevelEnabled: true,
      bevelThickness: .007, bevelSize: .004, bevelSegments: 3, curveSegments: 6,
    });
    geometry.translate(0, 0, -.0175);
    const face = new THREE.MeshPhysicalMaterial({ color, roughness: .36, metalness: .16, clearcoat: .6, clearcoatRoughness: .3 });
    const edge = new THREE.MeshStandardMaterial({ color: edgeColor, roughness: .5, metalness: .12 });
    const mesh = new THREE.Mesh(geometry, [face, edge]);
    const orbit = new THREE.Group();
    orbit.add(mesh);
    scene.add(orbit);
    return { orbit, mesh };
  }

  // Sayap berada pada cangkang radial berbeda; rotasi tidak membuatnya menembus globe atau sayap lain.
  const red = makeWing(wings.red, 0xe12923, 0xa91c22);
  const blue = makeWing(wings.blue, 0x14285c, 0x0b1639);

  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 256;
  shadowCanvas.height = 64;
  const brush = shadowCanvas.getContext('2d');
  brush.scale(1, .25);
  const gradient = brush.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(15,30,80,.16)');
  gradient.addColorStop(1, 'rgba(15,30,80,0)');
  brush.fillStyle = gradient;
  brush.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }));
  shadow.position.set(0, -2.25, -2.5);
  shadow.scale.set(2.4, .3, 1);
  scene.add(shadow);

  function showProgress() {
    const percent = Math.round(time / cycle * 100);
    phase.value = String(percent);
    position.value = percent + '%';
  }

  // Seluruh pose berasal dari satu waktu absolut; 0% dan 100% memiliki geometri yang sama.
  function render() {
    if (contextLost) return;
    const angle = time / cycle * tau;
    const tilt = Math.sin(angle);
    earth.rotation.y = THREE.MathUtils.degToRad(170) + angle;
    red.mesh.rotation.z = -angle * 3;
    red.orbit.rotation.set(.66 * tilt, .12 * Math.sin(angle * 2), 0);
    blue.mesh.rotation.z = angle * 2;
    blue.orbit.rotation.set(-.4 * tilt, .5 * tilt, 0);
    renderer.render(scene, camera);
  }

  function frame(timestamp) {
    if (lastFrame !== null) time = (time + (timestamp - lastFrame) / 1000) % cycle;
    lastFrame = timestamp;
    render();
    if (timestamp - lastProgress > 100) {
      showProgress();
      lastProgress = timestamp;
    }
  }

  function updatePlayback() {
    lastFrame = null;
    renderer.setAnimationLoop(playing && !comparing && !contextLost && !document.hidden ? frame : null);
    toggle.textContent = playing ? 'Jeda' : 'Putar';
    toggle.setAttribute('aria-pressed', String(!playing));
    compare.setAttribute('aria-pressed', String(comparing));
    toggle.disabled = comparing || contextLost;
    phase.disabled = comparing || contextLost;
    compare.disabled = contextLost;
    note.hidden = !preference.matches || playing;
  }

  function resize() {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    const { width, height } = stage.getBoundingClientRect();
    renderer.setSize(width, height, false);
    render();
  }

  toggle.addEventListener('click', () => {
    playing = !playing;
    showProgress();
    updatePlayback();
  });
  phase.addEventListener('input', () => {
    playing = false;
    time = Number(phase.value) / 100 * cycle;
    updatePlayback();
    render();
    showProgress();
  });
  compare.addEventListener('click', () => {
    comparing = !comparing;
    stage.classList.toggle('is-comparing', comparing);
    source.hidden = !comparing;
    showProgress();
    updatePlayback();
  });
  preference.addEventListener('change', () => {
    if (preference.matches) playing = false;
    updatePlayback();
    showProgress();
  });
  document.addEventListener('visibilitychange', updatePlayback);
  new ResizeObserver(resize).observe(stage);
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    contextLost = true;
    stage.classList.add('is-unavailable');
    source.hidden = false;
    document.querySelector('#error-message').textContent = 'Render 3D terhenti. Menunggu pemulihan grafis browser atau tekan Coba lagi.';
    errorPanel.hidden = false;
    updatePlayback();
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    stage.classList.remove('is-unavailable');
    source.hidden = !comparing;
    errorPanel.hidden = true;
    resize();
    updatePlayback();
  });
  window.addEventListener('pagehide', () => {
    renderer.setAnimationLoop(null);
    lastFrame = null;
  });
  window.addEventListener('pageshow', updatePlayback);

  resize();
  playing = !preference.matches;
  source.hidden = true;
  document.querySelector('#controls').hidden = false;
  showProgress();
  updatePlayback();
}
