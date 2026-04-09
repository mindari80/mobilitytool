/**
 * SHP link/node layer loader and renderer.
 * Depends on shpjs loaded as a global script (window.shp).
 *
 * Architecture:
 *  - shp-worker.js is a persistent spatial query server per SHP file.
 *  - Worker keeps ALL raw geometries + Float64Array bbox index.
 *  - Main thread sends viewport bounds → worker returns only visible features.
 *  - Coordinate transform (Bessel→WGS84) happens in worker, only for visible features.
 *  - No bulk transfer of millions of features to main thread.
 */

'use strict';

import { getMap } from './map-viewer.js';

const MIN_ZOOM = 17;

// ---- Module state -------------------------------------------------------- //

let linkWorker       = null;   // persistent worker for link SHP
let nodeWorker       = null;   // persistent worker for node SHP
let linkLayer        = null;
let nodeLayer        = null;
let activePopup      = null;
let clickListenerMap = null;
let moveListenerMap  = null;

let linkQueryId = 0;
let nodeQueryId = 0;
let linkEnabled = true;
let nodeEnabled = true;

// ---- Link selection mode ------------------------------------------------- //

let linkSelectMode = false;
let onLinkSelect   = null;
let selectedIndex  = -1;      // track by feature index (survives re-renders)
let selectedLayer  = null;    // current Leaflet layer for the selected feature

export function setLinkSelectMode(active, onSelect) {
  linkSelectMode = active;
  onLinkSelect   = onSelect;
  if (!active) {
    if (selectedLayer && linkLayer) { try { linkLayer.resetStyle(selectedLayer); } catch {} }
    selectedIndex = -1;
    selectedLayer = null;
  }
}

// ---- Viewport query ------------------------------------------------------ //

function updateViewport() {
  const map = getMap();
  if (!map) return;
  const zoom = map.getZoom();
  const show = zoom >= MIN_ZOOM;

  if (linkLayer) {
    if (!show || !linkEnabled || !linkWorker) {
      linkLayer.clearLayers();
    } else {
      const b = map.getBounds();
      linkQueryId++;
      linkWorker.postMessage({
        type: 'query',
        bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
        queryId: linkQueryId,
      });
    }
  }

  if (nodeLayer) {
    if (!show || !nodeEnabled || !nodeWorker) {
      nodeLayer.clearLayers();
    } else {
      const b = map.getBounds();
      nodeQueryId++;
      nodeWorker.postMessage({
        type: 'query',
        bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
        queryId: nodeQueryId,
      });
    }
  }
}

// ---- Map event listeners ------------------------------------------------- //

function ensureMapClickListener(map) {
  if (clickListenerMap === map) return;
  map.on('click', () => {
    if (activePopup) { try { map.closePopup(); } catch {} activePopup = null; }
  });
  clickListenerMap = map;
}

function ensureMapMoveListener(map) {
  if (moveListenerMap === map) return;
  map.on('zoomend moveend', () => updateViewport());
  moveListenerMap = map;
}

// ---- Popup HTML ---------------------------------------------------------- //

function buildPopupHtml(props) {
  if (!props) return '<em style="color:#94a3b8">속성 없음</em>';
  const entries = Object.entries(props)
    .filter(([k, v]) => k !== '_shpIndex' && v !== null && v !== undefined && v !== '');
  if (!entries.length) return '<em style="color:#94a3b8">속성 없음</em>';
  const rows = entries.map(([k, v]) =>
    `<tr>
      <td style="color:#94a3b8;padding:2px 10px 2px 0;font-size:11px;white-space:nowrap;vertical-align:top">${k}</td>
      <td style="font-size:11px;word-break:break-all">${v}</td>
    </tr>`
  ).join('');
  return `<div style="max-height:220px;overflow-y:auto;min-width:180px">
    <table style="border-collapse:collapse;width:100%">${rows}</table>
  </div>`;
}

// ---- Public API ---------------------------------------------------------- //

export function clearShpLayers() {
  if (linkWorker) { try { linkWorker.terminate(); } catch {} linkWorker = null; }
  if (nodeWorker) { try { nodeWorker.terminate(); } catch {} nodeWorker = null; }
  if (linkLayer)  { try { linkLayer.remove();      } catch {} linkLayer  = null; }
  if (nodeLayer)  { try { nodeLayer.remove();      } catch {} nodeLayer  = null; }
  const map = getMap();
  if (activePopup && map) { try { map.closePopup(); } catch {} }
  activePopup   = null;
  selectedIndex = -1;
  selectedLayer = null;
}

/**
 * @param {File[]} files
 * @param {(pct:number, msg:string)=>void} onProgress
 * @returns {Promise<{name,count,type}[]>}
 */
export async function loadShpFiles(files, onProgress) {
  const groups = new Map();
  for (const file of files) {
    const lower = file.name.toLowerCase();
    const dot   = lower.lastIndexOf('.');
    if (dot === -1) continue;
    const ext  = lower.slice(dot + 1);
    const base = lower.slice(0, dot);
    if (ext === 'shp' || ext === 'dbf') {
      if (!groups.has(base)) groups.set(base, {});
      groups.get(base)[ext] = file;
    }
  }

  const results = [];
  for (const [base, group] of groups) {
    if (!group.shp) continue;
    const displayName = base.split(/[\\/]/).pop();
    const info = await renderShpGroup(displayName, group, onProgress);
    results.push(info);
  }
  return results;
}

export function toggleShpLink(visible) {
  linkEnabled = visible;
  updateViewport();
}

export function toggleShpNode(visible) {
  nodeEnabled = visible;
  updateViewport();
}

// ---- Internal rendering -------------------------------------------------- //

async function renderShpGroup(name, group, onProgress) {
  const prog = (pct, msg) => { if (onProgress) onProgress(pct, msg); };

  prog(5, '[1/3] 파일 읽는 중...');
  const shpBuf = await group.shp.arrayBuffer();
  const dbfBuf = group.dbf ? await group.dbf.arrayBuffer() : null;

  prog(15, 'Worker 시작 중...');

  // Phase 1: load SHP in worker, wait for 'ready'
  const { count, geomType, worker } = await new Promise((resolve, reject) => {
    const url    = new URL('./shp-worker.js', import.meta.url);
    const worker = new Worker(url);

    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        prog(data.pct, data.msg);
      } else if (data.type === 'ready') {
        resolve({ count: data.count, geomType: data.geomType, worker });
      } else if (data.type === 'error') {
        worker.terminate();
        reject(new Error(data.msg));
      }
    };
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };

    const transfer = [shpBuf];
    if (dbfBuf) transfer.push(dbfBuf);
    worker.postMessage({ type: 'load', shpBuf, dbfBuf }, transfer);
  });

  if (!count) { prog(100, '완료 (feature 없음)'); return { name, count: 0, type: 'empty' }; }

  const isLine = geomType === 'LineString' || geomType === 'MultiLineString';
  const map    = getMap();

  ensureMapClickListener(map);
  ensureMapMoveListener(map);

  // Phase 2: set up Leaflet layer + switch worker to query mode
  if (isLine) {
    if (linkWorker) { try { linkWorker.terminate(); } catch {} }
    linkWorker = worker;

    if (linkLayer) { try { linkLayer.remove(); } catch {} }
    linkLayer = L.geoJSON(null, {
      style: { color: '#22c55e', weight: 1.5, opacity: 0.8 },
      onEachFeature(feature, layer) {
        const idx = feature._shpIndex;

        // Re-apply highlight if this is the selected feature
        if (idx === selectedIndex) {
          selectedLayer = layer;
          layer.setStyle({ color: '#f59e0b', weight: 3, opacity: 1 });
        }

        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if (linkSelectMode && onLinkSelect) {
            if (selectedLayer && linkLayer) { try { linkLayer.resetStyle(selectedLayer); } catch {} }
            e.target.setStyle({ color: '#f59e0b', weight: 3, opacity: 1 });
            selectedLayer = e.target;
            selectedIndex = idx;
            onLinkSelect(feature.properties);
          } else if (!linkSelectMode) {
            if (activePopup) { try { map.closePopup(); } catch {} }
            activePopup = L.popup({ maxWidth: 320, closeButton: true, autoClose: false, closeOnClick: false })
              .setLatLng(e.latlng)
              .setContent(buildPopupHtml(feature.properties));
            map.openPopup(activePopup);
          }
        });
        layer.on('mouseover', e => {
          if (idx !== selectedIndex) e.target.setStyle({ weight: 3, opacity: 1, color: '#4ade80' });
        });
        layer.on('mouseout', e => {
          if (idx !== selectedIndex && linkLayer) linkLayer.resetStyle(e.target);
        });
      },
    }).addTo(map);

    // Switch worker message handler to query responses
    worker.onmessage = ({ data }) => {
      if (data.type !== 'features' || data.queryId !== linkQueryId || !linkLayer) return;
      linkLayer.clearLayers();
      data.data.forEach(d => linkLayer.addData(d.wgs84Feature));
    };

  } else {
    if (nodeWorker) { try { nodeWorker.terminate(); } catch {} }
    nodeWorker = worker;

    if (nodeLayer) { try { nodeLayer.remove(); } catch {} }
    nodeLayer = L.geoJSON(null, {
      pointToLayer: (_, latlng) => L.circleMarker(latlng, {
        radius: 3, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.8, weight: 1,
      }),
      onEachFeature(feature, layer) {
        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if (activePopup) { try { map.closePopup(); } catch {} }
          activePopup = L.popup({ maxWidth: 320, closeButton: true, autoClose: false, closeOnClick: false })
            .setLatLng(e.latlng)
            .setContent(buildPopupHtml(feature.properties));
          map.openPopup(activePopup);
        });
      },
    }).addTo(map);

    worker.onmessage = ({ data }) => {
      if (data.type !== 'features' || data.queryId !== nodeQueryId || !nodeLayer) return;
      nodeLayer.clearLayers();
      data.data.forEach(d => nodeLayer.addData(d.wgs84Feature));
    };
  }

  // Trigger first viewport render
  updateViewport();
  prog(100, `완료 — ${count.toLocaleString()}개 feature 로드`);

  return { name, count, type: isLine ? 'link' : 'node' };
}
