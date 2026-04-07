/**
 * Main application entry point.
 * Handles file selection, progress display, and orchestrates parsing → rendering.
 */

'use strict';

import { extractLogs, formatTimestamp } from './extractor.js';
import { initMap, renderLogs, toggleLayer } from './map-viewer.js';

// ---- DOM refs ------------------------------------------------------------ //

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const progressSection = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const statsSection = document.getElementById('stats-section');
const statPoints = document.getElementById('stat-points');
const statGps = document.getElementById('stat-gps');
const statDrGps = document.getElementById('stat-drgps');
const statMmGps = document.getElementById('stat-mmgps');
const statMmMatch = document.getElementById('stat-mmmatch');
const statRoute = document.getElementById('stat-route');
const statTts = document.getElementById('stat-tts');
const statTimeRange = document.getElementById('stat-timerange');
const layerPanel = document.getElementById('layer-panel');

// ---- Layer toggle wiring ------------------------------------------------- //

document.querySelectorAll('[data-layer]').forEach(cb => {
  cb.addEventListener('change', e => {
    toggleLayer(e.target.dataset.layer, e.target.checked);
  });
});

// ---- File drop / browse -------------------------------------------------- //

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = [...e.dataTransfer.files].filter(f => f.name.endsWith('.dlt'));
  if (files.length) handleFiles(files);
});

// ---- Main flow ----------------------------------------------------------- //

async function handleFiles(files) {
  if (!files.length) return;

  const dltFiles = files.filter(f => f.name.endsWith('.dlt'));
  if (!dltFiles.length) {
    alert('.dlt 파일을 선택해 주세요.');
    return;
  }

  progressSection.hidden = false;
  statsSection.hidden = true;
  layerPanel.hidden = true;
  setProgress(0, '분석 준비 중...');

  let lastProgressUpdate = 0;

  function onProgress(filePath, fileIndex, fileCount, overallBytes, totalBytes) {
    const now = Date.now();
    if (now - lastProgressUpdate < 80) return; // throttle UI updates
    lastProgressUpdate = now;
    const pct = totalBytes > 0 ? (overallBytes / totalBytes) * 100 : 0;
    setProgress(pct, `[${fileIndex}/${fileCount}] ${filePath} — ${pct.toFixed(1)}%`);
  }

  try {
    const result = await extractLogs(dltFiles, onProgress);
    setProgress(100, '분석 완료');
    displayResults(result);
  } catch (err) {
    console.error(err);
    progressLabel.textContent = `오류: ${err.message}`;
  }
}

function setProgress(pct, label) {
  progressBar.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', pct.toFixed(0));
  progressLabel.textContent = label;
}

function displayResults({ locationLogs, mmLogs, routeRequests, ttsLogs }) {
  // Stats
  const gpsCount = locationLogs.filter(p => p.sourceType === 'gps').length;
  const drGpsCount = locationLogs.filter(p => p.sourceType === 'dr_gps').length;
  const mmGpsCount = mmLogs.filter(p => p.sourceType === 'mm_gps').length;
  const mmMatchCount = mmLogs.filter(p => p.sourceType === 'mm_match').length;

  statPoints.textContent = locationLogs.length;
  statGps.textContent = gpsCount;
  statDrGps.textContent = drGpsCount;
  statMmGps.textContent = mmGpsCount;
  statMmMatch.textContent = mmMatchCount;
  statRoute.textContent = routeRequests.length;
  statTts.textContent = ttsLogs.length;

  const allTimestamps = [
    ...locationLogs.map(p => p.timestamp),
    ...mmLogs.map(p => p.timestamp),
    ...routeRequests.map(r => r.timestamp),
    ...ttsLogs.map(t => t.timestamp),
  ].filter(Boolean).map(t => t.getTime());

  if (allTimestamps.length > 0) {
    const first = new Date(Math.min(...allTimestamps));
    const last = new Date(Math.max(...allTimestamps));
    statTimeRange.textContent = `${formatTimestamp(first)}\n${formatTimestamp(last)}`;
  } else {
    statTimeRange.textContent = 'N/A';
  }

  statsSection.hidden = false;
  layerPanel.hidden = false;

  // Find map center
  const firstLoc = [...locationLogs, ...mmLogs, ...routeRequests, ...ttsLogs]
    .find(p => (p.lat ?? p.requestLat) != null);
  const center = firstLoc
    ? [firstLoc.lat ?? firstLoc.requestLat, firstLoc.lon ?? firstLoc.requestLon]
    : [37.5665, 126.9780];

  initMap('map', center);
  renderLogs(locationLogs, mmLogs, routeRequests, ttsLogs);
}
