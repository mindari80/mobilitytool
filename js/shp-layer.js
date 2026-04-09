/**
 * SHP link/node layer loader and renderer.
 * Depends on shpjs loaded as a global script (window.shp).
 *
 * Coordinate system: GCS_Tokyo (Bessel 1841) → WGS84 via 3-param Helmert
 * Rendering: viewport-based at zoom >= MIN_ZOOM
 */

'use strict';

import { getMap } from './map-viewer.js';

const MIN_ZOOM = 17;

// ---- Coordinate transform: GCS_Tokyo (Bessel 1841) → WGS84 -------------- //

const BESSEL = { a: 6377397.155, invF: 299.1528128 };
const WGS84  = { a: 6378137.0,   invF: 298.257223563 };
// EPSG:1838 — Tokyo to WGS84, Korea South
const DX = -147.0, DY = 506.0, DZ = 687.5;

function besselToWgs84(lon, lat) {
  const f_b = 1 / BESSEL.invF, e2_b = 2*f_b - f_b*f_b;
  const f_w = 1 / WGS84.invF,  e2_w = 2*f_w - f_w*f_w;
  const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
  const sinφ = Math.sin(φ), cosφ = Math.cos(φ);
  const N_b = BESSEL.a / Math.sqrt(1 - e2_b * sinφ * sinφ);
  const X = N_b * cosφ * Math.cos(λ);
  const Y = N_b * cosφ * Math.sin(λ);
  const Z = N_b * (1 - e2_b) * sinφ;
  const X2 = X + DX, Y2 = Y + DY, Z2 = Z + DZ;
  const λ2 = Math.atan2(Y2, X2);
  const p  = Math.sqrt(X2*X2 + Y2*Y2);
  let φ2   = Math.atan2(Z2, p * (1 - e2_w));
  for (let i = 0; i < 10; i++) {
    const N = WGS84.a / Math.sqrt(1 - e2_w * Math.sin(φ2) ** 2);
    φ2 = Math.atan2(Z2 + e2_w * N * Math.sin(φ2), p);
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

// ---- Layer state --------------------------------------------------------- //

let linkLayer        = null;
let nodeLayer        = null;
let activePopup      = null;
let clickListenerMap = null;
let moveListenerMap  = null;

let allLinkData = [];  // { feature, bbox: [w,s,e,n] }[]
let allNodeData = [];

let linkEnabled = true;
let nodeEnabled = true;

// ---- Link selection mode ------------------------------------------------- //

let linkSelectMode  = false;
let onLinkSelect    = null;
let selectedFeature = null;
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
  const zoom   = map.getZoom();
  const show   = zoom >= MIN_ZOOM;
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
 * @param {(pct:number, msg:string)=>void} onProgress - progress callback (0-100)
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

  prog(5,  '[1/4] SHP 파일 읽는 중...');
  const shpBuf = await group.shp.arrayBuffer();

  prog(25, '[2/4] 지오메트리 파싱 중...');
  await new Promise(r => setTimeout(r, 0));
  const geometries = window.shp.parseShp(shpBuf);

  let attributes = [];
  if (group.dbf) {
    prog(45, '[3/4] DBF 속성 읽는 중...');
    const dbfBuf = await group.dbf.arrayBuffer();
    await new Promise(r => setTimeout(r, 0));
    attributes = window.shp.parseDbf(dbfBuf);
  } else {
    prog(45, '[3/4] DBF 없음 — 속성 생략');
  }

  prog(65, '[4/4] 좌표 변환 및 인덱스 생성 중...');
  await new Promise(r => setTimeout(r, 0));

  const features = geometries.map((geom, i) => ({
    type: 'Feature',
    geometry: transformGeom(geom),
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
        // Restore highlight if this is the selected feature after viewport rebuild
        if (feature === selectedFeature) {
          selectedLayer = layer;
          layer.setStyle({ color: '#f59e0b', weight: 3, opacity: 1 });
        }
        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if (linkSelectMode && onLinkSelect) {
            // Reset previous selection
            if (selectedLayer && linkLayer) { try { linkLayer.resetStyle(selectedLayer); } catch {} }
            // Highlight new selection
            e.target.setStyle({ color: '#f59e0b', weight: 3, opacity: 1 });
            selectedLayer  = e.target;
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
