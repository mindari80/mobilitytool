/**
 * SHP link/node layer loader and renderer.
 * Depends on shpjs loaded as a global script (window.shp).
 *
 * Architecture:
 *  - shp-worker.js is a persistent spatial query server per SHP file.
 *  - Worker keeps ALL raw geometries + Float64Array bbox index.
 *  - Main thread sends viewport bounds → worker returns only visible features.
 *  - Coordinate transform (Bessel→WGS84) happens in worker, only for visible features.
 *  - DBF attributes are NOT loaded at startup — fetched on-demand per click via 'attrs'.
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

// Pending callbacks for on-demand attrs requests
let pendingLinkAttrsCallback = null;
let pendingNodeAttrsCallback = null;

// ---- Selection state ----------------------------------------------------- //

const SEL_LINK_STYLE = { color: '#ef4444', weight: 3, opacity: 1 };
const SEL_NODE_STYLE = { color: '#ef4444', fillColor: '#ef4444', fillOpacity: 1, weight: 2, radius: 5 };
const DEF_NODE_STYLE = { color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.8, weight: 1, radius: 3 };

let linkSelectMode  = false;
let onLinkSelect    = null;
let selectedIndex   = -1;     // link: track by feature index (survives re-renders)
let selectedLayer   = null;   // link: current Leaflet layer for the selected feature
let selectedNodeIdx = -1;     // node: same
let selectedNodeLyr = null;   // node: current Leaflet layer

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

// GCS_Tokyo raw bbox is ~0.002-0.003° south of WGS84 due to datum shift.
// Expand query bounds so features near edges are not missed.
const QUERY_BUFFER = 0.01;  // ~1km, safely covers the ~250m datum offset

function queryBounds(map) {
  const b = map.getBounds();
  return [
    b.getWest()  - QUERY_BUFFER,
    b.getSouth() - QUERY_BUFFER,
    b.getEast()  + QUERY_BUFFER,
    b.getNorth() + QUERY_BUFFER,
  ];
}

function updateViewport() {
  const map = getMap();
  if (!map) return;
  const zoom = map.getZoom();
  const show = zoom >= MIN_ZOOM;

  if (linkLayer) {
    if (!show || !linkEnabled || !linkWorker) {
      linkLayer.clearLayers();
    } else {
      linkQueryId++;
      linkWorker.postMessage({ type: 'query', bounds: queryBounds(map), queryId: linkQueryId });
    }
  }

  if (nodeLayer) {
    if (!show || !nodeEnabled || !nodeWorker) {
      nodeLayer.clearLayers();
    } else {
      nodeQueryId++;
      nodeWorker.postMessage({ type: 'query', bounds: queryBounds(map), queryId: nodeQueryId });
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
    .filter(([, v]) => v !== null && v !== undefined && v !== '');
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
  activePopup              = null;
  selectedIndex            = -1;
  selectedLayer            = null;
  selectedNodeIdx          = -1;
  selectedNodeLyr          = null;
  pendingLinkAttrsCallback = null;
  pendingNodeAttrsCallback = null;
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

  prog(5, '파일 읽는 중...');
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
          layer.setStyle(SEL_LINK_STYLE);
        }

        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if (linkSelectMode && onLinkSelect) {
            if (selectedLayer && linkLayer) { try { linkLayer.resetStyle(selectedLayer); } catch {} }
            e.target.setStyle(SEL_LINK_STYLE);
            selectedLayer = e.target;
            selectedIndex = idx;
            // Request attrs on-demand
            pendingLinkAttrsCallback = props => onLinkSelect(props);
            linkWorker.postMessage({ type: 'attrs', index: idx });
          } else if (!linkSelectMode) {
            if (activePopup) { try { map.closePopup(); } catch {} }
            const latlng = e.latlng;
            pendingLinkAttrsCallback = props => {
              activePopup = L.popup({ maxWidth: 320, closeButton: true, autoClose: false, closeOnClick: false })
                .setLatLng(latlng)
                .setContent(buildPopupHtml(props));
              map.openPopup(activePopup);
            };
            linkWorker.postMessage({ type: 'attrs', index: idx });
          }
        });
        layer.on('mouseover', e => {
          if (idx !== selectedIndex) e.target.setStyle({ weight: 3, opacity: 1, color: '#4ade80' });
        });
        layer.on('mouseout',  e => {
          if (idx !== selectedIndex && linkLayer) linkLayer.resetStyle(e.target);
        });
      },
    }).addTo(map);

    // Handle both 'features' (viewport query) and 'attrs' (on-demand click) responses
    worker.onmessage = ({ data }) => {
      if (data.type === 'features') {
        if (data.queryId !== linkQueryId || !linkLayer) return;
        linkLayer.clearLayers();
        data.data.forEach(d => linkLayer.addData(d.wgs84Feature));
      } else if (data.type === 'attrs') {
        if (pendingLinkAttrsCallback) {
          pendingLinkAttrsCallback(data.props);
          pendingLinkAttrsCallback = null;
        }
      }
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
        const idx = feature._shpIndex;

        // Re-apply highlight if this is the selected node
        if (idx === selectedNodeIdx) {
          selectedNodeLyr = layer;
          layer.setStyle(SEL_NODE_STYLE);
        }

        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if (activePopup) { try { map.closePopup(); } catch {} }
          // Highlight selected node
          if (selectedNodeLyr) { try { selectedNodeLyr.setStyle(DEF_NODE_STYLE); } catch {} }
          e.target.setStyle(SEL_NODE_STYLE);
          selectedNodeLyr = e.target;
          selectedNodeIdx = idx;
          // Request attrs on-demand
          const latlng = e.latlng;
          pendingNodeAttrsCallback = props => {
            activePopup = L.popup({ maxWidth: 320, closeButton: true, autoClose: false, closeOnClick: false })
              .setLatLng(latlng)
              .setContent(buildPopupHtml(props));
            map.openPopup(activePopup);
          };
          nodeWorker.postMessage({ type: 'attrs', index: idx });
        });
      },
    }).addTo(map);

    worker.onmessage = ({ data }) => {
      if (data.type === 'features') {
        if (data.queryId !== nodeQueryId || !nodeLayer) return;
        nodeLayer.clearLayers();
        data.data.forEach(d => nodeLayer.addData(d.wgs84Feature));
      } else if (data.type === 'attrs') {
        if (pendingNodeAttrsCallback) {
          pendingNodeAttrsCallback(data.props);
          pendingNodeAttrsCallback = null;
        }
      }
    };
  }

  // Trigger first viewport render
  updateViewport();
  prog(100, `완료 — ${count.toLocaleString()}개 feature 로드`);

  return { name, count, type: isLine ? 'link' : 'node' };
}
