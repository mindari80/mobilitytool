/**
 * Main application entry point.
 * Uses File System Access API (showDirectoryPicker) to read a local directory
 * without any file upload — files are read directly from the local filesystem.
 *
 * Two-phase analysis:
 *   Phase 1 (auto) : GPS + Map Matching → fast, shows map immediately
 *   Phase 2 (manual): Route requests + TTS → user clicks button when ready
 */

'use strict';

import { extractLogs, formatTimestamp } from './extractor.js';
import { initMap, renderLogs, toggleLayer, addCoordMarker, clearCoordMarkers, getMap, setMapCenter, setRulerMode, clearRuler } from './map-viewer.js';
import { skCoordToWgs84 } from './coordinate.js';

// ---- DOM refs ------------------------------------------------------------ //

const dropZone        = document.getElementById('drop-zone');
const browseBtn       = document.getElementById('browse-btn');
const browserWarn     = document.getElementById('browser-warn');
const progressSection = document.getElementById('progress-section');
const folderName      = document.getElementById('folder-name');
const progressBar     = document.getElementById('progress-bar');
const progressLabel   = document.getElementById('progress-label');
const progressDetail  = document.getElementById('progress-detail');
const progressFiles   = document.getElementById('progress-files');
const statsSection    = document.getElementById('stats-section');
const statPoints          = document.getElementById('stat-points');
const statAnalysisCount   = document.getElementById('stat-analysis-count');
const bottomAnalysisCount = document.getElementById('bottom-analysis-count');
const statGps             = document.getElementById('stat-gps');
const statDrGps       = document.getElementById('stat-drgps');
const statMmGps       = document.getElementById('stat-mmgps');
const statMmMatch     = document.getElementById('stat-mmmatch');
const statRoute       = document.getElementById('stat-route');
const statTts         = document.getElementById('stat-tts');
const statTimeRange   = document.getElementById('stat-timerange');
const layerPanel      = document.getElementById('layer-panel');
const coordTypeButtons = document.querySelectorAll('.coord-type-btn');
const coordXInput      = document.getElementById('coord-x');
const coordYInput      = document.getElementById('coord-y');
const coordLabelX      = document.getElementById('coord-label-x');
const coordLabelY      = document.getElementById('coord-label-y');
const coordShowBtn     = document.getElementById('coord-show-btn');
const coordClearBtn    = document.getElementById('coord-clear-btn');
const coordResult      = document.getElementById('coord-result');
const rulerToggleBtn   = document.getElementById('ruler-toggle-btn');
const rulerClearBtn    = document.getElementById('ruler-clear-btn');
const rulerStatus      = document.getElementById('ruler-status');
const rulerBadge       = document.getElementById('ruler-badge');
const mapDiv           = document.getElementById('map');

// ---- State for two-phase analysis ---------------------------------------- //

let savedFiles        = null;   // File[] from Phase 1
let savedDisplayNames = null;   // string[] display names
let phase1Result      = null;   // { locationLogs, mmLogs, routeRequests, ttsLogs }

// ---- Browser compatibility check ----------------------------------------- //

const hasDirectoryPicker = typeof window.showDirectoryPicker === 'function';
if (!hasDirectoryPicker) {
  browserWarn.style.display = 'block';
}

// ---- Analysis count (persists via localStorage across all sessions) ------- //

function getAnalysisCount() {
  return parseInt(localStorage.getItem('gpsAnalysisCount') || '0', 10);
}

function updateCountDisplay() {
  const n = getAnalysisCount();
  if (bottomAnalysisCount) bottomAnalysisCount.textContent = n;
  if (statAnalysisCount)   statAnalysisCount.textContent   = n;
}

updateCountDisplay(); // show on page load

// Global uncaught error handler
window.addEventListener('unhandledrejection', e => showError(e.reason));
window.addEventListener('error', e => showError(e.error || e.message));

// ---- Initial map load with current location ------------------------------ //

initMap('map', [37.5665, 126.9780]); // default: Seoul
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    pos => setMapCenter(pos.coords.latitude, pos.coords.longitude, 15),
    () => {}  // silent fail — keep default center
  );
}

// ---- Layer toggle wiring ------------------------------------------------- //

document.querySelectorAll('[data-layer]').forEach(cb => {
  cb.addEventListener('change', e => {
    toggleLayer(e.target.dataset.layer, e.target.checked);
  });
});

// ---- Coordinate search --------------------------------------------------- //

let coordType = 'sk';

coordTypeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    coordType = btn.dataset.ctype;
    coordTypeButtons.forEach(b => b.classList.toggle('active', b === btn));
    if (coordType === 'sk') {
      coordLabelX.textContent = 'X (경도 방향)';
      coordLabelY.textContent = 'Y (위도 방향)';
      coordXInput.placeholder = '예: 4571910';
      coordYInput.placeholder = '예: 1347000';
    } else {
      coordLabelX.textContent = '위도 (Lat)';
      coordLabelY.textContent = '경도 (Lon)';
      coordXInput.placeholder = '예: 37.414890';
      coordYInput.placeholder = '예: 127.121111';
    }
    coordResult.textContent = '';
  });
});

coordShowBtn.addEventListener('click', () => {
  const a = parseFloat(coordXInput.value);
  const b = parseFloat(coordYInput.value);

  if (isNaN(a) || isNaN(b)) {
    setCoordResult('좌표를 입력하세요.', 'error');
    return;
  }

  let lat, lon, popupHtml;

  if (coordType === 'sk') {
    const wgs = skCoordToWgs84(a, b);
    if (!wgs) { setCoordResult('SK 좌표 변환 실패 — 값을 확인하세요.', 'error'); return; }
    [lat, lon] = wgs;
    popupHtml = `<b>SK → WGS84</b><br>SK X: ${a}<br>SK Y: ${b}<br><b>WGS84: ${lat.toFixed(6)}, ${lon.toFixed(6)}</b>`;
    setCoordResult(`→ ${lat.toFixed(6)}, ${lon.toFixed(6)}`, 'ok');
  } else {
    lat = a; lon = b;
    popupHtml = `<b>WGS84 좌표</b><br>위도: ${lat}<br>경도: ${lon}`;
    setCoordResult(`→ ${lat.toFixed(6)}, ${lon.toFixed(6)}`, 'ok');
  }

  if (!getMap()) initMap('map', [lat, lon]);
  addCoordMarker(lat, lon, popupHtml);
});

coordClearBtn.addEventListener('click', () => {
  clearCoordMarkers();
  coordResult.textContent = '';
});

// Enter key support
[coordXInput, coordYInput].forEach(el =>
  el.addEventListener('keydown', e => { if (e.key === 'Enter') coordShowBtn.click(); })
);

// ---- Ruler ---------------------------------------------------------------- //

let rulerOn = false;

function updateRulerStatus(state) {
  const msgs = {
    off:   '모드를 켜고 지도를 클릭하세요.',
    ready: '시작 지점을 클릭하세요.',
    start: '종료 지점을 클릭하세요.',
  };
  const badgeMsgs = {
    ready: '📏 줄자 모드 켜짐 — 시작 지점을 클릭하세요',
    start: '📏 줄자 모드 켜짐 — 종료 지점을 클릭하세요',
  };
  rulerStatus.textContent = msgs[state] || '';
  rulerStatus.className = state !== 'off' ? 'active' : '';
  mapDiv.classList.toggle('ruler-mode', state !== 'off');
  rulerBadge.textContent = badgeMsgs[state] || '';
  rulerBadge.classList.toggle('visible', state !== 'off');
}

rulerToggleBtn.addEventListener('click', () => {
  rulerOn = !rulerOn;
  rulerToggleBtn.textContent = rulerOn ? '줄자 모드 ON' : '줄자 모드 OFF';
  rulerToggleBtn.classList.toggle('active', rulerOn);
  setRulerMode(rulerOn, updateRulerStatus);
});

rulerClearBtn.addEventListener('click', () => {
  clearRuler();
});

function setCoordResult(msg, type) {
  coordResult.textContent = msg;
  coordResult.style.color = type === 'error' ? '#f87171' : '#4ade80';
}

// ---- Error popup --------------------------------------------------------- //

const errorOverlay = document.getElementById('error-overlay');
const errorMessage = document.getElementById('error-message');
document.getElementById('error-close').addEventListener('click', () => {
  errorOverlay.classList.remove('visible');
});
errorOverlay.addEventListener('click', e => {
  if (e.target === errorOverlay) errorOverlay.classList.remove('visible');
});

function showError(err) {
  const msg = err?.stack || err?.message || String(err);
  errorMessage.textContent = msg;
  errorOverlay.classList.add('visible');
  console.error(err);
}

// ---- Browse button: File System Access API ------------------------------- //

browseBtn.addEventListener('click', async () => {
  if (!hasDirectoryPicker) {
    alert('이 기능은 Chrome 또는 Edge 브라우저에서만 지원됩니다.');
    return;
  }

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
    return;
  }

  startProgress(dirHandle.name);
  setProgress(0, '디렉토리 스캔 중...', '하위 디렉토리를 탐색하고 있습니다.');

  const { files, names } = await scanDirectory(dirHandle, onScanProgress);

  if (!files.length) {
    setProgress(0, '파일 없음', '선택한 폴더에서 .dlt 파일을 찾을 수 없습니다.');
    return;
  }

  await analyzeGps(files, names);
});

// ---- Drag & drop (folder drop via FileSystemEntry API) ------------------- //

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  const rootName = [...e.dataTransfer.items]
    .map(i => i.webkitGetAsEntry?.())
    .filter(Boolean)
    .map(e => e.name)
    .join(', ') || '드롭된 폴더';
  startProgress(rootName);
  setProgress(0, '디렉토리 스캔 중...', '드롭된 항목에서 DLT 파일을 탐색합니다.');

  const { files, names } = await getFilesFromDataTransfer(e.dataTransfer);

  if (!files.length) {
    setProgress(0, '파일 없음', '드롭한 항목에서 .dlt 파일을 찾을 수 없습니다.');
    return;
  }

  await analyzeGps(files, names);
});

// ---- Directory scan: File System Access API ------------------------------ //

async function scanDirectory(dirHandle, onFound = null) {
  const files = [];
  const names = [];

  async function traverse(handle, prefix) {
    for await (const [entryName, entryHandle] of handle.entries()) {
      const path = prefix ? `${prefix}/${entryName}` : entryName;
      if (entryHandle.kind === 'file' && entryName.toLowerCase().endsWith('.dlt')) {
        const file = await entryHandle.getFile();
        files.push(file);
        names.push(path);
        if (onFound) onFound(files.length, path);
      } else if (entryHandle.kind === 'directory') {
        await traverse(entryHandle, path);
      }
    }
  }

  await traverse(dirHandle, '');
  return { files, names };
}

function onScanProgress(count, latestName) {
  setProgress(0, '디렉토리 스캔 중...', `${count}개 발견: ${latestName}`);
}

// ---- Directory traversal: Drag & Drop (FileSystemEntry API) -------------- //

async function getFilesFromDataTransfer(dataTransfer) {
  const files = [];
  const names = [];

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const entries = [];
    for (const item of dataTransfer.items) {
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
    }
    if (entries.length > 0) {
      for (const entry of entries) {
        await collectFromEntry(entry, files, names, '');
      }
      return { files, names };
    }
  }

  for (const f of dataTransfer.files) {
    if (f.name.toLowerCase().endsWith('.dlt')) {
      files.push(f);
      names.push(f.name);
    }
  }
  return { files, names };
}

async function collectFromEntry(entry, files, names, prefix) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (entry.name.toLowerCase().endsWith('.dlt')) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push(file);
      names.push(path);
      setProgress(0, '디렉토리 스캔 중...', `${files.length}개 발견: ${path}`);
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) {
        await collectFromEntry(child, files, names, path);
      }
    } while (batch.length > 0);
  }
}

// ---- Progress helpers ---------------------------------------------------- //

function startProgress(name = '') {
  progressSection.hidden = false;
  statsSection.hidden = true;
  layerPanel.hidden = true;
  progressFiles.innerHTML = '';
  folderName.textContent = name ? `📁 ${name}` : '';
}

function setProgress(pct, label, detail = '') {
  progressBar.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', pct.toFixed(0));
  progressLabel.textContent = label;
  progressDetail.textContent = detail;
}

function renderFileList(names, currentIdx, doneCount) {
  progressFiles.innerHTML = '';
  names.forEach((name, i) => {
    const row = document.createElement('div');
    let cls, icon;
    if (i < doneCount)         { cls = 'done';    icon = '✓'; }
    else if (i === currentIdx) { cls = 'active';   icon = '▶'; }
    else                       { cls = 'pending';  icon = '·'; }
    row.className = `pf-row ${cls}`;
    row.innerHTML = `<span class="pf-icon">${icon}</span><span class="pf-name" title="${name}">${name}</span>`;
    progressFiles.appendChild(row);
    if (i === currentIdx) {
      requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
    }
  });
}

// ---- Phase 1: GPS + Map Matching (fast) ---------------------------------- //

async function analyzeGps(dltFiles, displayNames) {
  savedFiles        = dltFiles;
  savedDisplayNames = displayNames;
  phase1Result      = null;

  setProgress(0, '[1단계] 스캔 완료', `DLT 파일 ${dltFiles.length}개 발견 — GPS 분석을 시작합니다.`);
  renderFileList(displayNames, 0, 0);

  let lastUIUpdate = 0;
  function onProgress(filePath, fileIndex, fileCount, overallBytes, totalBytes, fileBytes, fileTotal) {
    const now = Date.now();
    if (now - lastUIUpdate < 80) return;
    lastUIUpdate = now;

    const currentIdx = fileIndex - 1;
    const overallPct = totalBytes > 0 ? (overallBytes / totalBytes) * 100 : 0;
    const filePct    = fileTotal  > 0 ? (fileBytes    / fileTotal)  * 100 : 0;

    setProgress(
      overallPct,
      `분석 중 — ${overallPct.toFixed(1)}%`,
      `[${fileIndex}/${fileCount}] ${displayNames[currentIdx] ?? filePath}  (${filePct.toFixed(1)}%)`
    );
    renderFileList(displayNames, currentIdx, fileIndex - 1);
  }

  try {
    const result = await extractLogs(dltFiles, onProgress, 'all');
    phase1Result = result;

    setProgress(100, '분석 완료', `총 ${dltFiles.length}개 파일 처리 완료`);
    renderFileList(displayNames, -1, dltFiles.length);

    localStorage.setItem('gpsAnalysisCount', String(getAnalysisCount() + 1));
    updateCountDisplay();

    displayResults(result);
  } catch (err) {
    setProgress(0, '오류 발생', err.message || String(err));
    showError(err);
  }
}

// ---- Results display ----------------------------------------------------- //

function displayResults({ locationLogs, mmLogs, routeRequests, ttsLogs }) {
  const gpsCount     = locationLogs.filter(p => p.sourceType === 'gps').length;
  const drGpsCount   = locationLogs.filter(p => p.sourceType === 'dr_gps').length;
  const mmGpsCount   = mmLogs.filter(p => p.sourceType === 'mm_gps').length;
  const mmMatchCount = mmLogs.filter(p => p.sourceType === 'mm_match').length;

  statPoints.textContent  = locationLogs.length;
  updateCountDisplay();
  statGps.textContent     = gpsCount;
  statDrGps.textContent   = drGpsCount;
  statMmGps.textContent   = mmGpsCount;
  statMmMatch.textContent = mmMatchCount;
  statRoute.textContent   = routeRequests.length;
  statTts.textContent     = ttsLogs.length;

  const allTimestamps = [
    ...locationLogs.map(p => p.timestamp),
    ...mmLogs.map(p => p.timestamp),
    ...routeRequests.map(r => r.timestamp),
    ...ttsLogs.map(t => t.timestamp),
  ].filter(Boolean).map(t => t.getTime());

  if (allTimestamps.length > 0) {
    const first = new Date(Math.min(...allTimestamps));
    const last  = new Date(Math.max(...allTimestamps));
    statTimeRange.textContent = `${formatTimestamp(first)}\n${formatTimestamp(last)}`;
  } else {
    statTimeRange.textContent = 'N/A';
  }

  statsSection.hidden = false;
  layerPanel.hidden   = false;

  const firstLoc = [...locationLogs, ...mmLogs, ...routeRequests, ...ttsLogs]
    .find(p => (p.lat ?? p.requestLat) != null);
  const center = firstLoc
    ? [firstLoc.lat ?? firstLoc.requestLat, firstLoc.lon ?? firstLoc.requestLon]
    : [37.5665, 126.9780];

  initMap('map', center);
  renderLogs(locationLogs, mmLogs, routeRequests, ttsLogs);
}
