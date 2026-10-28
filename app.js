import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

const DATA_URL = 'assets/bhopal_project_data.json?v=28';
const CLOUD_VERSION = 'v=26';    // cache tag on the scene files
const RESUME_ROTATE_MS = 4000;   // auto-rotate resumes this long after a drag ends
const STUFF68 = [0, 1, 2, 3, 4, 5, 6, 7, 13, 14];        // 68-class ids without instances (stuff)
const MOVING68 = [29, 30, 31, 62, 63, 64, 65, 66, 67];   // moving-object classes, hidden in every mode but 68c
// Loaded scenes stay in memory, so switching back is instant. Each costs about 45 MB of JS heap
// plus 12 MB of GPU memory, and 4 MB more per colour mode viewed; low-memory devices keep one.
const SCENE_CACHE_LIMIT = navigator.deviceMemory && navigator.deviceMemory <= 4 ? 1 : 3;

const mount = document.getElementById('cloud-viewer');
const viewerShell = document.getElementById('viewer');
const hud = document.getElementById('viewer-hud');
const toolbar = document.getElementById('viewer-toolbar');
const legendEl = document.getElementById('viewer-legend');
const sceneCards = document.getElementById('scene-cards');
const sceneInfo = document.getElementById('scene-info');
const pointSizeInput = document.getElementById('point-size');
const resetButton = document.getElementById('reset-view');
const fullscreenButton = document.getElementById('fullscreen-view');
const taxonomyPanels = document.getElementById('taxonomy-panels');
const toolbarHome = toolbar.parentElement;
const legendHome = legendEl.parentElement;

let data = null;
let activeScene = null;
let viewer = null;
let wantedId = null;        // the scene the user asked for last
const paletteById = {};     // mode -> array indexed by class id -> [r, g, b] (sRGB bytes)

function colorCss(color) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function formatCount(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString();
}

function pct(value) {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function classListCell(items) {
  if (!items || !items.length) return '<span class="muted">-</span>';
  return `<span class="combined-list">${items.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</span>`;
}

function modeLabel(mode) {
  return ({ rgb: 'RGB', '12c': '12-class', '21c': '21-class', '62c': '62-class', '68c': '68-class', instance: 'Instance IDs' })[mode] || mode;
}

function hudMessage(text, hold = false) {
  hud.textContent = text;
  hud.classList.add('show');
  window.clearTimeout(hudMessage.timer);
  if (!hold) {
    hudMessage.timer = window.setTimeout(() => hud.classList.remove('show'), 1200);
  }
}

function hideHud() {
  hud.classList.remove('show');
}

function paletteColorsById(palette) {
  const map = [];
  for (const entry of palette) map[entry.id] = entry.color;
  return map;
}

function formatMB(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

// Deterministic per-instance tint of the class colour; sRGB bytes in and out. Shared by the
// worker (per-point colours) and the page (click labels), so the two always agree.
function instanceTint(instanceId, classId, colorById) {
  const base = colorById[classId] || [188, 191, 196];
  if (instanceId < 0) return base;
  let x = (instanceId * 2654435761) >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  const dh = ((((x >>> 0) & 255) / 255) - 0.5) * 0.10;
  const ds = ((((x >>> 8) & 255) / 255) - 0.5) * 0.22;
  const dl = ((((x >>> 16) & 255) / 255) - 0.5) * 0.30;
  const r = base[0] / 255, g = base[1] / 255, b = base[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  h = ((h + dh) % 1 + 1) % 1;
  s = Math.min(1, Math.max(0, s + ds));
  const l2 = Math.min(1, Math.max(0, l + dl));
  if (s === 0) {
    const v = Math.round(l2 * 255);
    return [v, v, v];
  }
  const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
  const p = 2 * l2 - q;
  const channel = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(channel(h + 1 / 3) * 255), Math.round(channel(h) * 255), Math.round(channel(h - 1 / 3) * 255)];
}

// Body of the scene-loading Web Worker. It streams a binary PLY, reports download progress
// against the exact decoded size from the file's own header (the page is served gzipped, so
// Content-Length would be the compressed size), decodes the vertices and builds the 8-bit colour
// table of every mode, then hands everything to the page as transferable buffers. The page
// thread never touches a point, so the viewer keeps turning while a scene loads. Runs from a
// Blob URL (an import map does not reach workers), so it must stay self-contained apart from
// instanceTint, which is bundled alongside.
function workerMain() {
  const TYPE_SIZE = {
    char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
    int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
  };
  const FALLBACK = [188, 191, 196];

  function parseHeader(bytes) {
    const text = new TextDecoder('windows-1252').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const at = text.indexOf('end_header');
    if (at < 0) return null;   // not all of the header has arrived yet
    let dataOffset = at + 'end_header'.length;
    if (text.charCodeAt(dataOffset) === 13) dataOffset += 1;
    if (text.charCodeAt(dataOffset) === 10) dataOffset += 1;
    const lines = text.slice(0, at).split(/\r?\n/);
    if (lines[0].trim() !== 'ply') throw new Error('not a PLY file');
    let littleEndian = null;
    let count = 0;
    let inVertex = false;
    let stride = 0;
    const props = [];
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'format') {
        if (parts[1] === 'binary_little_endian') littleEndian = true;
        else if (parts[1] === 'binary_big_endian') littleEndian = false;
        else throw new Error(`unsupported PLY format ${parts[1]}`);
      } else if (parts[0] === 'element') {
        inVertex = parts[1] === 'vertex';
        if (inVertex) count = parseInt(parts[2], 10);
        else if (props.length) break;   // elements after the vertices follow them in the file; ignored
        else if (parseInt(parts[2], 10) > 0) throw new Error(`unsupported PLY element before vertices: ${parts[1]}`);
      } else if (parts[0] === 'property' && inVertex) {
        if (parts[1] === 'list') throw new Error('unsupported PLY list property on vertices');
        const size = TYPE_SIZE[parts[1]];
        if (!size) throw new Error(`unknown PLY type ${parts[1]}`);
        props.push({ name: parts[2], type: parts[1], size, offset: stride });
        stride += size;
      }
    }
    if (littleEndian === null || !count || !props.length) throw new Error('incomplete PLY header');
    return { dataOffset, count, stride, props, littleEndian, totalBytes: dataOffset + count * stride };
  }

  function readerFor(view, prop, littleEndian) {
    switch (prop.type) {
      case 'char': case 'int8': return (o) => view.getInt8(o);
      case 'uchar': case 'uint8': return (o) => view.getUint8(o);
      case 'short': case 'int16': return (o) => view.getInt16(o, littleEndian);
      case 'ushort': case 'uint16': return (o) => view.getUint16(o, littleEndian);
      case 'int': case 'int32': return (o) => view.getInt32(o, littleEndian);
      case 'uint': case 'uint32': return (o) => view.getUint32(o, littleEndian);
      case 'float': case 'float32': return (o) => view.getFloat32(o, littleEndian);
      default: return (o) => view.getFloat64(o, littleEndian);
    }
  }

  function parseVertices(bytes, header) {
    if (bytes.byteLength < header.totalBytes) {
      throw new Error(`file truncated: ${bytes.byteLength} of ${header.totalBytes} bytes`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { count: n, stride, littleEndian } = header;
    const byName = new Map(header.props.map((p) => [p.name, p]));
    const reader = (name, required) => {
      const prop = byName.get(name);
      if (!prop) {
        if (required) throw new Error(`PLY has no '${name}' property`);
        return null;
      }
      const read = readerFor(view, prop, littleEndian);
      const off = prop.offset;
      const isFloat = prop.type.startsWith('float') || prop.type.startsWith('double');
      const scale = isFloat && /^(red|green|blue)$/.test(name) ? 255 : 1;   // float colours are 0..1
      return scale === 1 ? (o) => read(o + off) : (o) => read(o + off) * scale;
    };
    const rx = reader('x', true), ry = reader('y', true), rz = reader('z', true);
    const rr = reader('red'), rg = reader('green'), rb = reader('blue');
    const r12 = reader('label12'), r21 = reader('label21'), r68 = reader('label68'), ri = reader('instance');
    const position = new Float32Array(n * 3);
    const rgb = new Uint8Array(n * 3);
    const label12 = new Int16Array(n), label21 = new Int16Array(n), label68 = new Int16Array(n);
    const instance = new Int32Array(n);
    for (let i = 0, o = header.dataOffset; i < n; i += 1, o += stride) {
      position[3 * i] = rx(o);
      position[3 * i + 1] = ry(o);
      position[3 * i + 2] = rz(o);
      if (rr) {
        rgb[3 * i] = rr(o);
        rgb[3 * i + 1] = rg ? rg(o) : 0;
        rgb[3 * i + 2] = rb ? rb(o) : 0;
      }
      label12[i] = r12 ? r12(o) : -1;
      label21[i] = r21 ? r21(o) : -1;
      label68[i] = r68 ? r68(o) : -1;
      instance[i] = ri ? ri(o) : -1;
    }
    return { position, rgb, hasRgb: !!rr, label12, label21, label68, instance };
  }

  // One RGBA byte table per colour mode; alpha 0 hides moving objects (every mode but 68c).
  function buildTables(v, palettes, moving, stuff) {
    const n = v.label68.length;
    const hidden = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) if (moving.has(v.label68[i])) hidden[i] = 1;
    const tables = {};
    const fill = (key, labels, colorById, hideMoving) => {
      const out = new Uint8Array(n * 4);
      for (let i = 0, j = 0; i < n; i += 1, j += 4) {
        const c = (labels[i] >= 0 && colorById[labels[i]]) || FALLBACK;
        out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2];
        out[j + 3] = hideMoving && hidden[i] ? 0 : 255;
      }
      tables[key] = out;
    };
    if (v.hasRgb) {
      const out = new Uint8Array(n * 4);
      for (let i = 0, j = 0, k = 0; i < n; i += 1, j += 4, k += 3) {
        out[j] = v.rgb[k]; out[j + 1] = v.rgb[k + 1]; out[j + 2] = v.rgb[k + 2];
        out[j + 3] = hidden[i] ? 0 : 255;
      }
      tables.rgb = out;
    }
    fill('12c', v.label12, palettes['12c'], true);
    fill('21c', v.label21, palettes['21c'], true);
    fill('62c', v.label68, palettes['68c'], true);
    fill('68c', v.label68, palettes['68c'], false);
    const inst = new Uint8Array(n * 4);
    const cache = new Map();
    for (let i = 0, j = 0; i < n; i += 1, j += 4) {
      const id = v.instance[i];
      const cls = v.label68[i];
      const semanticOnly = id < 0 || stuff.has(cls);
      const key = semanticOnly ? -2 - cls : id;   // cls >= -1 keeps these below every real id
      let c = cache.get(key);
      if (!c) {
        c = instanceTint(semanticOnly ? -1 : id, cls, palettes['68c']);
        cache.set(key, c);
      }
      inst[j] = c[0]; inst[j + 1] = c[1]; inst[j + 2] = c[2];
      inst[j + 3] = hidden[i] ? 0 : 255;
    }
    tables.instance = inst;
    return tables;
  }

  async function run(job) {
    const { id, url, palettes } = job;
    const moving = new Set(job.moving);
    const stuff = new Set(job.stuff);
    let loaded = 0;
    let total = job.expectedBytes || 0;
    const post = (phase) => self.postMessage({ type: 'progress', id, phase, loaded, total });

    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const chunks = [];
    let header = null;
    if (!response.body) {
      const whole = new Uint8Array(await response.arrayBuffer());
      chunks.push(whole);
      loaded = whole.byteLength;
    } else {
      const reader = response.body.getReader();
      let head = new Uint8Array(0);
      let lastPost = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (!header && head.length < 65536) {
          const grown = new Uint8Array(Math.min(65536, head.length + value.byteLength));
          grown.set(head, 0);
          grown.set(value.subarray(0, grown.length - head.length), head.length);
          head = grown;
          header = parseHeader(head);
          if (header) total = header.totalBytes;
        }
        const now = performance.now();
        if (now - lastPost >= 80) {
          lastPost = now;
          post('download');
        }
      }
    }
    post('download');
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    if (!header) header = parseHeader(bytes);
    if (!header) throw new Error('no PLY header found');
    total = header.totalBytes;
    post('parse');
    const v = parseVertices(bytes, header);
    post('colors');
    const colors = buildTables(v, palettes, moving, stuff);
    const transfer = [v.position.buffer, v.label12.buffer, v.label21.buffer, v.label68.buffer, v.instance.buffer,
      ...Object.values(colors).map((table) => table.buffer)];
    self.postMessage({
      type: 'done', id, count: header.count, position: v.position,
      label12: v.label12, label21: v.label21, label68: v.label68, instance: v.instance, colors,
    }, transfer);
  }

  self.onmessage = (event) => {
    const job = event.data;
    run(job).catch((error) => {
      self.postMessage({ type: 'error', id: job.id, message: error && error.message ? error.message : String(error) });
    });
  };
}

class SceneViewer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0f14);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const renderTarget = new THREE.WebGLRenderTarget(w, h);
    renderTarget.depthTexture = new THREE.DepthTexture();
    this.composer = new EffectComposer(this.renderer, renderTarget);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);
    const edlShader = {
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: renderTarget.depthTexture },
        resolution: { value: new THREE.Vector2(w, h) }
      },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform vec2 resolution; varying vec2 vUv;
        void main() {
          float d = texture2D(tDepth, vUv).r;
          if (d >= 1.0) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
          float sum = 0.0; vec2 dX = vec2(1.0 / resolution.x, 0.0); vec2 dY = vec2(0.0, 1.0 / resolution.y);
          sum += max(0.0, d - texture2D(tDepth, vUv + dX).r); sum += max(0.0, d - texture2D(tDepth, vUv - dX).r);
          sum += max(0.0, d - texture2D(tDepth, vUv + dY).r); sum += max(0.0, d - texture2D(tDepth, vUv - dY).r);
          float factor = exp(-sum * 15000.0); 
          vec4 col = texture2D(tDiffuse, vUv); gl_FragColor = vec4(col.rgb * factor, col.a);
        }
      `
    };
    this.edlPass = new ShaderPass(edlShader);
    this.composer.addPass(this.edlPass);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0px';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    this.container.appendChild(this.labelRenderer.domElement);

    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.zoomSpeed = 0.8;
    this.orbitControls.panSpeed = 1;
    this.orbitControls.maxPolarAngle = Math.PI * 0.55;
    // Slow turntable by default, as on the E3DE page: paused while the user drags and resumed
    // RESUME_ROTATE_MS after; held while Measure is on (two picks on a moving scene miss).
    this.orbitControls.autoRotateSpeed = 1.2;   // ~50 s per turn
    this.rotateWanted = true;
    this.orbitControls.autoRotate = true;
    this.orbitControls.addEventListener('start', () => {
      this.orbitControls.autoRotate = false;
      clearTimeout(this.resumeTimer);
    });
    this.orbitControls.addEventListener('end', () => {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = setTimeout(() => this.syncAutoRotate(), RESUME_ROTATE_MS);
    });

    this.edlEnabled = false;
    this.clock = new THREE.Clock();

    this.mode = '12c';
    this.pointSize = 1.6;
    this.material = new THREE.PointsMaterial({
      size: this.pointSize,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.5,
    });
    // Colour tables are 8-bit sRGB (4 bytes per point instead of 16). three.js reads vertex
    // colours as linear, so decode sRGB -> linear in the vertex shader.
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>',
        '#include <color_vertex>\n\tvColor.rgb = mix(vColor.rgb / 12.92, pow((vColor.rgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), vColor.rgb));');
    };
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);   // enters the scene with the first record
    this.current = null;         // scene record on screen
    this.records = new Map();    // scene id -> record; oldest shown first
    this.loads = new Map();      // scene id -> in-flight load
    this.onProgress = () => {};  // (id, phase, loaded, total)
    this.onLoaded = () => {};    // (id)
    this.onEvicted = () => {};   // (id)
    this.worker = this.createWorker();
    this.home = { pos: new THREE.Vector3(50, -50, 40), target: new THREE.Vector3(0, 0, 0) };
    
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 0.3;
    this.mouse = new THREE.Vector2();
    this.renderer.domElement.addEventListener('click', this.onClick.bind(this));
    
    this.interactMode = false;
    this.measureMode = false;
    this.measurePoints = [];
    this.measureLines = new THREE.Group();
    this.scene.add(this.measureLines);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1));
    new ResizeObserver(() => this.resize()).observe(this.container);
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('fullscreenchange', () => this.resize());
    this.resize();
    this.animate();
  }

  createWorker() {
    const source = `${instanceTint.toString()}\n${workerMain.toString()}\nworkerMain();`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.onmessage = (event) => this.onWorkerMessage(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || 'scene worker failed');
      for (const load of this.loads.values()) load.reject(error);
      this.loads.clear();
    };
    return worker;
  }

  onWorkerMessage(msg) {
    const load = this.loads.get(msg.id);
    if (!load) return;
    if (msg.type === 'progress') {
      Object.assign(load, { phase: msg.phase, loaded: msg.loaded, total: msg.total });
      this.onProgress(msg.id, msg.phase, msg.loaded, msg.total);
      return;
    }
    this.loads.delete(msg.id);
    if (msg.type === 'error') load.reject(new Error(msg.message));
    else load.resolve(this.makeRecord(msg));
  }

  // A record is everything the viewer keeps per scene: the geometry (positions + the colour
  // attribute on show), one colour attribute per mode, and the label arrays for click lookup.
  // Labels stay out of the geometry so they are never uploaded to the GPU.
  makeRecord(msg) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(msg.position, 3));
    const colors = new Map();
    for (const [mode, bytes] of Object.entries(msg.colors)) {
      colors.set(mode, new THREE.BufferAttribute(bytes, 4, true));
    }
    geometry.setAttribute('color', colors.get('12c') || colors.values().next().value);
    return {
      id: msg.id,
      count: msg.count,
      geometry,
      colors,
      labels: { label12: msg.label12, label21: msg.label21, label68: msg.label68, instance: msg.instance },
    };
  }

  // The scene's record: from memory, or from a background load (joined if already running).
  fetchScene(scene) {
    const cached = this.records.get(scene.id);
    if (cached) return Promise.resolve(cached);
    let load = this.loads.get(scene.id);
    if (!load) {
      load = { phase: 'download', loaded: 0, total: scene.ply_bytes || 0 };
      load.promise = new Promise((resolve, reject) => {
        load.resolve = resolve;
        load.reject = reject;
      }).then((record) => {
        this.records.set(record.id, record);
        this.onLoaded(record.id);
        return record;
      });
      this.loads.set(scene.id, load);
      this.worker.postMessage({
        id: scene.id,
        url: new URL(`${scene.ply}?${CLOUD_VERSION}`, document.baseURI).href,
        expectedBytes: scene.ply_bytes || 0,
        palettes: { '12c': paletteById['12c'], '21c': paletteById['21c'], '68c': paletteById['68c'] },
        moving: MOVING68,
        stuff: STUFF68,
      });
    }
    return load.promise;
  }

  isLoaded(sceneId) {
    return this.records.has(sceneId);
  }

  isLoading(sceneId) {
    return this.loads.has(sceneId);
  }

  show(record) {
    if (this.current === record) return;
    this.clearDynamicLabels();
    this.clearMeasure();
    this.current = record;
    this.points.geometry = record.geometry;
    if (!this.points.parent) this.scene.add(this.points);
    this.applyMode();
    this.frame(record.geometry);
    hideHud();
    // most recently shown last; drop the oldest beyond the cache limit
    this.records.delete(record.id);
    this.records.set(record.id, record);
    for (const id of [...this.records.keys()]) {
      if (this.records.size <= SCENE_CACHE_LIMIT) break;
      if (id !== record.id) this.evict(id);
    }
  }

  evict(sceneId) {
    const record = this.records.get(sceneId);
    if (!record) return;
    this.records.delete(sceneId);
    // every colour table goes on the geometry first, so dispose() releases all their GPU buffers
    for (const [mode, attr] of record.colors) record.geometry.setAttribute(`color_${mode}`, attr);
    record.geometry.dispose();
    this.onEvicted(sceneId);
  }

  onClick(event) {
    if ((!this.interactMode && !this.measureMode) || !this.current) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const { labels } = this.current;
    const labelKey = this.mode === '12c' ? 'label12' : this.mode === '21c' ? 'label21' : 'label68';
    const paletteMode = this.mode === '12c' ? '12c' : this.mode === '21c' ? '21c' : '68c';
    const hideMoving = this.mode !== '68c';
    const hit = this.raycaster.intersectObject(this.points)
      .find((intersect) => !(hideMoving && MOVING68.includes(labels.label68[intersect.index])));
    if (!hit) return;

    if (this.measureMode) {
      this.addMeasurePoint(hit.point);
    } else {
      const idx = hit.index;
      this.addDynamicLabel(labels.instance[idx], labels[labelKey][idx], paletteMode,
        hit.point.x, hit.point.y, hit.point.z, hit.point.z + 0.5);
    }
  }

  addMeasurePoint(point) {
    if (this.measurePoints.length >= 2) this.clearMeasure();
    this.measurePoints.push(point);
    const sphereGeo = new THREE.SphereGeometry(0.2, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.copy(point);
    this.measureLines.add(sphere);

    if (this.measurePoints.length === 2) {
      const p1 = this.measurePoints[0];
      const p2 = this.measurePoints[1];
      const dist = p1.distanceTo(p2);
      const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2, depthTest: false });
      const line = new THREE.Line(lineGeo, lineMat);
      line.renderOrder = 999;
      this.measureLines.add(line);
      const midPoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      const label = this.makeTextLabel(`${dist.toFixed(2)}m`, '#ff0000');
      label.position.copy(midPoint);
      this.measureLines.add(label);
      hudMessage(`Measured: ${dist.toFixed(2)}m`, true);
    }
  }

  clearMeasure() {
    this.measurePoints = [];
    [...this.measureLines.children].forEach(c => {
      if (c.isCSS2DObject && c.element && c.element.parentNode) c.element.parentNode.removeChild(c.element);
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
      if (c.geometry) c.geometry.dispose();
      this.measureLines.remove(c);
    });
  }

  clearDynamicLabels() {
    if (this.dynamicBoxes) {
      [...this.dynamicBoxes.children].forEach(c => {
        if (c.isCSS2DObject && c.element && c.element.parentNode) c.element.parentNode.removeChild(c.element);
        if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
        if (c.geometry) c.geometry.dispose();
        this.dynamicBoxes.remove(c);
      });
      this.scene.remove(this.dynamicBoxes);
      this.dynamicBoxes = null;
    }
  }

  addDynamicLabel(id, classId, paletteMode, cx, cy, cz, maxZ) {
    this.clearDynamicLabels();
    
    if (!this.dynamicBoxes) {
      this.dynamicBoxes = new THREE.Group();
      this.scene.add(this.dynamicBoxes);
    }
    
    const center = new THREE.Vector3(cx, cy, cz);
    const labelPos = new THREE.Vector3(cx, cy, maxZ + 1.5);
    
    const palette = data.palettes[paletteMode] || [];
    const classInfo = palette.find((p) => p.id === classId);
    const className = classInfo ? classInfo.name : 'Unknown';
    let rgb, labelText;
    if (this.mode === 'instance' && id >= 0) {
      rgb = instanceTint(id, classId, paletteById['68c'] || []);
      labelText = `${className} (${id})`;
    } else {
      rgb = classInfo ? classInfo.color : [255, 255, 255];
      labelText = className;
    }
    const colorHex = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);

    const sphereGeo = new THREE.SphereGeometry(0.15, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: colorHex });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.copy(center);
    this.dynamicBoxes.add(sphere);
    
    const lineGeo = new THREE.BufferGeometry().setFromPoints([center, labelPos]);
    const lineMat = new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.8 });
    const pointer = new THREE.Line(lineGeo, lineMat);
    this.dynamicBoxes.add(pointer);
    
    const hex = '#' + colorHex.getHexString();
    const spr = this.makeTextLabel(labelText, hex);
    spr.position.copy(labelPos);
    this.dynamicBoxes.add(spr);
    
    hudMessage(`Selected: ${labelText}`, true);
  }

  makeTextLabel(text, bgHex) {
    const fs = 42, padX = 16, padY = 10;
    const cv = document.createElement('canvas');
    let ctx = cv.getContext('2d');
    ctx.font = `bold ${fs}px Inter, Arial, sans-serif`;
    const tw = Math.ceil(ctx.measureText(text).width);
    cv.width = tw + padX * 2; cv.height = fs + padY * 2;
    ctx = cv.getContext('2d');
    ctx.font = `bold ${fs}px Inter, Arial, sans-serif`;
    ctx.fillStyle = bgHex;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(2, 2, cv.width - 4, cv.height - 4, 12); ctx.fill(); }
    else ctx.fillRect(2, 2, cv.width - 4, cv.height - 4);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cv.width / 2, cv.height / 2 + 2);
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false }));
    const aspect = cv.width / cv.height;
    spr.scale.set(0.75 * aspect, 0.75, 1);
    return spr;
  }

  setMode(mode) {
    this.mode = mode;
    this.clearDynamicLabels();
    this.applyMode();
    hudMessage(modeLabel(mode));
  }

  applyMode() {
    const record = this.current;
    if (!record) return;
    const attr = record.colors.get(this.mode) || record.colors.get('12c') || record.colors.values().next().value;
    if (attr && record.geometry.getAttribute('color') !== attr) record.geometry.setAttribute('color', attr);
  }

  setPointSize(size) {
    this.pointSize = size;
    if (this.points) this.points.material.size = size;
  }

  setAutoRotate(on) {
    this.rotateWanted = on;
    clearTimeout(this.resumeTimer);
    this.syncAutoRotate();
  }

  syncAutoRotate() {
    this.orbitControls.autoRotate = this.rotateWanted && !this.measureMode;
  }

  resetView() {
    this.camera.position.copy(this.home.pos);
    this.orbitControls.target.copy(this.home.target);
    this.orbitControls.update();
  }

  frame(geo) {
    const pos = geo.getAttribute('position');
    const n = pos.count;
    
    const samples = Math.min(n, 10000);
    const xs = new Float32Array(samples);
    const ys = new Float32Array(samples);
    const zs = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      xs[i] = pos.getX(i);
      ys[i] = pos.getY(i);
      zs[i] = pos.getZ(i);
    }
    xs.sort(); ys.sort(); zs.sort();
    
    const center = new THREE.Vector3(
      xs[Math.floor(samples / 2)],
      ys[Math.floor(samples / 2)],
      zs[Math.floor(samples / 2)]
    );
    
    const p5 = Math.floor(samples * 0.05);
    const p95 = Math.floor(samples * 0.95);
    const sizeX = xs[p95] - xs[p5];
    const sizeY = ys[p95] - ys[p5];
    
    const r = Math.max(0.5 * Math.hypot(sizeX, sizeY), 5);
    const elev = THREE.MathUtils.degToRad(32);
    const azim = THREE.MathUtils.degToRad(45);
    const d = r * 1.35;
    this.camera.position.set(
      center.x + d * Math.cos(elev) * Math.sin(azim),
      center.y - d * Math.cos(elev) * Math.cos(azim),
      center.z + d * Math.sin(elev),
    );
    this.camera.near = Math.max(0.05, d * 0.01);
    this.camera.far = d * 50;
    this.camera.updateProjectionMatrix();
    this.orbitControls.target.copy(center);
    this.orbitControls.update();
    this.home = { pos: this.camera.position.clone(), target: center.clone() };
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.composer) {
      this.composer.setSize(w, h);
      this.edlPass.uniforms.resolution.value.set(w, h);
    }
    if (this.labelRenderer) this.labelRenderer.setSize(w, h);
  }

  animate = () => {
    requestAnimationFrame(this.animate);
    // frame time: the auto-rotate turns per second, not per frame (same speed at 60 and 120 Hz);
    // capped so a backgrounded tab does not jump on return
    this.orbitControls.update(Math.min(this.clock.getDelta(), 0.1));
    if (this.edlEnabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    if (this.labelRenderer) this.labelRenderer.render(this.scene, this.camera);
  };
}

// Centred progress panel over the viewer. The scene already on screen stays visible, dimmed,
// underneath and keeps turning: loading happens in the worker.
const loadingUi = (() => {
  const el = document.createElement('div');
  el.className = 'viewer-loading';
  el.hidden = true;
  el.innerHTML = `<div class="viewer-loading-box" role="status" aria-live="polite">
      <div class="title"></div>
      <div class="bar"><span></span></div>
      <div class="detail"></div>
      <button type="button" class="btn small retry" hidden>Retry</button>
    </div>`;
  viewerShell.appendChild(el);
  const title = el.querySelector('.title');
  const fill = el.querySelector('.bar span');
  const detail = el.querySelector('.detail');
  const retry = el.querySelector('.retry');
  let scene = null;
  retry.addEventListener('click', () => scene && selectScene(scene.id));
  return {
    show(next, load) {
      scene = next;
      title.textContent = `Loading ${scene.short_label}`;
      el.classList.remove('failed');
      retry.hidden = true;
      el.hidden = false;
      if (load) this.progress(load.phase, load.loaded, load.total);
      else this.progress('download', 0, scene.ply_bytes || 0);
    },
    progress(phase, loaded, total) {
      const share = total > 0 ? Math.min(1, loaded / total) : 0;
      fill.style.width = `${Math.round(share * 100)}%`;
      if (phase === 'download') {
        detail.textContent = total > 0 ? `Downloading ${Math.round(share * 100)}%` : `Downloading ${formatMB(loaded)}`;
      } else if (phase === 'parse') {
        detail.textContent = `Reading ${formatCount(scene ? scene.viewer_points : 0)} points`;
      } else {
        detail.textContent = 'Preparing colour modes';
      }
    },
    fail(next, error) {
      scene = next;
      title.textContent = `Could not load ${scene.short_label}`;
      detail.textContent = error && error.message ? error.message : 'Unknown error';
      el.classList.add('failed');
      retry.hidden = false;
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
  };
})();

function transferLabel(scene) {
  if (scene.ply_gzip_bytes) return `~${Math.ceil(scene.ply_gzip_bytes / 1e6)} MB`;   // what a gzip host sends
  if (scene.ply_bytes) return `${Math.round(scene.ply_bytes / 1e6)} MB`;
  return '';
}

async function selectScene(sceneId) {
  const scene = data.scenes.find((item) => item.id === sceneId);
  if (!scene) return;
  activeScene = scene;
  wantedId = sceneId;
  const sceneDropdown = document.getElementById('scene-dropdown');
  if (sceneDropdown) sceneDropdown.value = sceneId;
  sceneInfo.textContent = `${scene.short_label} · ${scene.combined_scenes} combined tiles · ${formatCount(scene.viewer_points)} viewer points · ${scene.instances} instances`;

  if (viewer.isLoaded(sceneId)) {
    loadingUi.hide();
    viewer.show(viewer.records.get(sceneId));
    paintCards();
    renderLegend();
    return;
  }
  const pending = viewer.fetchScene(scene);   // start (or join) the load before painting its state
  loadingUi.show(scene, viewer.loads.get(sceneId));
  paintCards();
  try {
    const record = await pending;
    paintCards();
    if (wantedId !== sceneId) return;   // the user moved on; the scene stays in memory
    loadingUi.hide();
    viewer.show(record);
    paintCards();
    renderLegend();
  } catch (error) {
    console.error(error);
    paintCards();
    if (wantedId === sceneId) loadingUi.fail(scene, error);
  }
}

function setMode(mode) {
  viewer.setMode(mode);
  toolbar.querySelectorAll('[data-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  renderLegend();
}

function renderCards() {
  sceneCards.innerHTML = data.scenes.map((scene) => `
    <article class="scene-card" data-scene="${scene.id}" data-state="idle">
      <img src="${scene.thumb}" alt="${scene.label} scene thumbnail" />
      <div class="body">
        <strong>${scene.short_label}</strong>
        <!-- Scenes: ${scene.combined_scene_label} -->
        <p>${scene.description}</p>
        <div class="scene-state">
          <button type="button" class="btn small scene-load">Load scene${transferLabel(scene) ? ` · ${transferLabel(scene)}` : ''}</button>
          <div class="scene-progress" hidden><div class="bar"><span></span></div><span class="scene-progress-text"></span></div>
          <span class="scene-loaded" hidden></span>
        </div>
      </div>
    </article>
  `).join('');
  sceneCards.querySelectorAll('.scene-card').forEach((card) => {
    card.addEventListener('click', () => selectScene(card.dataset.scene));
  });
  paintCards();
}

// Card footer: Load button (not in memory), progress (loading), or loaded / showing.
function paintCards() {
  sceneCards.querySelectorAll('.scene-card').forEach((card) => {
    const id = card.dataset.scene;
    const state = viewer.isLoaded(id) ? 'loaded' : viewer.isLoading(id) ? 'loading' : 'idle';
    const active = id === wantedId;
    card.dataset.state = state;
    card.classList.toggle('active', active);
    card.querySelector('.scene-load').hidden = state !== 'idle';
    card.querySelector('.scene-progress').hidden = state !== 'loading';
    const loaded = card.querySelector('.scene-loaded');
    loaded.hidden = state !== 'loaded';
    loaded.textContent = active ? '● Showing' : '✓ Loaded · click to view';
    if (state === 'loading') {
      const load = viewer.loads.get(id);
      paintCardProgress(id, load.phase, load.loaded, load.total);
    }
  });
}

function paintCardProgress(id, phase, loaded, total) {
  const card = sceneCards.querySelector(`.scene-card[data-scene="${id}"]`);
  if (!card) return;
  const share = total > 0 ? Math.min(1, loaded / total) : 0;
  card.querySelector('.scene-progress .bar span').style.width = `${Math.round(share * 100)}%`;
  card.querySelector('.scene-progress-text').textContent =
    phase === 'download' ? `${Math.round(share * 100)}%` : phase === 'parse' ? 'Reading…' : 'Preparing…';
}

function renderLegend() {
  if (!activeScene) return;
  const mode = viewer.mode;
  if (mode === 'rgb') {
    legendEl.innerHTML = '<span class="cl"><span class="swatch" style="background:linear-gradient(90deg,#777,#ddd,#8fb)"></span>Partial RGB</span>';
    return;
  }
  if (mode === 'instance') {
    legendEl.innerHTML = `<span class="cl"><span class="swatch" style="background:linear-gradient(90deg,#888,#0a0,#800,#00f)"></span>Stuff / no instance keeps 68-class color</span><span class="cl"><span class="swatch" style="background:linear-gradient(90deg,#f36,#39f,#fc4,#2c8)"></span>Click an object to view class and Global ID</span>`;
    return;
  }
  let rows = data.palettes[mode] || [];
  if (mode === '62c') {
    rows = data.palettes['68c'] || [];
    rows = rows.filter(row => ![29, 30, 31, 62, 63, 64, 65, 66, 67].includes(row.id));
  }
  legendEl.innerHTML = rows.map((row) => `
    <span class="cl" title="${row.name}">
      <span class="swatch" style="background:${colorCss(row.color)}"></span>${row.name}
    </span>
  `).join('');
}

const TAX_MODES = [
  { id: '12c', tab: '12-class', title: '12-class dataset statistics', sources: true,
    note: 'Dataset-level major-class totals from the paper hierarchy and verification files.' },
  { id: '21c', tab: '21-class', title: '21-class dataset statistics', sources: true,
    note: 'Dataset-level fine-grained benchmark totals folded with the V10 training overlay; the 21-class taxonomy reduces Human &amp; Animal to Human, so Animal, Dog, Cow and Moving Animal (37 instances, 0.24M points) fall outside it.' },
  { id: '62c', tab: '62-class', title: '62-class dataset statistics', sources: false,
    note: 'Dataset-level totals for the primary benchmark: the 62 static classes only, with shares over those classes (19,518 instances, 1,205.2M points).' },
  { id: '68c', tab: '68-class', title: '68-class dataset statistics', sources: false,
    note: 'Dataset-level V10 totals: 62 static classes plus 6 moving-object subclasses.' },
];

// Per-panel filter text and sort order. Default order is the one the data
// ships in: points, descending.
const taxState = {};

const TAX_SORTERS = {
  name: (row) => row.name.toLowerCase(),
  kind: (row) => row.kind,
  instances: (row) => row.instances,
  points: (row) => row.points,
};

function taxRows(mode) {
  const state = taxState[mode.id];
  let rows = (data.dataset_stats[mode.id] || []).slice();
  const needle = state.filter.trim().toLowerCase();
  if (needle) {
    rows = rows.filter((row) => {
      const haystack = [row.name, row.kind, ...row.static_classes, ...row.moving_classes];
      return haystack.some((value) => String(value).toLowerCase().includes(needle));
    });
  }
  const key = TAX_SORTERS[state.sort];
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === y) return b.points - a.points;
    return (x > y ? 1 : -1) * (state.dir === 'asc' ? 1 : -1);
  });
  return rows;
}

function taxBody(mode) {
  const rows = taxRows(mode);
  if (!rows.length) {
    const span = mode.sources ? 6 : 4;
    return `<tr><td colspan="${span}" class="tax-empty">No class matches that filter.</td></tr>`;
  }
  return rows.map((row) => `<tr>
        <td><span class="class-cell"><span class="swatch" style="background:${colorCss(row.color)}"></span><span>${escapeHtml(row.name)}</span><span class="class-id">${row.id}</span></span></td>
        <td>${row.kind}</td>${mode.sources ? `
        <td class="combined-cell">${classListCell(row.static_classes)}</td>
        <td class="combined-cell">${classListCell(row.moving_classes)}</td>` : ''}
        <td>${row.instances.toLocaleString()} <span class="muted">(${pct(row.instance_share)})</span></td>
        <td class="bar-cell">
          <div class="bar-track">
            <span class="bar-fill" style="width:${Math.max(2, row.share * 100)}%;background:${colorCss(row.color)}"></span>
            <span class="bar-label">${formatCount(row.points)} · ${pct(row.share)}</span>
          </div>
        </td>
      </tr>`).join('');
}

function taxHead(mode) {
  const state = taxState[mode.id];
  const th = (key, label) => {
    const active = state.sort === key;
    const arrow = active ? (state.dir === 'asc' ? '▲' : '▼') : '';
    return `<th class="sortable${active ? ' sorted' : ''}" data-sort-key="${key}"
      aria-sort="${active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}<span class="sort-arrow">${arrow}</span></th>`;
  };
  return `<tr>${th('name', 'Class legend')}${th('kind', 'Type')}${mode.sources
    ? '<th>Static 68 classes</th><th>Moving V10 classes</th>' : ''}${th('instances', 'Instances')}${th('points', 'Points')}</tr>`;
}

function refreshTaxPanel(mode) {
  const panel = taxonomyPanels.querySelector(`.tax-panel[data-tax-panel="${mode.id}"]`);
  if (!panel) return;
  panel.querySelector('thead').innerHTML = taxHead(mode);
  panel.querySelector('tbody').innerHTML = taxBody(mode);
  const shown = taxRows(mode).length;
  const total = (data.dataset_stats[mode.id] || []).length;
  panel.querySelector('.tax-count').textContent =
    shown === total ? `${total} classes` : `${shown} of ${total} classes`;
  bindTaxSort(panel, mode);
}

function bindTaxSort(panel, mode) {
  panel.querySelectorAll('th[data-sort-key]').forEach((header) => {
    header.addEventListener('click', () => {
      const state = taxState[mode.id];
      const key = header.dataset.sortKey;
      if (state.sort === key) {
        state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = key;
        // names read naturally A-Z; counts are most useful largest-first
        state.dir = key === 'name' || key === 'kind' ? 'asc' : 'desc';
      }
      refreshTaxPanel(mode);
    });
  });
}

function selectTaxTab(id) {
  taxonomyPanels.querySelectorAll('[data-tax-tab]').forEach((tab) => {
    const on = tab.dataset.taxTab === id;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  });
  taxonomyPanels.querySelectorAll('[data-tax-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.taxPanel !== id;
  });
}

function renderTaxonomyPanels() {
  TAX_MODES.forEach((mode) => {
    taxState[mode.id] = taxState[mode.id] || { filter: '', sort: 'points', dir: 'desc' };
  });

  taxonomyPanels.innerHTML = `
    <div class="tax-tabs" role="tablist" aria-label="Taxonomy granularity">
      ${TAX_MODES.map((mode, i) => `<button role="tab" data-tax-tab="${mode.id}"
        class="${i === 0 ? 'active' : ''}" aria-selected="${i === 0}">${mode.tab}</button>`).join('')}
    </div>
    ${TAX_MODES.map((mode, i) => `<article class="tax-panel" id="${mode.id}" data-tax-panel="${mode.id}"${i === 0 ? '' : ' hidden'}>
      <header>
        <div>
          <h3>${mode.title}</h3>
          <p>${mode.note}</p>
        </div>
        <div class="tax-controls">
          <input type="search" class="tax-filter" data-tax-filter="${mode.id}"
                 placeholder="Filter classes" aria-label="Filter ${mode.tab} classes" />
          <span class="tax-count muted"></span>
          <button data-view-mode="${mode.id}">View ${mode.id}</button>
        </div>
      </header>
      <div class="table-wrap">
        <table><thead></thead><tbody></tbody></table>
      </div>
    </article>`).join('')}`;

  TAX_MODES.forEach((mode) => refreshTaxPanel(mode));

  taxonomyPanels.querySelectorAll('[data-tax-tab]').forEach((tab) => {
    tab.addEventListener('click', () => selectTaxTab(tab.dataset.taxTab));
  });
  taxonomyPanels.querySelectorAll('[data-tax-filter]').forEach((input) => {
    const mode = TAX_MODES.find((m) => m.id === input.dataset.taxFilter);
    input.addEventListener('input', () => {
      taxState[mode.id].filter = input.value;
      refreshTaxPanel(mode);
    });
  });
  taxonomyPanels.querySelectorAll('button[data-view-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.viewMode));
  });
}

function bindEvents() {
  toolbar.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  const sceneDropdown = document.getElementById('scene-dropdown');
  if (sceneDropdown) {
    sceneDropdown.addEventListener('change', (e) => {
      selectScene(e.target.value);
    });
  }

  const interactBtn = document.getElementById('interact-toggle');
  if (interactBtn) {
    interactBtn.addEventListener('click', () => {
      viewer.interactMode = !viewer.interactMode;
      interactBtn.classList.toggle('active', viewer.interactMode);
      if (viewer.interactMode) {
        viewer.measureMode = false;
        const mBtn = document.getElementById('measure-toggle');
        if (mBtn) { mBtn.classList.remove('active'); mBtn.innerHTML = '📏 Measure'; mBtn.style.background = ''; mBtn.style.color = ''; }
        viewer.clearMeasure();

        interactBtn.innerHTML = '✅ Interact: ON';
        interactBtn.style.background = '#059669';
        interactBtn.style.color = '#fff';
        hudMessage('Interact mode ON: Click a point to identify it', true);
      } else {
        interactBtn.innerHTML = '👆 Interact';
        interactBtn.style.background = '';
        interactBtn.style.color = '';
        hudMessage('Interact mode OFF', true);
        viewer.clearDynamicLabels();
      }
    });
  }

  const edlBtn = document.getElementById('edl-toggle');
  if (edlBtn) {
    edlBtn.addEventListener('click', () => {
      viewer.edlEnabled = !viewer.edlEnabled;
      edlBtn.classList.toggle('active', viewer.edlEnabled);
      if (viewer.edlEnabled) {
        edlBtn.innerHTML = '🌑 Shadows: ON';
        edlBtn.style.background = '#6366f1';
        edlBtn.style.color = '#fff';
        hudMessage('EDL Shadows ON', true);
      } else {
        edlBtn.innerHTML = '🌑 Shadows';
        edlBtn.style.background = '';
        edlBtn.style.color = '';
        hudMessage('EDL Shadows OFF', true);
      }
    });
  }

  const measureBtn = document.getElementById('measure-toggle');
  if (measureBtn) {
    measureBtn.addEventListener('click', () => {
      viewer.measureMode = !viewer.measureMode;
      measureBtn.classList.toggle('active', viewer.measureMode);
      if (viewer.measureMode) {
        viewer.interactMode = false;
        const intBtn = document.getElementById('interact-toggle');
        if (intBtn) { intBtn.classList.remove('active'); intBtn.innerHTML = '👆 Interact'; intBtn.style.background = ''; intBtn.style.color = ''; }
        viewer.clearDynamicLabels();

        measureBtn.innerHTML = '📏 Measure: ON';
        measureBtn.style.background = '#0ea5e9';
        measureBtn.style.color = '#fff';
        hudMessage('Measure mode ON: Click 2 points to measure', true);
      } else {
        measureBtn.innerHTML = '📏 Measure';
        measureBtn.style.background = '';
        measureBtn.style.color = '';
        viewer.clearMeasure();
        hudMessage('Measure mode OFF', true);
      }
      viewer.syncAutoRotate();
    });
  }

  const rotateBtn = document.getElementById('rotate-toggle');
  if (rotateBtn) {
    const paintRotate = () => {
      rotateBtn.classList.toggle('active', viewer.rotateWanted);
      rotateBtn.innerHTML = viewer.rotateWanted ? '⟳ Auto-rotate: ON' : '⟳ Auto-rotate';
      rotateBtn.style.background = viewer.rotateWanted ? '#10b981' : '';
      rotateBtn.style.color = viewer.rotateWanted ? '#fff' : '';
    };
    paintRotate();
    rotateBtn.addEventListener('click', () => {
      viewer.setAutoRotate(!viewer.rotateWanted);
      paintRotate();
      hudMessage(viewer.rotateWanted ? 'Auto-rotate ON' : 'Auto-rotate OFF', true);
    });
  }

  pointSizeInput.addEventListener('input', () => viewer.setPointSize(Number(pointSizeInput.value)));
  resetButton.addEventListener('click', () => viewer.resetView());
  fullscreenButton.addEventListener('click', () => {
    if (document.fullscreenElement === viewerShell) void document.exitFullscreen();
    else void viewerShell.requestFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement === viewerShell;
    fullscreenButton.textContent = fs ? '⛶ Exit full screen' : '⛶ Full screen';
    toolbar.classList.toggle('fs-overlay', fs);
    legendEl.classList.toggle('fs-overlay', fs);
    if (fs) {
      viewerShell.appendChild(toolbar);
      viewerShell.appendChild(legendEl);
    } else {
      toolbarHome.insertBefore(toolbar, sceneCards);
      legendHome.insertBefore(legendEl, sceneCards);
    }
  });
}

async function main() {
  hudMessage('Loading metadata...', true);
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`Could not load page data (HTTP ${res.status})`);
  data = await res.json();
  for (const [mode, palette] of Object.entries(data.palettes)) paletteById[mode] = paletteColorsById(palette);

  viewer = new SceneViewer(mount);
  viewer.setPointSize(Number(pointSizeInput.value));
  viewer.onProgress = (id, phase, loaded, total) => {
    paintCardProgress(id, phase, loaded, total);
    if (id === wantedId) loadingUi.progress(phase, loaded, total);
  };
  viewer.onLoaded = () => paintCards();
  viewer.onEvicted = () => paintCards();
  bindEvents();
  renderCards();
  renderTaxonomyPanels();
  hideHud();
  await selectScene('dominant');
}

main().catch((error) => {
  console.error(error);
  hudMessage(error.message || 'Failed to load page data', true);
});
