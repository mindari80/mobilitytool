/**
 * Log extraction logic.
 * Ported from dlt_gpslog_parser4.py – extract_logs()
 *
 * Extracts:
 *  - locationLogs    (GPS / DR_GPS positions)
 *  - mmLogs          (Map-Matching results)
 *  - routeRequests   (HTTP route requests with payload)
 *  - ttsLogs         (TTS guidance events)
 */

'use strict';

import { iterateDltRecords, encodeMarkers } from './dlt-parser.js';
import {
  skCoordToWgs84, fitAffineTransform, applyAffineTransform
} from './coordinate.js';

// ---- Compiled patterns --------------------------------------------------- //

const LOCATION_RE = /#onLocationChanged.*?Location\[(dr_gps|gps) ([0-9.]+),([0-9.]+).*?bear=([0-9.]+)/;
const ET_RE = /et=\+\d+m\d+s\d+ms/;
const MM_RESULT_START_RE = /\[MM\]\[\d+\]:\[MM_RESULT\].*Result\(LocalMatch\)/;
const MM_GPS_RE = /\[MM\]\[\d+\]:\[MM_RESULT\]\s*GPS\s+Pos\s*=\s*([0-9.]+)\s+([0-9.]+),\s*([0-9.\-]+)/;
const MM_MATCH_RE = /\[MM\]\[\d+\]:\[MM_RESULT\]\s*Match\s+Pos\s*=\s*([0-9.]+)\s+([0-9.]+),\s*([0-9.\-]+)/;
const MM_GPS_SRC_RE = /\[MM\]\[\d+\]:\[MM_RESULT\]\s*GPS\s*=\s*([^,]+),\s*Hdop\s*=\s*([0-9.\-]+)\s*Speed:([0-9.\-]+)/;
const MM_STATE_RE = /\[MM\]\[\d+\]:\[MM_RESULT\]\s*State\s*=\s*([^\x00\r\n]+)/;
const MM_SUPPORT_DR_RE = /\[MM\]\[\d+\]:\[MM_RESULT\]\s*SupportDR\s*=\s*([^\x00\r\n]+)/;
const MM_SCORE_RE = /\[MM\]\[\d+\]:\[MM_RESULT\]\s*Score\s*=\s*([0-9.\-]+),\s*NumOfMatchesInDR\s*(\d+),\s*isOpenSkyDRMode\s*(\d+)/;
const MM_DIST_RE = /\[MM\]\[\d+\]:\[MM_RESULT\]\s*Dist=\s*([0-9.\-]+)\s*\/\s*vIndex\s*=\s*([0-9.\-]+)\s*\/\s*fB\s*=\s*([0-9.\-]+)/;

const RPLOG_POST_RE  = /#RpLog\[(\d+)\]:\[([^\]]+)\] --> POST (\S+)/;
const RPLOG_REQ_RE   = /#RpLog\[(\d+)\]:\[([^\]]+)\] REQ: (\{.*)/;
const RPLOG_RESP_RE  = /#RpLog\[(\d+)\]:\[([^\]]+)\] <-- (\d+) \((\d+)ms\) SessionID: (\S+)/;
const RPLOG_RES_RE   = /#RpLog\[(\d+)\]:\[([^\]]+)\] RES: \[(\d+) ([^\]]+)\] \(size: ([^)]+)\)/;
const TTS_STATUS_RE = /TmapAutoExternalVoicePlayer:requestTTS\[(\d+)\]:requestTTS status : ([^\x00\r\n]+)/;
const TTS_SCRIPT_RE = /TmapAutoExternalVoicePlayer:requestTTS\[(\d+)\]:requestTTS script : ([^\x00\r\n]+)/;

const GPS_INTERESTING_STRINGS = [
  '#onLocationChanged',
  '[MM_RESULT]',
];

const ROUTE_TTS_INTERESTING_STRINGS = [
  '#onLocationChanged',   // needed for recentLocation (route anchor)
  '#RpLog[',
  'requestTTS',
];

const ALL_INTERESTING_STRINGS = [
  '#onLocationChanged',
  '[MM_RESULT]',
  '#RpLog[',
  'requestTTS',
];

// ---- Helpers ------------------------------------------------------------- //

function sanitizeText(value) {
  if (value == null) return null;
  let text = String(value);
  text = text.replace(/\x00DLT.*/g, '');
  text = text.replace(/[^\t\n\r\u0020-\uFFFF]/g, '');
  return text.trim();
}

function isBase64ish(value) {
  if (typeof value !== 'string') return false;
  const compact = value.trim().replace(/\\n|\n/g, '');
  if (compact.length < 120) return false;
  return /^[A-Za-z0-9+/=]+$/.test(compact);
}

function preparePayloadForDisplay(payload) {
  if (Array.isArray(payload)) {
    const out = [];
    for (const item of payload) {
      const f = preparePayloadForDisplay(item);
      if (f !== '__OMIT__') out.push(f);
    }
    return out;
  }
  if (payload && typeof payload === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'gpsTraceData') continue;
      const f = preparePayloadForDisplay(v);
      if (f !== '__OMIT__') out[k] = f;
    }
    return out;
  }
  if (isBase64ish(payload)) return '__OMIT__';
  return payload;
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Parse "RP-218-Traffic_MinTime" → { rpId: 218, rpOption: "Traffic_MinTime" }
function parseRpLabel(label) {
  const m = /^RP-(\d+)-(.+)$/.exec(label);
  if (!m) return null;
  return { rpId: parseInt(m[1], 10), rpOption: m[2] };
}

// ---- Partial route payload extraction ------------------------------------ //

function extractPartialRoutePayload(text) {
  const payload = {};

  const stringFields = {
    departName: /"departName":"([^"]*)"/,
    destName: /"destName":"([^"]*)"/,
    destSearchFlag: /"destSearchFlag":"([^"]*)"/,
    destSearchDetailFlag: /"destSearchDetailFlag":"([^"]*)"/,
    departRoadType: /"departRoadType":"([^"]*)"/,
    autoAddingYn: /"autoAddingYn":"([^"]*)"/,
    guideImgResolutionCode: /"guideImgResolutionCode":"([^"]*)"/,
    serviceFlag: /"serviceFlag":"([^"]*)"/,
    tollCarType: /"tollCarType":"([^"]*)"/,
    tvas: /"tvas":"([^"]*)"/,
    vehicleId: /"vehicleId":"([^"]*)"/,
    vendor: /"vendor":"([^"]*)"/,
    version: /"version":"([^"]*)"/,
    consumptionParam: /"consumptionParam":"((?:\\.|[^"])*)"/,
    reqTime: /"reqTime":"([^"]*)"/,
    appVersion: /"appVersion":"([^"]*)"/,
    buildNo: /"buildNo":"([^"]*)"/,
    osVersion: /"osVersion":"([^"]*)"/,
    modelNo: /"modelNo":"([^"]*)"/,
  };

  const numericFields = {
    departXPos: /"departXPos":(-?\d+)/,
    departYPos: /"departYPos":(-?\d+)/,
    departDirPriority: /"departDirPriority":(-?\d+(?:\.\d+)?)/,
    departDirectionType: /"departDirectionType":(-?\d+(?:\.\d+)?)/,
    departSrchFlag: /"departSrchFlag":(-?\d+)/,
    destXPos: /"destXPos":(-?\d+)/,
    destYPos: /"destYPos":(-?\d+)/,
    angle: /"angle":(-?\d+(?:\.\d+)?)/,
    auxiliaryPower: /"auxiliaryPower":(-?\d+(?:\.\d+)?)/,
    chargedEnergy: /"chargedEnergy":(-?\d+(?:\.\d+)?)/,
    chargedRange: /"chargedRange":(-?\d+(?:\.\d+)?)/,
    currentEnergy: /"currentEnergy":(-?\d+(?:\.\d+)?)/,
    currentRange: /"currentRange":(-?\d+(?:\.\d+)?)/,
    minSocAtAutoAdding: /"minSocAtAutoAdding":(-?\d+(?:\.\d+)?)/,
    minSocAtChargingStation: /"minSocAtChargingStation":(-?\d+(?:\.\d+)?)/,
    minSocAtDestination: /"minSocAtDestination":(-?\d+(?:\.\d+)?)/,
    destRpFlag: /"destRpFlag":(-?\d+(?:\.\d+)?)/,
    destPoiId: /"destPoiId":"?([^",}\]]+)"?/,
    ecoModeFlag: /"ecoModeFlag":(-?\d+(?:\.\d+)?)/,
    hipassFlag: /"hipassFlag":(-?\d+(?:\.\d+)?)/,
    maxCharge: /"maxCharge":(-?\d+(?:\.\d+)?)/,
    minEnergy: /"minEnergy":(-?\d+(?:\.\d+)?)/,
    slopeFlag: /"slopeFlag":(-?\d+(?:\.\d+)?)/,
    speed: /"speed":(-?\d+(?:\.\d+)?)/,
    vehicleMass: /"vehicleMass":(-?\d+(?:\.\d+)?)/,
    efficientSpeed: /"efficientSpeed":(-?\d+(?:\.\d+)?)/,
  };

  const booleanFields = {
    applyEvChargingTimeOnETA: /"applyEvChargingTimeOnETA":(true|false)/,
    availableAutoAddingYn: /"availableAutoAddingYn":(true|false)/,
    destEVChargerFlag: /"destEVChargerFlag":(true|false)/,
  };

  for (const [key, re] of Object.entries(stringFields)) {
    const m = re.exec(text);
    if (m) payload[key] = key === 'consumptionParam'
      ? m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      : m[1];
  }

  for (const [key, re] of Object.entries(numericFields)) {
    const m = re.exec(text);
    if (m) payload[key] = m[1].includes('.') ? parseFloat(m[1]) : parseInt(m[1], 10);
  }

  for (const [key, re] of Object.entries(booleanFields)) {
    const m = re.exec(text);
    if (m) payload[key] = m[1] === 'true';
  }

  const camM = /"addCameraTypes":\[(.*?)\]/.exec(text);
  if (camM) payload.addCameraTypes = [...camM[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);

  const dangerM = /"dangerAreaOptions":\[(.*?)\]/.exec(text);
  if (dangerM) payload.dangerAreaOptions = [...dangerM[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);

  const routePlanM = /"routePlanTypes":\[(.*?)\]/.exec(text);
  if (routePlanM) payload.routePlanTypes = [...routePlanM[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);

  const socketM = /"socketType":\[(.*?)\]/.exec(text);
  if (socketM) payload.socketType = [...socketM[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);

  const waypointM = /"wayPoints":\[(.*?)\]/.exec(text);
  if (waypointM) {
    payload.wayPoints = [...waypointM[1].matchAll(/\{[^}]+\}/g)].map(wm => {
      const wp = {};
      const xM = /"x":(\d+)/.exec(wm[0]);
      const yM = /"y":(\d+)/.exec(wm[0]);
      const nameM = /"wayPointName":"([^"]*)"/.exec(wm[0]);
      if (xM) wp.xPos = parseInt(xM[1], 10);
      if (yM) wp.yPos = parseInt(yM[1], 10);
      if (nameM) wp.name = nameM[1];
      return wp;
    });
  }

  return payload;
}

// ---- Route response helpers ---------------------------------------------- //

/**
 * Loosely compare two route endpoint URLs.
 * Handles truncated URLs (one is a prefix of the other) and
 * trailing-slash / query-param differences.
 */
function endpointsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const norm = s => s.replace(/[?#].*/, '').replace(/\/$/, '');
  const na = norm(a), nb = norm(b);
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

/**
 * Assign an HTTP response code to the best matching pending route request.
 * First tries fuzzy endpoint URL matching; falls back to most-recent-unmatched.
 */
function assignResponseCode(requests, unmatchedIndices, code, endpoint) {
  if (endpoint) {
    for (let i = unmatchedIndices.length - 1; i >= 0; i--) {
      const rr = requests[unmatchedIndices[i]];
      if (endpointsMatch(rr.endpoint, endpoint) && rr.responseCode == null) {
        rr.responseCode = code;
        rr.responseStatus = code >= 200 && code < 300 ? 'SUCCESS' : 'FAILED';
        rr.responseMessage = `HTTP ${code}`;
        return true;
      }
    }
  }
  // Fallback: no endpoint match — use most recent unmatched request
  for (let i = unmatchedIndices.length - 1; i >= 0; i--) {
    const rr = requests[unmatchedIndices[i]];
    if (rr.responseCode == null) {
      rr.responseCode = code;
      rr.responseStatus = code >= 200 && code < 300 ? 'SUCCESS' : 'FAILED';
      rr.responseMessage = `HTTP ${code}`;
      return true;
    }
  }
  return false;
}

// ---- Route request builder ----------------------------------------------- //

function normalizeWaypoints(payload) {
  return (payload.wayPoints || [])
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      name: item.name || item.poiName || item.wayPointName || `Waypoint ${index + 1}`,
      lat: (item.position || {}).latitude ?? null,
      lon: (item.position || {}).longitude ?? null,
      x: item.xPos ?? item.xpos ?? item.poiXPos ?? item.x ?? null,
      y: item.yPos ?? item.ypos ?? item.poiYPos ?? item.y ?? null,
    }));
}

function buildRouteRequest(sequence, filePath, timestamp, endpoint, rawPayload, payload = {}) {
  const header = payload.header || {};
  return {
    sequence, filePath, timestamp, endpoint,
    rawPayload, payload,
    departName: payload.departName || '',
    departX: payload.departXPos ?? null,
    departY: payload.departYPos ?? null,
    destName: payload.destName || '',
    destX: payload.destXPos ?? null,
    destY: payload.destYPos ?? null,
    departLat: null, departLon: null,
    destLat: null, destLon: null,
    angle: payload.angle ?? null,
    applyEvChargingTimeOnETA: payload.applyEvChargingTimeOnETA ?? null,
    cameraTypes: payload.addCameraTypes || [],
    dangerAreaOptions: payload.dangerAreaOptions || [],
    routePlanTypes: payload.routePlanTypes || [],
    serviceFlag: payload.serviceFlag ?? null,
    searchFlag: payload.destSearchFlag ?? null,
    destSearchDetailFlag: payload.destSearchDetailFlag ?? null,
    destPoiId: payload.destPoiId ?? null,
    currentEnergy: payload.currentEnergy ?? null,
    currentRange: payload.currentRange ?? null,
    chargedEnergy: payload.chargedEnergy ?? null,
    chargedRange: payload.chargedRange ?? null,
    minSocAutoAdding: payload.minSocAtAutoAdding ?? null,
    minSocChargingStation: payload.minSocAtChargingStation ?? null,
    minSocDestination: payload.minSocAtDestination ?? null,
    autoAdding: payload.autoAddingYn ?? null,
    availableAutoAdding: payload.availableAutoAddingYn ?? null,
    auxiliaryPower: payload.auxiliaryPower ?? null,
    departDirPriority: payload.departDirPriority ?? null,
    departDirectionType: payload.departDirectionType ?? null,
    departRoadType: payload.departRoadType ?? null,
    departSrchFlag: payload.departSrchFlag ?? null,
    destEVChargerFlag: payload.destEVChargerFlag ?? null,
    destRpFlag: payload.destRpFlag ?? null,
    ecoModeFlag: payload.ecoModeFlag ?? null,
    efficientSpeed: payload.efficientSpeed ?? null,
    guideImgResolutionCode: payload.guideImgResolutionCode ?? null,
    hipassFlag: payload.hipassFlag ?? null,
    maxCharge: payload.maxCharge ?? null,
    minEnergy: payload.minEnergy ?? null,
    slopeFlag: payload.slopeFlag ?? null,
    socketType: payload.socketType || [],
    speed: payload.speed ?? null,
    tollCarType: payload.tollCarType ?? null,
    tvas: payload.tvas ?? null,
    vehicleId: payload.vehicleId ?? null,
    vehicleMass: payload.vehicleMass ?? null,
    vendor: payload.vendor ?? null,
    version: payload.version ?? null,
    waypointCount: (payload.wayPoints || []).length,
    waypoints: normalizeWaypoints(payload),
    reqTime: header.reqTime || payload.reqTime || null,
    appVersion: header.appVersion || payload.appVersion || null,
    buildNo: header.buildNo || payload.buildNo || null,
    osVersion: header.osVersion || payload.osVersion || null,
    modelNo: header.modelNo || payload.modelNo || null,
    responseCode: null,
    responseStatus: 'UNKNOWN',
    responseMessage: null,
    requestLat: null,
    requestLon: null,
    requestBearing: null,
    requestSourceType: null,
    requestLocationTime: null,
    // #RpLog specific
    rpId: null,
    rpOption: null,
    rpLabel: null,
    sessionId: null,
    responseTimeMs: null,
    responseSize: null,
  };
}

const EMPTY_VALUES = [null, '', undefined];
function isEmpty(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0) ||
    (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) ||
    v === 'UNKNOWN';
}

function applyRoutePayload(request, payload, rawPayload, endpoint) {
  const prev = { ...request };
  const enriched = buildRouteRequest(request.sequence, request.filePath, request.timestamp,
    endpoint || request.endpoint, rawPayload, payload);
  Object.assign(request, enriched);
  // Restore non-empty previous values
  for (const [key, prevVal] of Object.entries(prev)) {
    if (isEmpty(request[key]) && !isEmpty(prevVal)) request[key] = prevVal;
  }
}

function applyRecentLocationToRequest(request, loc) {
  if (!loc) return;
  request.requestLat = loc.lat;
  request.requestLon = loc.lon;
  request.requestBearing = loc.bearing;
  request.requestSourceType = loc.sourceType;
  request.requestLocationTime = loc.timestamp;
}

// ---- Route merging ------------------------------------------------------- //

const FIELD_SCORE_KEYS = [
  'departSrchFlag','searchFlag','destSearchDetailFlag','cameraTypes','angle',
  'applyEvChargingTimeOnETA','departX','departY','destX','destY',
  'minSocAutoAdding','minSocChargingStation','minSocDestination',
  'maxCharge','minEnergy','serviceFlag','tollCarType','vehicleId','vendor',
  'appVersion','buildNo','osVersion','modelNo','responseStatus',
];

function fieldScore(r) {
  return FIELD_SCORE_KEYS.filter(k => !isEmpty(r[k])).length;
}

function mergeRouteRequests(requests) {
  const merged = [];
  const sorted = [...requests].sort((a, b) => {
    const ta = a.timestamp ? a.timestamp.getTime() : Number.MAX_VALUE;
    const tb = b.timestamp ? b.timestamp.getTime() : Number.MAX_VALUE;
    return ta !== tb ? ta - tb : a.sequence - b.sequence;
  });

  for (const req of sorted) {
    const existing = merged.find(e =>
      (e.departName || '') === (req.departName || '') &&
      (e.destName || '') === (req.destName || '')
    );
    if (!existing) { merged.push({ ...req }); continue; }

    let src = req, tgt = existing;
    if (fieldScore(src) > fieldScore(tgt)) [src, tgt] = [tgt, src];

    for (const [key, val] of Object.entries(src)) {
      if (isEmpty(tgt[key]) && !isEmpty(val)) tgt[key] = val;
    }

    if (fieldScore(src) > fieldScore(tgt)) {
      for (const [key, val] of Object.entries(src)) {
        if (!isEmpty(val)) tgt[key] = val;
      }
      tgt.endpoint = src.endpoint || tgt.endpoint;
    } else if (tgt.endpoint === 'RouteRequestData' && src.endpoint !== 'RouteRequestData') {
      tgt.endpoint = src.endpoint;
    }
  }
  return merged;
}

// ---- TTS builder --------------------------------------------------------- //

function buildTtsEntry(sequence, filePath, timestamp, script, status, requestId) {
  return {
    sequence, filePath, timestamp,
    script: sanitizeText(script) || '',
    status,
    requestId,
    requestLat: null, requestLon: null,
    requestBearing: null, requestSourceType: null, requestLocationTime: null,
  };
}

// ---- Main extraction ----------------------------------------------------- //

/**
 * Extract all log data from an array of File objects.
 * Files are processed in parallel (up to CONCURRENCY at a time) for faster I/O.
 *
 * @param {File[]} files
 * @param {Function|null} progressCallback
 *   (filePath, fileIndex, fileCount, overallBytes, totalBytes, fileBytes, fileTotal)
 * @param {'all'|'gps'|'route_tts'} mode
 * @returns {Promise<{ locationLogs, mmLogs, routeRequests, ttsLogs }>}
 */
export async function extractLogs(files, progressCallback = null, mode = 'all') {
  const doGps   = mode === 'all' || mode === 'gps';
  const doRoute = mode === 'all' || mode === 'route_tts';
  const doTts   = mode === 'all' || mode === 'route_tts';

  const sortedFiles = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const totalBytes = sortedFiles.reduce((s, f) => s + f.size, 0);
  const fileCount = sortedFiles.length;

  const markerStrings = mode === 'gps' ? GPS_INTERESTING_STRINGS
    : mode === 'route_tts' ? ROUTE_TTS_INTERESTING_STRINGS
    : ALL_INTERESTING_STRINGS;
  // route 처리 시 멀티-청크 JSON 의 연속 라인(#RpLog 접두사 없는 조각)도 모두 봐야 하므로
  // 마커 필터를 비활성화한다. 약간 느려지지만 REQ JSON 누락을 방지한다.
  const interestingMarkers = doRoute ? null : encodeMarkers(markerStrings);

  // Track per-file progress for concurrent reporting
  const fileBytesDone = new Array(fileCount).fill(0);
  let lastUiTick = 0;
  function reportProgress(fileIndex, fileBytes, fileTotal) {
    fileBytesDone[fileIndex] = fileBytes;
    const now = Date.now();
    if (!progressCallback || (now - lastUiTick < 80 && fileBytes < fileTotal)) return;
    lastUiTick = now;
    const overallBytes = Math.min(fileBytesDone.reduce((s, b) => s + b, 0), totalBytes);
    progressCallback(
      sortedFiles[fileIndex].name, fileIndex + 1, fileCount,
      overallBytes, totalBytes, fileBytes, fileTotal
    );
  }

  // ---- Per-file processor ------------------------------------------------- //
  async function processFile(file, fileIndex) {
    const locationLogs = [], mmLogs = [], routeRequests = [], ttsLogs = [];
    let sequence = 0, mmSequence = 0, routeSequence = 0, ttsSequence = 0;

    let currentMmResult = null;
    let recentLocation = null;
    const ttsStatusByRequestId = {};
    const rplogMap = new Map();
    const rplogSessionLastRpId = new Map();
    // 현재 진행 중인 RpLog REQ (멀티-청크 JSON 흡수용). REQ: 라인에서 set, RES:/POST(다른 RP) 에서 clear
    let activeRpEntry = null;

    function finalizeRpLogEntry(entry) {
      if (entry.finalized) return;
      entry.finalized = true;
      // 멀티-청크 합쳐진 raw buffer 에서 newline 제거 후 JSON.parse 시도
      const { cleaned, parsed, parseError } = cleanAndParseRpReqBuffer(entry.reqBuffer);
      // 기존 정규식 기반 파셜 추출은 백업으로 유지
      const payload = extractPartialRoutePayload(cleaned);
      const rr = buildRouteRequest(routeSequence++, file.name,
        entry.timestamp, entry.endpoint || '', cleaned, payload);
      rr.rpId      = entry.rpId;
      rr.rpOption  = entry.rpOption;
      rr.rpLabel   = `RP-${entry.rpId}-${entry.rpOption}`;
      rr.sessionId = entry.sessionId || null;
      rr.responseTimeMs = entry.responseTimeMs;
      rr.responseSize   = entry.responseSize;
      // 전체 JSON 파싱 결과 + 파싱 실패시 원본 보존
      rr.payloadFull = parsed;
      rr.payloadParseError = parseError;
      rr.rawReqBuffer = cleaned;
      if (entry.responseCode != null) {
        rr.responseCode   = entry.responseCode;
        rr.responseStatus = entry.responseCode >= 200 && entry.responseCode < 300 ? 'SUCCESS' : 'FAILED';
        rr.responseMessage = entry.responseResult
          ? `[${entry.responseResult}] (${entry.responseTimeMs}ms) SessionID: ${entry.sessionId || 'N/A'}`
          : `HTTP ${entry.responseCode}`;
      }
      // 마커 위치: REQ 시점 GPS 스냅샷을 우선 사용, 없으면 최근 위치로 폴백
      const locForMarker = entry.reqLocation || recentLocation;
      applyRecentLocationToRequest(rr, locForMarker);
      // REQ 시점 정보도 함께 보존 (팝업에서 표시용)
      if (entry.reqTimestamp) rr.reqTimestamp = entry.reqTimestamp;
      if (entry.reqLocation) rr.reqLocationTime = entry.reqLocation.timestamp;
      routeRequests.push(rr);
      if (activeRpEntry === entry) activeRpEntry = null;
    }

    for await (const record of iterateDltRecords(
      file,
      (fb, ft) => reportProgress(fileIndex, fb, ft),
      interestingMarkers
    )) {
      const { text: line, timestamp } = record;

      const hasLocation = line.includes('#onLocationChanged') && line.includes('Location[');
      const hasMm = doGps && (line.includes('[MM_RESULT]') || currentMmResult != null);
      const hasRoute = doRoute && line.includes('#RpLog[');
      const hasTts = doTts && line.includes('requestTTS');

      // ---- Location ---- //
      if (hasLocation) {
        const m = LOCATION_RE.exec(line);
        if (m) {
          const sourceType = m[1];
          const lat = parseFloat(m[2]);
          const lon = parseFloat(m[3]);
          const bearing = parseFloat(m[4]);
          const etM = ET_RE.exec(line);
          const et = etM ? etM[0] : '';
          if (doGps) {
            locationLogs.push({ lon, lat, bearing, timestamp, et, sourceType, sequence });
            sequence++;
          }
          recentLocation = { lon, lat, bearing, timestamp, sourceType };
        }
      }

      // ---- Map Matching ---- //
      if (hasMm && MM_RESULT_START_RE.test(line)) {
        currentMmResult = {
          timestamp, gps: null, match: null,
          gpsSource: null, hdop: null, speed: null, state: null,
          supportDr: null, score: null, numMatchesInDr: null,
          openSkyDrMode: null, distance: null, vIndex: null, fB: null,
        };
        continue;
      }

      if (hasMm && currentMmResult != null) {
        if (!currentMmResult.timestamp) currentMmResult.timestamp = timestamp;

        const gpsM = MM_GPS_RE.exec(line);
        if (gpsM) currentMmResult.gps = [parseFloat(gpsM[2]), parseFloat(gpsM[1]), parseFloat(gpsM[3])];

        const matchM = MM_MATCH_RE.exec(line);
        if (matchM) currentMmResult.match = [parseFloat(matchM[2]), parseFloat(matchM[1]), parseFloat(matchM[3])];

        const srcM = MM_GPS_SRC_RE.exec(line);
        if (srcM) {
          currentMmResult.gpsSource = srcM[1].trim();
          currentMmResult.hdop = parseFloat(srcM[2]);
          currentMmResult.speed = parseFloat(srcM[3]);
        }

        const stateM = MM_STATE_RE.exec(line);
        if (stateM) currentMmResult.state = stateM[1].trim();

        const drM = MM_SUPPORT_DR_RE.exec(line);
        if (drM) currentMmResult.supportDr = drM[1].trim();

        const scoreM = MM_SCORE_RE.exec(line);
        if (scoreM) {
          currentMmResult.score = parseFloat(scoreM[1]);
          currentMmResult.numMatchesInDr = parseInt(scoreM[2], 10);
          currentMmResult.openSkyDrMode = parseInt(scoreM[3], 10);
        }

        const distM = MM_DIST_RE.exec(line);
        if (distM) {
          currentMmResult.distance = parseFloat(distM[1]);
          currentMmResult.vIndex = parseFloat(distM[2]);
          currentMmResult.fB = parseFloat(distM[3]);
        }

        if (currentMmResult.gps && currentMmResult.match) {
          const [gpsLon, gpsLat, gpsBearing] = currentMmResult.gps;
          const [matchLon, matchLat, matchBearing] = currentMmResult.match;
          const details = { ...currentMmResult };
          const ts = currentMmResult.timestamp;
          mmLogs.push({ lon: gpsLon, lat: gpsLat, bearing: gpsBearing, timestamp: ts, sourceType: 'mm_gps', sequence: mmSequence++, details });
          mmLogs.push({ lon: matchLon, lat: matchLat, bearing: matchBearing, timestamp: ts, sourceType: 'mm_match', sequence: mmSequence++, details });
          currentMmResult = null;
        }
      }

      // ---- Route (#RpLog) ---- //
      if (hasRoute) {
        const postM = RPLOG_POST_RE.exec(line);
        if (postM) {
          const [, sgId, label, url] = postM;
          const rpInfo = parseRpLabel(label);
          if (rpInfo) {
            rplogMap.set(`${sgId}:${rpInfo.rpId}`, {
              sgId, ...rpInfo, timestamp, endpoint: url,
              reqBuffer: '', hasReqStarted: false, finalized: false,
              responseCode: null, responseTimeMs: null, sessionId: null,
              responseResult: null, responseSize: null,
            });
          }
        } else {
          const reqM = RPLOG_REQ_RE.exec(line);
          if (reqM) {
            const [, sgId, label, body] = reqM;
            const rpInfo = parseRpLabel(label);
            if (rpInfo) {
              const key = `${sgId}:${rpInfo.rpId}`;
              let entry = rplogMap.get(key);
              if (!entry) {
                entry = {
                  sgId, ...rpInfo, timestamp, endpoint: '',
                  reqBuffer: '', hasReqStarted: false, finalized: false,
                  responseCode: null, responseTimeMs: null, sessionId: null,
                  responseResult: null, responseSize: null,
                };
                rplogMap.set(key, entry);
              }
              entry.reqBuffer = body;
              entry.hasReqStarted = true;
              entry.reqTimestamp = timestamp;
              // REQ 시점의 최신 GPS 위치를 스냅샷으로 저장 (finalize 시 응답 도착까지 시간이 흘러
              // recentLocation 이 바뀌어 있어도 REQ 시점 위치로 마커가 찍히도록)
              entry.reqLocation = recentLocation ? { ...recentLocation } : null;
              // JSON 깊이 상태 초기화 + 첫 body 청크 반영
              entry.jsonState = { depth: 0, inString: false, escape: false };
              entry.jsonState = advanceJsonDepth(body, entry.jsonState);
              entry.jsonComplete = entry.jsonState.depth === 0 && body.length > 0;
              rplogSessionLastRpId.set(sgId, rpInfo.rpId);
              // 멀티-청크 흡수용 active 포인터만 갱신 (이전 entry 는 조기 finalize 하지 않는다 —
              // 응답 라인이 새 REQ 이후에 도착할 수 있어서 sessionId/responseCode 가 유실됨).
              // 미완료 entry 들은 파일 끝에서 일괄 finalize 된다.
              activeRpEntry = entry;
            }
          } else {
            const respM = RPLOG_RESP_RE.exec(line);
            if (respM) {
              const [, sgId, label, code, ms, sessionId] = respM;
              const rpInfo = parseRpLabel(label);
              if (rpInfo) {
                const entry = rplogMap.get(`${sgId}:${rpInfo.rpId}`);
                if (entry) {
                  entry.responseCode = parseInt(code, 10);
                  entry.responseTimeMs = parseInt(ms, 10);
                  entry.sessionId = sessionId;
                }
              }
            } else {
              const resM = RPLOG_RES_RE.exec(line);
              if (resM) {
                const [, sgId, label, resultCode, resultMsg, size] = resM;
                const rpInfo = parseRpLabel(label);
                if (rpInfo) {
                  const entry = rplogMap.get(`${sgId}:${rpInfo.rpId}`);
                  if (entry) {
                    entry.responseResult = `${resultCode} ${resultMsg}`;
                    entry.responseSize = size;
                    finalizeRpLogEntry(entry);
                  }
                }
              } else {
                // Continuation: #RpLog[sgId]:data (no [RP-label] present)
                const contM = /#RpLog\[(\d+)\]:([^\[].*)/.exec(line);
                if (contM) {
                  const [, sgId, chunk] = contM;
                  const lastRpId = rplogSessionLastRpId.get(sgId);
                  if (lastRpId != null) {
                    const entry = rplogMap.get(`${sgId}:${lastRpId}`);
                    if (entry && entry.hasReqStarted && !entry.finalized && !entry.jsonComplete) {
                      entry.reqBuffer += chunk;
                      entry.jsonState = advanceJsonDepth(chunk, entry.jsonState || { depth: 0, inString: false, escape: false });
                      if (entry.jsonState.depth === 0) entry.jsonComplete = true;
                    }
                  }
                }
              }
            }
          }
        }
      }

      // ---- 접두사 없는 RpLog 연속 라인 흡수 ---- //
      // REQ JSON 이 매우 길면 DLT 가 여러 레코드로 쪼개는데, 일부 청크는
      // "#RpLog[sgId]:" 접두사 없이 message body 만 나오기도 한다.
      // 다른 알려진 로그 타입에 매칭되지 않고, active REQ 의 JSON 이 아직
      // 미완료(`jsonComplete=false`) 일 때만 그 buffer 에 이어붙인다.
      // 깊이가 0 으로 떨어지면 즉시 jsonComplete 로 마킹해 noise 흡수를 멈춘다.
      if (doRoute && activeRpEntry && !activeRpEntry.finalized && !activeRpEntry.jsonComplete
          && !hasLocation && !hasMm && !hasTts
          && !line.includes('#RpLog[')) {
        // DLT 바이너리 헤더 제거 후 페이로드만 이어붙임
        const chunk = stripDltBinaryPrefix(line);
        if (chunk) {
          activeRpEntry.reqBuffer += chunk;
          activeRpEntry.jsonState = advanceJsonDepth(chunk, activeRpEntry.jsonState || { depth: 0, inString: false, escape: false });
          if (activeRpEntry.jsonState.depth === 0) activeRpEntry.jsonComplete = true;
        }
      }

      // ---- TTS ---- //
      if (hasTts) {
        const statusM = TTS_STATUS_RE.exec(line);
        if (statusM) ttsStatusByRequestId[statusM[1]] = sanitizeText(statusM[2]);

        const scriptM = TTS_SCRIPT_RE.exec(line);
        if (scriptM) {
          const reqId = scriptM[1];
          const entry = buildTtsEntry(ttsSequence++, file.name, timestamp,
            scriptM[2], ttsStatusByRequestId[reqId] || null, reqId);
          if (recentLocation) {
            entry.requestLat = recentLocation.lat;
            entry.requestLon = recentLocation.lon;
            entry.requestBearing = recentLocation.bearing;
            entry.requestSourceType = recentLocation.sourceType;
            entry.requestLocationTime = recentLocation.timestamp;
          }
          ttsLogs.push(entry);
        }
      }
    }

      // Finalize any #RpLog entries that never received a RES line
      for (const entry of rplogMap.values()) {
        finalizeRpLogEntry(entry);
      }
      reportProgress(fileIndex, file.size, file.size);

      return { locationLogs, mmLogs, routeRequests, ttsLogs };
  } // end processFile

  // ---- Run files in parallel batches -------------------------------------- //
  const CONCURRENCY = 4;
  const allResults = [];
  for (let i = 0; i < fileCount; i += CONCURRENCY) {
    const batch = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, fileCount); j++) {
      batch.push(processFile(sortedFiles[j], j));
    }
    allResults.push(...await Promise.all(batch));
  }

  // ---- Merge results (preserve file-sort order, reassign sequences) ------- //
  const locationLogs = [], mmLogs = [], routeRequests = [], ttsLogs = [];
  let seq = 0, mmSeq = 0, routeSeq = 0, ttsSeq = 0;
  for (const r of allResults) {
    for (const p of r.locationLogs)    { p.sequence = seq++;      locationLogs.push(p); }
    for (const p of r.mmLogs)          { p.sequence = mmSeq++;    mmLogs.push(p); }
    for (const rr of r.routeRequests)  { rr.sequence = routeSeq++; routeRequests.push(rr); }
    for (const t of r.ttsLogs)         { t.sequence = ttsSeq++;   ttsLogs.push(t); }
  }

  // ---- Coordinate conversion ---- //
  const calibSamples = [];
  for (const rr of routeRequests) {
    if (rr.departLat != null && rr.departX != null && rr.departY != null)
      calibSamples.push([+rr.departX, +rr.departY, +rr.departLon, +rr.departLat]);
    if (rr.destLat != null && rr.destX != null && rr.destY != null)
      calibSamples.push([+rr.destX, +rr.destY, +rr.destLon, +rr.destLat]);
  }
  const affineTransform = fitAffineTransform(calibSamples);

  function convertCoord(x, y) {
    return skCoordToWgs84(x, y) || (affineTransform ? applyAffineTransform(affineTransform, +x, +y) : null);
  }
  function fillCoords(rr) {
    if (rr.departLat == null && rr.departX != null) {
      const c = convertCoord(rr.departX, rr.departY);
      if (c) { [rr.departLat, rr.departLon] = c; }
    }
    if (rr.destLat == null && rr.destX != null) {
      const c = convertCoord(rr.destX, rr.destY);
      if (c) { [rr.destLat, rr.destLon] = c; }
    }
    for (const wp of rr.waypoints || []) {
      if (wp.lat == null && wp.x != null) {
        const c = convertCoord(wp.x, wp.y);
        if (c) { [wp.lat, wp.lon] = c; }
      }
    }
  }
  routeRequests.forEach(fillCoords);

  return { locationLogs, mmLogs, routeRequests, ttsLogs };
}

// ---- Export helpers for display ----------------------------------------- //

export function formatTimestamp(ts) {
  if (!ts) return 'N/A';
  const p = (n, d = 2) => String(n).padStart(d, '0');
  return `${ts.getFullYear()}-${p(ts.getMonth()+1)}-${p(ts.getDate())} ` +
    `${p(ts.getHours())}:${p(ts.getMinutes())}:${p(ts.getSeconds())}` +
    (ts.getMilliseconds() ? `.${p(ts.getMilliseconds(), 3)}` : '');
}

export function preparePayloadForDisplayExport(payload) {
  return preparePayloadForDisplay(payload);
}

/**
 * DLT 레코드 텍스트 앞부분에 있는 바이너리 헤더(ECU/AppId/CtxId + control bytes)를
 * 제거하고 실제 메시지 페이로드 부분만 반환한다.
 *
 * DLT 페이로드 직전에는 보통  (EOT, End of Transmission) 또는 다른
 * control byte 시퀀스가 있다. 처음 256바이트 안의 마지막 control char (< 0x20)
 * 이후를 메시지 본문으로 간주한다.
 *
 * 헤더 패턴이 없는 라인 (이미 깨끗한 경우) 은 그대로 반환.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDltBinaryPrefix(text) {
  if (!text) return text;
  const limit = Math.min(256, text.length);
  let lastCtrl = -1;
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    // 제어 문자 (탭/개행/CR 제외) 또는 UTF-8 replacement char (�)
    if ((code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0xFFFD) {
      lastCtrl = i;
    }
  }
  return lastCtrl >= 0 ? text.slice(lastCtrl + 1) : text;
}

/**
 * 문자열에서 JSON brace/bracket 깊이를 한 글자씩 누적 계산한다.
 * 문자열 리터럴 안 (큰따옴표) + escape (`\`) 을 추적해 무시한다.
 *
 * @param {string} str  추가된 청크
 * @param {{depth:number,inString:boolean,escape:boolean}} state  이전 상태
 * @returns {{depth:number,inString:boolean,escape:boolean}}
 */
export function advanceJsonDepth(str, state) {
  let { depth, inString, escape } = state;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return { depth, inString, escape };
}

/**
 * RpLog REQ 멀티-청크 버퍼를 정리하고 JSON 파싱한다.
 *
 * - DLT 가 길어진 REQ JSON 을 여러 레코드로 쪼개기 때문에 청크 사이에는
 *   진짜 newline 이 끼어든다 (문자열 escape 가 아닌 실제 LF).
 * - 그 진짜 newline 만 제거하고, 문자열 안의 `\n` (백슬래시+n) 은 유지해야
 *   JSON 파싱 후 원본 문자열이 보존된다.
 *
 * @param {string} rawBuffer  연결된 REQ 버퍼
 * @returns {{cleaned: string, parsed: object|null, parseError: string|null}}
 */
export function cleanAndParseRpReqBuffer(rawBuffer) {
  if (!rawBuffer) return { cleaned: '', parsed: null, parseError: 'empty buffer' };
  // 실제 LF/CR 만 제거 (JSON 문자열 안의 `\\n` escape 는 백슬래시+n 이므로 영향 없음)
  const cleaned = String(rawBuffer).replace(/[\r\n]/g, '');
  try {
    const parsed = JSON.parse(cleaned);
    return { cleaned, parsed, parseError: null };
  } catch (e) {
    return { cleaned, parsed: null, parseError: e.message };
  }
}
