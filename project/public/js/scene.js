import * as THREE from 'three';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';


const CONFIG = {
  model:       '/models/scene.glb',   // файл лежит в public/models/scene.glb
  exposure:    1.0,
  worldColor:  0x0d0f12,
  shadows:     true,
  environment: true,

  // --- анимация по клику (значения совпадают со скриптом Blender) ---
  clickTime:   1.5,     // секунда в клипе, где происходит "нажатие" (кадр 36 при 24 fps)
  idleSpeed:   0.35,    // скорость вращения тарелки в ожидании, рад/с
  mapTilt:     45,      // наклон камеры над картой, градусы
  textIdle:    ['Астана', 'Нажмите на тарелку с бауырсаками'],
  textDone:    ['Астана', 'Нажмите на сцену, чтобы повторить']
};

const box = document.getElementById('scene3d');   // блок на странице

window.__scene3d = { module: true, box: !!box };

if (box) { window.__scene3d.started = true; start(box); }
else console.error('Не найден блок с id="scene3d" — проверьте разметку в index.ejs');


// ---------- вспомогательные функции (те же, что в Blender-скрипте)
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const eo  = (t) => 1 - Math.pow(1 - t, 3);
const eio = (t) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function start(box) {
  const canvas = box.querySelector('canvas');
  const loadEl = box.querySelector('.scene3d-load');
  const barEl  = box.querySelector('.scene3d-bar i');
  const errEl  = box.querySelector('.scene3d-err');
  const textEl = box.querySelector('.scene3d-text');
  // подпись внутри .scene3d-text: [заголовок, подсказка] (стили h2 и p уже есть в animation.css)
  const setText = (t) => {
    if (!textEl) return;
    textEl.innerHTML = '';
    if (!t) return;
    const h = document.createElement('h2'); h.textContent = t[0];
    const p = document.createElement('p');  p.textContent = t[1];
    textEl.append(h, p);
  };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace    = THREE.SRGBColorSpace;
  renderer.toneMapping         = THREE.AgXToneMapping;
  renderer.toneMappingExposure = CONFIG.exposure;
  if (CONFIG.shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.worldColor);
  const pmrem = new THREE.PMREMGenerator(renderer);

  // В scene.glb камеры нет, поэтому камеру ведём сами (вертикальный угол 40°, как в Blender)
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
  camera.position.set(6.6, 2.5, -7.5);
  camera.lookAt(6.6, 0.65, 0);

  let mixer = null, loaded = false;
  let actions = [], ref = null, duration = 12.5;
  let spin = null, idle = null, camTarget = null, dot = null, rings = [];
  let mapMesh = null, maskTex = null, maskCtx = null, lastMaskE = -1;
  let state = 'idle', t0 = 0;                          // idle | run | done
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();

  function resize() {
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(box);

  // ---------- маска карты: круг (размер тарелки) -> прямоугольник
  function makeMask() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 364;
    maskCtx = c.getContext('2d');
    maskTex = new THREE.CanvasTexture(c);
    drawMask(0);
  }
  function drawMask(e) {
    if (Math.abs(e - lastMaskE) < 0.002) return;
    lastMaskE = e;
    const n = 2 + e * 12, w = 256, h = 182, g = maskCtx;
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 364);
    g.fillStyle = '#fff'; g.beginPath();
    for (let i = 0; i <= 160; i++) {
      const a = i / 160 * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const r = Math.pow(Math.pow(Math.abs(ca), n) + Math.pow(Math.abs(sa), n), -1 / n);
      g.lineTo(w + ca * r * w * .995, h + sa * r * h * .995);
    }
    g.fill();
    maskTex.needsUpdate = true;
  }

  // ---------- прогресс анимации u (0..1): превращение тарелки в карту
  function progress() {
    if (state === 'idle' || !ref) return 0;
    const t = ref.time - CONFIG.clickTime;
    return eio(clamp((t - 4.4) / 2.9));
  }

  // ---------- камера: 15° -> mapTilt, смотрит на AST_CamTarget
  function updateCamera(u) {
    const asp = camera.aspect;
    const dIdle = Math.max(7.6, 6.2 / (.728 * asp));
    const dMap  = Math.max(8.4, 9.8 / (.728 * asp));
    const d  = dIdle + (dMap - dIdle) * u;
    const el = THREE.MathUtils.degToRad(15 + (CONFIG.mapTilt - 15) * u);
    camTarget.getWorldPosition(tmp);
    camera.position.set(tmp.x, tmp.y + d * Math.sin(el), tmp.z - d * Math.cos(el));
    camera.lookAt(tmp);
  }

  // ---------- клик по тарелке
  const ray = new THREE.Raycaster(), mp = new THREE.Vector2();
  function hit(ev) {
    const r = canvas.getBoundingClientRect();
    mp.set((ev.clientX - r.left) / r.width * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mp, camera);
    return ray.intersectObjects(spin.children, true).length > 0;     // тарелка и бауырсаки
  }
  function play() {
    state = 'run'; t0 = clock.elapsedTime;
    for (const a of actions) { a.paused = false; a.time = CONFIG.clickTime; }
    box.classList.add('is-playing');
    setText(null);
  }
  function reset() {
    for (const a of actions) { a.reset(); a.play(); a.paused = true; }
    mixer.update(0);
    lastMaskE = -1; state = 'idle';
    box.classList.remove('is-playing', 'is-done');
    setText(CONFIG.textIdle);
  }
  canvas.style.touchAction = 'manipulation';
  canvas.addEventListener('pointermove', (ev) => {
    if (!loaded) return;
    canvas.style.cursor = (state === 'idle' && hit(ev)) || state === 'done' ? 'pointer' : 'default';
  });
  canvas.addEventListener('pointerdown', (ev) => {
    if (!loaded) return;
    if (state === 'idle' && hit(ev)) play();
    else if (state === 'done') reset();
  });

  new GLTFLoader().load(
    CONFIG.model,
    (gltf) => {
      scene.add(gltf.scene);

      const byName = (n) => gltf.scene.getObjectByName(n);
      spin = byName('AST_Spin'); idle = byName('AST_Idle'); camTarget = byName('AST_CamTarget');
      dot = byName('AST_Dot'); mapMesh = byName('AST_Map');
      rings = [byName('AST_Ring0'), byName('AST_Ring1')];
      if (!spin || !idle || !camTarget) throw new Error('В сцене нет AST_Spin / AST_Idle / AST_CamTarget');

      // карта: берём картинку из экспорта и вешаем анимируемую маску
      makeMask();
      const oldMap = mapMesh.material;
      mapMesh.material = new THREE.MeshBasicMaterial({
        map: oldMap.emissiveMap || oldMap.map, alphaMap: maskTex,
        transparent: true, side: THREE.DoubleSide, toneMapped: false
      });
      // красная точка и кольца: яркий красный, без тонмаппинга; кольца плавно гаснут
      const red = () => new THREE.MeshBasicMaterial({ color: 0xe5322d, transparent: true,
        side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
      if (dot) dot.material = red();
      rings.forEach((r) => { if (r) r.material = red(); });
      // подписи на карте: тёмные, без освещения
      gltf.scene.traverse((o) => {
        if (o.isMesh && o.name.startsWith('AST_T_'))
          o.material = new THREE.MeshBasicMaterial({ color: 0x262421, toneMapped: false, side: THREE.DoubleSide });
      });

      // свет (в glb источников нет)
      const c0 = new THREE.Vector3(); camTarget.getWorldPosition(c0); c0.y = 0;
      const sun = new THREE.DirectionalLight(0xffffff, 2.4);
      sun.position.set(c0.x + 3, 8, c0.z - 4);
      sun.target.position.copy(c0);
      if (CONFIG.shadows) {
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.bias = -0.0008;
        Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 0.5, far: 30 });
        sun.shadow.camera.updateProjectionMatrix();
      }
      scene.add(sun, sun.target);

      if (CONFIG.shadows) {
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          const noShadow = o === dot || o === mapMesh || rings.includes(o) || o.name.startsWith('AST_T_');
          o.castShadow = !noShadow; o.receiveShadow = !noShadow;
        });
      }

      // анимации: все клипы ставим на паузу в начальной позе, играем после клика
      mixer = new THREE.AnimationMixer(gltf.scene);
      for (const clip of gltf.animations || []) {
        const a = mixer.clipAction(clip);
        a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
        a.play(); a.paused = true; actions.push(a);
        duration = Math.max(duration, clip.duration);
      }
      ref = actions[0] || null;
      mixer.update(0);

      if (CONFIG.environment)
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.6;

      resize();
      updateCamera(0);
      setText(CONFIG.textIdle);
      loaded = true;
      box.classList.add('is-ready');
      if (loadEl) loadEl.classList.add('hidden');
    },
    (e) => { if (e.total && barEl) barEl.style.width = (e.loaded / e.total * 100).toFixed(0) + '%'; },
    (e) => {
      if (loadEl) loadEl.classList.add('hidden');
      if (errEl) {
        errEl.style.display = 'block';
        errEl.textContent = 'Сцена не загрузилась. Проверьте, что файл лежит в public' +
                            CONFIG.model + ' и что в server.js включена раздача папки public.';
      }
      console.error('Сцена не загрузилась:', e);
    }
  );

  let visible = true;
  new IntersectionObserver(
    ([entry]) => { visible = entry.isIntersecting; },
    { threshold: 0.01 }
  ).observe(box);

  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (!loaded || !visible) return;

    // вращение тарелки: в ожидании крутится, после клика плавно тормозит
    if (state === 'idle') idle.rotation.y += CONFIG.idleSpeed * dt;
    else if (state === 'run') {
      const k = 1 - eio(clamp((clock.elapsedTime - t0) / 1.2));
      idle.rotation.y += CONFIG.idleSpeed * k * dt;
    }

    if (state === 'run') {
      mixer.update(dt);
      if (ref && ref.time >= duration - 0.03) {
        state = 'done';
        box.classList.remove('is-playing'); box.classList.add('is-done');
        setText(CONFIG.textDone);
      }
    }

    const u = state === 'done' ? 1 : progress();
    if (u > 0) drawMask(eo(u));                         // круг -> прямоугольник

    // кольца вокруг точки пульсируют и гаснут
    const kd = clamp((u - .78) / .22);
    const tr = state === 'done' ? clock.elapsedTime : (ref ? ref.time : 0);
    const ph = (tr % 1.6) / 1.6;
    rings.forEach((r, i) => {
      if (!r) return;
      const q = (ph + i * .5) % 1;
      r.material.opacity = kd > 0 ? .8 * (1 - q) : 0;
    });

    updateCamera(u);
    renderer.render(scene, camera);
  });
}