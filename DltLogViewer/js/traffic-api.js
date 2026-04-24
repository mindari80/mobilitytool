/**
 * TMAP traffic accident/control/construction API helpers.
 *
 * Endpoint: https://topopen.tmap.co.kr/tmapv20/traffic/acc
 *
 * Response is a FeatureCollection-shaped object with `geometries` holding
 * Feature entries. Point coordinates are [lon, lat]. String properties are
 * frequently padded with null characters (\u0000), which we strip here so
 * downstream UI doesn't have to.
 */

'use strict';

const TRAFFIC_ENDPOINT = 'https://topopen.tmap.co.kr/tmapv20/traffic/acc';

/**
 * Build the traffic API URL for the given WGS84 bounds.
 * @param {{minLat:number,minLon:number,maxLat:number,maxLon:number}} bounds
 * @returns {string}
 */
export function buildTrafficUrl({ minLat, minLon, maxLat, maxLon }) {
  const p = new URLSearchParams({
    minLat: String(minLat),
    minLon: String(minLon),
    maxLat: String(maxLat),
    maxLon: String(maxLon),
    reqCoordType: 'WGS84GEO',
    resCoordType: 'WGS84GEO',
  });
  return `${TRAFFIC_ENDPOINT}?${p.toString()}`;
}

function cleanStr(s) {
  if (s == null) return '';
  return String(s).replace(/\u0000+/g, '').trim();
}

/**
 * Normalise the raw API response into a flat list of incident objects.
 * Features without a valid Point coordinate pair are dropped.
 * @param {any} json
 * @returns {Array}
 */
export function parseTrafficResponse(json) {
  if (!json || !Array.isArray(json.geometries)) return [];
  const out = [];
  for (const feat of json.geometries) {
    const coords = feat?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const p = feat.properties || {};
    out.push({
      lat,
      lon,
      index: p.index,
      pointIndex: p.pointIndex,
      linkId: cleanStr(p.linkId),
      isAccidentNode: cleanStr(p.isAccidentNode),
      name: cleanStr(p.name),
      roadName: cleanStr(p.roadName),
      roadType: cleanStr(p.roadType),
      startTime: cleanStr(p.startTime),
      endTime: cleanStr(p.endTime),
      districtLargeCd: cleanStr(p.districtLargeCd),
      districtMiddleCd: cleanStr(p.districtMiddleCd),
      districtSmallCd: cleanStr(p.districtSmallCd),
      description: cleanStr(p.description),
      accidentUpperCode: cleanStr(p.accidentUpperCode),
      accidentUpperName: cleanStr(p.accidentUpperName),
      accidentDetailCode: cleanStr(p.accidentDetailCode),
      accidentDetailName: cleanStr(p.accidentDetailName),
    });
  }
  return out;
}

// Category colors — stay consistent between marker + legend.
const ACCIDENT_COLORS = {
  A: '#ef4444', // 사고
  B: '#f59e0b', // 공사
  C: '#a855f7', // 행사/기상
  D: '#06b6d4', // 재해
  E: '#dc2626', // 통제
  OTHER: '#94a3b8',
};

const CATEGORY_LABELS = {
  A: '사고',
  B: '공사',
  C: '행사',
  D: '재해',
  E: '통제',
  OTHER: '기타',
};

export const CATEGORY_KEYS = ['E', 'B', 'A', 'C', 'D', 'OTHER'];

export function colorForAccidentCode(code) {
  return ACCIDENT_COLORS[code] || ACCIDENT_COLORS.OTHER;
}

/** Map an incident to its UI category bucket ('A'|'B'|'C'|'D'|'E'|'OTHER'). */
export function categoryKeyForIncident(inc) {
  const c = inc && inc.accidentUpperCode;
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, c) && c !== 'OTHER'
    ? c
    : 'OTHER';
}

export function categoryLabel(key) {
  return CATEGORY_LABELS[key] || CATEGORY_LABELS.OTHER;
}

/**
 * Group incidents by category key. Always returns an object with all known
 * keys populated (empty arrays when no incidents fall in that bucket), so
 * the UI can render a stable set of toggles regardless of what the server
 * returned.
 */
export function groupIncidentsByCategory(incidents) {
  const groups = {};
  for (const k of CATEGORY_KEYS) groups[k] = [];
  for (const inc of incidents || []) {
    groups[categoryKeyForIncident(inc)].push(inc);
  }
  return groups;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(s) {
  const t = cleanStr(s);
  if (t.length !== 12) return t;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`;
}

function field(label, value) {
  const text = value == null || value === '' ? 'N/A' : String(value);
  return `<div><b>${esc(label)}:</b> ${esc(text)}</div>`;
}

/**
 * Render a Leaflet popup HTML string for one incident.
 */
export function buildTrafficPopupHtml(inc) {
  const color = colorForAccidentCode(inc.accidentUpperCode);
  const categoryLine = [inc.accidentUpperName, inc.accidentDetailName]
    .filter(Boolean).join(' / ');
  return `
    <div class="traffic-popup" style="word-break:break-all;overflow-wrap:anywhere;max-width:100%">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
        <b style="font-size:13px">${esc(categoryLine || 'RTM')}</b>
      </div>
      ${field('Name', inc.name)}
      ${field('Description', inc.description)}
      ${field('Road', [inc.roadName, inc.roadType].filter(Boolean).join(' · '))}
      ${field('Start', fmtTime(inc.startTime))}
      ${field('End', fmtTime(inc.endTime))}
      ${field('LinkId', inc.linkId)}
      ${field('WGS84', `${inc.lat.toFixed(6)}, ${inc.lon.toFixed(6)}`)}
    </div>`;
}
