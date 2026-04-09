/**
 * SHP link/node layer loader and renderer.
 * Depends on shpjs loaded as a global script (window.shp).
 */

'use strict';

import { getMap } from './map-viewer.js';

let linkLayer       = null;
let nodeLayer       = null;
let activePopup     = null;
let clickListenerMap = null;  // track which map has the background-click handler

// ---- Background click: close popup --------------------------------------- //

function ensureMapClickListener(map) {
  if (clickListenerMap === map) return;
  map.on('click', () => {
    if (activePopup) { try { map.closePopup(); } catch {} activePopup = null; }
  });
  clickListenerMap = map;
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
  if (linkLayer) { try { linkLayer.remove(); } catch {} linkLayer = null; }
  if (nodeLayer) { try { nodeLayer.remove(); } catch {} nodeLayer = null; }
  const map = getMap();
  if (activePopup && map) { try { map.closePopup(); } catch {} }
  activePopup = null;
}

/**
 * @param {File[]} files  - array of File objects (.shp, .dbf, etc.)
 * @param {(msg:string)=>void} onStatus - status callback
 * @returns {Promise<{name,count,type}[]>}
 */
export async function loadShpFiles(files, onStatus) {
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
    if (onStatus) onStatus(`읽는 중: ${displayName}...`);
    const info = await renderShpGroup(displayName, group);
    results.push(info);
  }
  return results;
}

export function toggleShpLink(visible) {
  const map = getMap();
  if (!linkLayer || !map) return;
  visible ? map.addLayer(linkLayer) : map.removeLayer(linkLayer);
}

export function toggleShpNode(visible) {
  const map = getMap();
  if (!nodeLayer || !map) return;
  visible ? map.addLayer(nodeLayer) : map.removeLayer(nodeLayer);
}

// ---- Internal rendering -------------------------------------------------- //

async function renderShpGroup(name, group) {
  const shpBuf = await group.shp.arrayBuffer();
  const dbfBuf = group.dbf ? await group.dbf.arrayBuffer() : null;

  // shpjs v4 top-level shp() only handles ZIP files.
  // Use parseShp / parseDbf to handle raw .shp/.dbf buffers directly.
  const geometries = window.shp.parseShp(shpBuf);
  const attributes = dbfBuf ? window.shp.parseDbf(dbfBuf) : [];

  const features = geometries.map((geom, i) => ({
    type: 'Feature',
    geometry: geom,
    properties: attributes[i] || {},
  }));

  const geojson = { type: 'FeatureCollection', features };
  if (!features.length) return { name, count: 0, type: 'empty' };

  const geomType = features[0]?.geometry?.type || '';
  const isLine   = geomType === 'LineString' || geomType === 'MultiLineString';
  const map      = getMap();

  ensureMapClickListener(map);

  if (isLine) {
    if (linkLayer) { try { linkLayer.remove(); } catch {} }
    linkLayer = L.geoJSON(geojson, {
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
    nodeLayer = L.geoJSON(geojson, {
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

  return { name, count: features.length, type: isLine ? 'link' : 'node' };
}
