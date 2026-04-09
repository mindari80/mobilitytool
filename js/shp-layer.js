/**
 * SHP link/node layer loader and renderer.
 * Depends on shpjs loaded as a global script (window.shp).
 *
 * Strategy:
 *  - Worker parses raw features + computes raw bbox (no coord transform).
 *  - Main thread lazily transforms only viewport-visible features on demand.
 *  - Transformed features are cached (wgs84 property on data entry).
 *  - Rendering only at zoom >= MIN_ZOOM.
 */

'use strict';

import { getMap } from './map-viewer.js';

const MIN_ZOOM = 17;

// ---- On-demand coordinate transform: GCS_Tokyo → WGS84 ------------------ //
// EPSG:1838 — Korea South (dx=-147, dy=506, dz=687.5)

const BESSEL_a  = 6377397.155;
const BESSEL_e2 = (() => { const f = 1/299.1528128;  return 2*f - f*f; })();
const WGS84_a   = 6378137.0;
const WGS84_e2  = (() => { const f = 1/298.257223563; return 2*f - f*f; })();
const DX = -147.0, DY = 506.0, DZ = 687.5;

function besselToWgs84(lon, lat) {
  const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
  const sinφ = Math.sin(φ), cosφ = Math.cos(φ);
  const N = BESSEL_a / Math.sqrt(1 - BESSEL_e2 * sinφ * sinφ);
  const X2 = N * cosφ * Math.cos(λ) + DX;
  const Y2 = N * cosφ * Math.sin(λ) + DY;
  const Z2 = N * (1 - BESSEL_e2) * sinφ + DZ;
  const λ2 = Math.atan2(Y2, X2);
  const p  = Math.sqrt(X2*X2 + Y2*Y2);
  let φ2 = Math.atan2(Z2, p * (1 - WGS84_e2));
  for (let i = 0; i < 10; i++) {
    const Nw = WGS84_a / Math.sqrt(1 - WGS84_e2 * Math.sin(φ2) ** 2);
    φ2 = Math.atan2(Z2 + WGS84_e2 * Nw * Math.sin(φ2), p);
  }
  return [λ2 * 180 / Math.PI, φ2 * 180 / Math.PI];
}

function transformGeom(geom) {
  if (!geom) return geom;
  const tr = ([lng, lat]) => besselToWgs84(lng, lat);
  switch (geom.type) {
    case 'Point':           return { ...geom, coordinates: tr(geom.coordinates) };
    case 'LineString':      return { ...geom, coordinates: geom.coordinates.map(tr) };
    case 'MultiLineString': return { ...geom, coordinates: geom.coordinates.map(r => r.map(tr)) };
    case 'MultiPoint':      return { ...geom, coordinates: geom.coordinates.map(tr) };
    default:                return geom;
  }
}

/**
 * Lazily transform and cache a data entry.
 * d = { rawFeature, rawBbox, wgs84: null }
 * After first call: d.wgs84 = { type:'Feature', geometry:<WGS84>, properties }
 */
function ensureWgs84(d) {
  if (!d.wgs84) {
    d.wgs84 = {
      type: 'Feature',
      geometry: transformGeom(d.rawFeature.geometry),
      properties: d.rawFeature.properties,
    };
  }
  return d.wgs84;
}

// ---- Layer state --------------------------------------------------------- //

let linkLayer        = null;
let nodeLayer        = null;
let activePopup      = null;
let clickListenerMap = null;
let moveListenerMap  = null;

// Data entries: { rawFeature, rawBbox, wgs84: null }
let allLinkData = [];
let allNodeData = [];

let linkEnabled = true;
let nodeEnabled = true;

// ---- Link selection mode ------------------------------------------------- //

let linkSelectMode  = false;
let onLinkSelect    = null;
let selectedFeature = null;   // wgs84 feature reference
let selectedLayer   = null;

export function setLinkSelectMode(active, onSelect) {
  linkSelectMode = active;
  onLinkSelect   = onSelect;
  if (!active) {
    if (selectedLayer && linkLayer) { try { linkLayer.resetStyle(selectedLayer); } catch {} }
    selectedFeature = null;
    selectedLayer   = null;
  }
}

// ---- Bbox intersection (raw coords are close enough for filtering) ------- //

function bboxIntersects([fw, fs, fe, fn], bounds) {
  return fe >= bounds.getWest()  && fw <= bounds.getEast() &&
         fn >= bounds.getSouth() && fs <= bounds.getNorth();
}

// ---- Web Worker parse ---------------------------------------------------- //

function parseInWorker(shpBuf, dbfBuf, onProgress) {
  return new Promise((resolve, reject) => {
    const workerUrl   = new URL('./shp-worker.js', import.meta.url);
    const worker      = new Worker(workerUrl);
    const accumulated = [];

    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        if (onProgress) onProgress(data.pct, data.msg);
      } else if (data.type === 'chunk') {
        for (let i = 0; i < data.data.length; i++) accumulated.push(data.data[i]);
        if (onProgress) onProgress(data.pct, data.msg);
      } else if (data.type === 'done') {
        worker.terminate();
        resolve(accumulated);
      } else if (data.type === 'error') {
        worker.terminate();
        reject(new Error(data.msg));
      }
    };
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };

    const transfer = [shpBuf];
    if (dbfBuf) transfer.push(dbfBuf);
    worker.postMessage({ shpBuf, dbfBuf }, transfer);
  });
}

// ---- Viewport update ----------------------------------------------------- //

function updateViewport() {
  const map = getMap();
  if (!map) return;
  const zoom   = map.getZoom();
  const show   = zoom >= MIN_ZOOM;
  const bounds = map.getBounds();

  if (linkLayer) {
    linkLayer.clearLayers();
    if (show && linkEnabled && allLinkData.length) {
      allLinkData
        .filter(d => bboxIntersects(d.rawBbox, bounds))
        .forEach(d => linkLayer.addData(ensureWgs84(d)));
    }
  }
  if (nodeLayer) {
    nodeLayer.clearLayers();
    if (show && nodeEnabled && allNodeData.length) {
      allNodeData
        .filter(d => bboxIntersects(d.rawBbox, bounds))
        .forEach(d => nodeLayer.addData(ensureWgs84(d)));
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
  const entries = Object.entries(props).filter(([, v]) => v !== null && v !== undefined && v !== '');
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
  allLinkData = [];
  allNodeData = [];
  selectedFeature = null;
  selectedLayer   = null;
  if (linkLayer) { try { linkLayer.remove(); } catch {} linkLayer = null; }
  if (nodeLayer) { try { nodeLayer.remove(); } catch {} nodeLayer = null; }
  const map = getMap();
  if (activePopup && map) { try { map.closePopup(); } catch {} }
  activePopup = null;
}

/**
 * @param {File[]} files  - array of File objects (.shp, .dbf, etc.)
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

  prog(15, '[2/3] 백그라운드 파싱 시작...');
  const parsedData = await parseInWorker(shpBuf, dbfBuf, prog);

  if (!parsedData.length) { prog(100, '완료 (feature 없음)'); return { name, count: 0, type: 'empty' }; }

  const geomType = parsedData[0]?.rawFeature?.geometry?.type || '';
  const isLine   = geomType === 'LineString' || geomType === 'MultiLineString';
  const map      = getMap();

  ensureMapClickListener(map);
  ensureMapMoveListener(map);

  if (isLine) {
    if (linkLayer) { try { linkLayer.remove(); } catch {} }
    allLinkData = parsedData;
    linkLayer = L.geoJSON(null, {
      style: { color: '#22c55e', weight: 1.5, opacity: 0.8 },
      onEachFeature(feature, layer) {
        // Restore highlight after viewport rebuild (feature is the cached wgs84 object)
        if (feature === selectedFeature) {
          selectedLayer = layer;
          layer.setStyle({ color: '#f59e0b', weight: 3, opacity: 1 });
        }
        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if (linkSelectMode && onLinkSelect) {
            if (selectedLayer && linkLayer) { try { linkLayer.resetStyle(selectedLayer); } catch {} }
            e.target.setStyle({ color: '#f59e0b', weight: 3, opacity: 1 });
            selectedLayer   = e.target;
            selectedFeature = feature;
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
          if (feature !== selectedFeature)
            e.target.setStyle({ weight: 3, opacity: 1, color: '#4ade80' });
        });
        layer.on('mouseout', e => {
          if (feature !== selectedFeature && linkLayer)
            linkLayer.resetStyle(e.target);
        });
      },
    }).addTo(map);
  } else {
    if (nodeLayer) { try { nodeLayer.remove(); } catch {} }
    allNodeData = parsedData;
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
  }

  updateViewport();
  prog(100, `완료 — ${parsedData.length.toLocaleString()}개 feature 로드`);

  return { name, count: parsedData.length, type: isLine ? 'link' : 'node' };
}
