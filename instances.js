// Instance Gallery: one annotated instance per fine class, the street-view crop it was annotated
// from on the left and its LiDAR points on the right. Assets and the manifest come from
// instances/build_instance_gallery.py. The viewer follows the scene viewer's conventions (app.js:
// z-up, 8-bit sRGB colour tables, turntable that pauses while you drag) but stays lighter: an
// instance is at most 150k points / 2 MB, so it is fetched and parsed on the main thread with a
// streamed progress bar, and only the selected instance is ever downloaded.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const MANIFEST_URL = 'assets/instances/instances.json';
const ASSET_VERSION = 'v=11';        // cache tag on the instance files; bump with each rebuild
const CACHE_LIMIT = 6;              // parsed instances kept in memory
const RESUME_ROTATE_MS = 4000;
// 'utonia' = per-point PCA of frozen Utonia features, shipped as red/green/blue in the PLY
// (instances/tools/utonia_pca_instances.py); the button is disabled for a cloud without them.
const MODES = [['intensity', 'Intensity'], ['height', 'Height'], ['class', 'Class colour'], ['utonia', 'Utonia PCA']];

const root = document.getElementById('instance-gallery');
if (root) {
  main().catch((err) => {
    console.error(err);
    root.innerHTML = `<p class="muted">The instance gallery could not load (${escapeHtml(err.message)}).</p>`;
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatCount(value) {
  return Number(value).toLocaleString('en-US');
}

function colorCss([r, g, b]) {
  return `rgb(${r}, ${g}, ${b})`;
}

// Ring marker (white halo, class-colour ring, white centre dot) as SVG for the photo and as a
// canvas texture for the 3D sprite, so both panes carry the same mark.
function ringSvg([x, y], color) {
  return `<circle cx="${x}" cy="${y}" r="26" fill="none" stroke="#fff" stroke-width="6"/>
          <circle cx="${x}" cy="${y}" r="26" fill="none" stroke="${colorCss(color)}" stroke-width="3"/>
          <circle cx="${x}" cy="${y}" r="4" fill="#fff"/>`;
}

const ringTextures = new Map();
function ringTexture(color) {
  const key = color.join(',');
  if (ringTextures.has(key)) return ringTextures.get(key);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.lineWidth = 14; ctx.strokeStyle = '#fff';
  ctx.beginPath(); ctx.arc(64, 64, 42, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 7; ctx.strokeStyle = colorCss(color);
  ctx.beginPath(); ctx.arc(64, 64, 42, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(64, 64, 7, 0, Math.PI * 2); ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  ringTextures.set(key, tex);
  return tex;
}

// Turbo colour map (Google's polynomial fit), 256 x RGB. Same look as the intensity renders in
// the annotation reference material, without jet's dead bands.
const TURBO = (() => {
  const R = [0.13572138, 4.61539260, -42.66032258, 132.13108234, -152.94239396, 59.28637943];
  const G = [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604];
  const B = [0.10667330, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973];
  const poly = (c, x) => c[0] + x * (c[1] + x * (c[2] + x * (c[3] + x * (c[4] + x * c[5]))));
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    lut[3 * i] = Math.max(0, Math.min(255, Math.round(255 * poly(R, x))));
    lut[3 * i + 1] = Math.max(0, Math.min(255, Math.round(255 * poly(G, x))));
    lut[3 * i + 2] = Math.max(0, Math.min(255, Math.round(255 * poly(B, x))));
  }
  return lut;
})();

// Binary little-endian PLY as written by build_instance_gallery.py (x y z float32, intensity
// uchar); the property list is read from the header so other layouts still parse.
function parsePly(buffer) {
  const bytes = new Uint8Array(buffer);
  const marker = new TextEncoder().encode('end_header\n');
  let headerEnd = -1;
  for (let i = 0; i < Math.min(bytes.length, 8192) - marker.length; i++) {
    let hit = true;
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) { hit = false; break; }
    if (hit) { headerEnd = i + marker.length; break; }
  }
  if (headerEnd < 0) throw new Error('not a PLY file');
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd));
  if (!/format binary_little_endian/.test(header)) throw new Error('unsupported PLY format');
  const count = parseInt((header.match(/element vertex (\d+)/) || [])[1], 10);
  const sizes = { float: 4, float32: 4, double: 8, float64: 8, uchar: 1, uint8: 1, char: 1, int8: 1, ushort: 2, uint16: 2, short: 2, int16: 2, uint: 4, uint32: 4, int: 4, int32: 4 };
  const offsets = {};
  let stride = 0;
  for (const m of header.matchAll(/property (\w+) (\w+)/g)) {
    offsets[m[2]] = { at: stride, type: m[1] };
    stride += sizes[m[1]];
  }
  if (!offsets.x || !offsets.y || !offsets.z) throw new Error('PLY without xyz');
  const view = new DataView(buffer, headerEnd);
  const position = new Float32Array(count * 3);
  const intensity = new Uint8Array(count);
  const hasRgb = offsets.red && offsets.green && offsets.blue;
  const rgb = hasRgb ? new Uint8Array(count * 3) : null;
  const ox = offsets.x.at, oy = offsets.y.at, oz = offsets.z.at;
  const oi = offsets.intensity ? offsets.intensity.at : -1;
  const or = hasRgb ? offsets.red.at : 0, og = hasRgb ? offsets.green.at : 0, ob = hasRgb ? offsets.blue.at : 0;
  // positions: float32, or ushort steps over the instance box (`comment quant ox oy oz sx sy sz`,
  // x = ox + q * sx), which is how build_instance_gallery.py writes them (10 bytes per point, not 16)
  const quant = (header.match(/comment quant (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)/) || []).slice(1).map(Number);
  const q16 = offsets.x.type === 'ushort' || offsets.x.type === 'uint16';
  if (q16 && quant.length !== 6) throw new Error('ushort PLY without quant comment');
  const [qx, qy, qz, sx, sy, sz] = q16 ? quant : [0, 0, 0, 1, 1, 1];
  for (let i = 0, b = 0; i < count; i++, b += stride) {
    if (q16) {
      position[3 * i] = qx + view.getUint16(b + ox, true) * sx;
      position[3 * i + 1] = qy + view.getUint16(b + oy, true) * sy;
      position[3 * i + 2] = qz + view.getUint16(b + oz, true) * sz;
    } else {
      position[3 * i] = view.getFloat32(b + ox, true);
      position[3 * i + 1] = view.getFloat32(b + oy, true);
      position[3 * i + 2] = view.getFloat32(b + oz, true);
    }
    intensity[i] = oi >= 0 ? view.getUint8(b + oi) : 128;
    if (rgb) {
      rgb[3 * i] = view.getUint8(b + or);
      rgb[3 * i + 1] = view.getUint8(b + og);
      rgb[3 * i + 2] = view.getUint8(b + ob);
    }
  }
  return { count, position, intensity, rgb };
}

// One 8-bit sRGB RGBA table per colour mode (decoded to linear in the vertex shader, as in app.js).
function colorTables(parsed, inst) {
  const n = parsed.count;
  const tables = { intensity: new Uint8Array(n * 4), height: new Uint8Array(n * 4), class: new Uint8Array(n * 4) };
  const step = Math.max(1, Math.floor(n / 20000));
  const zs = [];
  for (let i = 0; i < n; i += step) zs.push(parsed.position[3 * i + 2]);
  zs.sort((a, b) => a - b);
  const z0 = zs[Math.floor(zs.length * 0.02)];
  const z1 = Math.max(zs[Math.floor(zs.length * 0.98)], z0 + 1e-3);
  const [cr, cg, cb] = inst.color;
  for (let i = 0; i < n; i++) {
    const o = 4 * i;
    const v = 3 * parsed.intensity[i];
    tables.intensity[o] = TURBO[v]; tables.intensity[o + 1] = TURBO[v + 1]; tables.intensity[o + 2] = TURBO[v + 2]; tables.intensity[o + 3] = 255;
    const h = 3 * Math.max(0, Math.min(255, Math.round((parsed.position[3 * i + 2] - z0) / (z1 - z0) * 255)));
    tables.height[o] = TURBO[h]; tables.height[o + 1] = TURBO[h + 1]; tables.height[o + 2] = TURBO[h + 2]; tables.height[o + 3] = 255;
    tables.class[o] = cr; tables.class[o + 1] = cg; tables.class[o + 2] = cb; tables.class[o + 3] = 255;
  }
  if (parsed.rgb) {
    tables.utonia = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      tables.utonia[4 * i] = parsed.rgb[3 * i]; tables.utonia[4 * i + 1] = parsed.rgb[3 * i + 1];
      tables.utonia[4 * i + 2] = parsed.rgb[3 * i + 2]; tables.utonia[4 * i + 3] = 255;
    }
  }
  return new Map(Object.entries(tables).map(([mode, bytes]) => [mode, new THREE.BufferAttribute(bytes, 4, true)]));
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// onProgress(phase, loaded, total), phases as in the scene viewer: download -> parse -> colours.
// Parsing runs on this thread, so each phase change waits a frame for the panel to repaint.
async function fetchParsed(inst, onProgress) {
  const res = await fetch(`${inst.ply}?${ASSET_VERSION}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${inst.ply}`);
  // progress against the decoded size from the manifest: the server gzips, so Content-Length
  // (when present) undercounts what the reader delivers
  const total = inst.ply_bytes || Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress('download', loaded, total);
  }
  const buf = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  onProgress('parse', loaded, loaded);
  await nextFrame();
  return parsePly(buf.buffer);
}

class InstanceViewer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0f14);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.camera.up.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 0.8;
    this.controls.autoRotateSpeed = 1.5;
    this.rotateWanted = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.controls.autoRotate = this.rotateWanted;
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      clearTimeout(this.resumeTimer);
    });
    this.controls.addEventListener('end', () => {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = setTimeout(() => { this.controls.autoRotate = this.rotateWanted; }, RESUME_ROTATE_MS);
    });

    this.material = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, alphaTest: 0.5 });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>',
        '#include <color_vertex>\n\tvColor.rgb = mix(vColor.rgb / 12.92, pow((vColor.rgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), vColor.rgb));');
    };
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.scene.add(this.points);
    // constant-screen-size ring at the author's pointer (see setMarker)
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({ sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
    this.marker.scale.set(0.06, 0.06, 1);
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    this.markerWanted = true;    // on by default (author 2026-10-28); the Pointer button hides it
    this.markerAt = null;
    this.scene.add(this.marker);
    this.mode = 'intensity';
    this.current = null;
    this.records = new Map();   // slug -> record, most recently shown last
    this.loads = new Map();     // slug -> promise
    this.clock = new THREE.Clock();
    new ResizeObserver(() => this.resize()).observe(container);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.animate();
  }

  // Parsed record for an instance: from memory, or fetched (joined if already in flight).
  // A load joined later (a click on a prefetching instance) still gets its progress: every caller's
  // callback is kept on the load, and the latest state is replayed to a newcomer.
  fetchRecord(inst, onProgress) {
    const cached = this.records.get(inst.slug);
    if (cached) return Promise.resolve(cached);
    let load = this.loads.get(inst.slug);
    if (!load) {
      load = { listeners: new Set(), state: ['download', 0, inst.ply_bytes || 0] };
      const emit = (...state) => { load.state = state; for (const fn of load.listeners) fn(...state); };
      load.promise = fetchParsed(inst, emit).then(async (parsed) => {
        emit('colours', parsed.count, parsed.count);
        await nextFrame();
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(parsed.position, 3));
        geometry.computeBoundingBox();
        const record = { slug: inst.slug, count: parsed.count, geometry, colors: colorTables(parsed, inst), bbox: geometry.boundingBox };
        this.records.set(inst.slug, record);
        this.loads.delete(inst.slug);
        return record;
      }, (err) => { this.loads.delete(inst.slug); throw err; });
      this.loads.set(inst.slug, load);
    }
    if (onProgress) {
      load.listeners.add(onProgress);
      onProgress(...load.state);
    }
    return load.promise;
  }

  show(record, inst) {
    this.current = record;
    this.points.geometry = record.geometry;
    this.applyMode();
    this.frame(record, inst);
    this.setMarker(inst.pointer && inst.pointer.cloud, inst.color);
    this.records.delete(record.slug);
    this.records.set(record.slug, record);
    for (const slug of [...this.records.keys()]) {
      if (this.records.size <= CACHE_LIMIT) break;
      if (slug !== record.slug) this.evict(slug);
    }
  }

  evict(slug) {
    const record = this.records.get(slug);
    if (!record) return;
    this.records.delete(slug);
    for (const [mode, attr] of record.colors) record.geometry.setAttribute(`color_${mode}`, attr);
    record.geometry.dispose();
  }

  setMarker(p, color) {
    this.markerAt = p || null;
    this.marker.visible = Boolean(p) && this.markerWanted;
    if (!p) return;
    this.marker.material.map = ringTexture(color);
    this.marker.material.needsUpdate = true;
    this.marker.position.set(p[0], p[1], p[2]);
  }

  // the Pointer toggle: the ring stays placed per instance, only its visibility follows the button
  setMarkerWanted(on) {
    this.markerWanted = on;
    this.marker.visible = on && Boolean(this.markerAt);
  }

  setMode(mode) {
    this.mode = mode;
    this.applyMode();
  }

  applyMode() {
    const record = this.current;
    if (!record) return;
    const attr = record.colors.get(this.mode) || record.colors.get('intensity');
    if (attr && record.geometry.getAttribute('color') !== attr) record.geometry.setAttribute('color', attr);
  }

  setPointSize(size) {
    this.material.size = size;
  }

  setAutoRotate(on) {
    this.rotateWanted = on;
    clearTimeout(this.resumeTimer);
    this.controls.autoRotate = on;
  }

  // Camera on the scanned side of the object (manifest azimuth; +x when the side is undecided),
  // slightly above, far enough for the bounding sphere.
  frame(record, inst) {
    const center = record.bbox.getCenter(new THREE.Vector3());
    const radius = Math.max(record.bbox.getSize(new THREE.Vector3()).length() / 2, 0.3);
    const az = THREE.MathUtils.degToRad(inst.view_azimuth_deg ?? 0);
    const el = THREE.MathUtils.degToRad(18);
    const fov = THREE.MathUtils.degToRad(this.camera.fov) * Math.min(1, this.camera.aspect);
    const d = radius / Math.sin(fov / 2) * 1.05;
    this.camera.position.set(
      center.x + d * Math.cos(el) * Math.cos(az),
      center.y + d * Math.cos(el) * Math.sin(az),
      center.z + d * Math.sin(el),
    );
    this.camera.near = Math.max(0.01, d * 0.01);
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.home = { pos: this.camera.position.clone(), target: center.clone() };
  }

  resetView() {
    if (!this.home) return;
    this.camera.position.copy(this.home.pos);
    this.controls.target.copy(this.home.target);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update(Math.min(this.clock.getDelta(), 0.1));
    this.renderer.render(this.scene, this.camera);
  };
}

function template() {
  return `
    <div class="ig-classes" role="tablist" aria-label="Coarse class"></div>
    <div class="ig-fine" role="tablist" aria-label="Fine class"></div>
    <div class="ig-card">
      <figure class="ig-photo">
        <img alt="" />
        <div class="ig-photo-pending" hidden>Photo pending<small>the street-view crop for this instance is being replaced</small></div>
        <svg class="ig-pointer" viewBox="0 0 1024 1024" preserveAspectRatio="none" aria-hidden="true"></svg>
        <figcaption></figcaption>
      </figure>
      <div class="ig-3d">
        <div class="ig-canvas" aria-label="Instance point cloud"></div>
        <div class="ig-hud"></div>
        <div class="viewer-loading" hidden>
          <div class="viewer-loading-box" role="status" aria-live="polite">
            <div class="title"></div>
            <div class="bar"><span></span></div>
            <div class="detail"></div>
            <button type="button" class="btn small retry" hidden>Retry</button>
          </div>
        </div>
      </div>
    </div>
    <div class="ig-bar">
      <div class="ig-seg" role="group" aria-label="Colour mode">${MODES.map(([id, label]) => `<button type="button" data-mode="${id}">${label}</button>`).join('')}</div>
      <label class="range" title="Point size">Size <input class="ig-size" type="range" min="1" max="5" step="0.5" value="2" /></label>
      <button type="button" class="btn small toggle-btn ig-rotate" title="Slow turntable; pauses while you drag">&#10227; Auto-rotate</button>
      <button type="button" class="btn small toggle-btn ig-pointer-btn active" aria-pressed="true" title="Mark the same spot in the photo and in the 3D view">&#9678; Pointer</button>
      <button type="button" class="btn small ig-reset" title="Back to the opening view">&#10226; Reset view</button>
      <button type="button" class="btn small ig-fullscreen" title="Full-screen gallery (Esc exits)">&#9974; Full screen</button>
      <span class="ig-info"></span>
    </div>`;
}

async function main() {
  const res = await fetch(`${MANIFEST_URL}?${ASSET_VERSION}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for the manifest`);
  const manifest = await res.json();
  const instances = manifest.instances;
  const bySlug = new Map(instances.map((i) => [i.slug, i]));

  root.innerHTML = template();
  const el = {
    classes: root.querySelector('.ig-classes'),
    fine: root.querySelector('.ig-fine'),
    card: root.querySelector('.ig-card'),
    photo: root.querySelector('.ig-photo'),
    img: root.querySelector('.ig-photo img'),
    pending: root.querySelector('.ig-photo-pending'),
    pointer: root.querySelector('.ig-pointer'),
    caption: root.querySelector('.ig-photo figcaption'),
    canvas: root.querySelector('.ig-canvas'),
    hud: root.querySelector('.ig-hud'),
    loading: root.querySelector('.ig-3d .viewer-loading'),
    loadingTitle: root.querySelector('.ig-3d .viewer-loading .title'),
    loadingFill: root.querySelector('.ig-3d .viewer-loading .bar span'),
    loadingDetail: root.querySelector('.ig-3d .viewer-loading .detail'),
    loadingRetry: root.querySelector('.ig-3d .viewer-loading .retry'),
    info: root.querySelector('.ig-info'),
    modes: [...root.querySelectorAll('.ig-seg button')],
    size: root.querySelector('.ig-size'),
    rotate: root.querySelector('.ig-rotate'),
    pointerBtn: root.querySelector('.ig-pointer-btn'),
    reset: root.querySelector('.ig-reset'),
    fullscreen: root.querySelector('.ig-fullscreen'),
  };
  let showPointer = true;
  const viewer = new InstanceViewer(el.canvas);
  let coarse = manifest.classes[0].name;
  let current = null;
  let token = 0;

  function hud(text, hold = false) {
    el.hud.textContent = text;
    el.hud.classList.toggle('show', Boolean(text));
    clearTimeout(hud.timer);
    if (text && !hold) hud.timer = setTimeout(() => el.hud.classList.remove('show'), 1800);
  }

  function renderClasses() {
    el.classes.innerHTML = manifest.classes.map((c) => `
      <button type="button" class="ig-chip${c.name === coarse ? ' active' : ''}" role="tab" aria-selected="${c.name === coarse}" data-coarse="${escapeHtml(c.name)}">
        <span class="sw" style="background:${colorCss(c.color)}"></span>${escapeHtml(c.name)} <small>${c.fine.length}</small>
      </button>`).join('');
  }

  function renderFine() {
    const items = instances.filter((i) => i.coarse === coarse);
    el.fine.innerHTML = items.map((i) => `
      <button type="button" class="ig-fine-chip${current && i.slug === current.slug ? ' active' : ''}" role="tab" aria-selected="${current && i.slug === current.slug}" data-slug="${i.slug}" title="${escapeHtml(i.fine)}">
        ${i.thumb ? `<img src="${i.thumb}?${ASSET_VERSION}" alt="" loading="lazy" width="96" height="72" />`
                  : `<span class="ig-nophoto" style="background:${colorCss(i.color)}" title="photo pending"></span>`}
        <span>${escapeHtml(i.fine)}</span>
      </button>`).join('');
    // scroll the strip, not the page (scrollIntoView would pull the page down to the gallery on load)
    const active = el.fine.querySelector('.active');
    if (active) el.fine.scrollTo({ left: active.offsetLeft - el.fine.clientWidth / 2 + active.offsetWidth / 2, behavior: 'smooth' });
  }

  function paintPointer(inst) {
    const p = inst.photo && inst.pointer && inst.pointer.photo;
    el.pointer.innerHTML = p && showPointer ? ringSvg(p, inst.color) : '';
    el.caption.textContent = inst.photo
      ? `${inst.fine}: street-view crop, framed on the instance${p && showPointer ? '; the ring marks the same spot as in the 3D view' : ''}`
      : `${inst.fine}: street-view crop pending`;
  }

  function paintInfo(inst, record) {
    const [dx, dy, dz] = inst.extent_m;
    const points = record ? (inst.n_source > inst.n_points
      ? `${formatCount(inst.n_points)} of ${formatCount(inst.n_source)} points shown`
      : `${formatCount(inst.n_points)} points`) : '';
    el.info.textContent = `${inst.fine} · ${inst.coarse}${points ? ` · ${points}` : ''} · ${dx} × ${dy} × ${dz} m`;
  }

  async function select(slug) {
    const inst = bySlug.get(slug);
    if (!inst || (current && current.slug === slug)) return;
    current = inst;
    const mine = ++token;
    if (inst.coarse !== coarse) { coarse = inst.coarse; renderClasses(); }
    renderFine();
    // photo (or the placeholder while a crop is being replaced)
    el.photo.classList.toggle('pending', !inst.photo);
    el.pending.hidden = Boolean(inst.photo);
    if (inst.photo) {
      // Never leave the previous instance's photo under this instance's ring: show this
      // instance's thumbnail at once (already loaded for the strip; the ring is in 1024-px photo
      // coordinates, so it sits right on it too), then swap in the full photo once it has arrived.
      // On a slow link the full photo can take seconds behind the scene viewer's download.
      const full = `${inst.photo}?${ASSET_VERSION}`;
      el.photo.classList.add('loading');
      el.img.onload = null;
      el.img.src = `${inst.thumb}?${ASSET_VERSION}`;
      el.img.alt = `Street-view crop around a ${inst.fine} instance`;
      const pre = new Image();
      pre.onload = () => {
        if (current !== inst) return;
        el.img.src = full;
        el.photo.classList.remove('loading');
      };
      pre.src = full;
    } else {
      el.photo.classList.remove('loading');
      el.img.removeAttribute('src');
      el.img.alt = '';
    }
    paintPointer(inst);
    paintInfo(inst, null);
    // points: the scene viewer's loading panel over the 3D pane (the previous instance stays
    // underneath, dimmed and turning); a cached instance shows at once
    if (!viewer.records.has(slug)) loading.show(inst);
    try {
      const record = await viewer.fetchRecord(inst, (phase, loaded, total) => {
        if (mine === token) loading.progress(inst, phase, loaded, total);
      });
      if (mine !== token) return;
      viewer.show(record, inst);
      loading.hide();
      paintInfo(inst, record);
      // the Utonia PCA button follows the cloud; a cloud without the colours falls back to intensity
      const utoniaBtn = el.modes.find((b) => b.dataset.mode === 'utonia');
      utoniaBtn.disabled = !record.colors.has('utonia');
      utoniaBtn.title = utoniaBtn.disabled ? 'No Utonia PCA colours for this instance' : 'PCA of frozen Utonia features, one fit over all instances';
      for (const b of el.modes) b.classList.toggle('active', b.dataset.mode === (record.colors.has(viewer.mode) ? viewer.mode : 'intensity'));
      prefetchNeighbours(inst);
    } catch (err) {
      if (mine !== token) return;
      console.error(err);
      loading.fail(inst, err);
    }
  }

  // Same panel, wording and phases as the scene viewer (app.js loadingUi): download with a
  // percentage against the decoded size, then reading the points, then the colour modes.
  const loading = {
    show(inst) {
      el.loadingTitle.textContent = `Loading ${inst.fine}`;
      el.loading.classList.remove('failed');
      el.loadingRetry.hidden = true;
      el.loading.hidden = false;
      this.progress(inst, 'download', 0, inst.ply_bytes || 0);
    },
    progress(inst, phase, loaded, total) {
      const share = total > 0 ? Math.min(1, loaded / total) : 0;
      el.loadingFill.style.width = `${Math.round(share * 100)}%`;
      if (phase === 'download') {
        el.loadingDetail.textContent = total > 0
          ? `Downloading ${Math.round(share * 100)}% · ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
          : `Downloading ${(loaded / 1e6).toFixed(1)} MB`;
      } else if (phase === 'parse') {
        el.loadingDetail.textContent = `Reading ${formatCount(inst.n_points)} points`;
      } else {
        el.loadingDetail.textContent = 'Preparing colour modes';
      }
    },
    fail(inst, err) {
      el.loadingTitle.textContent = `Could not load ${inst.fine}`;
      el.loadingDetail.textContent = err && err.message ? err.message : 'Unknown error';
      el.loading.classList.add('failed');
      el.loadingRetry.hidden = false;
      el.loading.hidden = false;
    },
    hide() {
      el.loading.hidden = true;
    },
  };
  el.loadingRetry.addEventListener('click', () => {
    const slug = current && current.slug;
    current = null;
    if (slug) select(slug);
  });

  // the previous and next instance, so arrow keys and the next chip feel instant
  function prefetchNeighbours(inst) {
    const k = instances.indexOf(inst);
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
    idle(() => {
      for (const j of [k + 1, k - 1]) {
        const n = instances[j];
        if (n && !viewer.records.has(n.slug) && !viewer.loads.has(n.slug) && n.ply_bytes < 1.2e6) viewer.fetchRecord(n).catch(() => {});
      }
    });
  }

  function setMode(mode) {
    viewer.setMode(mode);
    for (const b of el.modes) b.classList.toggle('active', b.dataset.mode === mode);
    hud(MODES.find(([id]) => id === mode)[1]);
  }

  // events
  el.classes.addEventListener('click', (e) => {
    const b = e.target.closest('[data-coarse]');
    if (!b) return;
    const first = instances.find((i) => i.coarse === b.dataset.coarse);
    if (first) select(first.slug);
  });
  el.fine.addEventListener('click', (e) => {
    const b = e.target.closest('[data-slug]');
    if (b) select(b.dataset.slug);
  });
  for (const b of el.modes) b.addEventListener('click', () => setMode(b.dataset.mode));
  el.size.addEventListener('input', () => viewer.setPointSize(parseFloat(el.size.value)));
  el.rotate.addEventListener('click', () => {
    const on = !el.rotate.classList.contains('active');
    el.rotate.classList.toggle('active', on);
    viewer.setAutoRotate(on);
  });
  el.reset.addEventListener('click', () => viewer.resetView());
  // Full screen takes the whole gallery (class chips, strip, card, toolbar), so browsing works
  // there too; Esc exits. iPhone Safari has no element full screen, so the button hides there.
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled)) el.fullscreen.hidden = true;
  el.fullscreen.addEventListener('click', () => {
    if (fsElement() === root) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
  });
  const onFullscreen = () => {
    const on = fsElement() === root;
    el.fullscreen.innerHTML = on ? '&#9974; Exit full screen' : '&#9974; Full screen';
    el.fullscreen.classList.toggle('active', on);
    viewer.resize();
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);
  el.pointerBtn.addEventListener('click', () => {
    showPointer = !showPointer;
    el.pointerBtn.classList.toggle('active', showPointer);
    el.pointerBtn.setAttribute('aria-pressed', String(showPointer));
    viewer.setMarkerWanted(showPointer);
    if (current) paintPointer(current);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.target.closest('input, select, textarea')) return;
    e.preventDefault();
    const k = instances.indexOf(current);
    const next = instances[(k + (e.key === 'ArrowRight' ? 1 : -1) + instances.length) % instances.length];
    select(next.slug);
  });

  el.rotate.classList.toggle('active', viewer.rotateWanted);
  setMode('intensity');
  renderClasses();
  // open on the car: a shape everyone reads at a glance (the palette order would start on a ground strip)
  await select(bySlug.has('vehicle_car') ? 'vehicle_car' : instances[0].slug);
}
