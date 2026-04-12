/**
 * TVAS v5.9 binary format parser.
 * Pure data module — no DOM or Leaflet dependencies.
 *
 * Reference: TVAS(v5.9) 포맷 TMAP용 20250103
 * Byte order: Little-endian throughout.
 */

'use strict';

import { besselToWgs84 } from './coordinate.js';

// ---- Low-level helpers ---------------------------------------------------- //

function readString(dv, offset, length, charset) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + offset, length);
  const nullIdx = bytes.indexOf(0);
  const slice = nullIdx >= 0 ? bytes.slice(0, nullIdx) : bytes;
  const decoder = new TextDecoder(charset === 0 ? 'euc-kr' : 'utf-8');
  return decoder.decode(slice);
}

function readAscii(dv, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = dv.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ---- Header parsing ------------------------------------------------------- //

function parseHeader(dv) {
  const totalSize      = dv.getUint32(0, true);
  const versionByte    = dv.getUint8(4);
  const version        = `${(versionByte >> 4) & 0xF}.${versionByte & 0xF}`;
  const reserved1      = dv.getUint8(5);
  const language       = dv.getUint8(6);
  const charset        = dv.getUint8(7);
  const mapVersion     = readAscii(dv, 8, 8);

  // Route search info (28 bytes starting at offset 16)
  const routeSearch = {
    optionCode:       dv.getUint8(16),
    tollWeightOption: dv.getUint8(17),
    departureDayType: dv.getUint8(18),
    nextDayType:      dv.getUint8(19),
    totalDistance:     dv.getInt32(20, true),
    totalTime:        dv.getInt32(24, true),
    taxiFare:         dv.getInt32(28, true),
    controlCode:      dv.getUint8(32),
    routeType:        dv.getUint8(33),
    altBranchPoint:   dv.getUint16(34, true),
    destPositionInfo: dv.getUint8(36),
    routeChangeFlag:  dv.getUint8(37),
    evReachableFlag:  dv.getUint8(38),
  };

  // Map info (224 bytes starting at offset 44)
  const coordSystem  = dv.getUint8(44);
  const tileInfoCode = dv.getUint8(45);

  const departureX = dv.getInt32(48, true);
  const departureY = dv.getInt32(52, true);
  const destX      = dv.getInt32(56, true);
  const destY      = dv.getInt32(60, true);

  const departureName = readString(dv, 64, 100, charset);
  const destName      = readString(dv, 164, 100, charset);

  const indexCount = dv.getUint16(264, true);

  const mapInfo = {
    coordSystem, tileInfoCode,
    departure: { x: departureX, y: departureY },
    destination: { x: destX, y: destY },
    departureName, destinationName: destName,
    indexCount,
  };

  // Info index data (12 bytes each, starting at offset 268)
  const infoIndices = [];
  for (let i = 0; i < indexCount; i++) {
    const base = 268 + i * 12;
    const id     = readAscii(dv, base, 4).replace(/\0+$/, '');
    const offset = dv.getInt32(base + 4, true);
    const size   = dv.getInt32(base + 8, true);
    infoIndices.push({ id, offset, size });
  }

  const headerSize = 268 + indexCount * 12;

  return {
    totalSize, version, language, charset, mapVersion,
    routeSearch, mapInfo, infoIndices, headerSize,
  };
}

// ---- Section parsers ------------------------------------------------------ //

function parseTiles(dv, offset, size) {
  // Header: 8 bytes
  const count = dv.getUint16(offset, true);
  const tiles = [];
  const dataStart = offset + 8;
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 8;
    const tileCode  = dv.getInt32(base, true);
    const xCode     = (tileCode >> 16) & 0xFFFF;
    const yCode     = tileCode & 0xFFFF;
    const lastVxIdx = dv.getUint16(base + 4, true);
    tiles.push({ xCode, yCode, lastVxIdx, tileCode });
  }
  return tiles;
}

function parseVertices(dv, offset, size) {
  const count = dv.getUint16(offset, true);
  const vertices = [];
  const dataStart = offset + 8;
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 8;
    vertices.push({
      xInTile:    dv.getUint16(base, true),
      yInTile:    dv.getUint16(base + 2, true),
      distToNext: dv.getUint16(base + 4, true),
      timeToNext: dv.getUint16(base + 6, true),
    });
  }
  return vertices;
}

function parseRoads(dv, offset, size) {
  const count = dv.getUint16(offset, true);
  const roads = [];
  const dataStart = offset + 8;
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 20;
    roads.push({
      lastVxIdx:         dv.getUint16(base, true),
      linkType:          dv.getUint8(base + 2),
      roadType:          dv.getUint8(base + 3),
      facilityCode:      dv.getUint8(base + 4),
      elevation:         dv.getUint8(base + 5),
      roadLength:        dv.getUint16(base + 6, true),
      laneCount:         dv.getUint8(base + 8),
      speedLimit:        dv.getUint8(base + 9),
      energyConsumption: dv.getInt16(base + 10, true),
    });
  }
  return roads;
}

function parseGuidancePoints(dv, offset, size) {
  const count = dv.getUint16(offset, true);
  const points = [];
  const dataStart = offset + 8;
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 4;
    points.push({
      vxIndex:            dv.getUint16(base, true),
      guidanceCode:       dv.getUint8(base + 2),
      continuousTurnCode: dv.getUint8(base + 3),
    });
  }
  return points;
}

function parseDangerAreas(dv, offset, size) {
  // Header: 12 bytes (UShort count, Byte type, Byte reserved, Char[4] id, Int timeInfoSize)
  const count = dv.getUint16(offset, true);
  const areas = [];
  const dataStart = offset + 12;
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 28;
    areas.push({
      startVxIdx:       dv.getUint16(base, true),
      endVxIdx:         dv.getUint16(base + 2, true),
      type:             dv.getUint8(base + 4),
      speedLimit:       dv.getUint8(base + 5),
      sectionLength:    dv.getUint16(base + 6, true),
      hasTimeInfo:      dv.getUint8(base + 8),
      variableSpeed:    dv.getUint8(base + 9),
      sectionSpeed:     dv.getUint8(base + 10),
      groupId:          dv.getInt32(base + 11, true),
      schoolZoneCamera: dv.getUint8(base + 15),
      continuousExist:  dv.getUint8(base + 16),
    });
  }
  return areas;
}

function parseRoadNames(dv, offset, size, charset) {
  // Header: 12 bytes (UShort count, Byte type, Byte reserved, Char[4] id, Int blobSize)
  const count    = dv.getUint16(offset, true);
  const blobSize = dv.getInt32(offset + 8, true);
  const dataStart = offset + 12;
  const blobStart = dataStart + count * 8;
  const names = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 8;
    const lastVxIdx  = dv.getUint16(base, true);
    const nameOffset = dv.getUint16(base + 2, true);
    const display    = dv.getUint8(base + 4);
    // Read name from blob
    let name = '';
    if (blobStart + nameOffset < offset + size) {
      name = readString(dv, blobStart + nameOffset, Math.min(200, offset + size - blobStart - nameOffset), charset);
    }
    names.push({ lastVxIdx, name, display });
  }
  return names;
}

function parseDirectionNames(dv, offset, size, charset) {
  const count    = dv.getUint16(offset, true);
  const blobSize = dv.getInt32(offset + 8, true);
  const dataStart = offset + 12;
  const blobStart = dataStart + count * 8;
  const names = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 8;
    const lastVxIdx  = dv.getUint16(base, true);
    const typeCode   = dv.getUint8(base + 3);
    const nameOffset = dv.getInt32(base + 4, true);
    let name = '';
    if (blobStart + nameOffset < offset + size) {
      name = readString(dv, blobStart + nameOffset, Math.min(400, offset + size - blobStart - nameOffset), charset);
    }
    names.push({ lastVxIdx, typeCode, name });
  }
  return names;
}

function parseIntersectionNames(dv, offset, size, charset) {
  const count    = dv.getUint16(offset, true);
  const blobSize = dv.getInt32(offset + 8, true);
  const dataStart = offset + 12;
  const blobStart = dataStart + count * 4;
  const names = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 4;
    const lastVxIdx  = dv.getUint16(base, true);
    const nameOffset = dv.getUint16(base + 2, true);
    let name = '';
    if (blobStart + nameOffset < offset + size) {
      name = readString(dv, blobStart + nameOffset, Math.min(200, offset + size - blobStart - nameOffset), charset);
    }
    names.push({ lastVxIdx, name });
  }
  return names;
}

function parseTollGates(dv, offset, size, charset) {
  const count    = dv.getUint16(offset, true);
  const blobSize = dv.getInt32(offset + 8, true);
  const dataStart = offset + 12;
  const tollGates = [];
  // Each record: 24 bytes
  const blobStart = dataStart + count * 24;
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 24;
    const vxIdx      = dv.getUint16(base, true);
    const nameOffset = dv.getUint16(base + 2, true);
    const fare       = dv.getInt32(base + 4, true);
    const guideType  = dv.getUint8(base + 8);
    const hipassOnly = dv.getUint8(base + 9);
    const avgSpeed   = dv.getUint8(base + 10);
    const congestion = String.fromCharCode(dv.getUint8(base + 11));
    const dist100m   = dv.getUint16(base + 12, true);
    const time10s    = dv.getUint16(base + 14, true);
    const tgId       = dv.getUint16(base + 16, true);
    let name = '';
    if (blobStart + nameOffset < offset + size) {
      name = readString(dv, blobStart + nameOffset, Math.min(200, offset + size - blobStart - nameOffset), charset);
    }
    tollGates.push({ vxIdx, name, fare, guideType, hipassOnly, avgSpeed, congestion, dist100m, time10s, tgId });
  }
  return tollGates;
}

function parseRestAreas(dv, offset, size, charset) {
  const count    = dv.getUint16(offset, true);
  const blobSize = dv.getInt32(offset + 8, true);
  const dataStart = offset + 12;
  const blobStart = dataStart + count * 24;
  const restAreas = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 24;
    const entryVxIdx = dv.getUint16(base, true);
    const exitVxIdx  = dv.getUint16(base + 2, true);
    const gasBrand   = dv.getUint8(base + 4);
    const evBrand    = dv.getUint8(base + 5);
    const info       = dv.getUint16(base + 6, true);
    const nameOffset = dv.getInt32(base + 8, true);
    const poiId      = dv.getInt32(base + 12, true);
    let name = '';
    if (blobStart + nameOffset < offset + size) {
      name = readString(dv, blobStart + nameOffset, Math.min(200, offset + size - blobStart - nameOffset), charset);
    }
    restAreas.push({ entryVxIdx, exitVxIdx, gasBrand, evBrand, info, name, poiId });
  }
  return restAreas;
}

function parseForcedReroute(dv, offset, size) {
  const count = dv.getUint16(offset, true);
  const dataStart = offset + 8;
  const points = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 16;
    points.push({
      vxIdx:     dv.getUint16(base, true),
      type:      dv.getUint8(base + 2),
      distance:  dv.getInt16(base + 3, true),
      rid:       dv.getInt32(base + 5, true),
    });
  }
  return points;
}

function parseHighwayMode(dv, offset, size) {
  const count = dv.getUint16(offset, true);
  const dataStart = offset + 8;
  const segments = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 4;
    segments.push({
      startVxIdx: dv.getUint16(base, true),
      endVxIdx:   dv.getUint16(base + 2, true),
    });
  }
  return segments;
}

function parseCityBoundary(dv, offset, size, charset) {
  const count = dv.getUint16(offset, true);
  const dataStart = offset + 8;
  const boundaries = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 8;
    boundaries.push({
      vxIdx:     dv.getUint16(base, true),
      cityCode:  dv.getUint16(base + 2, true),
    });
  }
  return boundaries;
}

// ---- Main parser ---------------------------------------------------------- //

export function parseTvas(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const header = parseHeader(dv);
  const { headerSize, charset, mapInfo } = header;

  const result = {
    header,
    tiles: [],
    vertices: [],
    roads: [],
    guidancePoints: [],
    dangerAreas: [],
    roadNames: null,
    directionNames: null,
    intersectionNames: null,
    tollGates: null,
    restAreas: null,
    forcedReroute: null,
    highwayMode: null,
    cityBoundary: null,
  };

  // Parse each section using info indices
  for (const idx of header.infoIndices) {
    const absOffset = headerSize + idx.offset;
    if (absOffset + idx.size > dv.byteLength) continue;

    switch (idx.id) {
      case 'TI':
        result.tiles = parseTiles(dv, absOffset, idx.size);
        break;
      case 'VX':
        result.vertices = parseVertices(dv, absOffset, idx.size);
        break;
      case 'RO4':
        result.roads = parseRoads(dv, absOffset, idx.size);
        break;
      case 'GP':
        result.guidancePoints = parseGuidancePoints(dv, absOffset, idx.size);
        break;
      case 'DA5':
        result.dangerAreas = parseDangerAreas(dv, absOffset, idx.size);
        break;
      case 'RN2':
        result.roadNames = parseRoadNames(dv, absOffset, idx.size, charset);
        break;
      case 'DN5':
        result.directionNames = parseDirectionNames(dv, absOffset, idx.size, charset);
        break;
      case 'CN':
        result.intersectionNames = parseIntersectionNames(dv, absOffset, idx.size, charset);
        break;
      case 'TG4':
        result.tollGates = parseTollGates(dv, absOffset, idx.size, charset);
        break;
      case 'SA3':
        result.restAreas = parseRestAreas(dv, absOffset, idx.size, charset);
        break;
      case 'DRG3':
        result.forcedReroute = parseForcedReroute(dv, absOffset, idx.size);
        break;
      case 'HW':
        result.highwayMode = parseHighwayMode(dv, absOffset, idx.size);
        break;
      case 'CB':
        result.cityBoundary = parseCityBoundary(dv, absOffset, idx.size, charset);
        break;
    }
  }

  return result;
}

// ---- Coordinate resolution ------------------------------------------------ //

/**
 * Convert tile-relative vertex coordinates to WGS84.
 * Uses the tile mesh code to compute SK normalized coordinates,
 * then Bessel-to-WGS84 datum shift.
 */
export function resolveVertexCoordinates(tvasResult) {
  const { tiles, vertices, header } = tvasResult;
  const tileInfoCode = header.mapInfo.tileInfoCode;
  const coords = [];

  if (tiles.length === 0 || vertices.length === 0) return coords;

  // Build tile ownership map: for each vertex, which tile does it belong to?
  let tileIdx = 0;
  for (let i = 0; i < vertices.length; i++) {
    // Advance tile index when we've passed the current tile's last vertex
    while (tileIdx < tiles.length - 1 && i > tiles[tileIdx].lastVxIdx) {
      tileIdx++;
    }
    const tile = tiles[tileIdx];
    const vx = vertices[i];

    const sk = tileToSkCoord(tile, vx.xInTile, vx.yInTile, tileInfoCode);
    const besselLon = sk.skX / 360000.0;
    const besselLat = sk.skY / 360000.0;
    const [lat, lon] = besselToWgs84(besselLon, besselLat);

    coords.push({
      lat, lon,
      skX: sk.skX, skY: sk.skY,
      distToNext: vx.distToNext,
      timeToNext: vx.timeToNext,
    });
  }

  return coords;
}

/**
 * Convert PointInTile header coordinates to WGS84.
 */
export function resolvePointInTile(pit, tileInfoCode) {
  // PointInTile: bytes 0-1 = xTileCode, 2-3 = yTileCode packed in lower bytes
  // Actually stored as full int with tile code embedded:
  // For header departure/destination, the format is:
  // [xTileCode(2B)|yTileCode(2B)] in upper/lower halves
  // and [xInTile(2B)|yInTile(2B)] in the second int
  // But spec says 4 bytes for X coord, 4 bytes for Y coord as PointInTile
  // PointInTile: Tile code + coordinate in tile (link format)
  // Actually: SK정규화좌표 (8-digit integer format, 0.01 second precision)
  // skX = raw value, skY = raw value
  // Then Bessel degree = SK/360000

  // The header stores departure/destination as SK normalized 8-digit coordinates
  const besselLon = pit.x / 360000.0;
  const besselLat = pit.y / 360000.0;
  if (besselLon < 120 || besselLon > 135 || besselLat < 30 || besselLat > 45) {
    return null; // Invalid Korean coordinate
  }
  return besselToWgs84(besselLon, besselLat);
}

function tileToSkCoord(tile, xInTile, yInTile, tileInfoCode) {
  // Default tile type 0x02: 위도 1/12도, 경도 1/8도, (0~2047 or extended)
  const mesh = tile.xCode * 100 + tile.yCode;
  const a = Math.floor(mesh / 1000);
  const b = Math.floor((mesh - a * 1000) / 100);
  const c = Math.floor((mesh % 100) / 10);
  const d = mesh % 10;

  const dminX = a + 122.0 + (c - 1) * 7.5 / 60.0;
  const dminY = (99.0 + (b - 1) * 2.0) / 3.0 + ((d - 1) * 7.5 / 60.0) * 2.0 / 3.0;

  const skX = Math.floor(dminX * 360000 + xInTile);
  const skY = Math.floor(dminY * 360000 + yInTile);

  return { skX, skY };
}

// ---- Code table lookups --------------------------------------------------- //

const ROUTE_OPTION_NAMES = {
  0: '교통+추천경로', 1: '교통+무료우선', 2: '교통+최소시간',
  3: '교통+초보운전', 4: '교통+고속도로 우선', 10: '최단경로',
  12: '교통+일반도로 우선',
};

const ROAD_TYPE_NAMES = {
  0: '고속도로', 1: '도시고속', 2: '일반국도', 3: '지방도',
  4: '주요도로1', 5: '주요도로2', 6: '주요도로3', 7: '기타도로1',
  8: '기타도로2', 9: '페리항로',
};

const LINK_TYPE_NAMES = {
  0: '일반', 1: '터널', 2: '교량', 3: '지하도로', 4: '고가도로',
  5: '분리구간', 6: '측도', 7: '단지내도로', 8: '기타',
};

const FACILITY_CODE_NAMES = {
  0: '없음', 1: '교량', 2: '터널', 3: '고가도로', 4: '지하차도',
  5: '나들목', 6: '분기점', 7: '휴게소', 8: '톨게이트',
};

const GUIDANCE_CODE_NAMES = {
  0: '직진', 1: '좌회전', 2: '우회전', 3: 'U턴',
  4: 'P턴', 5: '8시방향 좌회전', 6: '10시방향 좌회전',
  7: '2시방향 우회전', 8: '4시방향 우회전',
  12: '왼쪽 고속도로 진입', 14: '오른쪽 고속도로 진입',
  16: '좌측 출구', 17: '우측 출구', 18: '좌측 2개 출구',
  19: '우측 2개 출구', 20: '직진(톨게이트)', 21: '좌회전(톨게이트)',
  22: '우회전(톨게이트)',
  26: '목적지', 27: '경유지1', 28: '경유지2', 29: '경유지3',
  30: '경유지4', 31: '경유지5',
  33: '페리항로 시작', 34: '페리항로 종료',
  36: '회전교차로 직진', 37: '회전교차로 좌회전', 38: '회전교차로 우회전',
  39: '회전교차로 U턴',
  43: '좌측 합류', 44: '우측 합류', 45: '본선 합류',
  71: '출발지', 72: '방면안내(고속)', 73: '방면안내(일반)',
};

const DANGER_TYPE_NAMES = {
  1: '고정식 카메라', 2: '고정식 카메라', 3: '고정식 카메라(끼어들기)',
  4: '고정식 카메라(신호위반)', 5: '이동식 카메라', 6: '이동식 카메라(신호)',
  7: '버스전용차로', 8: '과적단속', 9: '주정차단속',
  10: '구간단속', 11: '구간단속(끝)', 12: '끼어들기 단속',
  13: '교통정보 수집', 14: '어린이보호구역', 15: '사고다발지역',
  16: '급커브구간', 17: '안개다발지역', 18: '철도건널목',
  19: '낙석주의구간', 20: '노면상태불량', 21: '급경사지역',
  22: '결빙주의구간', 23: '과속방지턱', 24: '추락주의구간',
  30: '가변 구간단속', 40: '교통약자보호구역', 41: '후면카메라',
  42: '화물차 높이제한', 43: '화물차 중량제한', 44: '화물차 폭제한',
  50: 'C-ITS 설치점', 51: '기상청 안내구간', 52: '홍수예보',
  53: '댐방류', 54: '보행자 우선도로 시점', 55: '보행자 우선도로 종점',
};

export {
  ROUTE_OPTION_NAMES, ROAD_TYPE_NAMES, LINK_TYPE_NAMES,
  FACILITY_CODE_NAMES, GUIDANCE_CODE_NAMES, DANGER_TYPE_NAMES,
};
