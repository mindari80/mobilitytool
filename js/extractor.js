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

const ROUTE_ENDPOINT_RE_SRC = '(https://[^\\s\\x00]+/(?:rsd/(?:ev/)?route(?:/[^\\s\\x00]+)?|route(?:/[^\\s\\x00]+)?))';
const ROUTE_POST_RE = new RegExp('okhttp\\.OkHttpClient\\[\\d+\\]:--> POST ' + ROUTE_ENDPOINT_RE_SRC);
const ROUTE_RESP_RE = new RegExp('okhttp\\.OkHttpClient\\[\\d+\\]:<-- (\\d{3}) ' + ROUTE_ENDPOINT_RE_SRC);
const ROUTE_RESP_FAILED_RE = /okhttp\.OkHttpClient\[\d+\]:<-- HTTP FAILED: (.+)/;
const ROUTE_REQ_LOG_RE = /#RpLog\[\d+\]:\[[^\]]+\]\s+REQ:\s+(\{.*)/;
const ROUTE_SUCCESS_RE = /okhttpclient\[\d+\]:(EV route success.*)/i;
const ROUTE_FAILED_RE = /okhttpclient\[\d+\]:(EV route fail(?:ed)?.*)/i;
const ROUTE_REQUEST_DATA_RE = /RouteRequestData\(departure=RoutePoiData\(position=Wgs84\(latitude=([0-9.\-]+), longitude=([0-9.\-]+)\).*?name=([^,]+).*?destination=RoutePoiData\(position=Wgs84\(latitude=([0-9.\-]+), longitude=([0-9.\-]+)\).*?name=([^,]+)/;
const TTS_STATUS_RE = /TmapAutoExternalVoicePlayer:requestTTS\[(\d+)\]:requestTTS status : ([^\x00\r\n]+)/;
const TTS_SCRIPT_RE = /TmapAutoExternalVoicePlayer:requestTTS\[(\d+)\]:requestTTS script : ([^\x00\r\n]+)/;
const OKHTTP_MSG_RE = /okhttp\.OkHttpClient\[\d+\]:(.*)/;

const INTERESTING_STRINGS = [
  '#onLocationChanged',
  '[MM_RESULT]',
  'RouteRequestData(',
  '#RpLog[',
  'okhttp.OkHttpClient',
  'okhttpclient[',
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

function extractOkhttpMessage(line) {
  const m = OKHTTP_MSG_RE.exec(line);
  if (!m) return null;
  return m[1].split('\x00')[0];
}

function extractDltContinuationChunk(line) {
  const okhttp = extractOkhttpMessage(line);
  if (okhttp != null) return okhttp;

  const prefix = line.split('\x00DLT')[0];
  const segments = prefix.split('\x00').filter(s => s.length > 0);
  if (!segments.length) return null;

  const candidate = segments[segments.length - 1];
  let printable = 0;
  for (const c of candidate) {
    const code = c.charCodeAt(0);
    if (c === '\n' || c === '\r' || c === '\t' || (code >= 32 && code <= 126) || code >= 160) {
      printable++;
    }
  }
  if (printable / Math.max(candidate.length, 1) < 0.6) return null;
  return candidate;
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
  if (waypointM) payload.wayPoints = [...waypointM[1].matchAll(/\{/g)].map(() => ({}));

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
      name: item.name || item.poiName || `Waypoint ${index + 1}`,
      lat: (item.position || {}).latitude ?? null,
      lon: (item.position || {}).longitude ?? null,
      x: item.xPos ?? item.xpos ?? item.poiXPos ?? null,
      y: item.yPos ?? item.ypos ?? item.poiYPos ?? null,
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
 *
 * @param {File[]} files
 * @param {Function|null} progressCallback
 *   (filePath, fileIndex, fileCount, overallBytes, totalBytes, fileBytes, fileTotal)
 * @returns {Promise<{ locationLogs, mmLogs, routeRequests, ttsLogs }>}
 */
export async function extractLogs(files, progressCallback = null) {
  const locationLogs = [];  // { lon, lat, bearing, timestamp, et, sourceType, sequence }
  const mmLogs = [];        // { lon, lat, bearing, timestamp, sourceType, sequence, details }
  const routeRequests = [];
  const ttsLogs = [];

  let sequence = 0, mmSequence = 0, routeSequence = 0, ttsSequence = 0;

  const sortedFiles = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const totalBytes = sortedFiles.reduce((s, f) => s + f.size, 0);
  let processedBytesBeforeFile = 0;

  const interestingMarkers = encodeMarkers(INTERESTING_STRINGS);

  for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
    const file = sortedFiles[fileIndex];
    const fileSize = file.size;

    const onFileProgress = (fileProcessed, fileTotal) => {
      if (progressCallback) {
        progressCallback(
          file.name, fileIndex + 1, sortedFiles.length,
          processedBytesBeforeFile + fileProcessed, totalBytes,
          fileProcessed, fileTotal
        );
      }
    };

    let currentMmResult = null;
    let recentRouteRequestData = null;
    let pendingRoutePost = null;
    let pendingRouteReqLog = null;
    let pendingRouteResp = null;   // accumulator for split <-- NNN response lines
    const unmatchedRouteIndices = [];
    let recentLocation = null;
    const ttsStatusByRequestId = {};

    for await (const record of iterateDltRecords(file, onFileProgress, interestingMarkers)) {
      const { text: line, timestamp } = record;

      const hasLocation = line.includes('#onLocationChanged') && line.includes('Location[');
      const hasMm = line.includes('[MM_RESULT]') || currentMmResult != null;
      const hasRoute = (
        line.includes('RouteRequestData(') || line.includes('#RpLog[') ||
        line.includes('okhttp.OkHttpClient') || line.includes('okhttpclient[') ||
        pendingRoutePost != null || pendingRouteReqLog != null || pendingRouteResp != null
      );
      const hasTts = line.includes('requestTTS');

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
          locationLogs.push({ lon, lat, bearing, timestamp, et, sourceType, sequence });
          recentLocation = { lon, lat, bearing, timestamp, sourceType };
          sequence++;
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

      // ---- RouteRequestData ---- //
      if (hasRoute) {
        const rdM = ROUTE_REQUEST_DATA_RE.exec(line);
        if (rdM) {
          recentRouteRequestData = {
            timestamp,
            departName: rdM[3].trim(),
            departLat: parseFloat(rdM[1]),
            departLon: parseFloat(rdM[2]),
            destName: rdM[6].trim(),
            destLat: parseFloat(rdM[4]),
            destLon: parseFloat(rdM[5]),
            filePath: file.name,
          };
          const rr = buildRouteRequest(routeSequence, file.name, timestamp, 'RouteRequestData', line);
          rr.departName = recentRouteRequestData.departName;
          rr.destName = recentRouteRequestData.destName;
          rr.departLat = recentRouteRequestData.departLat;
          rr.departLon = recentRouteRequestData.departLon;
          rr.destLat = recentRouteRequestData.destLat;
          rr.destLon = recentRouteRequestData.destLon;
          applyRecentLocationToRequest(rr, recentLocation);
          routeRequests.push(rr);
          unmatchedRouteIndices.push(routeRequests.length - 1);
          routeSequence++;
        }

        // Partial payload from line
        if (
          line.includes('destSearchDetailFlag') || line.includes('destSearchFlag') ||
          line.includes('departXPos') || line.includes('destXPos') || line.includes('departSrchFlag')
        ) {
          const partial = extractPartialRoutePayload(line);
          if (partial && Object.keys(partial).length > 0) {
            let target = null;
            if (pendingRouteReqLog?.targetRequest) {
              target = pendingRouteReqLog.targetRequest;
            } else {
              for (let i = routeRequests.length - 1; i >= 0; i--) {
                if (routeRequests[i].filePath === file.name) { target = routeRequests[i]; break; }
              }
            }
            if (target) applyRoutePayload(target, partial, line, target.endpoint);
          }
        }

        // POST detection
        const postM = ROUTE_POST_RE.exec(line);
        if (postM) {
          pendingRoutePost = { timestamp, endpoint: postM[1], buffer: '' };
          continue;
        }
      }

      // Accumulate POST body (use extractDltContinuationChunk to also catch
      // continuation records that lack the okhttp.OkHttpClient prefix)
      if (pendingRoutePost) {
        const msg = extractDltContinuationChunk(line);
        if (msg) pendingRoutePost.buffer += msg;

        if (pendingRoutePost.buffer.includes('}')) {
          const jsonText = extractFirstJsonObject(pendingRoutePost.buffer);
          if (jsonText) {
            let routePayload = null;
            try { routePayload = JSON.parse(jsonText); } catch { /* ignore */ }

            if (routePayload && 'departXPos' in routePayload && 'destXPos' in routePayload) {
              const rr = buildRouteRequest(routeSequence, file.name,
                pendingRoutePost.timestamp || timestamp, pendingRoutePost.endpoint, jsonText, routePayload);

              if (recentRouteRequestData &&
                recentRouteRequestData.departName === rr.departName &&
                recentRouteRequestData.destName === rr.destName) {
                rr.departLat = recentRouteRequestData.departLat;
                rr.departLon = recentRouteRequestData.departLon;
                rr.destLat = recentRouteRequestData.destLat;
                rr.destLon = recentRouteRequestData.destLon;
              }
              applyRecentLocationToRequest(rr, recentLocation);
              routeRequests.push(rr);
              unmatchedRouteIndices.push(routeRequests.length - 1);
              routeSequence++;
              pendingRoutePost = null;
              continue;
            }
          }
        }
        if (line.includes('--> END POST')) pendingRoutePost = null;
      }

      // RpLog
      if (hasRoute) {
        const rpM = ROUTE_REQ_LOG_RE.exec(line);
        if (rpM) {
          const partial = extractPartialRoutePayload(rpM[1]);
          let target = null;
          if (partial && Object.keys(partial).length > 0) {
            for (let i = routeRequests.length - 1; i >= 0; i--) {
              const rr = routeRequests[i];
              if (rr.filePath !== file.name) continue;
              const sameDepart = !rr.departName || rr.departName === (partial.departName || '');
              const sameDest = !rr.destName || rr.destName === (partial.destName || '');
              if (sameDepart && sameDest) { target = rr; break; }
            }
            if (!target) {
              target = buildRouteRequest(routeSequence, file.name, timestamp, 'RpLogRequest', rpM[1], partial);
              applyRecentLocationToRequest(target, recentLocation);
              routeRequests.push(target);
              unmatchedRouteIndices.push(routeRequests.length - 1);
              routeSequence++;
            } else {
              applyRoutePayload(target, partial, rpM[1], target.endpoint);
              if (!target.requestLat) applyRecentLocationToRequest(target, recentLocation);
            }
          }
          pendingRouteReqLog = { timestamp, buffer: rpM[1], targetRequest: target };
        } else if (pendingRouteReqLog) {
          const chunk = extractDltContinuationChunk(line);
          if (chunk) {
            pendingRouteReqLog.buffer += chunk;
            if (pendingRouteReqLog.buffer.includes('}')) {
              const partial = extractPartialRoutePayload(pendingRouteReqLog.buffer);
              if (partial && pendingRouteReqLog.targetRequest) {
                applyRoutePayload(pendingRouteReqLog.targetRequest, partial, pendingRouteReqLog.buffer, pendingRouteReqLog.targetRequest.endpoint);
                if (!pendingRouteReqLog.targetRequest.requestLat)
                  applyRecentLocationToRequest(pendingRouteReqLog.targetRequest, recentLocation);
              }
            }
          }
        }

        if (pendingRouteReqLog && pendingRouteReqLog.buffer.includes('}')) {
          const jsonText = extractFirstJsonObject(pendingRouteReqLog.buffer);
          if (jsonText) {
            let routePayload = null;
            try { routePayload = JSON.parse(jsonText); } catch { /* ignore */ }
            if (routePayload && 'departXPos' in routePayload && 'destXPos' in routePayload) {
              let target = null;
              for (let i = routeRequests.length - 1; i >= 0; i--) {
                const rr = routeRequests[i];
                if (rr.filePath !== file.name) continue;
                const sd = !rr.departName || rr.departName === (routePayload.departName || '');
                const dd = !rr.destName || rr.destName === (routePayload.destName || '');
                if (sd && dd) { target = rr; break; }
              }
              if (!target) {
                target = buildRouteRequest(routeSequence, file.name,
                  pendingRouteReqLog.timestamp || timestamp, 'RpLogRequest', jsonText, routePayload);
                applyRecentLocationToRequest(target, recentLocation);
                routeRequests.push(target);
                unmatchedRouteIndices.push(routeRequests.length - 1);
                routeSequence++;
              } else {
                applyRoutePayload(target, routePayload, jsonText, target.endpoint);
                if (!target.requestLat) applyRecentLocationToRequest(target, recentLocation);
              }
              pendingRouteReqLog = null;
            }
          }
        }

        // Response codes
        const respM = ROUTE_RESP_RE.exec(line);
        if (respM) {
          // Full response line matched in a single record
          assignResponseCode(routeRequests, unmatchedRouteIndices,
            parseInt(respM[1], 10), respM[2]);
          pendingRouteResp = null;
        } else if (pendingRouteResp != null) {
          // Accumulate continuation of a split response line
          const chunk = extractDltContinuationChunk(line);
          if (chunk) pendingRouteResp.buffer += chunk;

          const accM = ROUTE_RESP_RE.exec(pendingRouteResp.buffer);
          if (accM) {
            assignResponseCode(routeRequests, unmatchedRouteIndices,
              parseInt(accM[1], 10), accM[2]);
            pendingRouteResp = null;
          } else if (pendingRouteResp.buffer.length > 512) {
            // Buffer overflow — extract status code only and fall back
            const codeM = /<--\s*(\d{3})/.exec(pendingRouteResp.buffer);
            if (codeM) {
              assignResponseCode(routeRequests, unmatchedRouteIndices,
                parseInt(codeM[1], 10), null);
            }
            pendingRouteResp = null;
          }
        } else if (line.includes('<--') &&
                   (line.includes('okhttp.OkHttpClient') || line.includes('okhttpclient['))) {
          // Response line might be split — start buffering if we see a status code
          const msg = extractOkhttpMessage(line);
          if (msg && /<--\s*\d{3}/.test(msg)) {
            pendingRouteResp = { buffer: msg };
          }
        }

        const failedM = ROUTE_RESP_FAILED_RE.exec(line);
        if (failedM && unmatchedRouteIndices.length > 0) {
          const rr = routeRequests[unmatchedRouteIndices[unmatchedRouteIndices.length - 1]];
          if (rr.responseCode == null) {
            rr.responseStatus = 'FAILED';
            rr.responseMessage = failedM[1].trim();
          }
        }

        const successM = ROUTE_SUCCESS_RE.exec(line);
        if (successM && unmatchedRouteIndices.length > 0) {
          const rr = routeRequests[unmatchedRouteIndices[unmatchedRouteIndices.length - 1]];
          if (rr.responseStatus === 'UNKNOWN' || rr.responseStatus == null) {
            rr.responseStatus = 'SUCCESS';
            rr.responseMessage = successM[1].trim();
          }
        }

        const routeFailM = ROUTE_FAILED_RE.exec(line);
        if (routeFailM && unmatchedRouteIndices.length > 0) {
          const rr = routeRequests[unmatchedRouteIndices[unmatchedRouteIndices.length - 1]];
          if (rr.responseCode == null) {
            rr.responseStatus = 'FAILED';
            rr.responseMessage = routeFailM[1].trim();
          }
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

    processedBytesBeforeFile += fileSize;
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
  const merged = mergeRouteRequests(routeRequests);
  merged.forEach(fillCoords);

  return {
    locationLogs,
    mmLogs,
    routeRequests: merged,
    ttsLogs,
  };
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
