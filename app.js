const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

const ui = {
  newProjectBtn: document.getElementById('newProjectBtn'),
  projectNameInput: document.getElementById('projectNameInput'),
  mapImageInput: document.getElementById('mapImageInput'),
  saveProjectBtn: document.getElementById('saveProjectBtn'),
  loadProjectBtn: document.getElementById('loadProjectBtn'),
  projectList: document.getElementById('projectList'),
  layerList: document.getElementById('layerList'),
  addMarkerLayerBtn: document.getElementById('addMarkerLayerBtn'),
  addTextLayerBtn: document.getElementById('addTextLayerBtn'),
  layerEditor: document.getElementById('layerEditor'),
  instanceEditor: document.getElementById('instanceEditor'),
  modeButtons: [...document.querySelectorAll('.mode-btn')],
  statusBar: document.getElementById('statusBar'),
  rulerInfo: document.getElementById('rulerInfo'),
  quickToggle: document.getElementById('quickToggle'),
  quickAlpha: document.getElementById('quickAlpha'),
  measureLineBtn: document.getElementById('measureLineBtn'),
  measureRadiusBtn: document.getElementById('measureRadiusBtn'),
  clearMeasureBtn: document.getElementById('clearMeasureBtn')
};

const state = {
  projects: [], currentProjectId: null,
  serverProjects: [],
  view: { x: 0, y: 0, zoom: 1 }, mode: 'view', prevMode: 'view',
  activeLayerId: null, activeInstanceId: null,
  draggingPan: false, dragInstance: null,
  dragOrigin: null,
  temp: { initRulerPoints: [], measureType: null, measurePoints: [] },
  mapImage: null, quickLayerOverrides: {},
  notice: ''
};

const uid = () => Math.random().toString(36).slice(2, 10);
const defaultCommonLayer = () => ({ visibility: true, transparency: 1, offset: { x: 0, y: 0 }, localRotationPerInstance: 0, localScalePerInstance: 1 });

function createProject(name = '새 프로젝트') {
  return {
    id: uid(), name,
    serverFileName: '',
    savedToServer: false,
    map: { imagePath: '', width: 0, height: 0 },
    ruler: { pixelsPerKm: Number.NaN },
    layers: []
  };
}
function createLayer(type) {
  if (type === 'marker') {
    return { id: uid(), type, name: `MarkerLayer-${Date.now() % 10000}`, common: defaultCommonLayer(),
      layerProperty: { markerShape: 'circle', markerImagePath: '', markerColor: '#ffff00ff' }, instances: [] };
  }
  return { id: uid(), type, name: `TextLayer-${Date.now() % 10000}`, common: defaultCommonLayer(),
    layerProperty: { pivot: 'center', fontFamily: 'Arial', fontColor: '#ffffffff', outlineEnabled: true, outlineColor: '#000000ff', outlineWidth: 3 }, instances: [] };
}
function createMarkerInstance(pos) { return { id: uid(), position: pos, scale: 1, colorMultiply: '#ffffffff' }; }
function createTextInstance(pos) { return { id: uid(), position: pos, scale: 1, text: '텍스트', colorMultiply: '#ffffffff' }; }

function currentProject() { return state.projects.find(p => p.id === state.currentProjectId) || null; }
function currentLayer() {
  const p = currentProject(); if (!p) return null;
  return p.layers.find(l => l.id === state.activeLayerId) || null;
}

function projectFileNameFromName(name) {
  const base = (name || 'project').trim() || 'project';
  const safe = base.replace(/[\\/:*?"<>|]/g, '_');
  return safe.endsWith('.mapproj') ? safe : `${safe}.mapproj`;
}

function displayProjectName(fileName) {
  return (fileName || '').replace(/\.mapproj$/i, '');
}

function serializeProject(project) {
  const cloned = JSON.parse(JSON.stringify(project));
  delete cloned.serverFileName;
  delete cloned.savedToServer;
  return cloned;
}

function normalizeProject(project, serverFileName = '') {
  const base = createProject(project?.name || displayProjectName(serverFileName) || '새 프로젝트');
  const merged = {
    ...base,
    ...project,
    id: project?.id || uid(),
    name: project?.name || base.name,
    serverFileName: serverFileName || projectFileNameFromName(project?.name || base.name),
    savedToServer: true,
    map: { ...base.map, ...(project?.map || {}) },
    ruler: { ...base.ruler, ...(project?.ruler || {}) },
    layers: Array.isArray(project?.layers) ? project.layers : []
  };
  return merged;
}

function resolveMapImagePath(path) {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (path.startsWith('/')) return path;
  if (path.startsWith('projects/')) return `/${path}`;
  return `/projects/assets/${path}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`이미지를 불러오지 못했습니다: ${src}`));
    img.src = src;
  });
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(text);
    }
  }
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

function setNotice(message = '') {
  state.notice = message;
}

async function refreshServerProjects() {
  const data = await requestJson('/api/projects');
  state.serverProjects = Array.isArray(data.projects) ? data.projects : [];
  renderProjectList();
}

async function saveProjectToServer(project) {
  project.serverFileName = projectFileNameFromName(project.serverFileName || project.name);
  const payload = serializeProject(project);
  const result = await requestJson(`/api/projects/${encodeURIComponent(project.serverFileName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload, null, 2)
  });
  project.serverFileName = result.file || project.serverFileName;
  project.savedToServer = true;
}

async function loadProjectFromServer(fileName) {
  const projectData = await requestJson(`/api/projects/${encodeURIComponent(fileName)}`);
  const loaded = normalizeProject(projectData, fileName);
  const idx = state.projects.findIndex(p => p.serverFileName === fileName);
  if (idx >= 0) state.projects[idx] = loaded;
  else state.projects.push(loaded);

  state.currentProjectId = loaded.id;
  state.activeLayerId = loaded.layers[0]?.id || null;
  state.activeInstanceId = null;
  state.quickLayerOverrides = {};
  await loadMapImageForCurrentProject();
  renderUi();
}

async function uploadMapImageToServer(file) {
  const form = new FormData();
  form.append('image', file, file.name);
  return requestJson('/api/images', { method: 'POST', body: form });
}

async function loadMapImageForCurrentProject() {
  const p = currentProject();
  if (!p || !p.map.imagePath) {
    state.mapImage = null;
    return;
  }
  const src = resolveMapImagePath(p.map.imagePath);
  state.mapImage = await loadImage(src);
  if (!p.map.width || !p.map.height) {
    p.map.width = state.mapImage.width;
    p.map.height = state.mapImage.height;
  }
}

function fitMapToView() {
  const p = currentProject();
  if (!p || !p.map.width || !p.map.height) return;
  state.view.x = 0;
  state.view.y = 0;
  state.view.zoom = Math.min(canvas.width / p.map.width, canvas.height / p.map.height);
}

function resizeCanvasToDisplay() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(rect.width * ratio));
  const h = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
}

function hexToRgba(hex, alphaMul = 1) {
  const clean = hex.replace('#', '').padEnd(8, 'f');
  const n = parseInt(clean, 16);
  const r = (n >> 24) & 255;
  const g = (n >> 16) & 255;
  const b = (n >> 8) & 255;
  const a = (n & 255) / 255 * alphaMul;
  return `rgba(${r},${g},${b},${a})`;
}

function worldToScreen(p) {
  return {
    x: (p.x + state.view.x) * state.view.zoom + canvas.width / 2,
    y: (p.y + state.view.y) * state.view.zoom + canvas.height / 2
  };
}
function screenToWorld(p) {
  return {
    x: (p.x - canvas.width / 2) / state.view.zoom - state.view.x,
    y: (p.y - canvas.height / 2) / state.view.zoom - state.view.y
  };
}

function drawGrid() {
  const step = 128 * state.view.zoom;
  if (step < 20) return;
  ctx.strokeStyle = '#1c2838';
  ctx.lineWidth = 1;
  for (let x = (canvas.width / 2 + state.view.x * state.view.zoom) % step; x < canvas.width; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = (canvas.height / 2 + state.view.y * state.view.zoom) % step; y < canvas.height; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
}

function draw() {
  resizeCanvasToDisplay();
  ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  const p = currentProject();
  if (!p) return;

  if (state.mapImage) {
    const topLeft = worldToScreen({ x: -p.map.width / 2, y: -p.map.height / 2 });
    const w = p.map.width * state.view.zoom;
    const h = p.map.height * state.view.zoom;
    ctx.drawImage(state.mapImage, topLeft.x, topLeft.y, w, h);
  }

  for (const layer of p.layers) {
    const quick = state.quickLayerOverrides[layer.id] || { visibility: true, transparency: 1 };
    if (!layer.common.visibility || !quick.visibility) continue;
    const layerAlpha = layer.common.transparency * quick.transparency;
    for (const inst of layer.instances) {
      const pos = {
        x: inst.position.x + layer.common.offset.x,
        y: inst.position.y + layer.common.offset.y
      };
      const scr = worldToScreen(pos);
      const rot = (layer.common.localRotationPerInstance * Math.PI) / 180;
      const scl = inst.scale * layer.common.localScalePerInstance * state.view.zoom;
      ctx.save();
      ctx.globalAlpha = layerAlpha;
      ctx.translate(scr.x, scr.y);
      ctx.rotate(rot);
      ctx.scale(scl, scl);

      if (layer.type === 'marker') drawMarker(layer, inst);
      if (layer.type === 'text') drawText(layer, inst);
      ctx.restore();
    }
  }

  drawTransient();
  updateStatus();
}

function drawMarker(layer, inst) {
  const shape = layer.layerProperty.markerShape;
  const color = hexToRgba(layer.layerProperty.markerColor, 1);
  const mul = hexToRgba(inst.colorMultiply, 1);
  ctx.fillStyle = color;
  ctx.strokeStyle = mul;
  ctx.lineWidth = 2 / state.view.zoom;
  const size = 14;
  if (shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill(); }
  else if (shape === 'rect') { ctx.fillRect(-size, -size, size * 2, size * 2); }
  else if (shape === 'diamond') {
    ctx.beginPath(); ctx.moveTo(0, -size); ctx.lineTo(size, 0); ctx.lineTo(0, size); ctx.lineTo(-size, 0); ctx.closePath(); ctx.fill();
  } else if (shape === 'cross') {
    ctx.fillRect(-4, -size, 8, size * 2); ctx.fillRect(-size, -4, size * 2, 8);
  } else {
    // star
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? size : size * 0.45;
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / 10;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.stroke();
}

function textPivotOffset(pivot, width, height) {
  const map = {
    'top-left': [0, 0], top: [-width / 2, 0], 'top-right': [-width, 0],
    left: [0, -height / 2], center: [-width / 2, -height / 2], right: [-width, -height / 2],
    'bottom-left': [0, -height], bottom: [-width / 2, -height], 'bottom-right': [-width, -height]
  };
  const [x, y] = map[pivot] || map.center;
  return { x, y };
}

function drawText(layer, inst) {
  const txt = inst.text || '';
  ctx.font = `20px ${layer.layerProperty.fontFamily || 'Arial'}`;
  const m = ctx.measureText(txt);
  const w = m.width, h = 20;
  const piv = textPivotOffset(layer.layerProperty.pivot, w, h);
  if (layer.layerProperty.outlineEnabled) {
    ctx.strokeStyle = hexToRgba(layer.layerProperty.outlineColor);
    ctx.lineWidth = layer.layerProperty.outlineWidth || 3;
    ctx.strokeText(txt, piv.x, piv.y + h);
  }
  ctx.fillStyle = hexToRgba(layer.layerProperty.fontColor);
  ctx.fillText(txt, piv.x, piv.y + h);
}

function drawTransient() {
  if (state.mode === 'init-ruler') {
    for (const pt of state.temp.initRulerPoints) drawPoint(pt, '#ffab4f');
    if (state.temp.initRulerPoints.length === 2) drawLine(state.temp.initRulerPoints[0], state.temp.initRulerPoints[1], '#ffab4f');
  }
  if (state.temp.measurePoints.length > 0) {
    drawPoint(state.temp.measurePoints[0], '#78f0a2');
    if (state.temp.measurePoints[1]) {
      const a = state.temp.measurePoints[0], b = state.temp.measurePoints[1];
      if (state.temp.measureType === 'line') drawLine(a, b, '#78f0a2');
      if (state.temp.measureType === 'radius') {
        const r = Math.hypot(a.x - b.x, a.y - b.y);
        const sc = worldToScreen(a);
        ctx.strokeStyle = '#78f0a2';
        ctx.beginPath(); ctx.arc(sc.x, sc.y, r * state.view.zoom, 0, Math.PI * 2); ctx.stroke();
      }
      drawPoint(b, '#78f0a2');
    }
  }
}

function drawPoint(p, color) {
  const s = worldToScreen(p);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill();
}
function drawLine(a, b, color) {
  const sa = worldToScreen(a), sb = worldToScreen(b);
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
}

function pickInstance(world) {
  const p = currentProject(); if (!p) return null;
  for (let i = p.layers.length - 1; i >= 0; i--) {
    const layer = p.layers[i];
    for (let j = layer.instances.length - 1; j >= 0; j--) {
      const inst = layer.instances[j];
      const x = inst.position.x + layer.common.offset.x;
      const y = inst.position.y + layer.common.offset.y;
      if (Math.hypot(world.x - x, world.y - y) < 16 / state.view.zoom) {
        return { layer, inst };
      }
    }
  }
  return null;
}

function setMode(mode) {
  if (mode === 'init-ruler') {
    state.prevMode = state.mode;
    state.temp.initRulerPoints = [];
  }
  state.mode = mode;
  state.temp.measureType = null;
  state.temp.measurePoints = [];
  renderUi();
}

function updateStatus() {
  const p = currentProject();
  const kmLabel = (!p || p.ruler.pixelsPerKm == null || Number.isNaN(p.ruler.pixelsPerKm)) ? 'ruler 미설정' : `1km=${p.ruler.pixelsPerKm.toFixed(2)}px`;
  let measure = '';
  if (state.temp.measurePoints.length === 2 && p && !Number.isNaN(p.ruler.pixelsPerKm)) {
    const dPx = Math.hypot(state.temp.measurePoints[0].x - state.temp.measurePoints[1].x, state.temp.measurePoints[0].y - state.temp.measurePoints[1].y);
    measure = ` / 측정: ${(dPx / p.ruler.pixelsPerKm).toFixed(3)} km`;
  }
  const notice = state.notice ? ` / ${state.notice}` : '';
  ui.statusBar.textContent = `mode=${state.mode} zoom=${state.view.zoom.toFixed(2)} ${kmLabel}${measure}${notice}`;
}

function renderProjectList() {
  ui.projectList.innerHTML = '';
  const current = currentProject();

  if (current && !current.savedToServer) {
    const li = document.createElement('li');
    li.className = 'active';
    li.textContent = `${current.name} (로컬, 미저장)`;
    ui.projectList.appendChild(li);
  }

  for (const fileName of state.serverProjects) {
    const loaded = state.projects.find(p => p.serverFileName === fileName);
    const li = document.createElement('li');
    li.className = current?.serverFileName === fileName ? 'active' : '';
    li.textContent = loaded ? `${loaded.name} (${loaded.layers.length} layers)` : `${displayProjectName(fileName)} (server)`;
    li.onclick = () => { void loadProjectFromServer(fileName).catch((err) => { setNotice(err.message); renderUi(); }); };
    ui.projectList.appendChild(li);
  }

  if (!current && state.serverProjects.length === 0) {
    const li = document.createElement('li');
    li.textContent = '저장된 프로젝트가 없습니다.';
    ui.projectList.appendChild(li);
  }
}

function renderLayerList() {
  const p = currentProject();
  ui.layerList.innerHTML = '';
  if (!p) return;
  for (const l of p.layers) {
    const li = document.createElement('li');
    li.className = l.id === state.activeLayerId ? 'active' : '';
    const q = state.quickLayerOverrides[l.id] || { visibility: true, transparency: 1 };
    li.innerHTML = `<div>${l.name} <span class="small">[${l.type}]</span></div>
      <div class="row"><label><input data-act="vis" type="checkbox" ${l.common.visibility ? 'checked' : ''}/>L-Vis</label>
      <label><input data-act="qvis" type="checkbox" ${q.visibility ? 'checked' : ''}/>Q-Vis</label>
      <button data-act="up">↑</button><button data-act="down">↓</button><button data-act="del">삭제</button></div>`;
    li.onclick = () => { state.activeLayerId = l.id; state.activeInstanceId = null; renderUi(); };
    li.querySelectorAll('input,button').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const act = el.dataset.act;
        if (act === 'vis') l.common.visibility = el.checked;
        if (act === 'qvis') { state.quickLayerOverrides[l.id] = { ...(state.quickLayerOverrides[l.id] || {}), visibility: el.checked }; }
        if (act === 'del') p.layers = p.layers.filter(x => x.id !== l.id);
        if (act === 'up') {
          const idx = p.layers.findIndex(x => x.id === l.id); if (idx > 0) [p.layers[idx - 1], p.layers[idx]] = [p.layers[idx], p.layers[idx - 1]];
        }
        if (act === 'down') {
          const idx = p.layers.findIndex(x => x.id === l.id); if (idx < p.layers.length - 1) [p.layers[idx + 1], p.layers[idx]] = [p.layers[idx], p.layers[idx + 1]];
        }
        renderUi();
      };
    });
    ui.layerList.appendChild(li);
  }
}

function numberInput(label, value, oninput, step = '0.1') {
  return `<label>${label}<input type="number" step="${step}" value="${value}" data-field="${oninput}"/></label>`;
}

function escapeHtmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function renderLayerEditor() {
  const l = currentLayer();
  if (!l) { ui.layerEditor.textContent = '레이어를 선택하세요.'; return; }
  ui.layerEditor.innerHTML = `<label>Layer Name<input data-field="l.name" value="${escapeHtmlAttr(l.name)}"/></label>
    ${numberInput('Transparency', l.common.transparency, 'c.transparency', '0.01')}
    ${numberInput('Offset X', l.common.offset.x, 'c.offset.x')}
    ${numberInput('Offset Y', l.common.offset.y, 'c.offset.y')}
    ${numberInput('Local Rotation', l.common.localRotationPerInstance, 'c.localRotationPerInstance')}
    ${numberInput('Local Scale', l.common.localScalePerInstance, 'c.localScalePerInstance', '0.01')}`;
  if (l.type === 'marker') {
    ui.layerEditor.innerHTML += `<label>Shape<select data-field="m.markerShape">
      ${['circle','rect','diamond','star','cross'].map(x => `<option ${x===l.layerProperty.markerShape?'selected':''}>${x}</option>`).join('')}
    </select></label>
    <label>Layer Color<input type="color" data-field="m.markerColor" value="${l.layerProperty.markerColor.slice(0,7)}"/></label>`;
  }
  if (l.type === 'text') {
    ui.layerEditor.innerHTML += `<label>Pivot<select data-field="t.pivot">${['top-left','top','top-right','left','center','right','bottom-left','bottom','bottom-right'].map(x => `<option ${x===l.layerProperty.pivot?'selected':''}>${x}</option>`).join('')}</select></label>
    <label>Font<input data-field="t.fontFamily" value="${l.layerProperty.fontFamily}"/></label>
    <label>Font Color<input type="color" data-field="t.fontColor" value="${l.layerProperty.fontColor.slice(0,7)}"/></label>
    <label><input type="checkbox" data-field="t.outlineEnabled" ${l.layerProperty.outlineEnabled ? 'checked':''}/> Outline</label>
    <label>Outline Color<input type="color" data-field="t.outlineColor" value="${l.layerProperty.outlineColor.slice(0,7)}"/></label>
    ${numberInput('Outline Width', l.layerProperty.outlineWidth, 't.outlineWidth', '1')}`;
  }
  ui.layerEditor.querySelectorAll('[data-field]').forEach(el => {
    el.oninput = () => {
      const path = el.dataset.field;
      const v = el.type === 'checkbox' ? el.checked : el.value;
      applyPath(l, path, v);
      if (path === 'l.name') renderLayerList();
      draw();
    };
  });
}

function applyPath(layer, path, v) {
  const num = ['transparency','offset.x','offset.y','localRotationPerInstance','localScalePerInstance','outlineWidth'];
  const norm = num.some(x => path.includes(x)) ? Number(v) : v;
  if (path === 'l.name') layer.name = String(v ?? '');
  else if (path === 'c.transparency') layer.common.transparency = norm;
  else if (path === 'c.offset.x') layer.common.offset.x = norm;
  else if (path === 'c.offset.y') layer.common.offset.y = norm;
  else if (path === 'c.localRotationPerInstance') layer.common.localRotationPerInstance = norm;
  else if (path === 'c.localScalePerInstance') layer.common.localScalePerInstance = norm;
  else if (path === 'm.markerShape') layer.layerProperty.markerShape = v;
  else if (path === 'm.markerColor') layer.layerProperty.markerColor = `${v}ff`;
  else if (path === 't.pivot') layer.layerProperty.pivot = v;
  else if (path === 't.fontFamily') layer.layerProperty.fontFamily = v;
  else if (path === 't.fontColor') layer.layerProperty.fontColor = `${v}ff`;
  else if (path === 't.outlineEnabled') layer.layerProperty.outlineEnabled = !!v;
  else if (path === 't.outlineColor') layer.layerProperty.outlineColor = `${v}ff`;
  else if (path === 't.outlineWidth') layer.layerProperty.outlineWidth = norm;
}

function renderInstanceEditor() {
  const l = currentLayer(); if (!l) return;
  const inst = l.instances.find(i => i.id === state.activeInstanceId);
  if (!inst) { ui.instanceEditor.textContent = '인스턴스를 선택하세요.'; return; }
  ui.instanceEditor.innerHTML = `${numberInput('Pos X', inst.position.x, 'i.position.x')}
    ${numberInput('Pos Y', inst.position.y, 'i.position.y')}
    ${numberInput('Scale', inst.scale, 'i.scale', '0.01')}
    <button data-field="i.delete">삭제</button>`;
  if (l.type === 'marker') ui.instanceEditor.innerHTML += `<label>Color Multiply<input type="color" data-field="i.color" value="${inst.colorMultiply.slice(0,7)}"/></label>`;
  if (l.type === 'text') ui.instanceEditor.innerHTML += `<label>Text<textarea data-field="i.text">${inst.text}</textarea></label><label>Color Multiply<input type="color" data-field="i.color" value="${inst.colorMultiply.slice(0,7)}"/></label>`;
  ui.instanceEditor.querySelectorAll('[data-field]').forEach(el => {
    el.oninput = () => {
      const f = el.dataset.field;
      const val = el.value;
      if (f === 'i.position.x') inst.position.x = Number(val);
      if (f === 'i.position.y') inst.position.y = Number(val);
      if (f === 'i.scale') inst.scale = Number(val);
      if (f === 'i.color') inst.colorMultiply = `${val}ff`;
      if (f === 'i.text') inst.text = val;
      draw();
    };
    if (el.dataset.field === 'i.delete') {
      el.onclick = () => {
        l.instances = l.instances.filter(i => i.id !== inst.id);
        state.activeInstanceId = null;
        renderUi();
      };
    }
  });
}

function renderUi() {
  ui.modeButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === state.mode));
  const p = currentProject();
  ui.projectNameInput.value = p?.name || '';
  ui.rulerInfo.textContent = (!p || Number.isNaN(p.ruler.pixelsPerKm)) ? '⚠ init-ruler 미설정' : '';
  renderProjectList();
  renderLayerList();
  renderLayerEditor();
  renderInstanceEditor();
  draw();
}

canvas.addEventListener('mousedown', (e) => {
  const pt = { x: e.offsetX * (canvas.width / canvas.clientWidth), y: e.offsetY * (canvas.height / canvas.clientHeight) };
  const w = screenToWorld(pt);
  const p = currentProject(); if (!p) return;

  if (state.mode === 'init-ruler') {
    state.temp.initRulerPoints.push(w);
    if (state.temp.initRulerPoints.length === 2) {
      const d = Math.hypot(
        state.temp.initRulerPoints[0].x - state.temp.initRulerPoints[1].x,
        state.temp.initRulerPoints[0].y - state.temp.initRulerPoints[1].y
      );
      p.ruler.pixelsPerKm = d;
      state.mode = state.prevMode;
      state.temp.initRulerPoints = [];
    }
    renderUi();
    return;
  }

  if (state.mode === 'view' && state.temp.measureType) {
    state.temp.measurePoints.push(w);
    if (state.temp.measurePoints.length > 2) state.temp.measurePoints = [state.temp.measurePoints[1], state.temp.measurePoints[2]];
    renderUi();
    return;
  }

  if (state.mode === 'edit' && e.button === 0) {
    const picked = pickInstance(w);
    if (picked) {
      state.activeLayerId = picked.layer.id;
      state.activeInstanceId = picked.inst.id;
      state.dragInstance = picked.inst;
      state.dragOrigin = { startMouse: w, startPos: { ...picked.inst.position } };
      renderUi();
      return;
    }
    const l = currentLayer();
    if (l) {
      const inst = l.type === 'marker' ? createMarkerInstance(w) : createTextInstance(w);
      l.instances.push(inst);
      state.activeInstanceId = inst.id;
      renderUi();
    }
  }
  if (state.mode === 'view' && e.button === 0) {
    state.draggingPan = true;
    state.dragOrigin = { startMouse: pt, startView: { ...state.view } };
  }
});

canvas.addEventListener('mousemove', (e) => {
  const pt = { x: e.offsetX * (canvas.width / canvas.clientWidth), y: e.offsetY * (canvas.height / canvas.clientHeight) };
  const w = screenToWorld(pt);
  if (state.draggingPan) {
    const dx = (pt.x - state.dragOrigin.startMouse.x) / state.view.zoom;
    const dy = (pt.y - state.dragOrigin.startMouse.y) / state.view.zoom;
    state.view.x = state.dragOrigin.startView.x + dx;
    state.view.y = state.dragOrigin.startView.y + dy;
    draw();
  }
  if (state.dragInstance && state.dragOrigin) {
    state.dragInstance.position.x = state.dragOrigin.startPos.x + (w.x - state.dragOrigin.startMouse.x);
    state.dragInstance.position.y = state.dragOrigin.startPos.y + (w.y - state.dragOrigin.startMouse.y);
    draw();
  }
});
window.addEventListener('mouseup', () => { state.draggingPan = false; state.dragInstance = null; state.dragOrigin = null; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const scale = e.deltaY < 0 ? 1.1 : 0.9;
  state.view.zoom = Math.min(8, Math.max(0.1, state.view.zoom * scale));
  draw();
}, { passive: false });

ui.newProjectBtn.onclick = () => {
  const p = createProject(ui.projectNameInput.value.trim() || undefined);
  p.serverFileName = projectFileNameFromName(p.name);
  p.savedToServer = false;
  state.projects.push(p);
  state.currentProjectId = p.id;
  state.activeLayerId = null;
  state.mapImage = null;
  state.quickLayerOverrides = {};
  setNotice('새 로컬 프로젝트를 만들었습니다. 서버에 저장하면 목록에 나타납니다.');
  renderUi();
};
ui.projectNameInput.oninput = () => {
  const p = currentProject();
  if (p) {
    p.name = ui.projectNameInput.value;
    if (!p.savedToServer) {
      p.serverFileName = projectFileNameFromName(p.name);
    }
  }
  renderProjectList();
};
ui.mapImageInput.onchange = async () => {
  const file = ui.mapImageInput.files?.[0];
  const p = currentProject(); if (!file || !p) return;
  try {
    const result = await uploadMapImageToServer(file);
    p.map.imagePath = result.path || '';
    p.map.width = Number(result.width) || 0;
    p.map.height = Number(result.height) || 0;
    await loadMapImageForCurrentProject();
    fitMapToView();
    setNotice('지도 이미지를 서버에 업로드했습니다.');
    renderUi();
  } catch (err) {
    setNotice(`이미지 업로드 실패: ${err.message}`);
    renderUi();
  } finally {
    ui.mapImageInput.value = '';
  }
};
ui.addMarkerLayerBtn.onclick = () => {
  const p = currentProject(); if (!p) return;
  const l = createLayer('marker');
  p.layers.push(l); state.activeLayerId = l.id; renderUi();
};
ui.addTextLayerBtn.onclick = () => {
  const p = currentProject(); if (!p) return;
  const l = createLayer('text');
  p.layers.push(l); state.activeLayerId = l.id; renderUi();
};
ui.modeButtons.forEach(btn => btn.onclick = () => setMode(btn.dataset.mode));
ui.quickToggle.oninput = () => {
  const l = currentLayer(); if (!l) return;
  state.quickLayerOverrides[l.id] = { ...(state.quickLayerOverrides[l.id] || {}), visibility: ui.quickToggle.checked };
  draw();
};
ui.quickAlpha.oninput = () => {
  const l = currentLayer(); if (!l) return;
  state.quickLayerOverrides[l.id] = { ...(state.quickLayerOverrides[l.id] || {}), transparency: Number(ui.quickAlpha.value) };
  draw();
};
ui.measureLineBtn.onclick = () => { setMode('view'); state.temp.measureType = 'line'; state.temp.measurePoints = []; draw(); };
ui.measureRadiusBtn.onclick = () => { setMode('view'); state.temp.measureType = 'radius'; state.temp.measurePoints = []; draw(); };
ui.clearMeasureBtn.onclick = () => { state.temp.measureType = null; state.temp.measurePoints = []; draw(); };

ui.saveProjectBtn.onclick = async () => {
  const p = currentProject(); if (!p) return;
  try {
    await saveProjectToServer(p);
    await refreshServerProjects();
    setNotice(`서버 저장 완료: ${p.serverFileName}`);
    renderUi();
  } catch (err) {
    setNotice(`서버 저장 실패: ${err.message}`);
    renderUi();
  }
};
ui.loadProjectBtn.onclick = async () => {
  try {
    await refreshServerProjects();
    if (state.serverProjects.length > 0 && (!currentProject() || !currentProject().savedToServer)) {
      await loadProjectFromServer(state.serverProjects[0]);
      setNotice(`서버 프로젝트 로드: ${state.serverProjects[0]}`);
    } else {
      setNotice('서버 목록을 새로고침했습니다.');
      renderUi();
    }
  } catch (err) {
    setNotice(`서버 목록 조회 실패: ${err.message}`);
    renderUi();
  }
};

window.addEventListener('resize', draw);

async function bootstrap() {
  try {
    await refreshServerProjects();
    if (state.serverProjects.length > 0) {
      await loadProjectFromServer(state.serverProjects[0]);
      setNotice(`서버 프로젝트 로드: ${state.serverProjects[0]}`);
      renderUi();
      return;
    }
  } catch (err) {
    setNotice(`서버 연결 실패: ${err.message}`);
  }

  const initial = createProject('Demo Project');
  initial.serverFileName = projectFileNameFromName(initial.name);
  state.projects = [initial];
  state.currentProjectId = initial.id;
  renderUi();
}

void bootstrap();

