/**
 * Main application entry point.
 * Uses File System Access API (showDirectoryPicker) to read a local directory
 * without any file upload — files are read directly from the local filesystem.
 *
 * Fallback: drag & drop a folder (FileSystemEntry API)
 */

'use strict';

import { extractLogs, formatTimestamp } from './extractor.js';
import { initMap, renderLogs, toggleLayer } from './map-viewer.js';

// ---- DOM refs ------------------------------------------------------------ //

const dropZone       = document.getElementById('drop-zone');
const browseBtn      = document.getElementById('browse-btn');
const browserWarn    = document.getElementById('browser-warn');
const progressSection= document.getElementById('progress-section');
const progressBar    = document.getElementById('progress-bar');
const progressLabel  = document.getElementById('progress-label');
const progressDetail = document.getElementById('progress-detail');
const progressFiles  = document.getElementById('progress-files');
const statsSection   = document.getElementById('stats-section');
const statPoints     = document.getElementById('stat-points');
const statGps        = document.getElementById('stat-gps');
const statDrGps      = document.getElementById('stat-drgps');
const statMmGps      = document.getElementById('stat-mmgps');
const statMmMatch    = document.getElementById('stat-mmmatch');
const statRoute      = document.getElementById('stat-route');
const statTts        = document.getElementById('stat-tts');
const statTimeRange  = document.getElementById('stat-timerange');
const layerPanel     = document.getElementById('layer-panel');

// ---- Browser compatibility check ----------------------------------------- //

const hasDirectoryPicker = typeof window.showDirectoryPicker === 'function';
if (!hasDirectoryPicker) {
  browserWarn.style.display = 'block';
}

// ---- Layer toggle wiring ------------------------------------------------- //

document.querySelectorAll('[data-layer]').forEach(cb => {
  cb.addEventListener('change', e => {
    toggleLayer(e.target.dataset.layer, e.target.checked);
  });
});

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
    return; // 사용자가 취소했거나 오류
  }

  startProgress();
  setProgress(0, '디렉토리 스캔 중...', '하위 디렉토리를 탐색하고 있습니다.');

  const { files, names } = await scanDirectory(dirHandle, onScanProgress);

  if (!files.length) {
    setProgress(0, '파일 없음', '선택한 폴더에서 .dlt 파일을 찾을 수 없습니다.');
    return;
  }

  await analyzeFiles(files, names);
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

  startProgress();
  setProgress(0, '디렉토리 스캔 중...', '드롭된 항목에서 DLT 파일을 탐색합니다.');

  const { files, names } = await getFilesFromDataTransfer(e.dataTransfer);

  if (!files.length) {
    setProgress(0, '파일 없음', '드롭한 항목에서 .dlt 파일을 찾을 수 없습니다.');
    return;
  }

  await analyzeFiles(files, names);
});

// ---- Directory scan: File System Access API ------------------------------ //

/**
 * Recursively scan a FileSystemDirectoryHandle for .dlt files.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {Function} onFound  callback(count, latestName) called each time a file is found
 * @returns {{ files: File[], names: string[] }}
 */
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

  // Fallback: plain file list
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

function startProgress() {
  progressSection.hidden = false;
  statsSection.hidden = true;
  layerPanel.hidden = true;
  progressFiles.innerHTML = '';
}

function setProgress(pct, label, detail = '') {
  progressBar.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', pct.toFixed(0));
  progressLabel.textContent = label;
  progressDetail.textContent = detail;
}

/**
 * Render the file list panel.
 * @param {string[]} names
 * @param {number}   currentIdx  index of file currently being parsed
 * @param {number}   doneCount   number of finished files
 */
function renderFileList(names, currentIdx, doneCount) {
  progressFiles.innerHTML = '';
  names.forEach((name, i) => {
    const row = document.createElement('div');
    let cls, icon;
    if (i < doneCount)        { cls = 'done';    icon = '✓'; }
    else if (i === currentIdx) { cls = 'active';  icon = '▶'; }
    else                       { cls = 'pending'; icon = '·'; }
    row.className = `pf-row ${cls}`;
    row.innerHTML = `<span class="pf-icon">${icon}</span><span class="pf-name" title="${name}">${name}</span>`;
    progressFiles.appendChild(row);
    if (i === currentIdx) {
      requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
    }
  });
}

// ---- Analysis ------------------------------------------------------------ //

async function analyzeFiles(dltFiles, displayNames) {
  // Step 1 완료 — 스캔 결과 표시
  setProgress(0, `[1단계] 스캔 완료`, `DLT 파일 ${dltFiles.length}개 발견 — 분석을 시작합니다.`);
  renderFileList(displayNames, 0, 0);

  // Step 2 — 파일별 분석
  let lastUIUpdate = 0;

  function onProgress(filePath, fileIndex, fileCount, overallBytes, totalBytes, fileBytes, fileTotal) {
    const now = Date.now();
    if (now - lastUIUpdate < 80) return;
    lastUIUpdate = now;

    const currentIdx  = fileIndex - 1;
    const overallPct  = totalBytes > 0 ? (overallBytes / totalBytes) * 100 : 0;
    const filePct     = fileTotal  > 0 ? (fileBytes    / fileTotal)  * 100 : 0;

    setProgress(
      overallPct,
      `[2단계] 파일 분석 중 — ${overallPct.toFixed(1)}%`,
      `[${fileIndex}/${fileCount}] ${displayNames[currentIdx] ?? filePath}  (${filePct.toFixed(1)}%)`
    );
    renderFileList(displayNames, currentIdx, fileIndex - 1);
  }

  try {
    const result = await extractLogs(dltFiles, onProgress);

    // Step 3 — 완료
    setProgress(100, `[3단계] 분석 완료`, `총 ${dltFiles.length}개 파일 처리 완료`);
    renderFileList(displayNames, -1, dltFiles.length);

    displayResults(result);
  } catch (err) {
    console.error(err);
    setProgress(0, '오류 발생', err.message);
  }
}

// ---- Results display ----------------------------------------------------- //

function displayResults({ locationLogs, mmLogs, routeRequests, ttsLogs }) {
  const gpsCount     = locationLogs.filter(p => p.sourceType === 'gps').length;
  const drGpsCount   = locationLogs.filter(p => p.sourceType === 'dr_gps').length;
  const mmGpsCount   = mmLogs.filter(p => p.sourceType === 'mm_gps').length;
  const mmMatchCount = mmLogs.filter(p => p.sourceType === 'mm_match').length;

  statPoints.textContent   = locationLogs.length;
  statGps.textContent      = gpsCount;
  statDrGps.textContent    = drGpsCount;
  statMmGps.textContent    = mmGpsCount;
  statMmMatch.textContent  = mmMatchCount;
  statRoute.textContent    = routeRequests.length;
  statTts.textContent      = ttsLogs.length;

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
