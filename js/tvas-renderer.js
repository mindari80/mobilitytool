/**
 * TVAS route renderer — visualizes parsed TVAS data on a Leaflet map.
 * Creates layer groups for route polylines, guidance markers, danger areas, etc.
 */

'use strict';

import {
  ROAD_TYPE_NAMES, LINK_TYPE_NAMES, FACILITY_CODE_NAMES,
  GUIDANCE_CODE_NAMES, DANGER_TYPE_NAMES, ROUTE_OPTION_NAMES,
} from './tvas-parser.js';

// ---- Rendering state ------------------------------------------------------ //

let tvasLayerGroup = null;

// ---- Color schemes -------------------------------------------------------- //

const ROAD_TYPE_COLORS = {
  0: '#ef4444',  // 고속국도 (red)
  1: '#f97316',  // 도시고속 (orange)
  2: '#3b82f6',  // 국도 (blue)
  3: '#10b981',  // 국가지원지방도 (emerald)
  4: '#22c55e',  // 지방도 (green)
  5: '#8b5cf6',  // 주요도로1 (purple)
  6: '#a855f7',  // 주요도로2
  7: '#6366f1',  // 주요도로3
  8: '#94a3b8',  // 기타도로1
  9: '#64748b',  // 이면도로
  10: '#06b6d4', // 페리항로 (cyan)
  11: '#78716c', // 단지내도로
  12: '#78716c', // 단지내도로2
  16: '#a78bfa', // 일반도로
  20: '#fbbf24', // 번화가링크
};

const DANGER_TYPE_ICONS = {
  camera: '📷', section: '📐', schoolZone: '🏫',
  accident: '⚠', curve: '↩', fog: '🌫',
  train: '🚂', default: '⚠',
};

function getDangerIcon(type) {
  if (type >= 1 && type <= 6)  return DANGER_TYPE_ICONS.camera;
  if (type === 10 || type === 11 || type === 30) return DANGER_TYPE_ICONS.section;
  if (type === 14 || type === 40) return DANGER_TYPE_ICONS.schoolZone;
  if (type === 15) return DANGER_TYPE_ICONS.accident;
  if (type === 16) return DANGER_TYPE_ICONS.curve;
  if (type === 17) return DANGER_TYPE_ICONS.fog;
  if (type === 18) return DANGER_TYPE_ICONS.train;
  return DANGER_TYPE_ICONS.default;
}

// ---- HTML helpers --------------------------------------------------------- //

function esc(s) {
  return String(s ?? 'N/A')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDistance(meters) {
  if (meters >= 1000) return (meters / 1000).toFixed(1) + ' km';
  return meters + ' m';
}

function formatTime(seconds) {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}시간 ${m}분`;
  }
  return Math.floor(seconds / 60) + '분';
}

function guidanceName(code) {
  return GUIDANCE_CODE_NAMES[code] || `안내코드 ${code}`;
}

function dangerName(type) {
  return DANGER_TYPE_NAMES[type] || `위험지역 ${type}`;
}

// ---- Guidance point icon -------------------------------------------------- //

function guidanceIconHtml(code) {
  const arrows = {
    11: '↑', 12: '←', 13: '→', 14: '↩', 15: '↰',
    16: '↰', 17: '↰', 18: '↱', 19: '↱',
    43: '→', 44: '←', 51: '↑', 77: '⤺', 78: '⤻',
    101: '⤻', 102: '⤺', 103: '↑', 104: '⤻', 105: '⤺', 106: '↑',
    111: '⤻', 112: '⤺', 113: '↑', 114: '⤻', 115: '⤺', 116: '↑',
    150: '🅿', 151: '🅿', 152: '🅿', 160: '⚡',
    170: '⛴', 171: '⛴',
    200: '🚩', 201: '🏁', 203: '🏁', 204: '🚧',
    211: '🚶', 218: '🛗',
  };
  const arrow = arrows[code] || '●';
  return `<div style="
    width:22px;height:22px;line-height:22px;text-align:center;
    background:rgba(15,23,42,0.85);color:#e2e8f0;
    border:2px solid #a855f7;border-radius:50%;font-size:12px;
    box-shadow:0 1px 4px rgba(0,0,0,.4)">${arrow}</div>`;
}

// ---- Departure/Destination icons ------------------------------------------ //

function departIconHtml() {
  return `<div style="
    width:28px;height:28px;line-height:28px;text-align:center;
    background:#22c55e;color:#fff;border-radius:50%;font-size:14px;
    font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4);
    border:2px solid #fff">S</div>`;
}

function destIconHtml() {
  return `<div style="
    width:28px;height:28px;line-height:28px;text-align:center;
    background:#ef4444;color:#fff;border-radius:50%;font-size:14px;
    font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4);
    border:2px solid #fff">E</div>`;
}

// ---- Main render function ------------------------------------------------- //

/**
 * Render parsed TVAS route on the map.
 * @param {L.Map} map - Leaflet map instance
 * @param {Object} tvasResult - Parsed TVAS result from parseTvas()
 * @param {Array} resolvedCoords - Array of {lat, lon, ...} from resolveVertexCoordinates()
 * @param {number} routeIndex - Route index (0-based) for labeling
 * @returns {{ layerGroup: L.LayerGroup, summary: Object }}
 */
export function renderTvasRoute(map, tvasResult, resolvedCoords, routeIndex = 0) {
  // Clear previous
  clearTvasRoute(map);

  const lg = L.layerGroup();
  tvasLayerGroup = lg;

  const { header, roads, guidancePoints, dangerAreas, tollGates, restAreas,
          roadNames, directionNames, intersectionNames } = tvasResult;

  if (resolvedCoords.length === 0) {
    lg.addTo(map);
    return { layerGroup: lg, summary: buildSummary(header, resolvedCoords, tvasResult) };
  }

  // ---- 1. Route polyline (colored by road type) ---- //
  renderRoutePolylines(lg, resolvedCoords, roads);

  // ---- 2. Departure / Destination markers ---- //
  renderEndpoints(lg, resolvedCoords, header);

  // ---- 3. Guidance point markers ---- //
  renderGuidancePoints(lg, resolvedCoords, guidancePoints, directionNames, intersectionNames);

  // ---- 4. Danger area markers ---- //
  renderDangerAreas(lg, resolvedCoords, dangerAreas);

  // ---- 5. Toll gates ---- //
  if (tollGates && tollGates.length > 0) {
    renderTollGates(lg, resolvedCoords, tollGates);
  }

  // ---- 6. Rest areas ---- //
  if (restAreas && restAreas.length > 0) {
    renderRestAreas(lg, resolvedCoords, restAreas);
  }

  lg.addTo(map);

  return { layerGroup: lg, summary: buildSummary(header, resolvedCoords, tvasResult) };
}

export function clearTvasRoute(map) {
  if (tvasLayerGroup) {
    tvasLayerGroup.clearLayers();
    if (map && map.hasLayer(tvasLayerGroup)) {
      map.removeLayer(tvasLayerGroup);
    }
    tvasLayerGroup = null;
  }
}

export function getTvasLayerGroup() {
  return tvasLayerGroup;
}

// ---- Sub-renderers -------------------------------------------------------- //

function renderRoutePolylines(lg, coords, roads) {
  if (roads.length === 0) {
    // No road info — draw single polyline
    const latlngs = coords.map(c => [c.lat, c.lon]);
    L.polyline(latlngs, { color: '#a855f7', weight: 5, opacity: 0.85 }).addTo(lg);
    return;
  }

  // Build polyline segments by road type
  let startIdx = 0;
  for (const road of roads) {
    const endIdx = Math.min(road.lastVxIdx, coords.length - 1);
    if (startIdx > endIdx || startIdx >= coords.length) {
      startIdx = endIdx + 1;
      continue;
    }
    const segment = [];
    for (let i = startIdx; i <= endIdx && i < coords.length; i++) {
      segment.push([coords[i].lat, coords[i].lon]);
    }
    if (segment.length >= 2) {
      const color = ROAD_TYPE_COLORS[road.roadType] || '#94a3b8';
      const popup = `
        <b>${esc(ROAD_TYPE_NAMES[road.roadType] || '도로')}</b><br>
        링크종별: ${esc(LINK_TYPE_NAMES[road.linkType] || road.linkType)}<br>
        시설물: ${esc(FACILITY_CODE_NAMES[road.facilityCode] || road.facilityCode)}<br>
        길이: ${formatDistance(road.roadLength)}<br>
        차선: ${road.laneCount}<br>
        제한속도: ${road.speedLimit} km/h<br>
        에너지: ${road.energyConsumption} Wh<br>
        VX: ${startIdx}~${endIdx}`;
      L.polyline(segment, {
        color, weight: 5, opacity: 0.85,
      }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
    }
    startIdx = endIdx + 1;
  }
}

function renderEndpoints(lg, coords, header) {
  const first = coords[0];
  const last = coords[coords.length - 1];
  const depName = header.mapInfo.departureName || '출발지';
  const dstName = header.mapInfo.destinationName || '목적지';

  L.marker([first.lat, first.lon], {
    icon: L.divIcon({ className: '', html: departIconHtml(), iconSize: [28, 28], iconAnchor: [14, 14] }),
    zIndexOffset: 1000,
  }).bindPopup(`<b>${esc(depName)}</b><br>SK: (${first.skX}, ${first.skY})<br>WGS84: ${first.lat.toFixed(6)}, ${first.lon.toFixed(6)}`).addTo(lg);

  L.marker([last.lat, last.lon], {
    icon: L.divIcon({ className: '', html: destIconHtml(), iconSize: [28, 28], iconAnchor: [14, 14] }),
    zIndexOffset: 1000,
  }).bindPopup(`<b>${esc(dstName)}</b><br>SK: (${last.skX}, ${last.skY})<br>WGS84: ${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}`).addTo(lg);
}

function renderGuidancePoints(lg, coords, guidancePoints, directionNames, intersectionNames) {
  for (const gp of guidancePoints) {
    if (gp.vxIndex >= coords.length) continue;
    const c = coords[gp.vxIndex];
    const name = guidanceName(gp.guidanceCode);

    // Find direction name at this point
    let dirName = '';
    if (directionNames) {
      const dn = directionNames.find(d => d.lastVxIdx >= gp.vxIndex);
      if (dn) dirName = dn.name;
    }
    let intName = '';
    if (intersectionNames) {
      const cn = intersectionNames.find(d => d.lastVxIdx >= gp.vxIndex);
      if (cn) intName = cn.name;
    }

    let popup = `<b>${esc(name)}</b> (코드: ${gp.guidanceCode})`;
    if (gp.continuousTurnCode > 0) popup += `<br>연속회전: ${gp.continuousTurnCode === 1 ? '고속' : '일반'}`;
    if (dirName) popup += `<br>방면: ${esc(dirName)}`;
    if (intName) popup += `<br>교차로: ${esc(intName)}`;
    popup += `<br>VX: ${gp.vxIndex}<br>WGS84: ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;

    L.marker([c.lat, c.lon], {
      icon: L.divIcon({
        className: '',
        html: guidanceIconHtml(gp.guidanceCode),
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

function renderDangerAreas(lg, coords, dangerAreas) {
  for (const da of dangerAreas) {
    if (da.startVxIdx >= coords.length) continue;
    const startC = coords[da.startVxIdx];
    const endC = coords[Math.min(da.endVxIdx, coords.length - 1)];
    const icon = getDangerIcon(da.type);
    const name = dangerName(da.type);

    // Highlighted segment
    if (da.startVxIdx !== da.endVxIdx) {
      const segment = [];
      for (let i = da.startVxIdx; i <= Math.min(da.endVxIdx, coords.length - 1); i++) {
        segment.push([coords[i].lat, coords[i].lon]);
      }
      if (segment.length >= 2) {
        L.polyline(segment, {
          color: '#ef4444', weight: 8, opacity: 0.5,
          dashArray: '8,6',
        }).addTo(lg);
      }
    }

    // Marker at start
    let popup = `<b>${icon} ${esc(name)}</b>`;
    if (da.speedLimit > 0) popup += `<br>제한속도: ${da.speedLimit} km/h`;
    if (da.sectionLength > 0) popup += `<br>구간길이: ${formatDistance(da.sectionLength)}`;
    if (da.sectionSpeed > 0) popup += `<br>구간단속속도: ${da.sectionSpeed} km/h`;
    if (da.variableSpeed) popup += `<br>가변속도`;
    if (da.schoolZoneCamera) popup += `<br>어린이보호구역 단속카메라`;
    popup += `<br>VX: ${da.startVxIdx}~${da.endVxIdx}`;

    L.marker([startC.lat, startC.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          width:24px;height:24px;line-height:24px;text-align:center;
          background:rgba(239,68,68,0.9);border-radius:6px;
          font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);
          border:1px solid #fff">${icon}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

function renderTollGates(lg, coords, tollGates) {
  for (const tg of tollGates) {
    if (tg.vxIdx >= coords.length) continue;
    const c = coords[tg.vxIdx];
    const typeNames = { 1: '개방형', 2: '폐쇄형', 3: 'IC', 4: 'JC', 5: '진출IC', 6: '휴게소' };
    const congNames = { '1': '원활', '2': '서행', '4': '정체', '0': '정보없음' };
    let popup = `<b>🚧 ${esc(tg.name || '톨게이트')}</b>`;
    popup += `<br>유형: ${typeNames[tg.guideType] || tg.guideType}`;
    if (tg.fare > 0) popup += `<br>요금: ${tg.fare.toLocaleString()}원`;
    if (tg.hipassOnly) popup += `<br>하이패스 전용`;
    if (tg.avgSpeed > 0) popup += `<br>평균속도: ${tg.avgSpeed} km/h`;
    popup += `<br>혼잡도: ${congNames[tg.congestion] || tg.congestion}`;
    if (tg.dist100m > 0) popup += `<br>거리: ${formatDistance(tg.dist100m * 100)}`;
    popup += `<br>VX: ${tg.vxIdx}`;

    L.marker([c.lat, c.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          width:24px;height:24px;line-height:24px;text-align:center;
          background:rgba(251,191,36,0.9);border-radius:6px;
          font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);
          border:1px solid #fff">🚧</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

function renderRestAreas(lg, coords, restAreas) {
  for (const ra of restAreas) {
    if (ra.entryVxIdx >= coords.length) continue;
    const c = coords[ra.entryVxIdx];
    let popup = `<b>🅿 ${esc(ra.name || '휴게소')}</b>`;
    popup += `<br>VX: ${ra.entryVxIdx}~${ra.exitVxIdx}`;
    if (ra.poiId) popup += `<br>POI ID: ${ra.poiId}`;

    L.marker([c.lat, c.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          width:24px;height:24px;line-height:24px;text-align:center;
          background:rgba(34,197,94,0.9);border-radius:6px;
          font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);
          border:1px solid #fff">🅿</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    }).bindPopup(popup, { maxWidth: 300 }).addTo(lg);
  }
}

// ---- Summary builder ------------------------------------------------------ //

function buildSummary(header, coords, tvasResult) {
  const { routeSearch, mapInfo } = header;
  return {
    totalDistance:    routeSearch.totalDistance,
    totalTime:       routeSearch.totalTime,
    taxiFare:        routeSearch.taxiFare,
    routeOption:     ROUTE_OPTION_NAMES[routeSearch.optionCode] || `옵션 ${routeSearch.optionCode}`,
    routeType:       routeSearch.routeType === 1 ? '추천경로' : routeSearch.routeType === 2 ? '대안경로' : '테마로드',
    departureName:   mapInfo.departureName,
    destinationName: mapInfo.destinationName,
    vertexCount:     coords.length,
    roadCount:       tvasResult.roads.length,
    guidanceCount:   tvasResult.guidancePoints.length,
    dangerCount:     tvasResult.dangerAreas.length,
    tollGateCount:   tvasResult.tollGates ? tvasResult.tollGates.length : 0,
    restAreaCount:   tvasResult.restAreas ? tvasResult.restAreas.length : 0,
    version:         header.version,
    mapVersion:      header.mapVersion,
    evReachable:     routeSearch.evReachableFlag,
    formatDistFn:    formatDistance,
    formatTimeFn:    formatTime,
  };
}
