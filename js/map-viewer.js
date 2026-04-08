/**
 * TMAP map rendering using Leaflet + TMAP tile layer.
 * Renders location, map-matching, route request, and TTS layers.
 */

'use strict';

import { formatTimestamp, preparePayloadForDisplayExport } from './extractor.js';
import { wgs84ToSkCoord } from './coordinate.js';

let map = null;
let layers = {};
let routeAnchorLayer = null;
let coordLayer = null;

export function getMap() { return map; }

// ---- Popup HTML helpers -------------------------------------------------- //

function esc(s) {
  return String(s ?? 'N/A')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function field(label, value) {
  const text = (value == null || value === '') ? 'N/A' :
    Array.isArray(value) ? (value.length ? value.join(', ') : 'N/A') : String(value);
  return `<div><b>${esc(label)}:</b> ${esc(text)}</div>`;
}

function routePopupHtml(rr) {
  const displayPayload = rr.payload ? preparePayloadForDisplayExport(rr.payload) : null;
  const payloadPretty = displayPayload ? JSON.stringify(displayPayload, null, 2) : 'N/A';
  const statusColor = rr.responseStatus === 'SUCCESS' ? '#5eead4' :
    rr.responseStatus === 'FAILED' ? '#f87171' : '#94a3b8';
  const respDetail = [
    rr.responseTimeMs != null ? `${rr.responseTimeMs}ms` : null,
    rr.responseSize   != null ? `size: ${rr.responseSize}` : null,
  ].filter(Boolean).join(', ');

  return `
    <div class="route-popup">
      <div class="route-banner">
        <div><b>Route ID</b><br><span style="font-size:15px;font-weight:700;color:#a78bfa">${esc(rr.rpLabel || 'N/A')}</span></div>
        <div><b>Response</b><br><span style="font-size:17px;font-weight:700;color:${statusColor}">${esc(rr.responseStatus || 'UNKNOWN')}</span></div>
        <div><b>Session ID</b><br><span style="font-size:12px;font-weight:700;word-break:break-all">${esc(rr.sessionId || 'N/A')}</span></div>
      </div>
      ${field('Log File', rr.filePath)}
      ${field('Response', respDetail ? `${rr.responseStatus || 'UNKNOWN'} (${respDetail})` : rr.responseStatus || 'UNKNOWN')}
      ${field('Endpoint', rr.endpoint)}
      ${field('ReqTime', rr.reqTime)}
      ${field('Departure', rr.departName)}
      ${field('Departure SK', `${rr.departX}, ${rr.departY}`)}
      ${field('Departure WGS84', rr.departLat != null ? `${rr.departLat.toFixed(6)}, ${rr.departLon.toFixed(6)}` : null)}
      ${field('Destination', rr.destName)}
      ${field('Destination SK', `${rr.destX}, ${rr.destY}`)}
      ${field('Destination WGS84', rr.destLat != null ? `${rr.destLat.toFixed(6)}, ${rr.destLon.toFixed(6)}` : null)}
      ${field('CameraTypes', rr.cameraTypes)}
      ${field('DangerAreaOptions', rr.dangerAreaOptions)}
      ${field('RoutePlanTypes', rr.routePlanTypes)}
      ${field('angle', rr.angle)}
      ${field('applyEvChargingTimeOnETA', rr.applyEvChargingTimeOnETA)}
      ${field('autoAddingYn', rr.autoAdding)}
      ${field('availableAutoAddingYn', rr.availableAutoAdding)}
      ${field('currentEnergy', rr.currentEnergy)}
      ${field('currentRange', rr.currentRange)}
      ${field('chargedEnergy', rr.chargedEnergy)}
      ${field('chargedRange', rr.chargedRange)}
      ${field('minSocAtAutoAdding', rr.minSocAutoAdding)}
      ${field('minSocAtChargingStation', rr.minSocChargingStation)}
      ${field('minSocAtDestination', rr.minSocDestination)}
      ${field('maxCharge', rr.maxCharge)}
      ${field('minEnergy', rr.minEnergy)}
      ${field('vehicleId', rr.vehicleId)}
      ${field('vendor', rr.vendor)}
      ${field('version', rr.version)}
      ${field('AppVersion', rr.appVersion)}
      ${field('BuildNo', rr.buildNo)}
      ${field('OSVersion', rr.osVersion)}
      ${field('ModelNo', rr.modelNo)}
      ${field('WaypointCount', rr.waypointCount)}
      <details><summary>Request Payload</summary><pre>${esc(payloadPretty)}</pre></details>
    </div>`;
}

function ttsPopupHtml(entry) {
  return `
    <div>
      ${field('Type', 'TTS Guidance')}
      ${field('Log File', entry.filePath)}
      ${field('Log Time', formatTimestamp(entry.timestamp))}
      ${field('Status', entry.status)}
      ${field('RequestId', entry.requestId)}
      ${field('GPS Source', entry.requestSourceType)}
      ${field('GPS Time', formatTimestamp(entry.requestLocationTime))}
      ${field('GPS WGS84', entry.requestLat != null ? `${entry.requestLat.toFixed(6)}, ${entry.requestLon.toFixed(6)}` : null)}
      ${field('Script', entry.script)}
    </div>`;
}

// ---- SVG icons ----------------------------------------------------------- //

const ttsIconHtml = `<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="#f97316" stroke="#7c2d12" stroke-width="1.5"/><path d="M8 15V11H11L14.5 8.5V17.5L11 15H8Z" fill="#fff"/><path d="M16.5 10.5C17.7 11.6 17.7 14.4 16.5 15.5" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><path d="M18.8 8.7C20.9 10.7 20.9 15.3 18.8 17.3" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const coordIconHtml = `<svg width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="#ef4444" stroke="#7f1d1d" stroke-width="1.5"/><line x1="14" y1="3" x2="14" y2="11" stroke="#fff" stroke-width="2" stroke-linecap="round"/><line x1="14" y1="17" x2="14" y2="25" stroke="#fff" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="14" x2="11" y2="14" stroke="#fff" stroke-width="2" stroke-linecap="round"/><line x1="17" y1="14" x2="25" y2="14" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="14" r="3" fill="#fff"/></svg>`;
const routeIconHtml = `<svg width="30" height="36" viewBox="0 0 30 36"><path d="M15 2C9.48 2 5 6.48 5 12C5 19.2 15 34 15 34C15 34 25 19.2 25 12C25 6.48 20.52 2 15 2Z" fill="#0f766e" stroke="#134e4a" stroke-width="1.6"/><path d="M10.5 12.5C12 10.1 14.2 8.8 18.4 8.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M18 6.9L20.7 8.8L18 10.7" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="17" r="1.9" fill="#fff"/><circle cx="18" cy="17" r="1.9" fill="#fff"/></svg>`;
const departIconHtml = `<svg width="28" height="28" viewBox="0 0 28 28"><path d="M7 4H9V24H7Z" fill="#14532d"/><path d="M9 5H21L17.2 9.2L21 13.4H9Z" fill="#22c55e" stroke="#166534" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
const destIconHtml = `<svg width="28" height="28" viewBox="0 0 28 28"><path d="M7 4H9V24H7Z" fill="#7f1d1d"/><path d="M9 5H21L17.2 9.2L21 13.4H9Z" fill="#ef4444" stroke="#7f1d1d" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
const waypointIconHtml = `<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" fill="#f59e0b" stroke="#92400e" stroke-width="1.5"/><path d="M7.2 11H14.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M11 7.2V14.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`;

function divIcon(html, size, anchor, popupAnchor) {
  return L.divIcon({ className: '', html, iconSize: size, iconAnchor: anchor, popupAnchor });
}

// ---- Map init ------------------------------------------------------------ //

/**
 * Initialise the Leaflet map with TMAP tiles.
 * @param {string} containerId  DOM element id
 * @param {[number,number]} center  [lat, lon]
 */
export function initMap(containerId, center = [37.5665, 126.9780]) {
  if (map) { map.remove(); map = null; }

  map = L.map(containerId, { preferCanvas: true, maxZoom: 19 }).setView(center, 15);

  L.tileLayer('https://tlpimg1.tmap.co.kr/tms/1.0.0/hd_tile/{z}/{x}/{-y}.png', {
    minZoom: 5, maxZoom: 19,
    attribution: 'TMAP',
  }).addTo(map);

  // ---- Zoom level display (next to +/- buttons) ----------------------------
  const ZoomDisplay = L.Control.extend({
    options: { position: 'topleft' },
    onAdd(m) {
      const el = L.DomUtil.create('div', 'leaflet-zoom-display');
      el.style.cssText = [
        'background:white',
        'color:#333',
        'width:26px',
        'height:26px',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'font-size:12px',
        'font-weight:700',
        'font-family:Arial,sans-serif',
        'border-radius:2px',
        'border:2px solid rgba(0,0,0,0.2)',
        'margin-top:1px',
        'pointer-events:none',
        'box-shadow:0 1px 5px rgba(0,0,0,0.4)',
        'line-height:1',
      ].join(';');
      const update = () => { el.textContent = m.getZoom(); };
      update();
      m.on('zoomend', update);
      return el;
    },
  });
  new ZoomDisplay().addTo(map);

  // Fallback OSM tile layer (shown if TMAP tiles fail)
  // Uncomment below to switch to OSM:
  // L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  //   attribution: '© OpenStreetMap contributors'
  // }).addTo(map);

  layers = {
    gps: L.layerGroup().addTo(map),
    drGps: L.layerGroup().addTo(map),
    mmGps: L.layerGroup().addTo(map),
    mmMatch: L.layerGroup().addTo(map),
    routeRequest: L.layerGroup().addTo(map),
    tts: L.layerGroup().addTo(map),
  };
  routeAnchorLayer = L.layerGroup().addTo(map);
  coordLayer = L.layerGroup().addTo(map);

  map.on('click', clearRouteAnchors);

  // Long tap / right-click → coordinate popup
  map.on('contextmenu', e => {
    L.DomEvent.preventDefault(e.originalEvent);
    const { lat, lng } = e.latlng;
    const sk = wgs84ToSkCoord(lat, lng);
    L.popup({ maxWidth: 260 })
      .setLatLng(e.latlng)
      .setContent(`
        <div style="font-size:12px;line-height:1.8">
          <b>좌표 정보</b><br>
          <b>WGS84</b><br>
          위도: ${lat.toFixed(6)}<br>
          경도: ${lng.toFixed(6)}<br>
          <b>SK</b><br>
          X: ${sk[0]}<br>
          Y: ${sk[1]}
        </div>`)
      .openOn(map);
  });

  return map;
}

export function getLayerGroup(name) { return layers[name] || null; }

export function setMapCenter(lat, lon, zoom = 15) {
  if (map) map.setView([lat, lon], zoom);
}

// ---- Coordinate marker --------------------------------------------------- //

/**
 * Add a coordinate search result marker to the map.
 * Initialises the map first if it hasn't been loaded yet.
 */
export function addCoordMarker(lat, lon, popupHtml) {
  if (!map) initMap('map', [lat, lon]);
  const icon = divIcon(coordIconHtml, [28, 28], [14, 14], [0, -16]);
  L.marker([lat, lon], { icon })
    .bindPopup(popupHtml, { maxWidth: 300 })
    .addTo(coordLayer)
    .openPopup();
  map.setView([lat, lon], Math.max(map.getZoom(), 15));
}

export function clearCoordMarkers() {
  if (coordLayer) coordLayer.clearLayers();
}

// ---- Route anchor helpers ------------------------------------------------ //

function clearRouteAnchors() {
  if (routeAnchorLayer) routeAnchorLayer.clearLayers();
}

function addAnchor(lat, lon, iconHtml, iconSize, popupLabel) {
  if (lat == null || lon == null) return null;
  const icon = divIcon(iconHtml, iconSize, [iconSize[0] * 0.3, iconSize[1] * 0.85], [0, -iconSize[1] * 0.7]);
  const marker = L.marker([lat, lon], { icon });
  marker.bindPopup(popupLabel);
  marker.addTo(routeAnchorLayer);
  return [lat, lon];
}

function showRouteAnchors(rr) {
  clearRouteAnchors();
  const polyPoints = [];

  const dp = addAnchor(rr.departLat, rr.departLon, departIconHtml, [28, 28],
    `<b>Departure</b><br>${esc(rr.departName || 'Departure')}`);
  if (dp) polyPoints.push(dp);

  for (let i = 0; i < (rr.waypoints || []).length; i++) {
    const wp = rr.waypoints[i];
    const p = addAnchor(wp.lat, wp.lon, waypointIconHtml, [22, 22],
      `<b>Waypoint ${i + 1}</b><br>${esc(wp.name || 'Waypoint')}`);
    if (p) polyPoints.push(p);
  }

  const dp2 = addAnchor(rr.destLat, rr.destLon, destIconHtml, [28, 28],
    `<b>Destination</b><br>${esc(rr.destName || 'Destination')}`);
  if (dp2) polyPoints.push(dp2);

  if (polyPoints.length >= 2) {
    L.polyline(polyPoints, { color: '#14b8a6', weight: 3, opacity: 0.9, dashArray: '6 6' })
      .addTo(routeAnchorLayer);
  }
}

// ---- Render all logs ----------------------------------------------------- //

/**
 * Render extracted logs on the map.
 * Clears previous layers first.
 */
export function renderLogs(locationLogs, mmLogs, routeRequests, ttsLogs) {
  if (!map) return;

  // Clear existing layers
  for (const lg of Object.values(layers)) lg.clearLayers();
  clearRouteAnchors();

  // Sort by timestamp
  const sortByTime = (arr, tsKey = 'timestamp', seqKey = 'sequence') =>
    [...arr].sort((a, b) => {
      const ta = a[tsKey] ? a[tsKey].getTime() : Infinity;
      const tb = b[tsKey] ? b[tsKey].getTime() : Infinity;
      return ta !== tb ? ta - tb : (a[seqKey] || 0) - (b[seqKey] || 0);
    });

  const sortedLoc = sortByTime(locationLogs);
  const sortedMm = sortByTime(mmLogs);
  const sortedRoute = sortByTime(routeRequests);
  const sortedTts = sortByTime(ttsLogs);

  // GPS track polyline
  const trackPoints = sortedLoc.map(p => [p.lat, p.lon]);
  if (trackPoints.length > 1) {
    L.polyline(trackPoints, { color: '#f97316', weight: 4, opacity: 0.9 }).addTo(map);
  }

  // Location markers
  sortedLoc.forEach((p, idx) => {
    const color = p.sourceType === 'gps' ? '#2563eb' : '#64748b';
    const layer = p.sourceType === 'gps' ? layers.gps : layers.drGps;
    const popup = `<b>#${idx + 1}</b><br>
      <b>Source:</b> ${esc(p.sourceType?.toUpperCase())}<br>
      <b>Bearing:</b> ${p.bearing?.toFixed(2)}°<br>
      <b>Log Time:</b> ${esc(formatTimestamp(p.timestamp))}<br>
      <b>ET:</b> ${esc(p.et || 'N/A')}<br>
      <b>Lat/Lon:</b> ${p.lat?.toFixed(6)}, ${p.lon?.toFixed(6)}`;
    L.circleMarker([p.lat, p.lon], {
      radius: 5, color, weight: 2, fillColor: color, fillOpacity: 0.75
    }).bindPopup(popup).addTo(layer);
  });

  // Map-matching markers
  sortedMm.forEach((p, idx) => {
    const isGps = p.sourceType === 'mm_gps';
    const color = isGps ? '#06b6d4' : '#22c55e';
    const layer = isGps ? layers.mmGps : layers.mmMatch;
    const d = p.details || {};
    const popup = `<b>MM #${idx + 1}</b><br>
      <b>Source:</b> ${esc(p.sourceType?.toUpperCase())}<br>
      <b>Log Time:</b> ${esc(formatTimestamp(p.timestamp))}<br>
      <b>GPS Source:</b> ${esc(d.gpsSource)}<br>
      <b>State:</b> ${esc(d.state)}<br>
      <b>SupportDR:</b> ${esc(d.supportDr)}<br>
      <b>HDOP:</b> ${esc(d.hdop)}<br>
      <b>Speed:</b> ${esc(d.speed)}<br>
      <b>Score:</b> ${esc(d.score)}<br>
      <b>NumOfMatchesInDR:</b> ${esc(d.numMatchesInDr)}<br>
      <b>isOpenSkyDRMode:</b> ${esc(d.openSkyDrMode)}<br>
      <b>Dist:</b> ${esc(d.distance)}<br>
      <b>vIndex:</b> ${esc(d.vIndex)}<br>
      <b>fB:</b> ${esc(d.fB)}<br>
      <b>Lat/Lon:</b> ${p.lat?.toFixed(6)}, ${p.lon?.toFixed(6)}`;
    L.circleMarker([p.lat, p.lon], {
      radius: 4, color, weight: 2, fillColor: color, fillOpacity: 0.9
    }).bindPopup(popup).addTo(layer);
  });

  // MM GPS Pos → Match Pos 편차 연결선
  const mmPairMap = new Map();
  sortedMm.forEach(p => {
    if (!mmPairMap.has(p.details)) mmPairMap.set(p.details, {});
    const pair = mmPairMap.get(p.details);
    if (p.sourceType === 'mm_gps')        pair.gps   = p;
    else if (p.sourceType === 'mm_match') pair.match = p;
  });
  for (const { gps, match } of mmPairMap.values()) {
    if (gps && match) {
      L.polyline([[gps.lat, gps.lon], [match.lat, match.lon]], {
        color: '#a855f7',
        weight: 1.5,
        opacity: 0.7,
        dashArray: '3 4',
      }).addTo(layers.mmMatch);
    }
  }

  // Route request markers
  const routeIcon = divIcon(routeIconHtml, [30, 36], [15, 34], [0, -30]);
  sortedRoute.forEach((rr, idx) => {
    const lat = rr.requestLat, lon = rr.requestLon;
    if (lat == null || lon == null) return;
    const marker = L.marker([lat, lon], { icon: routeIcon });
    marker.bindPopup(`<b>Route #${idx + 1}</b>${routePopupHtml(rr)}`, { maxWidth: 540 });
    marker.on('click', () => showRouteAnchors(rr));
    marker.addTo(layers.routeRequest);
  });

  // TTS markers
  const ttsIcon = divIcon(ttsIconHtml, [26, 26], [13, 13], [0, -12]);
  sortedTts.forEach((entry, idx) => {
    const lat = entry.requestLat, lon = entry.requestLon;
    if (lat == null || lon == null) return;
    L.marker([lat, lon], { icon: ttsIcon })
      .bindPopup(`<b>TTS #${idx + 1}</b>${ttsPopupHtml(entry)}`, { maxWidth: 400 })
      .addTo(layers.tts);
  });

  // Fit bounds
  if (trackPoints.length > 1) {
    map.fitBounds(L.latLngBounds(trackPoints), { padding: [24, 24] });
  } else {
    const all = [
      ...sortedLoc.map(p => [p.lat, p.lon]),
      ...sortedMm.map(p => [p.lat, p.lon]),
      ...sortedRoute.filter(r => r.requestLat != null).map(r => [r.requestLat, r.requestLon]),
      ...sortedTts.filter(t => t.requestLat != null).map(t => [t.requestLat, t.requestLon]),
    ];
    if (all.length > 0) map.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
  }
}

export function toggleLayer(name, visible) {
  const lg = layers[name];
  if (!lg) return;
  if (visible) lg.addTo(map);
  else map.removeLayer(lg);
}
