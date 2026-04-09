/**
 * SHP link/node layer loader and renderer.
 * Depends on shpjs loaded as a global script (window.shp).
 *
 * Rendering strategy:
 *  - All features are parsed once and kept in memory with pre-computed bboxes.
 *  - Only features that intersect the current map viewport are rendered.
 *  - Layers are only shown at zoom >= MIN_ZOOM (17).
 */

'use strict';

import { getMap } from './map-viewer.js';

const MIN_ZOOM = 17;

let linkLayer        = null;
let nodeLayer        = null;
let activePopup      = null;
let clickListenerMap = null;
let moveListenerMap  = null;

let allLinkData = [];  // { feature, bbox: [w,s,e,n] }[]
let allNodeData = [];

let linkEnabled = true;
let nodeEnabled = true;

// ---- Geometry helpers ---------------------------------------------------- //

function flatCoords(geom) {
  if (!geom) return [];
  switch (geom.type) {
    case 'Point':           return [geom.coordinates];
    case 'LineString':      return geom.coordinates;
    case 'MultiLineString': return geom.coordinates.flat();
    case 'MultiPoint':      return geom.coordinates;
    default:                return [];
  }
}

function featureBbox(geom) {
  const coords = flatCoords(geom);
  if (!coords.length) return [0, 0, 0, 0];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < w) w = lng; if (lat < s) s = lat;
    if (lng > e) e = lng; if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

function bboxIntersects([fw, fs, fe, fn], bounds) {
  return fe >= bounds.getWest()  && fw <= bounds.getEast() &&
         fn >= bounds.getSouth() && fs <= bounds.getNorth();
}

// ---- Viewport update ----------------------------------------------------- //

function updateViewport() {
  const map = getMap();
  if (!map) return;
  const zoom  = map.getZoom();
  const show  = zoom >= MIN_ZOOM;
  const bounds = map.getBounds();

  if (linkLayer) {
    linkLayer.clearLayers();
    if (show && linkEnabled && allLinkData.length) {
      allLinkData
        .filter(d => bboxIntersects(d.bbox, bounds))
        .forEach(d => linkLayer.addData(d.feature));
    }
  }
  if (nodeLayer) {
    nodeLayer.clearLayers();
    if (show && nodeEnabled && allNodeData.length) {
      allNodeData
        .filter(d => bboxIntersects(d.bbox, bounds))
        .forEach(d => nodeLayer.addData(d.feature));
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
  if (linkLayer) { try { linkLayer.remove(); } catch {} linkLayer = null; }
  if (nodeLayer) { try { nodeLayer.remove(); } catch {} nodeLayer = null; }
  const map = getMap();
  if (activePopup && map) { try { map.closePopup(); } catch {} }
  activePopup = null;
}

/**
 * @param {File[]} files  - array of File objects (.shp, .dbf, etc.)
 * @param {(pct:number, msg:string)=>void} onProgress - progress callback (0-100)
 * @returns {Promise<{name,count,type}[]>}
 */
export async function loadShpFiles(files, onProgress) {
  // Group by lowercase base name → { shp?: File, dbf?: File }
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

  prog(5,  `[1/4] SHP 파일 읽는 중...`);
  const shpBuf = await group.shp.arrayBuffer();

  prog(25, `[2/4] 지오메트리 파싱 중...`);
  // Small yield so the UI can repaint before heavy parse
  await new Promise(r => setTimeout(r, 0));
  const geometries = window.shp.parseShp(shpBuf);

  let attributes = [];
  if (group.dbf) {
    prog(50, `[3/4] DBF 속성 읽는 중...`);
    const dbfBuf = await group.dbf.arrayBuffer();
    await new Promise(r => setTimeout(r, 0));
    attributes = window.shp.parseDbf(dbfBuf);
  } else {
    prog(50, `[3/4] DBF 없음 — 속성 생략`);
  }

  prog(75, `[4/4] 공간 인덱스 생성 중...`);
  await new Promise(r => setTimeout(r, 0));

  const features = geometries.map((geom, i) => ({
    type: 'Feature',
    geometry: geom,
    properties: attributes[i] || {},
  }));

  if (!features.length) { prog(100, '완료 (feature 없음)'); return { name, count: 0, type: 'empty' }; }

  const geomType = features[0]?.geometry?.type || '';
  const isLine   = geomType === 'LineString' || geomType === 'MultiLineString';
  const map      = getMap();

  ensureMapClickListener(map);
  ensureMapMoveListener(map);

  if (isLine) {
    if (linkLayer) { try { linkLayer.remove(); } catch {} }
    allLinkData = features.map(f => ({ feature: f, bbox: featureBbox(f.geometry) }));
    linkLayer = L.geoJSON(null, {
      style: { color: '#22c55e', weight: 1.5, opacity: 0.8 },
      onEachFeature(feature, layer) {
        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if (activePopup) { try { map.closePopup(); } catch {} }
          activePopup = L.popup({ maxWidth: 320, closeButton: true, autoClose: false, closeOnClick: false })
            .setLatLng(e.latlng)
            .setContent(buildPopupHtml(feature.properties));
          map.openPopup(activePopup);
        });
        layer.on('mouseover', e => e.target.setStyle({ weight: 3, opacity: 1, color: '#4ade80' }));
        layer.on('mouseout',  e => { if (linkLayer) linkLayer.resetStyle(e.target); });
      },
    }).addTo(map);
  } else {
    if (nodeLayer) { try { nodeLayer.remove(); } catch {} }
    allNodeData = features.map(f => ({ feature: f, bbox: featureBbox(f.geometry) }));
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
  prog(100, `완료 — ${features.length.toLocaleString()}개 feature 로드`);

  return { name, count: features.length, type: isLine ? 'link' : 'node' };
}
