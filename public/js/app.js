// Config
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_HOST = window.location.host || 'localhost:3000';
const CONTROL_TOKEN_KEY = 'lidar_control_token';
const MAX_DIST = 200;
const GRID_RINGS = [50, 100, 150, 200];

// State
let points = new Array(360).fill(null);
let scanData = [];
let scanCount = 0;
let sweepAngle = 0;
let ws, animFrame;
let isSimulating = false;
let isHardwareConnected = false;
let savedMaps = safeArray(safeJsonParse(localStorage.getItem('lidar_maps'), []));
let emailSettings = safeJsonParse(localStorage.getItem('lidar_email'), null);
let emailScheduleTimer = null;
let currentViewMap = null;
let batteryLevel = 75;
let sweepTrail = [];
let pointTimestamps = new Array(360).fill(0);
let ripples = [];
let fpsSamples = [], lastFpsUpdate = 0, displayFps = 0;

// Battery
function updateBattery(pct) {
  batteryLevel = Math.max(0, Math.min(100, pct));
  const fill = document.getElementById('battery-fill');
  const label = document.getElementById('battery-label');
  fill.style.width = batteryLevel + '%';
  if (batteryLevel <= 15) {
    fill.style.background = 'var(--danger)';
    label.className = 'battery-label low';
  } else if (batteryLevel <= 30) {
    fill.style.background = 'var(--warning)';
    label.className = 'battery-label mid';
  } else {
    fill.style.background = 'var(--primary)';
    label.className = 'battery-label';
  }
  label.style.opacity = '1';
  label.textContent = batteryLevel + '%';
}

setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const delta = (Math.random() > 0.7) ? -1 : 0;
    updateBattery(batteryLevel + delta);
  }
}, 10000);

// WebSocket
function connect() {
  ws = new WebSocket(buildWsUrl());
  ws.onopen = () => { 
    setBackendStatus(true);
    log('Свързан към LiDAR сървъра', 'ok'); 
  };
  ws.onclose = () => { 
    setBackendStatus(false);
    setHardwareStatus(false);
    log('Връзката е прекъсната — опит след 3 сек...', 'err'); 
    enableButtons(false); 
    setTimeout(connect, 3000); 
  };
  ws.onerror = () => log('WebSocket грешка', 'err');
  ws.onmessage = (e) => { try { handleMessage(JSON.parse(e.data)); } catch { log(String(e.data), 'info'); } };
}

function buildWsUrl() {
  const url = new URL(WS_PROTOCOL + '//' + WS_HOST);
  const token = localStorage.getItem(CONTROL_TOKEN_KEY) || new URLSearchParams(window.location.search).get('token');
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function sendCmd(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) { 
    if (cmd === 'SIMULATE_SCAN') isSimulating = true;
    ws.send(JSON.stringify({ type: cmd })); 
    log('→ ' + cmd, 'info'); 
  }
}

// Messages
function handleMessage(msg) {
  switch (msg.type) {
    case 'SCAN_START':
      points = new Array(360).fill(null); scanData = [];
      setStatus('scanning', 'СКАНИРАНЕ'); log('— Скан стартиран —', 'info'); updateProgress(0);
      break;
    case 'POINT':
      const angle = Number.parseInt(msg.angle, 10);
      const dist = Number.parseFloat(msg.dist);
      if (!Number.isInteger(angle) || angle < 0 || angle >= 360 || !Number.isFinite(dist)) return;
      const valid = msg.status === 'OK' && dist > 0;
      points[angle] = { dist, valid };
      if (valid) {
        scanData.push({ angle, dist });
        pointTimestamps[angle] = performance.now();
        if (ripples.length < 120) ripples.push({ angle, dist, born: performance.now() });
      }
      sweepAngle = angle; updateProgress(angle + 1); updateStats();
      break;
    case 'HARDWARE_STATUS':
      setHardwareStatus(msg.connected);
      break;
    case 'SCAN_END':
      isSimulating = false;
      scanCount++; setStatus('connected', 'СВЪРЗАН');
      log(`✓ Скан завършен — ${msg.points || scanData.length} валидни точки`, 'ok');
      updateStats(); document.getElementById('s-scans').textContent = scanCount;
      enableButtons(isHardwareConnected);
      autoSaveMap();
      if (emailSettings && emailSettings.freq === 'scan') sendEmailNow(true);
      break;
    case 'STATUS':
      if (msg.scanning) setStatus('scanning', 'СКАНИРАНЕ');
      if (msg.battery !== undefined) updateBattery(msg.battery);
      break;
    case 'BATTERY': updateBattery(msg.level); break;
    case 'LOG':
      const text = String(msg.msg || '');
      const cls = msg.level || (text.includes('ERROR') ? 'err' : text.includes('OK') ? 'ok' : 'info');
      log(text, cls); break;
  }
}

// Radar rendering
const canvas = document.getElementById('radar');
const ctx = canvas.getContext('2d');
let frameTime = 0, vrPulse = 0;

function resize() {
  const wrap = document.getElementById('radar-wrap');
  const availW = wrap.clientWidth - 40;
  const availH = wrap.clientHeight - 40;
  const size = Math.max(100, Math.min(availW, availH));
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
}

function drawScene(tctx, W, H, pts, swAngle, pulse, opts) {
  const o = opts || {};
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 18, scale = R / MAX_DIST;
  const trail = o.sweepTrail || [];
  const stamps = o.pointTimestamps;
  const rips = o.ripples || [];
  const now = o.now || 0;
  const showHUD = o.showHUD || false;
  const fps = o.fps || 0;

  tctx.clearRect(0, 0, W, H);

  // Background
  tctx.fillStyle = '#0a0e1a';
  tctx.fillRect(0, 0, W, H);
  const grad = tctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  grad.addColorStop(0, 'rgba(56,189,248,0.06)');
  grad.addColorStop(0.5, 'rgba(56,189,248,0.02)');
  grad.addColorStop(1, 'rgba(10,14,26,1)');
  tctx.beginPath(); tctx.arc(cx, cy, R, 0, Math.PI * 2);
  tctx.fillStyle = grad; tctx.fill();

  // Hex grid (clipped)
  tctx.save();
  tctx.beginPath(); tctx.arc(cx, cy, R, 0, Math.PI * 2); tctx.clip();
  tctx.strokeStyle = 'rgba(56,189,248,0.03)';
  tctx.lineWidth = 0.5;
  const hexSize = 24;
  for (let row = -Math.ceil(R / hexSize); row <= Math.ceil(R / hexSize) * 2; row++) {
    for (let col = -Math.ceil(R / hexSize); col <= Math.ceil(R / hexSize) * 2; col++) {
      const hx = cx + col * hexSize * 1.732 + (row % 2) * hexSize * 0.866;
      const hy = cy + row * hexSize * 1.5;
      tctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        i === 0 ? tctx.moveTo(hx + hexSize * Math.cos(a), hy + hexSize * Math.sin(a))
                : tctx.lineTo(hx + hexSize * Math.cos(a), hy + hexSize * Math.sin(a));
      }
      tctx.closePath(); tctx.stroke();
    }
  }
  tctx.restore();

  // Grid rings
  GRID_RINGS.forEach((r, i) => {
    const pr = r * scale;
    const alpha = 0.12 + 0.04 * Math.sin(pulse + i);
    tctx.beginPath(); tctx.arc(cx, cy, pr, 0, Math.PI * 2);
    tctx.strokeStyle = `rgba(56,189,248,${alpha})`;
    tctx.lineWidth = 1;
    tctx.setLineDash([3, 8]); tctx.stroke(); tctx.setLineDash([]);
    tctx.fillStyle = 'rgba(148,163,184,0.4)';
    tctx.font = '10px "JetBrains Mono", monospace';
    tctx.textAlign = 'left'; tctx.textBaseline = 'middle';
    tctx.fillText(r + ' cm', cx + pr + 6, cy - 5);
  });

  // Axes + compass
  for (let a = 0; a < 360; a += 30) {
    const rad = (a - 90) * Math.PI / 180;
    tctx.beginPath(); tctx.moveTo(cx, cy);
    tctx.lineTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R);
    tctx.strokeStyle = a % 90 === 0 ? 'rgba(56,189,248,0.15)' : 'rgba(56,189,248,0.04)';
    tctx.lineWidth = a % 90 === 0 ? 1 : 0.5;
    tctx.stroke();
    if (a % 90 === 0) {
      const labels = ['N','E','S','W'];
      const tx = cx + Math.cos(rad) * (R + 14);
      const ty = cy + Math.sin(rad) * (R + 14);
      tctx.fillStyle = '#38bdf8';
      tctx.shadowColor = '#38bdf8'; tctx.shadowBlur = 10;
      tctx.font = 'bold 11px "Inter", sans-serif';
      tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
      tctx.fillText(labels[a / 90], tx, ty);
      tctx.shadowBlur = 0;
    }
  }

  // COMET TRAIL (clipped)
  if (trail.length > 1) {
    tctx.save();
    tctx.beginPath(); tctx.arc(cx, cy, R, 0, Math.PI * 2); tctx.clip();
    for (let ti = 0; ti < trail.length - 1; ti++) {
      const progress = ti / trail.length;
      const alpha = Math.pow(progress, 1.8) * 0.22;
      const a0 = (trail[ti] - 90) * Math.PI / 180;
      const a1 = (trail[ti + 1] - 90) * Math.PI / 180;
      tctx.beginPath(); tctx.moveTo(cx, cy);
      tctx.arc(cx, cy, R * 0.98, a0, a1, false);
      tctx.closePath();
      tctx.fillStyle = `rgba(0,255,128,${alpha})`;
      tctx.fill();
    }
    tctx.restore();
  }

  // SWEEP CONE (green glow)
  const swRad = (swAngle - 90) * Math.PI / 180;
  tctx.save();
  tctx.beginPath(); tctx.arc(cx, cy, R, 0, Math.PI * 2); tctx.clip();
  tctx.beginPath(); tctx.moveTo(cx, cy);
  tctx.arc(cx, cy, R, swRad - 0.55, swRad, false);
  tctx.closePath();
  const coneGrad = tctx.createLinearGradient(cx, cy, cx + Math.cos(swRad) * R, cy + Math.sin(swRad) * R);
  coneGrad.addColorStop(0, 'rgba(0,255,128,0)');
  coneGrad.addColorStop(1, 'rgba(0,255,128,0.14)');
  tctx.fillStyle = coneGrad; tctx.fill();
  tctx.restore();

  tctx.beginPath(); tctx.moveTo(cx, cy);
  tctx.lineTo(cx + Math.cos(swRad) * R, cy + Math.sin(swRad) * R);
  tctx.strokeStyle = '#00ff80';
  tctx.lineWidth = 2;
  tctx.shadowColor = '#00ff80'; tctx.shadowBlur = 22;
  tctx.stroke(); tctx.shadowBlur = 0;

  tctx.beginPath(); tctx.arc(cx + Math.cos(swRad) * R * 0.97, cy + Math.sin(swRad) * R * 0.97, 3, 0, Math.PI * 2);
  tctx.fillStyle = '#00ff80';
  tctx.shadowColor = '#00ff80'; tctx.shadowBlur = 18;
  tctx.fill(); tctx.shadowBlur = 0;

  // POINTS — HSL heatmap + age fade
  pts.forEach((p, angle) => {
    if (!p || !p.valid || p.dist <= 0) return;
    const rad = (angle - 90) * Math.PI / 180;
    const d = Math.min(p.dist, MAX_DIST);
    const norm = d / MAX_DIST;
    const hue = Math.round(120 * (1 - norm));
    const ts = stamps ? stamps[angle] : 0;
    const age = ts > 0 ? now - ts : 0;
    const alpha = age > 0 ? Math.max(0.1, 1 - age / 12000) : 1;
    const px = cx + Math.cos(rad) * d * scale;
    const py = cy + Math.sin(rad) * d * scale;

    const halo = tctx.createRadialGradient(px, py, 0, px, py, 12);
    halo.addColorStop(0, `hsla(${hue},100%,60%,${0.28 * alpha})`);
    halo.addColorStop(1, `hsla(${hue},100%,60%,0)`);
    tctx.beginPath(); tctx.arc(px, py, 12, 0, Math.PI * 2);
    tctx.fillStyle = halo; tctx.fill();

    tctx.beginPath(); tctx.arc(px, py, 2.5, 0, Math.PI * 2);
    tctx.fillStyle = `hsla(${hue},100%,65%,${alpha})`;
    tctx.shadowColor = `hsl(${hue},100%,60%)`;
    tctx.shadowBlur = 10 * alpha;
    tctx.fill(); tctx.shadowBlur = 0;
  });

  // RIPPLE PINGS
  rips.forEach(rip => {
    const age = now - rip.born;
    const progress = age / 650;
    if (progress >= 1) return;
    const rad = (rip.angle - 90) * Math.PI / 180;
    const d = Math.min(rip.dist, MAX_DIST);
    const px = cx + Math.cos(rad) * d * scale;
    const py = cy + Math.sin(rad) * d * scale;
    const hue = Math.round(120 * (1 - d / MAX_DIST));
    tctx.beginPath(); tctx.arc(px, py, progress * 20, 0, Math.PI * 2);
    tctx.strokeStyle = `hsla(${hue},100%,65%,${(1 - progress) * 0.8})`;
    tctx.lineWidth = 1.5; tctx.stroke();
  });

  // OUTER RING
  tctx.beginPath(); tctx.arc(cx, cy, R, 0, Math.PI * 2);
  tctx.strokeStyle = `rgba(56,189,248,${0.2 + 0.08 * Math.sin(pulse * 2)})`;
  tctx.lineWidth = 2;
  tctx.shadowColor = '#38bdf8'; tctx.shadowBlur = 12;
  tctx.stroke(); tctx.shadowBlur = 0;

  // Crosshair
  [[-8,0],[8,0],[0,-8],[0,8]].forEach(([dx,dy]) => {
    tctx.beginPath();
    tctx.moveTo(cx + dx * 0.3, cy + dy * 0.3);
    tctx.lineTo(cx + dx, cy + dy);
    tctx.strokeStyle = 'rgba(0,255,128,0.7)';
    tctx.lineWidth = 1; tctx.stroke();
  });
  tctx.beginPath(); tctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  tctx.fillStyle = '#00ff80';
  tctx.shadowColor = '#00ff80'; tctx.shadowBlur = 20;
  tctx.fill(); tctx.shadowBlur = 0;

  // HUD OVERLAY
  if (showHUD) {
    tctx.font = '10px "JetBrains Mono", monospace';
    tctx.fillStyle = 'rgba(0,255,128,0.55)';
    tctx.textAlign = 'left'; tctx.textBaseline = 'bottom';
    tctx.fillText(`${Math.round(swAngle % 360)}°`, cx - R + 8, cy + R - 6);
    if (fps) {
      tctx.textAlign = 'right';
      tctx.fillText(`${fps}fps`, cx + R - 8, cy + R - 6);
    }
  }
}

function drawRadar(ts = 0) {
  const dt = ts - frameTime; frameTime = ts;
  vrPulse += dt * 0.001; sweepAngle += dt * 0.04;

  if (dt > 0) fpsSamples.push(dt);
  if (fpsSamples.length > 30) fpsSamples.shift();
  if (ts - lastFpsUpdate > 600) {
    const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
    displayFps = Math.round(1000 / avg);
    lastFpsUpdate = ts;
  }

  sweepTrail.push(sweepAngle);
  if (sweepTrail.length > 60) sweepTrail.shift();

  const now = performance.now();
  ripples = ripples.filter(r => now - r.born < 650);

  drawScene(ctx, canvas.width, canvas.height, points, sweepAngle, vrPulse, {
    now,
    sweepTrail,
    pointTimestamps,
    ripples,
    fps: displayFps,
    showHUD: true
  });
  animFrame = requestAnimationFrame(drawRadar);
}

// Map Archive
function generateThumbnail(mapData) {
  const tc = document.createElement('canvas');
  tc.width = 64; tc.height = 64;
  const tctx = tc.getContext('2d');
  const pts = new Array(360).fill(null);
  safeArray(mapData.points).forEach(p => { pts[p.angle] = { dist: p.dist, valid: true }; });
  tctx.fillStyle = '#0a0e1a';
  tctx.beginPath(); tctx.arc(32, 32, 32, 0, Math.PI * 2); tctx.fill();
  const scale = 32 / MAX_DIST;
  pts.forEach((p, angle) => {
    if (!p) return;
    const rad = (angle - 90) * Math.PI / 180;
    const d = Math.min(p.dist, MAX_DIST);
    const norm = d / MAX_DIST;
    const hue = Math.round(120 * (1 - norm));
    tctx.beginPath();
    tctx.arc(32 + Math.cos(rad) * d * scale, 32 + Math.sin(rad) * d * scale, 1.5, 0, Math.PI * 2);
    tctx.fillStyle = `hsl(${hue},100%,60%)`; tctx.fill();
  });
  tctx.strokeStyle = 'rgba(0,255,128,0.3)';
  tctx.lineWidth = 1; tctx.beginPath();
  tctx.arc(32, 32, 31, 0, Math.PI * 2); tctx.stroke();
  return tc.toDataURL();
}

function autoSaveMap() {
  if (scanData.length === 0) return;
  const mapObj = { id: Date.now(), name: 'Скан ' + scanCount, date: new Date().toLocaleString('bg'), points: [...scanData], thumbnail: null };
  mapObj.thumbnail = generateThumbnail(mapObj);
  savedMaps.unshift(mapObj);
  if (savedMaps.length > 50) savedMaps.pop();
  localStorage.setItem('lidar_maps', JSON.stringify(savedMaps));
  renderMapList(); log('Картата е запазена: ' + mapObj.name, 'ok');
}

function saveCurrentScan() {
  if (scanData.length === 0) { log('Няма данни за запазване', 'err'); return; }
  autoSaveMap();
}

function generateTestMap() {
  const fakePoints = [];
  const shapeType = ['RECT', 'CIRCLE', 'STAR', 'NOISE'][Math.floor(Math.random() * 4)];
  const baseDist = 70 + Math.random() * 80;

  for (let i = 0; i < 360; i += 2) {
    const rad = (i * Math.PI) / 180;
    let dist = baseDist;
    
    if (shapeType === 'RECT') {
      const wallFactor = 1 / Math.max(Math.abs(Math.cos(rad)), Math.abs(Math.sin(rad)));
      dist = baseDist * wallFactor;
    } else if (shapeType === 'STAR') {
      dist = baseDist * (1 + 0.4 * Math.abs(Math.sin(rad * 5)));
    } else if (shapeType === 'CIRCLE') {
      dist = baseDist;
    } else {
      dist = baseDist + Math.random() * 100;
    }

    dist = Math.round(dist + (Math.random() * 8 - 4));
    fakePoints.push({ angle: i, dist: dist });
  }

  const mapObj = {
    id: 'test-' + Date.now(),
    name: '🧪 ' + shapeType + ' Карта #' + (savedMaps.length + 1),
    date: new Date().toLocaleString('bg'),
    points: fakePoints,
    thumbnail: null  // FIX: was empty string, now null so generateThumbnail runs
  };

  // FIX: generate thumbnail for test maps too
  mapObj.thumbnail = generateThumbnail(mapObj);

  savedMaps.unshift(mapObj);
  if (savedMaps.length > 50) savedMaps.pop();
  localStorage.setItem('lidar_maps', JSON.stringify(savedMaps));
  renderMapList();
  log('Генерирана тестова ' + shapeType + ' карта', 'ok');
}

function renderMapList() {
  const list = document.getElementById('map-list');
  document.getElementById('map-count-badge').textContent = savedMaps.length + ' карти';
  list.replaceChildren();
  if (savedMaps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Няма запазени карти';
    list.appendChild(empty);
    return;
  }

  savedMaps.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'map-item';
    item.id = 'mapitem-' + safeDomId(m.id);
    item.addEventListener('click', () => viewMap(i));

    const thumb = document.createElement('div');
    thumb.className = 'map-thumb';
    const img = document.createElement('img');
    img.width = 36;
    img.height = 36;
    img.alt = '';
    if (isSafeDataImage(m.thumbnail)) img.src = m.thumbnail;
    thumb.appendChild(img);

    const info = document.createElement('div');
    info.className = 'map-info';
    const name = document.createElement('div');
    name.className = 'map-name';
    name.textContent = m.name || 'Скан';
    const date = document.createElement('div');
    date.className = 'map-date';
    date.textContent = m.date || '';
    const pts = document.createElement('div');
    pts.className = 'map-pts';
    pts.textContent = safeArray(m.points).length + ' точки';
    info.append(name, date, pts);

    const del = document.createElement('span');
    del.className = 'map-del';
    del.title = 'Изтрий';
    del.textContent = '✕';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteMap(i);
    });

    item.append(thumb, info, del);
    list.appendChild(item);
  });
}

function deleteMap(i) {
  savedMaps.splice(i, 1);
  localStorage.setItem('lidar_maps', JSON.stringify(savedMaps));
  renderMapList(); log('Картата е изтрита', 'info');
}

function viewMap(i) {
  currentViewMap = savedMaps[i];
  if (!currentViewMap) return;
  const mapPoints = safeArray(currentViewMap.points);
  document.getElementById('modal-title').textContent = currentViewMap.name + ' · ' + currentViewMap.date;
  document.getElementById('modal-info').textContent = mapPoints.length + ' точки · макс. ' + MAX_DIST + ' cm';
  const mc = document.getElementById('modal-canvas');
  mc.width = 400; mc.height = 400;
  const mctx = mc.getContext('2d');
  const pts = new Array(360).fill(null);
  mapPoints.forEach(p => { pts[p.angle] = { dist: p.dist, valid: true }; });
  drawScene(mctx, 400, 400, pts, -999, 0, { showHUD: false });
  document.getElementById('map-modal').classList.add('open');
}

function closeModal() { document.getElementById('map-modal').classList.remove('open'); }
function closeMapModal(e) { if (e.target === document.getElementById('map-modal')) closeModal(); }

function downloadModalCSV() {
  if (!currentViewMap) return;
  let csv = 'angle_deg,distance_cm\n';
  safeArray(currentViewMap.points).forEach(p => csv += p.angle + ',' + p.dist + '\n');
  triggerDownload('data:text/csv,' + encodeURIComponent(csv), safeFilename(currentViewMap.name) + '.csv');
}

function downloadMapImage() {
  if (!currentViewMap) return;
  triggerDownload(document.getElementById('modal-canvas').toDataURL('image/png'), safeFilename(currentViewMap.name) + '.png');
}

function triggerDownload(href, filename) {
  const a = document.createElement('a'); a.href = href; a.download = filename; a.click();
}

// ─── Email Scheduler ────────────────────────────────────────────────────────

// FIX: Read current field values directly — don't rely on prior saveEmailSettings() call
function getEmailFormValues() {
  return {
    addr: document.getElementById('email-addr').value.trim(),
    freq: document.getElementById('email-freq').value,
    time: document.getElementById('email-time').value,
    maps: document.getElementById('email-maps').value,
  };
}

// FIX: Validate email with a proper regex instead of just checking for '@'
function isValidEmail(addr) {
  return typeof addr === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

document.getElementById('email-freq').addEventListener('change', function() {
  document.getElementById('custom-time-wrap').style.display = this.value === 'custom' ? 'block' : 'none';
  saveEmailSettings(true);
});

document.getElementById('email-addr').addEventListener('change', () => saveEmailSettings(true));
document.getElementById('email-time').addEventListener('change', () => saveEmailSettings(true));
document.getElementById('email-maps').addEventListener('change', () => saveEmailSettings(true));

function saveEmailSettings(silent = false) {
  const { addr, freq, time, maps } = getEmailFormValues();

  if (!isValidEmail(addr)) {
    if (!silent) showEmailStatus('Невалиден имейл адрес', 'err');
    return false;
  }

  emailSettings = { addr, freq, time, maps };
  localStorage.setItem('lidar_email', JSON.stringify(emailSettings));
  scheduleEmail();

  showEmailStatus('✓ Активиран · ' + addr, 'ok');
  document.getElementById('email-active-tag').style.display = 'inline-block';
  if (!silent) log('Имейл планировчик активиран: ' + addr + ' · ' + freq, 'ok');
  return true;
}

function clearEmailSettings() {
  emailSettings = null;
  localStorage.removeItem('lidar_email');
  if (emailScheduleTimer) { clearInterval(emailScheduleTimer); emailScheduleTimer = null; }
  document.getElementById('email-active-tag').style.display = 'none';
  showEmailStatus('', '');
  document.getElementById('email-addr').value = '';
  document.getElementById('email-freq').value = 'manual';
  document.getElementById('email-time').value = '08:00';
  document.getElementById('email-maps').value = '1';
  document.getElementById('custom-time-wrap').style.display = 'none';
  log('Имейл планировчик деактивиран', 'info');
}

function scheduleEmail() {
  if (emailScheduleTimer) { clearInterval(emailScheduleTimer); emailScheduleTimer = null; }
  if (!emailSettings) return;

  if (emailSettings.freq === 'hourly') {
    emailScheduleTimer = setInterval(() => sendEmailNow(true), 3600000);
  } else if (emailSettings.freq === 'daily' || emailSettings.freq === 'custom') {
    emailScheduleTimer = setInterval(() => {
      const now = new Date();
      const [th, tm] = (emailSettings.time || '08:00').split(':').map(Number);
      if (now.getHours() === th && now.getMinutes() === tm) sendEmailNow(true);
    }, 60000);
  }
  // 'manual' and 'scan' need no timer
}

// FIX: Always read fresh values from form before sending,
//      and attempt to save settings if not yet saved.
function sendEmailNow(silent = false) {
  // Try to persist current form values first (in case user typed but didn't blur)
  const { addr } = getEmailFormValues();

  // If no saved settings yet, try saving now
  if (!emailSettings || !emailSettings.addr) {
    const saved = saveEmailSettings(false); // show error if invalid
    if (!saved) return;
  }

  // After save attempt, re-check
  if (!emailSettings || !isValidEmail(emailSettings.addr)) {
    if (!silent) showEmailStatus('Въведете валиден имейл адрес първо', 'err');
    return;
  }

  if (savedMaps.length === 0 && scanData.length === 0) {
    if (!silent) showEmailStatus('Няма карти за изпращане', 'err');
    return;
  }

  const mapsToSend = emailSettings.maps === 'all'
    ? savedMaps
    : emailSettings.maps === '3'
      ? savedMaps.slice(0, 3)
      : savedMaps.slice(0, 1);

  const payload = {
    to: emailSettings.addr,
    subject: `LiDAR Скан · ${new Date().toLocaleString('bg')}`,
    maps: mapsToSend.map(m => ({
      name: m.name,
      date: m.date,
      points: safeArray(m.points).length,
      thumbnail: m.thumbnail
    }))
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'SEND_EMAIL', payload }));
    if (!silent) showEmailStatus('✓ Изпратено към ' + emailSettings.addr, 'ok');
    log('↑ Имейл изпратен към ' + emailSettings.addr + ' · ' + mapsToSend.length + ' карти', 'ok');
  } else {
    // Fallback: open mailto link
    const body = payload.maps.map(m => `• ${m.name} (${m.date}) — ${m.points} точки`).join('\n');
    const mailtoUrl = `mailto:${encodeURIComponent(emailSettings.addr)}`
      + `?subject=${encodeURIComponent(payload.subject)}`
      + `&body=${encodeURIComponent(body)}`;
    window.open(mailtoUrl);
    if (!silent) showEmailStatus('↑ Отворен имейл клиент', 'ok');
    log('↑ Имейл клиент отворен за ' + emailSettings.addr, 'info');
  }
}

function showEmailStatus(msg, type) {
  const el = document.getElementById('email-status');
  el.textContent = msg;
  el.className = 'email-status' + (type ? ' ' + type : '');
}

function restoreEmailSettings() {
  if (!emailSettings) return;
  document.getElementById('email-addr').value = emailSettings.addr || '';
  document.getElementById('email-freq').value = emailSettings.freq || 'manual';
  document.getElementById('email-time').value = emailSettings.time || '08:00';
  document.getElementById('email-maps').value = emailSettings.maps || '1';
  if (emailSettings.freq === 'custom') {
    document.getElementById('custom-time-wrap').style.display = 'block';
  }
  document.getElementById('email-active-tag').style.display = 'inline-block';
  // FIX: show persisted status on restore so user knows scheduler is active
  showEmailStatus('✓ Активиран · ' + (emailSettings.addr || ''), 'ok');
  scheduleEmail();
}

// ─── Panel collapse ──────────────────────────────────────────────────────────

function togglePanel(titleEl) {
  const body = titleEl.nextElementSibling;
  if (!body || !body.classList.contains('panel-body')) return;
  body.classList.toggle('hidden');
  titleEl.classList.toggle('collapsed');
}

// Depth bar animation
let depthIdx = 0;
setInterval(() => {
  const segs = document.querySelectorAll('.depth-seg');
  segs.forEach((s, i) => s.classList.toggle('active', i === depthIdx));
  depthIdx = (depthIdx + 1) % segs.length;
}, 400);

// Stats / Progress / UI
function updateStats() {
  const valid = scanData.map(p => p.dist);
  const total = points.filter(p => p !== null).length;
  document.getElementById('s-points').textContent = total;
  document.getElementById('s-valid').textContent = valid.length;
  if (valid.length > 0) {
    document.getElementById('s-min').textContent = Math.min(...valid) + ' cm';
    document.getElementById('s-max').textContent = Math.max(...valid) + ' cm';
    document.getElementById('s-avg').textContent = Math.round(valid.reduce((a,b) => a+b, 0) / valid.length) + ' cm';
  }
}

function updateProgress(n) {
  const pct = Math.round(n / 360 * 100);
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-label').textContent = n + ' / 360°';
}

function setStatus(cls, label) {
  const el = document.getElementById('status-pill');
  if (el) { el.className = 'status-pill ' + cls; el.textContent = label; }
}

function setBackendStatus(connected) {
  const el = document.getElementById('backend-status');
  const sys = document.getElementById('sys-badge');
  if (!el) return;
  if (connected) {
    el.className = 'status-pill connected';
    el.textContent = 'БЕКЕНД: ВКЛ.';
    if (sys) { sys.textContent = 'SYS:ACTIVE'; sys.style.borderColor = 'rgba(56, 189, 248, 0.4)'; sys.style.color = 'var(--primary)'; }
  } else {
    el.className = 'status-pill disconnected';
    el.textContent = 'БЕКЕНД: ИЗКЛ.';
    if (sys) { sys.textContent = 'SYS:OFFLINE'; sys.style.borderColor = 'rgba(239, 68, 68, 0.4)'; sys.style.color = 'var(--danger)'; }
  }
}

function setHardwareStatus(connected) {
  isHardwareConnected = !!connected;
  const el = document.getElementById('lidar-status');
  const fill = document.getElementById('battery-fill');
  const label = document.getElementById('battery-label');
  if (!el) return;

  if (isHardwareConnected) {
    el.className = 'status-pill connected';
    el.textContent = 'ЛИДАР: СВЪРЗАН';
    enableButtons(true);
  } else {
    el.className = 'status-pill disconnected';
    el.textContent = 'ЛИДАР: ЛИПСВА';
    if (fill) { fill.style.width = '0%'; fill.style.background = '#333'; }
    if (label) { label.textContent = 'Unknown'; label.style.opacity = '0.5'; }
    if (!isSimulating) enableButtons(false);
  }
}

function log(msg, type = 'info') {
  const el = document.getElementById('log');
  const div = document.createElement('div');
  div.className = 'log-' + type;
  div.textContent = '[' + new Date().toLocaleTimeString('bg') + '] ' + msg;
  el.appendChild(div); el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

function clearRadar() {
  points = new Array(360).fill(null); scanData = [];
  pointTimestamps = new Array(360).fill(0);
  sweepTrail = []; ripples = [];
  updateStats(); updateProgress(0); log('Екранът е изчистен', 'info');
}

function enableButtons(on) {
  ['btn-scan','btn-calib','btn-home'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

function downloadCSV() {
  if (scanData.length === 0) { log('Няма данни за запис', 'err'); return; }
  let csv = 'angle_deg,distance_cm\n';
  scanData.forEach(p => csv += p.angle + ',' + p.dist + '\n');
  triggerDownload('data:text/csv,' + encodeURIComponent(csv), 'scan_' + Date.now() + '.csv');
  log('CSV запазен', 'ok');
}

// ─── Safe helpers ────────────────────────────────────────────────────────────

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeDomId(value) {
  const id = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return id || 'map';
}

function isSafeDataImage(value) {
  return typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(value);
}

function safeFilename(value) {
  const name = String(value || 'scan').replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_').trim().slice(0, 80);
  return name || 'scan';
}

// ─── Init ────────────────────────────────────────────────────────────────────

window.addEventListener('resize', resize);
resize();
enableButtons(false);
renderMapList();
restoreEmailSettings();
connect();
requestAnimationFrame(drawRadar);
