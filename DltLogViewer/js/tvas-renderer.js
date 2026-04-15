/**
 * TVAS route renderer — visualizes parsed TVAS data on a Leaflet map.
 * Creates SEPARATE layer groups per section for individual on/off control.
 */

'use strict';

import {
  ROAD_TYPE_NAMES,
  GUIDANCE_CODE_NAMES, DANGER_TYPE_NAMES, ROUTE_OPTION_NAMES,
  LANE_ANGLE_NAMES, LANE_ANGLE_ARROWS,
} from './tvas-parser.js';
import { besselToWgs84 } from './coordinate.js';

// ---- Layer state ---------------------------------------------------------- //

let tvasLayers = {
  route: null,         // 경로 폴리라인
  guidance: null,      // 안내점
  danger: null,        // 위험지역
  tollgate: null,      // 톨게이트
  restArea: null,      // 휴게소
  lane: null,          // 차로안내
  evCharger: null,     // 전기차 충전소
  direction: null,     // 방면 명칭 라벨
  roadName: null,      // 도로 명칭 라벨
  waypoint: null,      // 경유지
  incident: null,      // 돌발정보
  congestion: null,    // 정체구간
  intersection: null,  // 교차로명칭
  reroute: null,       // 강제재탐색
  trafficInfo: null,   // 교통정보 구간 (LT2)
  cityBoundary: null,  // 시도경계
  highwayMode: null,   // 고속모드
  rpLink: null,        // RP 링크 (RD5)
  truck: null,         // 화물차 제한구간
};

// ---- Color schemes -------------------------------------------------------- //

// 경로요약 items의 혼잡도 Char 코드별 색상 (parseRouteSummary → items[i].congestion)
//   '4' 정체 → 빨강, '2' 서행 → 주황, '1' 원활 → 녹색, '0' 정보없음 → 하늘색
// 알 수 없는 코드는 하늘색(fallback)로 취급해 "정보없음"과 동일하게 보이게 함.
const CONGESTION_COLORS = {
  '4': '#ef4444',
  '2': '#f97316',
  '1': '#22c55e',
  '0': '#38bdf8',
};
const CONGESTION_FALLBACK_COLOR = '#38bdf8';
const CONGESTION_NAMES = { '1': '원활', '2': '서행', '4': '정체', '0': '정보없음' };

const DANGER_TYPE_ICONS = {
  camera: '📷', section: '📐', schoolZone: '🏫',
  accident: '⚠', curve: '↩', fog: '🌫',
  train: '🚂', default: '⚠',
};

function getDangerIcon(type) {
  if ([1,2,6,14,21,37,38].includes(type)) return DANGER_TYPE_ICONS.camera;
  if ([11,12,13,26,27].includes(type)) return DANGER_TYPE_ICONS.section;
  if ([16,17,29,30,31,32,33,34,35,36].includes(type)) return DANGER_TYPE_ICONS.schoolZone;
  if ([3,22].includes(type)) return DANGER_TYPE_ICONS.accident;
  if (type === 4) return DANGER_TYPE_ICONS.curve;
  if ([5,23,28].includes(type)) return DANGER_TYPE_ICONS.fog;
  if (type === 15) return DANGER_TYPE_ICONS.train;
  return DANGER_TYPE_ICONS.default;
}

// ---- HTML helpers --------------------------------------------------------- //

function esc(s) {
  return String(s ?? 'N/A').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDistance(meters) {
  return meters >= 1000 ? (meters / 1000).toFixed(1) + ' km' : meters + ' m';
}

function formatTime(seconds) {
  if (seconds >= 3600) {
    return Math.floor(seconds / 3600) + '시간 ' + Math.floor((seconds % 3600) / 60) + '분';
  }
  return Math.floor(seconds / 60) + '분';
}

function guidanceName(code) { return GUIDANCE_CODE_NAMES[code] || `안내코드 ${code}`; }
function dangerName(type) { return DANGER_TYPE_NAMES[type] || `위험지역 ${type}`; }

// ---- Icons ---------------------------------------------------------------- //

function guidanceIconHtml(code) {
  const arrows = {
    11:'↑',12:'←',13:'→',14:'↩',15:'↰',16:'↰',17:'↰',18:'↱',19:'↱',
    43:'→',44:'←',51:'↑',77:'⤺',78:'⤻',
    101:'⤻',102:'⤺',103:'↑',104:'⤻',105:'⤺',106:'↑',
    111:'⤻',112:'⤺',113:'↑',114:'⤻',115:'⤺',116:'↑',
    150:'🅿',151:'🅿',152:'🅿',160:'⚡',170:'⛴',171:'⛴',
    200:'🚩',201:'🏁',203:'🏁',204:'🚧',211:'🚶',218:'🛗',
  };
  return `<div style="width:22px;height:22px;line-height:22px;text-align:center;background:rgba(15,23,42,0.85);color:#e2e8f0;border:2px solid #a855f7;border-radius:50%;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.4)">${arrows[code] || '●'}</div>`;
}

function departIconHtml() {
  return `<div style="width:28px;height:28px;line-height:28px;text-align:center;background:#22c55e;color:#fff;border-radius:50%;font-size:14px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4);border:2px solid #fff">S</div>`;
}

function destIconHtml() {
  return `<div style="width:28px;height:28px;line-height:28px;text-align:center;background:#ef4444;color:#fff;border-radius:50%;font-size:14px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4);border:2px solid #fff">E</div>`;
}

// ---- Lane icon for map ---------------------------------------------------- //

function angleToArrow(angle) { return LANE_ANGLE_ARROWS[angle] || '?'; }
function angleName(angle) { return LANE_ANGLE_NAMES[angle] || angle + '\u00b0'; }

// Decode per-lane angles from a 2-byte combined angle value
// Each lane gets a direction based on its bit position in the angle field
function decodeLaneAngles(angleVal, laneVal, totalLanes) {
  // The angle value encodes directions for active lanes
  // For simplicity, distribute the angle to all active bits
  const angles = [];
  for (let b = 0; b < totalLanes; b++) {
    if ((laneVal >> b) & 1) {
      angles[b] = angleVal; // All active lanes share the angle
    }
  }
  return angles;
}

export function laneIconHtml(tl) {
  const n = tl.totalLanes;
  if (n === 0) return '';
  const recArrow = angleToArrow(tl.recommendAngle);
  const valArrow = angleToArrow(tl.validAngle);

  // Build per-lane invalid arrows (multiple directions can be invalid per lane)
  const invalidArrowsByLane = [];
  if (tl.invalidLanes && tl.invalidLanes.length > 0) {
    for (const iv of tl.invalidLanes) {
      const a = angleToArrow(iv.angle);
      if (!a || a === '?') continue;
      for (let b = 0; b < n; b++) {
        if ((iv.lane >> b) & 1) {
          if (!invalidArrowsByLane[b]) invalidArrowsByLane[b] = '';
          invalidArrowsByLane[b] += a;
        }
      }
    }
  }

  let html = '<div style="display:flex;gap:1px;background:rgba(15,23,42,0.92);padding:3px 4px;border-radius:5px;border:1px solid #475569;box-shadow:0 2px 6px rgba(0,0,0,.6)">';
  for (let b = 0; b < n; b++) {
    const isRec = (tl.recommendLane >> b) & 1;
    const isVal = (tl.validLane >> b) & 1;
    const isLP = b < tl.leftPocket;
    const isRP = b >= (n - tl.rightPocket);
    const isOverpass = (tl.overpassLane >> b) & 1;
    const isUnderpass = (tl.underpassLane >> b) & 1;
    const isBus = (tl.busLaneCode === 1 || tl.busLaneCode === 2) ? (b === n - 1) :
                  (tl.busLaneCode === 3 || tl.busLaneCode === 4) ? (b === 0) : false;
    let bg, border;
    if (isRec) { bg = '#166534'; border = '#22c55e'; }
    else if (isVal) { bg = '#1e3a5f'; border = '#3b82f6'; }
    else { bg = '#374151'; border = '#6b7280'; }
    const arrow = isRec ? recArrow : isVal ? valArrow : '';
    let extra = '';
    if (isLP || isRP) extra = '<div style="font-size:6px;color:#fbbf24">P</div>';
    if (isOverpass) extra = '<div style="font-size:6px;color:#f97316">고</div>';
    if (isUnderpass) extra = '<div style="font-size:6px;color:#06b6d4">지</div>';
    if (isBus) extra = '<div style="font-size:6px;color:#a78bfa">B</div>';
    // 비유효 방향 화살표 (빨간색, 작은 글씨로 본 화살표 아래)
    const invHtml = invalidArrowsByLane[b]
      ? `<div style="font-size:9px;color:#ef4444;line-height:1">${invalidArrowsByLane[b]}</div>`
      : '';
    html += `<div style="width:16px;text-align:center;border-radius:2px;background:${bg};border:1px solid ${border};padding:1px 0;line-height:1.1">
      <div style="font-size:10px;color:#fff">${arrow}</div>${invHtml}${extra}</div>`;
  }
  html += '</div>';
  return html;
}

// ---- Main render function ------------------------------------------------- //

export function renderTvasRoute(map, tvasResult, resolvedCoords, routeIndex = 0) {
  clearTvasRoute(map);

  const { header, guidancePoints, dangerAreas, tollGates, restAreas,
          directionNames, intersectionNames, laneGuidance, evChargers, routeSummary,
          waypoints, incidents, congestion, forcedReroute,
          trafficInfo, cityBoundary, highwayMode, rpLinks,
          truckWidth, truckHeight, truckWeight } = tvasResult;
  const routeItems = (routeSummary && routeSummary.items) ? routeSummary.items : [];
  const summaryRoadNames = (routeSummary && routeSummary.roadNames) ? routeSummary.roadNames : [];
  const rpLinkItems = (rpLinks && rpLinks.items) ? rpLinks.items : [];

  // Create separate layer groups
  Object.keys(tvasLayers).forEach(k => { tvasLayers[k] = L.layerGroup(); });

  if (resolvedCoords.length > 0) {
    renderRoutePolylines(tvasLayers.route, resolvedCoords, routeItems);
    renderEndpoints(tvasLayers.route, resolvedCoords, header);
    renderGuidancePoints(tvasLayers.guidance, resolvedCoords, guidancePoints, directionNames, intersectionNames);
    renderDangerAreas(tvasLayers.danger, resolvedCoords, dangerAreas);
    if (tollGates && tollGates.length > 0) renderTollGates(tvasLayers.tollgate, resolvedCoords, tollGates);
    if (restAreas && restAreas.length > 0) renderRestAreas(tvasLayers.restArea, resolvedCoords, restAreas);
    if (laneGuidance && laneGuidance.length > 0) renderLaneGuidance(tvasLayers.lane, resolvedCoords, laneGuidance);
    if (evChargers && evChargers.length > 0) renderEvChargers(tvasLayers.evCharger, resolvedCoords, evChargers);
    renderDirectionNames(tvasLayers.direction, resolvedCoords, directionNames);
    renderRoadNames(tvasLayers.roadName, resolvedCoords, summaryRoadNames);
    renderWaypoints(tvasLayers.waypoint, resolvedCoords, waypoints);
    renderIncidents(tvasLayers.incident, resolvedCoords, incidents);
    renderCongestion(tvasLayers.congestion, resolvedCoords, congestion);
    renderIntersectionNames(tvasLayers.intersection, resolvedCoords, intersectionNames);
    renderForcedReroute(tvasLayers.reroute, resolvedCoords, forcedReroute);
    renderTrafficInfo(tvasLayers.trafficInfo, resolvedCoords, trafficInfo);
    renderCityBoundary(tvasLayers.cityBoundary, resolvedCoords, cityBoundary);
    renderHighwayMode(tvasLayers.highwayMode, resolvedCoords, highwayMode);
    renderRpLinks(tvasLayers.rpLink, resolvedCoords, rpLinkItems);
    renderTruckRestrictions(tvasLayers.truck, resolvedCoords, { truckWidth, truckHeight, truckWeight });
  }

  // Add all layers to map
  Object.values(tvasLayers).forEach(lg => { if (lg) lg.addTo(map); });

  return { layers: tvasLayers, summary: buildSummary(header, resolvedCoords, tvasResult) };
}

export function clearTvasRoute(map) {
  Object.keys(tvasLayers).forEach(key => {
    const lg = tvasLayers[key];
    if (lg) {
      lg.clearLayers();
      if (map && map.hasLayer(lg)) map.removeLayer(lg);
    }
    tvasLayers[key] = null;
  });
}

export function getTvasLayers() { return tvasLayers; }

export function toggleTvasLayer(map, key, visible) {
  const lg = tvasLayers[key];
  if (!lg || !map) return;
  if (visible) { if (!map.hasLayer(lg)) map.addLayer(lg); }
  else { if (map.hasLayer(lg)) map.removeLayer(lg); }
}

// ---- Sub-renderers -------------------------------------------------------- //

/**
 * Build per-segment arrow specs for direction overlays on the route polyline.
 * Side-effect-free — returns an array of `{ latlngs, color }` suitable for
 * feeding into L.polylineDecorator (one decorator per spec).
 *
 * `items` is routeSummary.items (경로요약 DATA, 32B per entry). The color of
 * each segment is derived from that item's 혼잡도(congestion) char code.
 * When items is empty, a single sky-blue fallback segment covering all coords
 * is returned. Segments shorter than 2 points are skipped.
 */
export function buildRouteArrowSpecs(coords, items) {
  if (!coords || coords.length < 2) return [];

  if (!items || items.length === 0) {
    return [{
      latlngs: coords.map(c => [c.lat, c.lon]),
      color: CONGESTION_FALLBACK_COLOR,
    }];
  }

  const specs = [];
  for (const item of items) {
    const start = item.startVxIdx;
    const end   = Math.min(item.endVxIdx, coords.length - 1);
    if (!(start >= 0) || start >= end || start >= coords.length) continue;
    const segment = [];
    for (let i = start; i <= end && i < coords.length; i++) {
      segment.push([coords[i].lat, coords[i].lon]);
    }
    if (segment.length >= 2) {
      specs.push({
        latlngs: segment,
        color: CONGESTION_COLORS[item.congestion] || CONGESTION_FALLBACK_COLOR,
      });
    }
  }
  return specs;
}

/**
 * Build label specs for 방면 명칭 (DN5 directionNames).
 * Each entry is `{lastVxIdx, typeCode, name}`. Places the label at
 * coords[lastVxIdx]. Skips entries with empty/whitespace names or
 * out-of-range indices.
 */
export function buildDirectionNameLabels(coords, directionNames) {
  if (!coords || coords.length === 0) return [];
  if (!directionNames || directionNames.length === 0) return [];
  const labels = [];
  for (const dn of directionNames) {
    if (!dn || !dn.name || !dn.name.trim()) continue;
    const idx = dn.lastVxIdx;
    if (typeof idx !== 'number' || idx < 0 || idx >= coords.length) continue;
    const c = coords[idx];
    labels.push({ lat: c.lat, lon: c.lon, name: dn.name.trim(), typeCode: dn.typeCode });
  }
  return labels;
}

/**
 * Build label specs for 교차로 명칭 (CN intersectionNames).
 * Entries are `{lastVxIdx, name}`. Places the label at coords[lastVxIdx].
 * Skips empty names and out-of-range indices.
 */
export function buildIntersectionNameLabels(coords, names) {
  if (!coords || coords.length === 0) return [];
  if (!names || names.length === 0) return [];
  const labels = [];
  for (const cn of names) {
    if (!cn || !cn.name || !cn.name.trim()) continue;
    const idx = cn.lastVxIdx;
    if (typeof idx !== 'number' || idx < 0 || idx >= coords.length) continue;
    const c = coords[idx];
    labels.push({ lat: c.lat, lon: c.lon, name: cn.name.trim() });
  }
  return labels;
}

/**
 * Build latlng polyline segments from `{startVxIdx, endVxIdx, ...}` items.
 * Used by TC/LT2/HW/RD5/WHR/HTR/WTR — any section that defines a VX range.
 * Returns `[{latlngs, item}]`; skips invalid/reversed/single-point ranges.
 * endVxIdx is clamped to coords.length-1.
 */
export function buildRangeSegments(coords, items) {
  if (!coords || coords.length === 0) return [];
  if (!items || items.length === 0) return [];
  const out = [];
  for (const item of items) {
    const start = item.startVxIdx;
    const endRaw = item.endVxIdx;
    if (typeof start !== 'number' || start < 0 || start >= coords.length) continue;
    if (typeof endRaw !== 'number' || endRaw <= start) continue;
    const end = Math.min(endRaw, coords.length - 1);
    if (end <= start) continue;
    const latlngs = [];
    for (let i = start; i <= end; i++) latlngs.push([coords[i].lat, coords[i].lon]);
    out.push({ latlngs, item });
  }
  return out;
}

/**
 * Build label specs for TC 정체구간. Each item is
 * `{startVxIdx, endVxIdx, distance, time}`. Returns
 * `[{lat, lon, distance, time}]` placed at the midpoint vertex.
 * Invalid ranges are skipped; endVxIdx is clamped to coords range.
 */
export function buildCongestionLabels(coords, items) {
  if (!coords || coords.length === 0) return [];
  if (!items || items.length === 0) return [];
  const labels = [];
  for (const item of items) {
    const start = item.startVxIdx;
    const endRaw = item.endVxIdx;
    if (typeof start !== 'number' || start < 0 || start >= coords.length) continue;
    if (typeof endRaw !== 'number' || endRaw <= start) continue;
    const end = Math.min(endRaw, coords.length - 1);
    if (end <= start) continue;
    const mid = Math.floor((start + end) / 2);
    const c = coords[mid];
    labels.push({ lat: c.lat, lon: c.lon, distance: item.distance, time: item.time });
  }
  return labels;
}

/**
 * Build label specs for 도로 명칭 (routeSummary.roadNames).
 * Each entry is `{startVxIdx, endVxIdx, name}`. Places the label at the
 * midpoint vertex of the range. Skips empty names and invalid ranges.
 */
export function buildRoadNameLabels(coords, roadNames) {
  if (!coords || coords.length === 0) return [];
  if (!roadNames || roadNames.length === 0) return [];
  const labels = [];
  for (const rn of roadNames) {
    if (!rn || !rn.name || !rn.name.trim()) continue;
    const start = rn.startVxIdx;
    const endRaw = rn.endVxIdx;
    if (typeof start !== 'number' || start < 0 || start >= coords.length) continue;
    if (typeof endRaw !== 'number' || endRaw < start) continue;
    const end = Math.min(endRaw, coords.length - 1);
    if (end < start) continue;
    const mid = Math.floor((start + end) / 2);
    const c = coords[mid];
    labels.push({ lat: c.lat, lon: c.lon, name: rn.name.trim() });
  }
  return labels;
}

function renderRoutePolylines(lg, coords, items) {
  // Base polyline connecting ALL VX points (ensures no gaps between items)
  const allLatLngs = coords.map(c => [c.lat, c.lon]);
  L.polyline(allLatLngs, { color: '#a855f7', weight: 3, opacity: 0.35 }).addTo(lg);

  // Per-item colored segments by 혼잡도 with informational popup
  for (const item of items) {
    const start = item.startVxIdx;
    const end   = Math.min(item.endVxIdx, coords.length - 1);
    if (!(start >= 0) || start >= end || start >= coords.length) continue;
    const segment = [];
    for (let i = start; i <= end && i < coords.length; i++) {
      segment.push([coords[i].lat, coords[i].lon]);
    }
    if (segment.length < 2) continue;
    const color = CONGESTION_COLORS[item.congestion] || CONGESTION_FALLBACK_COLOR;
    const congName = CONGESTION_NAMES[item.congestion] || '알수없음';
    const nameHtml = item.name ? `<b>${esc(item.name)}</b><br>` : '';
    L.polyline(segment, { color, weight: 5, opacity: 0.85 })
      .bindPopup(
        `${nameHtml}혼잡도: ${congName}<br>속도: ${item.speed}km/h<br>거리: ${formatDistance(item.distance)}<br>시간: ${item.time}초<br>VX: ${start}~${end}`,
        { maxWidth: 300 }
      )
      .addTo(lg);
  }

  // Direction arrows overlaid, colored to match each 혼잡도 segment
  addDirectionArrows(lg, buildRouteArrowSpecs(coords, items));
}

function addDirectionArrows(lg, specs) {
  // PolylineDecorator plugin is loaded via CDN in index.html.
  // Guard against its absence so unit tests / non-browser contexts don't crash.
  if (typeof L === 'undefined' || typeof L.polylineDecorator !== 'function') return;
  for (const spec of specs) {
    L.polylineDecorator(spec.latlngs, {
      patterns: [{
        offset: '5%',
        repeat: '80px',
        symbol: L.Symbol.arrowHead({
          pixelSize: 10,
          polygon: false,
          pathOptions: { stroke: true, color: spec.color, weight: 2, opacity: 0.95 },
        }),
      }],
    }).addTo(lg);
  }
}

function renderEndpoints(lg, coords, header) {
  const first = coords[0], last = coords[coords.length - 1];
  const depName = header.mapInfo.departureName || '출발지';
  const dstName = header.mapInfo.destinationName || '목적지';
  L.marker([first.lat, first.lon], {
    icon: L.divIcon({ className: '', html: departIconHtml(), iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: 1000,
  }).bindPopup(`<b>${esc(depName)}</b><br>SK: (${first.skX}, ${first.skY})<br>WGS84: ${first.lat.toFixed(6)}, ${first.lon.toFixed(6)}`).addTo(lg);
  L.marker([last.lat, last.lon], {
    icon: L.divIcon({ className: '', html: destIconHtml(), iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: 1000,
  }).bindPopup(`<b>${esc(dstName)}</b><br>SK: (${last.skX}, ${last.skY})<br>WGS84: ${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}`).addTo(lg);
}

function renderGuidancePoints(lg, coords, guidancePoints, directionNames, intersectionNames) {
  for (const gp of guidancePoints) {
    if (gp.vxIndex >= coords.length) continue;
    const c = coords[gp.vxIndex];
    let dirName = '', intName = '';
    if (directionNames) { const dn = directionNames.find(d => d.lastVxIdx >= gp.vxIndex); if (dn) dirName = dn.name; }
    if (intersectionNames) { const cn = intersectionNames.find(d => d.lastVxIdx >= gp.vxIndex); if (cn) intName = cn.name; }
    let popup = `<b>${esc(guidanceName(gp.guidanceCode))}</b> (코드: ${gp.guidanceCode})`;
    if (gp.continuousTurnCode > 0) popup += `<br>연속회전: ${gp.continuousTurnCode === 1 ? '고속' : '일반'}`;
    if (dirName) popup += `<br>방면: ${esc(dirName)}`;
    if (intName) popup += `<br>교차로: ${esc(intName)}`;
    popup += `<br>VX: ${gp.vxIndex}<br>WGS84: ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: guidanceIconHtml(gp.guidanceCode), iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

function renderDangerAreas(lg, coords, dangerAreas) {
  for (const da of dangerAreas) {
    if (da.startVxIdx >= coords.length) continue;
    const startC = coords[da.startVxIdx];
    const icon = getDangerIcon(da.type);
    if (da.startVxIdx !== da.endVxIdx) {
      const segment = [];
      for (let i = da.startVxIdx; i <= Math.min(da.endVxIdx, coords.length - 1); i++) segment.push([coords[i].lat, coords[i].lon]);
      if (segment.length >= 2) L.polyline(segment, { color: '#ef4444', weight: 8, opacity: 0.5, dashArray: '8,6' }).addTo(lg);
    }
    let popup = `<b>${icon} ${esc(dangerName(da.type))}</b>`;
    if (da.speedLimit > 0) popup += `<br>제한속도: ${da.speedLimit}km/h`;
    if (da.sectionLength > 0) popup += `<br>구간길이: ${formatDistance(da.sectionLength)}`;
    if (da.sectionSpeed > 0) popup += `<br>구간단속속도: ${da.sectionSpeed}km/h`;
    if (da.variableSpeed) popup += `<br>가변속도`;
    if (da.schoolZoneCamera) popup += `<br>어린이보호구역 단속카메라`;
    popup += `<br>VX: ${da.startVxIdx}~${da.endVxIdx}`;
    L.marker([startC.lat, startC.lon], {
      icon: L.divIcon({ className: '', html: `<div style="width:24px;height:24px;line-height:24px;text-align:center;background:rgba(239,68,68,0.9);border-radius:6px;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid #fff">${icon}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

function renderTollGates(lg, coords, tollGates) {
  for (const tg of tollGates) {
    if (tg.vxIdx >= coords.length) continue;
    const c = coords[tg.vxIdx];
    const typeNames = { 1:'개방형',2:'폐쇄형',3:'IC',4:'JC',5:'진출IC',6:'휴게소' };
    const congNames = { '1':'원활','2':'서행','4':'정체','0':'정보없음' };
    let popup = `<b>[TG] ${esc(tg.name || '톨게이트')}</b><br>유형: ${typeNames[tg.guideType] || tg.guideType}`;
    if (tg.fare > 0) popup += `<br>요금: ${tg.fare.toLocaleString()}원`;
    if (tg.hipassOnly) popup += `<br>하이패스 전용`;
    popup += `<br>혼잡도: ${congNames[tg.congestion] || tg.congestion}<br>VX: ${tg.vxIdx}`;
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: `<div style="width:26px;height:24px;line-height:24px;text-align:center;background:rgba(251,191,36,0.95);border-radius:6px;font-size:11px;font-weight:800;letter-spacing:-0.5px;color:#1e293b;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid #fff">TG</div>`, iconSize: [26, 24], iconAnchor: [13, 12] }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

function renderRestAreas(lg, coords, restAreas) {
  for (const ra of restAreas) {
    if (ra.entryVxIdx >= coords.length) continue;
    const c = coords[ra.entryVxIdx];
    let popup = `<b>🍴 ${esc(ra.name || '휴게소')}</b><br>VX: ${ra.entryVxIdx}~${ra.exitVxIdx}`;
    if (ra.poiId) popup += `<br>POI: ${ra.poiId}`;
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: `<div style="width:24px;height:24px;line-height:24px;text-align:center;background:rgba(34,197,94,0.9);border-radius:6px;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid #fff">🍴</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

// Store individual charger markers for show/hide from list
let evChargerMarkers = [];

function buildEvPopup(ev, lat, lon) {
  const isMust = ev.mustCharge === 1;
  const speedName = {0:'정보없음',1:'완속',2:'급속',3:'초급속'}[ev.chargeSpeed] || '';
  let sockets = [];
  if (ev.dcCha) sockets.push('DC차데모');
  if (ev.ac3) sockets.push('AC3상');
  if (ev.dcCombo) sockets.push('DC콤보');
  if (ev.slow) sockets.push('완속');
  if (ev.tesla) sockets.push('테슬라');

  let popup = `<div style="font-size:12px;line-height:1.6;max-width:320px">`;
  popup += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">`;
  popup += `<span style="font-size:20px">⚡</span>`;
  popup += `<b style="font-size:15px">${esc(ev.name || '충전소')}</b>`;
  if (isMust) popup += ` <span style="color:#fff;background:#f04452;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">필수충전</span>`;
  popup += `</div>`;
  popup += `<table style="width:100%;font-size:11px;line-height:1.5;border-collapse:collapse">`;
  popup += `<tr><td style="color:#8b95a1;padding:2px 0;width:70px">위치</td><td>${ev.onRoute === 0 ? '<b style="color:#3182f6">경로상</b>' : '경로주변'}</td></tr>`;
  popup += `<tr><td style="color:#8b95a1;padding:2px 0">소켓</td><td>${sockets.join(', ') || '-'}</td></tr>`;
  popup += `<tr><td style="color:#8b95a1;padding:2px 0">충전기</td><td><b>${ev.availChargers}</b>/${ev.totalChargers} (${speedName})</td></tr>`;
  if (ev.chargeTime) popup += `<tr><td style="color:#8b95a1;padding:2px 0">충전시간</td><td>${Math.floor(ev.chargeTime/60)}분 ${ev.chargeTime%60}초</td></tr>`;
  if (ev.chargePower) popup += `<tr><td style="color:#8b95a1;padding:2px 0">충전 파워</td><td>${ev.chargePower} kW</td></tr>`;
  if (ev.arrivalSoc) popup += `<tr><td style="color:#8b95a1;padding:2px 0">SoC</td><td>도착 ${ev.arrivalSoc}% → ${ev.expectedSoc}%</td></tr>`;
  popup += `<tr><td style="color:#8b95a1;padding:2px 0">POI</td><td>${ev.poiId}</td></tr>`;
  popup += `<tr><td style="color:#8b95a1;padding:2px 0">좌표</td><td>${lat.toFixed(6)}, ${lon.toFixed(6)}</td></tr>`;
  if (ev.manualStation) popup += `<tr><td style="color:#8b95a1">구분</td><td style="color:#fbbf24">수동충전소</td></tr>`;
  if (ev.isSelf) popup += `<tr><td style="color:#8b95a1">셀프</td><td>셀프 충전</td></tr>`;
  popup += `</table></div>`;
  return popup;
}

function resolveEvCoord(ev, coords) {
  let lat = null, lon = null;
  if (ev.locX && ev.locY && ev.locX > 100000 && ev.locY > 100000) {
    const bLon = ev.locX / 360000.0, bLat = ev.locY / 360000.0;
    if (bLon > 120 && bLon < 135 && bLat > 30 && bLat < 45) {
      [lat, lon] = besselToWgs84(bLon, bLat);
    }
  }
  if (lat == null && ev.vxIdx > 0 && ev.vxIdx < coords.length) {
    lat = coords[ev.vxIdx].lat; lon = coords[ev.vxIdx].lon;
  }
  return lat != null ? { lat, lon } : null;
}

function renderEvChargers(lg, coords, evChargers) {
  evChargerMarkers = [];
  for (let idx = 0; idx < evChargers.length; idx++) {
    const ev = evChargers[idx];
    const pos = resolveEvCoord(ev, coords);
    if (!pos) { evChargerMarkers.push(null); continue; }
    const { lat, lon } = pos;
    const isMust = ev.mustCharge === 1;

    // Must charge: 빨간 원 38px + 펄스, 일반: 초록 26px
    const size = isMust ? 38 : 26;
    const zOff = isMust ? 1500 : 400;
    let iconHtml;
    if (isMust) {
      iconHtml = `<div style="display:flex;flex-direction:column;align-items:center">
        <div style="position:relative;width:${size}px;height:${size}px">
          <div style="position:absolute;inset:0;background:rgba(240,68,82,0.25);border-radius:50%;animation:evPulse 1.5s ease-in-out infinite"></div>
          <div style="position:absolute;inset:4px;background:#f04452;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 3px 12px rgba(240,68,82,0.6);border:2px solid #fff;color:#fff;font-weight:700">⚡</div>
        </div>
        <div style="margin-top:2px;padding:1px 6px;background:rgba(240,68,82,0.9);color:#fff;font-size:8px;font-weight:700;border-radius:6px;white-space:nowrap">필수충전</div>
      </div>`;
    } else {
      iconHtml = `<div style="width:${size}px;height:${size}px;line-height:${size}px;text-align:center;background:rgba(49,130,246,0.85);border-radius:8px;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid #fff;color:#fff">⚡</div>`;
    }

    const popup = buildEvPopup(ev, lat, lon);
    const marker = L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: iconHtml, iconSize: [size, isMust ? size+16 : size], iconAnchor: [size/2, isMust ? (size+16)/2 : size/2] }),
      zIndexOffset: zOff,
    }).bindPopup(popup, { maxWidth: 320 });

    evChargerMarkers.push({ marker, lat, lon, isMust });

    // Only must-charge chargers are shown by default
    if (isMust) marker.addTo(lg);
  }
}

// Show a specific non-must charger on map (called from list click)
export function showEvChargerOnMap(map, idx) {
  if (!evChargerMarkers[idx]) return;
  const { marker, lat, lon, isMust } = evChargerMarkers[idx];
  if (!map.hasLayer(marker)) {
    const lg = tvasLayers.evCharger;
    if (lg) marker.addTo(lg);
  }
  map.setView([lat, lon], 17, { animate: true });
  marker.openPopup();
}

export function buildLanePopup(tl, c) {
  const n = tl.totalLanes;
  const busNames = {0:'없음',1:'우측차로(전일)',2:'우측차로(시간제)',3:'중앙차로(전일)',4:'중앙차로(시간제)'};
  const roadNames = ROAD_TYPE_NAMES;

  // 차로별 비유효 방향 목록 수집 (한 차로에 여러 방향이 invalid일 수 있음)
  const invalidPerLane = Array.from({ length: n }, () => []);
  if (tl.invalidLanes && tl.invalidLanes.length > 0) {
    for (const iv of tl.invalidLanes) {
      for (let b = 0; b < n; b++) {
        if ((iv.lane >> b) & 1) invalidPerLane[b].push(iv.angle);
      }
    }
  }

  // 각 차로의 셀 내용 / 하이라이트 배경 미리 계산
  const recCells = [], valCells = [], invCells = [], attrCells = [], laneBg = [];
  for (let b = 0; b < n; b++) {
    const isRec   = (tl.recommendLane >> b) & 1;
    const isVal   = (tl.validLane >> b) & 1;
    const isLP    = b < tl.leftPocket;
    const isRP    = b >= (n - tl.rightPocket);
    const isOver  = (tl.overpassLane >> b) & 1;
    const isUnder = (tl.underpassLane >> b) & 1;
    const isBus   = (tl.busLaneCode === 1 || tl.busLaneCode === 2) ? (b === n - 1) :
                    (tl.busLaneCode === 3 || tl.busLaneCode === 4) ? (b === 0) : false;

    recCells.push(isRec
      ? `<span style="color:#22c55e;font-weight:700">${angleToArrow(tl.recommendAngle)} ${angleName(tl.recommendAngle)}</span>`
      : '<span style="color:#6b7280">-</span>');
    valCells.push(isVal
      ? `<span style="color:#3b82f6">${angleToArrow(tl.validAngle)} ${angleName(tl.validAngle)}</span>`
      : '<span style="color:#6b7280">-</span>');

    const invAngles = invalidPerLane[b];
    invCells.push(invAngles.length > 0
      ? invAngles.map(a => `<span style="color:#ef4444">${angleToArrow(a)} ${angleName(a)}</span>`).join('<br>')
      : '<span style="color:#6b7280">-</span>');

    const attrs = [];
    if (isLP)    attrs.push('<span style="color:#fbbf24">좌포켓</span>');
    if (isRP)    attrs.push('<span style="color:#fbbf24">우포켓</span>');
    if (isOver)  attrs.push('<span style="color:#f97316">고가</span>');
    if (isUnder) attrs.push('<span style="color:#06b6d4">지하</span>');
    if (isBus)   attrs.push('<span style="color:#a78bfa">버스</span>');
    attrCells.push(attrs.join(' ') || '-');

    laneBg.push(isRec ? 'rgba(34,197,94,0.08)' : isVal ? 'rgba(59,130,246,0.06)' : '');
  }

  let html = `<div style="font-size:12px;line-height:1.6;max-width:360px">`;
  html += `<b>차로안내</b> (${n}차로)`;
  html += `<br>VX: ${tl.vxIdx} | WGS84: ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;
  if (tl.roadTypeCode !== undefined) html += `<br>도로종별: ${roadNames[tl.roadTypeCode] || tl.roadTypeCode}`;
  if (tl.busLaneCode > 0) html += `<br>버스전용차로: ${busNames[tl.busLaneCode] || tl.busLaneCode}`;

  // 전치 테이블: 가로축 = 차로(1..n), 세로축 = 권장/유효/비유효/속성
  const th = 'padding:3px 4px;border:1px solid #334155;text-align:center';
  const td = 'padding:3px 4px;border:1px solid #334155;vertical-align:top';
  const labelTh = `${th};background:rgba(148,163,184,0.1);font-weight:600`;

  html += `<table style="width:100%;margin:6px 0;border-collapse:collapse;font-size:11px">`;

  // Header row: 차로 | 1 | 2 | 3 ...
  html += `<tr style="background:rgba(148,163,184,0.1)"><th style="${th}">차로</th>`;
  for (let b = 0; b < n; b++) html += `<th style="${th}">${b + 1}</th>`;
  html += `</tr>`;

  const renderRow = (label, cells) => {
    let row = `<tr><th style="${labelTh}">${label}</th>`;
    for (let b = 0; b < n; b++) {
      const bg = laneBg[b] ? `;background:${laneBg[b]}` : '';
      row += `<td style="${td}${bg}">${cells[b]}</td>`;
    }
    return row + `</tr>`;
  };

  html += renderRow('권장', recCells);
  html += renderRow('유효', valCells);
  html += renderRow('비유효', invCells);
  html += renderRow('속성', attrCells);

  html += `</table>`;

  // Raw hex (디버그용)
  html += `<span style="color:#6b7280;font-size:10px">권장:0x${tl.recommendLane.toString(16).padStart(4,'0')} 유효:0x${tl.validLane.toString(16).padStart(4,'0')} 각도:${tl.recommendAngle}/${tl.validAngle}</span>`;
  html += `</div>`;
  return html;
}

function renderLaneGuidance(lg, coords, laneGuidance) {
  for (const tl of laneGuidance) {
    if (tl.vxIdx >= coords.length) continue;
    const c = coords[tl.vxIdx];
    const iconHtml = laneIconHtml(tl);
    if (!iconHtml) continue;
    const n = tl.totalLanes;
    const popup = buildLanePopup(tl, c);
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: iconHtml, iconSize: [n * 18 + 8, 30], iconAnchor: [(n * 18 + 8) / 2, 36] }),
      zIndexOffset: 500,
    }).bindPopup(popup, { maxWidth: 380 }).addTo(lg);
  }
}

// ---- 방면/도로 명칭 라벨 렌더러 -------------------------------------------- //

function directionLabelIconHtml(name, typeCode) {
  // 파란 테두리 칩 — 방면(안내 방향)
  const safe = esc(name);
  return `<div style="display:inline-block;background:rgba(15,23,42,0.9);color:#93c5fd;border:1px solid #3b82f6;border-radius:6px;padding:2px 6px;font-size:11px;font-weight:600;line-height:1.2;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.5)">▶ ${safe}</div>`;
}

function roadNameLabelIconHtml(name) {
  // 회색 테두리 칩 — 도로 명칭
  const safe = esc(name);
  return `<div style="display:inline-block;background:rgba(15,23,42,0.85);color:#e2e8f0;border:1px solid #64748b;border-radius:4px;padding:2px 6px;font-size:11px;line-height:1.2;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.5)">${safe}</div>`;
}

function renderDirectionNames(lg, coords, directionNames) {
  const labels = buildDirectionNameLabels(coords, directionNames);
  for (const lb of labels) {
    L.marker([lb.lat, lb.lon], {
      icon: L.divIcon({
        className: '',
        html: directionLabelIconHtml(lb.name, lb.typeCode),
        iconSize: null,
        iconAnchor: [0, 0],
      }),
      interactive: false,
      zIndexOffset: 200,
    }).addTo(lg);
  }
}

function renderRoadNames(lg, coords, roadNames) {
  const labels = buildRoadNameLabels(coords, roadNames);
  for (const lb of labels) {
    L.marker([lb.lat, lb.lon], {
      icon: L.divIcon({
        className: '',
        html: roadNameLabelIconHtml(lb.name),
        iconSize: null,
        iconAnchor: [0, 0],
      }),
      interactive: false,
      zIndexOffset: 150,
    }).addTo(lg);
  }
}

// ---- 경유지 / 돌발 / 재탐색 / 교차로명 / 시도경계 마커 ---------------------- //

function waypointIconHtml(index) {
  return `<div style="width:26px;height:26px;line-height:26px;text-align:center;background:#3b82f6;color:#fff;border-radius:50%;font-size:12px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4);border:2px solid #fff">${index + 1}</div>`;
}

function renderWaypoints(lg, coords, waypoints) {
  if (!waypoints || waypoints.length === 0) return;
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    if (typeof wp.vxIdx !== 'number' || wp.vxIdx < 0 || wp.vxIdx >= coords.length) continue;
    const c = coords[wp.vxIdx];
    let popup = `<b>🚩 경유지 ${i + 1}</b><br>VX: ${wp.vxIdx}`;
    if (wp.type) popup += `<br>유형: ${wp.type}`;
    if (wp.poiId) popup += `<br>POI: ${wp.poiId}`;
    popup += `<br>WGS84: ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: waypointIconHtml(i), iconSize: [26, 26], iconAnchor: [13, 13] }),
      zIndexOffset: 900,
    }).bindPopup(popup, { maxWidth: 260 }).addTo(lg);
  }
}

function incidentIconHtml(typeCode) {
  const iconByType = { 'A':'🚧', 'B':'🚗', 'C':'⛔', 'D':'🚨', 'E':'🌊', 'F':'🌫' };
  const ico = iconByType[typeCode] || '⚠';
  return `<div style="width:24px;height:24px;line-height:24px;text-align:center;background:rgba(234,88,12,0.9);color:#fff;border-radius:6px;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid #fff">${ico}</div>`;
}

function renderIncidents(lg, coords, incidents) {
  if (!incidents || incidents.length === 0) return;
  for (const ua of incidents) {
    if (typeof ua.startVxIdx !== 'number' || ua.startVxIdx < 0 || ua.startVxIdx >= coords.length) continue;
    const c = coords[ua.startVxIdx];
    let popup = `<b>돌발정보</b> (유형:${esc(ua.typeCode)})`;
    if (ua.content) popup += `<br>${esc(ua.content)}`;
    popup += `<br>VX: ${ua.startVxIdx}`;
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: incidentIconHtml(ua.typeCode), iconSize: [24, 24], iconAnchor: [12, 12] }),
      zIndexOffset: 800,
    }).bindPopup(popup, { maxWidth: 280 }).addTo(lg);
  }
}

function rerouteIconHtml() {
  return `<div style="width:22px;height:22px;line-height:22px;text-align:center;background:rgba(168,85,247,0.9);color:#fff;border-radius:50%;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid #fff">↻</div>`;
}

function renderForcedReroute(lg, coords, points) {
  if (!points || points.length === 0) return;
  for (const pt of points) {
    if (typeof pt.vxIdx !== 'number' || pt.vxIdx < 0 || pt.vxIdx >= coords.length) continue;
    const c = coords[pt.vxIdx];
    let popup = `<b>강제재탐색</b>`;
    if (pt.type) popup += `<br>유형: ${pt.type}`;
    if (pt.distance) popup += `<br>거리: ${pt.distance}m`;
    if (pt.rid) popup += `<br>RID: ${pt.rid}`;
    popup += `<br>VX: ${pt.vxIdx}`;
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: rerouteIconHtml(), iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 700,
    }).bindPopup(popup, { maxWidth: 260 }).addTo(lg);
  }
}

function intersectionLabelIconHtml(name) {
  return `<div style="display:inline-block;background:rgba(15,23,42,0.85);color:#fbbf24;border:1px solid #f59e0b;border-radius:4px;padding:2px 6px;font-size:11px;line-height:1.2;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.5)">✕ ${esc(name)}</div>`;
}

function renderIntersectionNames(lg, coords, names) {
  const labels = buildIntersectionNameLabels(coords, names);
  for (const lb of labels) {
    L.marker([lb.lat, lb.lon], {
      icon: L.divIcon({ className: '', html: intersectionLabelIconHtml(lb.name), iconSize: null, iconAnchor: [0, 0] }),
      interactive: false,
      zIndexOffset: 180,
    }).addTo(lg);
  }
}

function cityBoundaryIconHtml(cityCode) {
  return `<div style="display:inline-block;background:rgba(15,23,42,0.8);color:#cbd5e1;border:1px dashed #94a3b8;border-radius:3px;padding:1px 5px;font-size:10px;line-height:1.2;white-space:nowrap">시도 ${cityCode}</div>`;
}

function renderCityBoundary(lg, coords, boundaries) {
  if (!boundaries || boundaries.length === 0) return;
  for (const cb of boundaries) {
    if (typeof cb.vxIdx !== 'number' || cb.vxIdx < 0 || cb.vxIdx >= coords.length) continue;
    const c = coords[cb.vxIdx];
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: cityBoundaryIconHtml(cb.cityCode), iconSize: null, iconAnchor: [0, 0] }),
      interactive: false,
      zIndexOffset: 140,
    }).addTo(lg);
  }
}

// ---- 범위 기반 polyline 레이어 (TC/LT2/HW/RD5/truck) ------------------------ //

function congestionLabelHtml(distance, time) {
  const distText = formatDistance(distance);
  const timeText = formatTime(time);
  return `<div style="display:inline-block;background:#dc2626;color:#fff;border:2px solid #fff;border-radius:6px;padding:3px 8px;font-size:12px;font-weight:700;line-height:1.2;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5)">🚨 정체 ${distText} · ${timeText}</div>`;
}

function renderCongestion(lg, coords, items) {
  // TC: 정체구간 — 빨간 굵은 점선 + 중앙에 항상 보이는 라벨
  const segs = buildRangeSegments(coords, items);
  for (const { latlngs, item } of segs) {
    const popup = `<b>정체구간</b><br>거리: ${formatDistance(item.distance)}<br>시간: ${formatTime(item.time)}<br>VX: ${item.startVxIdx}~${item.endVxIdx}`;
    L.polyline(latlngs, { color: '#dc2626', weight: 7, opacity: 0.55, dashArray: '10,6' })
      .bindPopup(popup, { maxWidth: 260 })
      .addTo(lg);
  }

  // 항상 보이는 칩 라벨 (중앙점)
  const labels = buildCongestionLabels(coords, items);
  for (const lb of labels) {
    L.marker([lb.lat, lb.lon], {
      icon: L.divIcon({
        className: '',
        html: congestionLabelHtml(lb.distance, lb.time),
        iconSize: null,
        iconAnchor: [0, 0],
      }),
      interactive: false,
      zIndexOffset: 600,
    }).addTo(lg);
  }
}

function renderTrafficInfo(lg, coords, items) {
  // LT2: TSD링크교통정보 — 혼잡도별 색, 경로보다 얇게
  const segs = buildRangeSegments(coords, items);
  for (const { latlngs, item } of segs) {
    const congChar = String.fromCharCode(item.congestion);
    const color = CONGESTION_COLORS[congChar] || CONGESTION_FALLBACK_COLOR;
    const congName = CONGESTION_NAMES[congChar] || `코드 ${item.congestion}`;
    const popup = `<b>교통정보(LT2)</b><br>속도: ${item.speed}km/h<br>혼잡도: ${congName}<br>VX: ${item.startVxIdx}~${item.endVxIdx}`;
    L.polyline(latlngs, { color, weight: 2, opacity: 0.85, dashArray: '2,6' })
      .bindPopup(popup, { maxWidth: 260 })
      .addTo(lg);
  }
}

function renderHighwayMode(lg, coords, segments) {
  // HW: 고속모드 범위 — 하늘색 굵은 대시
  const segs = buildRangeSegments(coords, segments);
  for (const { latlngs, item } of segs) {
    L.polyline(latlngs, { color: '#0ea5e9', weight: 4, opacity: 0.5, dashArray: '12,8' })
      .bindPopup(`<b>고속모드</b><br>VX: ${item.startVxIdx}~${item.endVxIdx}`, { maxWidth: 200 })
      .addTo(lg);
  }
}

function renderRpLinks(lg, coords, items) {
  // RD5: RP 링크 — 노란색 얇은 선 + 방향 메타
  const segs = buildRangeSegments(coords, items);
  for (const { latlngs, item } of segs) {
    const dirText = item.direction === 1 ? '역방향' : '정방향';
    const popup = `<b>RP링크</b><br>RID: ${item.rid}<br>소요: ${item.ridTime}초<br>LinkID: ${item.linkId}<br>Mesh: ${item.meshCode}<br>방향: ${dirText}${item.superCruise ? '<br>Super Cruise' : ''}<br>VX: ${item.startVxIdx}~${item.endVxIdx}`;
    L.polyline(latlngs, { color: '#eab308', weight: 2, opacity: 0.7 })
      .bindPopup(popup, { maxWidth: 280 })
      .addTo(lg);
  }
}

function renderTruckRestrictions(lg, coords, { truckWidth, truckHeight, truckWeight }) {
  const kinds = [
    { arr: truckWidth,  label: '폭 제한',  unit: 'cm', color: '#f43f5e' },
    { arr: truckHeight, label: '높이 제한', unit: 'cm', color: '#e11d48' },
    { arr: truckWeight, label: '중량 제한', unit: 'kg', color: '#be123c' },
  ];
  for (const k of kinds) {
    const segs = buildRangeSegments(coords, k.arr);
    for (const { latlngs, item } of segs) {
      const popup = `<b>화물차 ${k.label}</b><br>제한: ${item.limit}${k.unit}${item.overFlag ? '<br>초과' : ''}<br>VX: ${item.startVxIdx}~${item.endVxIdx}`;
      L.polyline(latlngs, { color: k.color, weight: 5, opacity: 0.5, dashArray: '4,4' })
        .bindPopup(popup, { maxWidth: 240 })
        .addTo(lg);
    }
  }
}

// ---- Summary builder ------------------------------------------------------ //

function buildSummary(header, coords, tvasResult) {
  const { routeSearch, mapInfo } = header;
  return {
    totalDistance: routeSearch.totalDistance, totalTime: routeSearch.totalTime,
    taxiFare: routeSearch.taxiFare,
    routeOption: ROUTE_OPTION_NAMES[routeSearch.optionCode] || `옵션 ${routeSearch.optionCode}`,
    routeType: routeSearch.routeType === 1 ? '추천경로' : routeSearch.routeType === 2 ? '대안경로' : '테마로드',
    departureName: mapInfo.departureName, destinationName: mapInfo.destinationName,
    vertexCount: coords.length, roadCount: tvasResult.roads.length,
    guidanceCount: tvasResult.guidancePoints.length, dangerCount: tvasResult.dangerAreas.length,
    tollGateCount: tvasResult.tollGates ? tvasResult.tollGates.length : 0,
    restAreaCount: tvasResult.restAreas ? tvasResult.restAreas.length : 0,
    laneCount: tvasResult.laneGuidance ? tvasResult.laneGuidance.length : 0,
    version: header.version, mapVersion: header.mapVersion,
    evReachable: routeSearch.evReachableFlag,
    formatDistFn: formatDistance, formatTimeFn: formatTime,
  };
}
