/**
 * TVAS route renderer — visualizes parsed TVAS data on a Leaflet map.
 * Creates SEPARATE layer groups per section for individual on/off control.
 */

'use strict';

import {
  ROAD_TYPE_NAMES, LINK_TYPE_NAMES, FACILITY_CODE_NAMES,
  GUIDANCE_CODE_NAMES, DANGER_TYPE_NAMES, ROUTE_OPTION_NAMES,
  LANE_ANGLE_NAMES, LANE_ANGLE_ARROWS,
} from './tvas-parser.js';

// ---- Layer state ---------------------------------------------------------- //

let tvasLayers = {
  route: null,      // 경로 폴리라인
  guidance: null,   // 안내점
  danger: null,     // 위험지역
  tollgate: null,   // 톨게이트
  restArea: null,   // 휴게소
  lane: null,       // 차로안내
};

// ---- Color schemes -------------------------------------------------------- //

const ROAD_TYPE_COLORS = {
  0: '#ef4444', 1: '#f97316', 2: '#3b82f6', 3: '#10b981',
  4: '#22c55e', 5: '#8b5cf6', 6: '#a855f7', 7: '#6366f1',
  8: '#94a3b8', 9: '#64748b', 10: '#06b6d4', 11: '#78716c',
  12: '#78716c', 16: '#a78bfa', 20: '#fbbf24',
};

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

function laneIconHtml(tl) {
  const n = tl.totalLanes;
  if (n === 0) return '';
  const recArrow = angleToArrow(tl.recommendAngle);
  const valArrow = angleToArrow(tl.validAngle);
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
    html += `<div style="width:16px;text-align:center;border-radius:2px;background:${bg};border:1px solid ${border};padding:1px 0;line-height:1.1">
      <div style="font-size:10px;color:#fff">${arrow}</div>${extra}</div>`;
  }
  html += '</div>';
  return html;
}

// ---- Main render function ------------------------------------------------- //

export function renderTvasRoute(map, tvasResult, resolvedCoords, routeIndex = 0) {
  clearTvasRoute(map);

  const { header, roads, guidancePoints, dangerAreas, tollGates, restAreas,
          roadNames, directionNames, intersectionNames, laneGuidance } = tvasResult;

  // Create separate layer groups
  tvasLayers.route = L.layerGroup();
  tvasLayers.guidance = L.layerGroup();
  tvasLayers.danger = L.layerGroup();
  tvasLayers.tollgate = L.layerGroup();
  tvasLayers.restArea = L.layerGroup();
  tvasLayers.lane = L.layerGroup();

  if (resolvedCoords.length > 0) {
    renderRoutePolylines(tvasLayers.route, resolvedCoords, roads);
    renderEndpoints(tvasLayers.route, resolvedCoords, header);
    renderGuidancePoints(tvasLayers.guidance, resolvedCoords, guidancePoints, directionNames, intersectionNames);
    renderDangerAreas(tvasLayers.danger, resolvedCoords, dangerAreas);
    if (tollGates && tollGates.length > 0) renderTollGates(tvasLayers.tollgate, resolvedCoords, tollGates);
    if (restAreas && restAreas.length > 0) renderRestAreas(tvasLayers.restArea, resolvedCoords, restAreas);
    if (laneGuidance && laneGuidance.length > 0) renderLaneGuidance(tvasLayers.lane, resolvedCoords, laneGuidance);
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

function renderRoutePolylines(lg, coords, roads) {
  // Base polyline connecting ALL VX points (ensures no gaps)
  const allLatLngs = coords.map(c => [c.lat, c.lon]);
  L.polyline(allLatLngs, { color: '#a855f7', weight: 3, opacity: 0.4 }).addTo(lg);

  if (roads.length === 0) return;

  // Colored segments by road type on top
  let startIdx = 0;
  for (const road of roads) {
    const endIdx = Math.min(road.lastVxIdx, coords.length - 1);
    if (startIdx > endIdx || startIdx >= coords.length) { startIdx = endIdx + 1; continue; }
    const segment = [];
    for (let i = startIdx; i <= endIdx && i < coords.length; i++) segment.push([coords[i].lat, coords[i].lon]);
    if (segment.length >= 2) {
      const color = ROAD_TYPE_COLORS[road.roadType] || '#94a3b8';
      L.polyline(segment, { color, weight: 5, opacity: 0.85 })
        .bindPopup(`<b>${esc(ROAD_TYPE_NAMES[road.roadType] || '도로')}</b><br>링크: ${esc(LINK_TYPE_NAMES[road.linkType] || road.linkType)}<br>시설: ${esc(FACILITY_CODE_NAMES[road.facilityCode] || road.facilityCode)}<br>길이: ${formatDistance(road.roadLength)}<br>차선: ${road.laneCount}<br>제한속도: ${road.speedLimit}km/h<br>에너지: ${road.energyConsumption}Wh<br>VX: ${startIdx}~${endIdx}`, { maxWidth: 300 })
        .addTo(lg);
    }
    startIdx = endIdx + 1;
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
    let popup = `<b>🚧 ${esc(tg.name || '톨게이트')}</b><br>유형: ${typeNames[tg.guideType] || tg.guideType}`;
    if (tg.fare > 0) popup += `<br>요금: ${tg.fare.toLocaleString()}원`;
    if (tg.hipassOnly) popup += `<br>하이패스 전용`;
    popup += `<br>혼잡도: ${congNames[tg.congestion] || tg.congestion}<br>VX: ${tg.vxIdx}`;
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: `<div style="width:24px;height:24px;line-height:24px;text-align:center;background:rgba(251,191,36,0.9);border-radius:6px;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid #fff">🚧</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

function renderRestAreas(lg, coords, restAreas) {
  for (const ra of restAreas) {
    if (ra.entryVxIdx >= coords.length) continue;
    const c = coords[ra.entryVxIdx];
    let popup = `<b>🅿 ${esc(ra.name || '휴게소')}</b><br>VX: ${ra.entryVxIdx}~${ra.exitVxIdx}`;
    if (ra.poiId) popup += `<br>POI: ${ra.poiId}`;
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: `<div style="width:24px;height:24px;line-height:24px;text-align:center;background:rgba(34,197,94,0.9);border-radius:6px;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid #fff">🅿</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

function buildLanePopup(tl, c) {
  const n = tl.totalLanes;
  const busNames = {0:'없음',1:'우측차로(전일)',2:'우측차로(시간제)',3:'중앙차로(전일)',4:'중앙차로(시간제)'};
  const roadNames = ROAD_TYPE_NAMES;

  let html = `<div style="font-size:12px;line-height:1.6;max-width:320px">`;
  html += `<b>차로안내</b> (${n}차로)`;
  html += `<br>VX: ${tl.vxIdx} | WGS84: ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;
  if (tl.roadTypeCode !== undefined) html += `<br>도로종별: ${roadNames[tl.roadTypeCode] || tl.roadTypeCode}`;

  // 차로 상세 테이블
  html += `<table style="width:100%;margin:6px 0;border-collapse:collapse;font-size:11px">`;
  html += `<tr style="background:rgba(148,163,184,0.1)"><th style="padding:3px 4px;text-align:center;border:1px solid #334155">차로</th><th style="padding:3px;border:1px solid #334155">권장</th><th style="padding:3px;border:1px solid #334155">유효</th><th style="padding:3px;border:1px solid #334155">속성</th></tr>`;

  for (let b = 0; b < n; b++) {
    const isRec = (tl.recommendLane >> b) & 1;
    const isVal = (tl.validLane >> b) & 1;
    const isLP = b < tl.leftPocket;
    const isRP = b >= (n - tl.rightPocket);
    const isOver = (tl.overpassLane >> b) & 1;
    const isUnder = (tl.underpassLane >> b) & 1;
    const isBus = (tl.busLaneCode === 1 || tl.busLaneCode === 2) ? (b === n - 1) :
                  (tl.busLaneCode === 3 || tl.busLaneCode === 4) ? (b === 0) : false;

    const recMark = isRec ? `<span style="color:#22c55e;font-weight:700">${angleToArrow(tl.recommendAngle)} ${angleName(tl.recommendAngle)}</span>` : '<span style="color:#6b7280">-</span>';
    const valMark = isVal ? `<span style="color:#3b82f6">${angleToArrow(tl.validAngle)} ${angleName(tl.validAngle)}</span>` : '<span style="color:#6b7280">-</span>';

    let attrs = [];
    if (isLP) attrs.push('<span style="color:#fbbf24">좌포켓</span>');
    if (isRP) attrs.push('<span style="color:#fbbf24">우포켓</span>');
    if (isOver) attrs.push('<span style="color:#f97316">고가</span>');
    if (isUnder) attrs.push('<span style="color:#06b6d4">지하</span>');
    if (isBus) attrs.push('<span style="color:#a78bfa">버스</span>');

    const rowBg = isRec ? 'rgba(34,197,94,0.08)' : isVal ? 'rgba(59,130,246,0.06)' : '';
    html += `<tr style="background:${rowBg}"><td style="padding:3px 4px;text-align:center;border:1px solid #334155;font-weight:600">${b+1}</td>`;
    html += `<td style="padding:3px 4px;border:1px solid #334155">${recMark}</td>`;
    html += `<td style="padding:3px 4px;border:1px solid #334155">${valMark}</td>`;
    html += `<td style="padding:3px 4px;border:1px solid #334155">${attrs.join(' ') || '-'}</td></tr>`;
  }
  html += `</table>`;

  // 비유효차로 정보
  if (tl.invalidLanes && tl.invalidLanes.length > 0) {
    html += `<b>비유효차로 (${tl.invalidLanes.length}건)</b><br>`;
    tl.invalidLanes.forEach((iv, j) => {
      let ivLanes = [];
      for (let b = 0; b < n; b++) { if ((iv.lane >> b) & 1) ivLanes.push(b + 1); }
      html += `#${j+1}: 차로 [${ivLanes.join(',')}] ${angleToArrow(iv.angle)} ${angleName(iv.angle)}<br>`;
    });
  }

  // 버스전용차로
  if (tl.busLaneCode > 0) {
    html += `<br><b>버스전용차로:</b> ${busNames[tl.busLaneCode] || tl.busLaneCode}`;
  }

  // 고가/지하
  if (tl.overpassLane) {
    let ovLanes = [];
    for (let b = 0; b < n; b++) { if ((tl.overpassLane >> b) & 1) ovLanes.push(b + 1); }
    if (ovLanes.length) html += `<br><b>고가진입차로:</b> ${ovLanes.join(', ')}차로`;
  }
  if (tl.underpassLane) {
    let unLanes = [];
    for (let b = 0; b < n; b++) { if ((tl.underpassLane >> b) & 1) unLanes.push(b + 1); }
    if (unLanes.length) html += `<br><b>지하진입차로:</b> ${unLanes.join(', ')}차로`;
  }

  // Raw hex
  html += `<br><span style="color:#6b7280;font-size:10px">권장:0x${tl.recommendLane.toString(16).padStart(4,'0')} 유효:0x${tl.validLane.toString(16).padStart(4,'0')} 각도:${tl.recommendAngle}/${tl.validAngle}</span>`;
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
