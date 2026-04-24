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

  // Route search info (24 bytes starting at offset 16)
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

  // Map info (224 bytes starting at offset 40)
  const coordSystem  = dv.getUint8(40);
  const tileInfoCode = dv.getUint8(41);
  // bytes 42-43: reserved

  // Departure/Destination: 8-byte compound PointInTile each
  // [UShort xTileCode, UShort yTileCode, UShort xInTile, UShort yInTile]
  const depTileX = dv.getUint16(44, true);
  const depTileY = dv.getUint16(46, true);
  const depInX   = dv.getUint16(48, true);
  const depInY   = dv.getUint16(50, true);

  const dstTileX = dv.getUint16(52, true);
  const dstTileY = dv.getUint16(54, true);
  const dstInX   = dv.getUint16(56, true);
  const dstInY   = dv.getUint16(58, true);

  const departureName = readString(dv, 60, 100, charset);
  const destName      = readString(dv, 160, 100, charset);

  const indexCount = dv.getUint16(260, true);
  // bytes 262-263: reserved

  const mapInfo = {
    coordSystem, tileInfoCode,
    departure: { tileX: depTileX, tileY: depTileY, inX: depInX, inY: depInY },
    destination: { tileX: dstTileX, tileY: dstTileY, inX: dstInX, inY: dstInY },
    departureName, destinationName: destName,
    indexCount,
  };

  // Info index data (12 bytes each, starting at offset 264)
  const infoIndices = [];
  for (let i = 0; i < indexCount; i++) {
    const base = 264 + i * 12;
    const id     = readAscii(dv, base, 4).replace(/\0+$/, '');
    const offset = dv.getInt32(base + 4, true);
    const size   = dv.getInt32(base + 8, true);
    infoIndices.push({ id, offset, size });
  }

  const headerSize = 264 + indexCount * 12;

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
    const xCode     = dv.getUint16(base, true);      // bytes 0-1: X방향 타일 Code (경도)
    const yCode     = dv.getUint16(base + 2, true);  // bytes 2-3: Y방향 타일 Code (위도)
    const lastVxIdx = dv.getUint16(base + 4, true);
    tiles.push({ xCode, yCode, lastVxIdx });
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
  const count        = dv.getUint16(offset, true);
  const timeInfoSize = dv.getInt32(offset + 8, true);
  const dataStart    = offset + 12;
  const timeInfoBase = dataStart + count * 28;   // timeInfo blob starts here

  // ---- timeInfo blob 파싱 ------------------------------------------------
  // 각 entry (timeInfoOffset 으로 참조):
  //   Byte:  slotCount
  //   Per slot (6 bytes):
  //     UShort: dayFlags  (bit0=월 bit1=화 ... bit5=토 bit6=일 bit7=공휴일)
  //     Byte: startHour, Byte: startMin, Byte: endHour, Byte: endMin
  function parseTimeSlots(blobOffset) {
    try {
      if (timeInfoSize <= 0 || blobOffset < 0) return [];
      const absBase = timeInfoBase + blobOffset;
      if (absBase < 0 || absBase >= offset + size) return [];
      const slotCount = dv.getUint8(absBase);
      if (slotCount === 0 || slotCount > 20) return [];  // 이상값 방어
      const slots = [];
      for (let s = 0; s < slotCount; s++) {
        const sb = absBase + 1 + s * 6;
        if (sb + 6 > offset + size) break;
        slots.push({
          dayFlags:  dv.getUint16(sb, true),
          startHour: dv.getUint8(sb + 2),
          startMin:  dv.getUint8(sb + 3),
          endHour:   dv.getUint8(sb + 4),
          endMin:    dv.getUint8(sb + 5),
        });
      }
      return slots;
    } catch { return []; }
  }

  const areas = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 28;
    if (base + 28 > offset + size) break;   // 범위 초과 방어
    const hasTimeInfo    = dv.getUint8(base + 8);
    const timeInfoOffset = dv.getUint16(base + 17, true);  // timeInfo blob 내 오프셋
    areas.push({
      startVxIdx:       dv.getUint16(base, true),
      endVxIdx:         dv.getUint16(base + 2, true),
      type:             dv.getUint8(base + 4),
      speedLimit:       dv.getUint8(base + 5),
      sectionLength:    dv.getUint16(base + 6, true),
      hasTimeInfo,
      variableSpeed:    dv.getUint8(base + 9),
      sectionSpeed:     dv.getUint8(base + 10),
      groupId:          dv.getInt32(base + 11, true),
      schoolZoneCamera: dv.getUint8(base + 15),
      continuousExist:  dv.getUint8(base + 16),
      timeInfoOffset,
      timeSlots:        hasTimeInfo ? parseTimeSlots(timeInfoOffset) : [],
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

export function parseLaneGuidance(dv, offset, size) {
  // Header: 20 bytes
  const count          = dv.getUint16(offset, true);
  const invalidBlobSize = dv.getInt32(offset + 8, true);
  const busBlobSize     = dv.getInt32(offset + 12, true);
  const dataStart = offset + 20;
  const blobStart = dataStart + count * 32; // 비유효차로/버스 실데이터 영역

  const lanes = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 32;
    const vxIdx          = dv.getUint16(base, true);
    const totalLanes     = dv.getUint8(base + 2);
    const leftPocket     = dv.getUint8(base + 3);
    const rightPocket    = dv.getUint8(base + 4);
    const invalidCount   = dv.getUint8(base + 5);
    const busLaneCode    = dv.getUint8(base + 7);
    const busLaneOffset  = dv.getInt32(base + 8, true);
    const recommendLane  = dv.getUint16(base + 12, true);
    const recommendAngle = dv.getUint16(base + 14, true);
    const validLane      = dv.getUint16(base + 16, true);
    const validAngle     = dv.getUint16(base + 18, true);
    const invalidOffset  = dv.getInt32(base + 20, true);
    const overpassLane   = dv.getUint16(base + 24, true);
    const underpassLane  = dv.getUint16(base + 26, true);
    const roadTypeCode   = dv.getUint8(base + 28);

    // Parse invalid lane data (비유효차로 정보)
    const invalidLanes = [];
    if (invalidCount > 0 && invalidOffset >= 0) {
      const ivBase = blobStart + invalidOffset;
      for (let j = 0; j < invalidCount; j++) {
        const ivOff = ivBase + j * 4;
        if (ivOff + 4 <= offset + size) {
          invalidLanes.push({
            // TVAS v5.9 비유효차로 쌍 (4B × N):
            //   +0 (Byte[2] = UShort LE)  레인정보: 차로 비트맵
            //                              (bit n = 1 → (n+1)차로가 해당 방향으로 invalid)
            //   +2 (UShort LE)            각도정보: 0/45/90/135/180/225/270/315
            lane:  dv.getUint16(ivOff, true),
            angle: dv.getUint16(ivOff + 2, true),
          });
        }
      }
    }

    lanes.push({
      vxIdx, totalLanes, leftPocket, rightPocket, invalidCount, busLaneCode,
      recommendLane, recommendAngle, validLane, validAngle,
      overpassLane, underpassLane, roadTypeCode, invalidLanes,
    });
  }
  return lanes;
}

// Lane angle → direction name
const LANE_ANGLE_NAMES = {
  0: '직진', 45: '우측', 90: '우회전', 135: '우하측',
  180: '유턴', 225: '좌하측', 270: '좌회전', 315: '좌측',
};

// Lane angle → arrow symbol
const LANE_ANGLE_ARROWS = {
  0: '↑', 45: '↗', 90: '→', 135: '↘',
  180: '↓', 225: '↙', 270: '←', 315: '↖',
};

export { LANE_ANGLE_NAMES, LANE_ANGLE_ARROWS };

function parseEvChargers(dv, offset, size, charset) {
  // ES3 header: 28 bytes
  const count       = dv.getUint16(offset, true);
  const nameSize    = dv.getInt32(offset + 8, true);
  const typeNameSize = dv.getInt32(offset + 12, true);
  const opNameSize  = dv.getInt32(offset + 16, true);
  const dataStart = offset + 28;
  const chargers = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 44;
    if (base + 44 > offset + size) break;
    const vxIdx      = dv.getUint16(base, true);
    const poiId      = dv.getInt32(base + 2, true);
    const roadType   = dv.getUint8(base + 6);
    const locX       = dv.getInt32(base + 7, true);
    const locY       = dv.getInt32(base + 11, true);
    const nameOffset = dv.getInt32(base + 15, true);
    const onRoute    = dv.getUint8(base + 19);
    const dcCha      = dv.getUint8(base + 20);
    const ac3        = dv.getUint8(base + 21);
    const dcCombo    = dv.getUint8(base + 22);
    const slow       = dv.getUint8(base + 23);
    const tesla      = dv.getUint8(base + 24);
    const stationType = dv.getUint8(base + 25);
    const mustCharge  = dv.getUint8(base + 26);
    const isSelf     = dv.getUint8(base + 27);
    const fastType   = dv.getUint8(base + 28);
    const typeNameOff = dv.getInt32(base + 29, true);
    const totalChargers = dv.getUint8(base + 33);
    const availChargers = dv.getUint8(base + 34);
    const chargeSpeed   = dv.getUint8(base + 35);
    const opCount    = dv.getUint8(base + 36);
    const chargeTime = dv.getUint16(base + 37, true);
    const chargePower = dv.getUint16(base + 39, true);
    const arrivalSoc  = dv.getUint8(base + 41);
    const expectedSoc = dv.getUint8(base + 42);
    const manualStation = dv.getUint8(base + 43);

    // Read name from blob
    const blobStart = dataStart + count * 44;
    let name = '';
    if (nameOffset >= 0 && blobStart + nameOffset < offset + size) {
      name = readString(dv, blobStart + nameOffset, Math.min(200, offset + size - blobStart - nameOffset), charset);
    }

    chargers.push({
      vxIdx, poiId, roadType, locX, locY, name, onRoute,
      dcCha, ac3, dcCombo, slow, tesla, stationType, mustCharge, isSelf, fastType,
      totalChargers, availChargers, chargeSpeed, opCount,
      chargeTime, chargePower, arrivalSoc, expectedSoc, manualStation,
    });
  }
  return chargers;
}

function parseTrafficInfo(dv, offset, size) {
  // LT2: TSD링크교통정보
  const count = dv.getUint16(offset, true);
  const dataStart = offset + 8;
  const items = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 8;
    if (base + 8 > offset + size) break;
    items.push({
      startVxIdx: dv.getUint16(base, true),
      endVxIdx:   dv.getUint16(base + 2, true),
      speed:      dv.getUint8(base + 4),
      congestion: dv.getUint8(base + 5),
    });
  }
  return items;
}

function parseWaypoints(dv, offset, size, charset) {
  // WP2: 경유지 지점정보
  const count = dv.getUint16(offset, true);
  const dataStart = offset + 8;
  const items = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 16;
    if (base + 16 > offset + size) break;
    items.push({
      vxIdx: dv.getUint16(base, true),
      type:  dv.getUint8(base + 2),
      x:     dv.getInt32(base + 4, true),
      y:     dv.getInt32(base + 8, true),
      poiId: dv.getInt32(base + 12, true),
    });
  }
  return items;
}

function parseRpLinks(dv, offset, size, charset) {
  // RD5: RPLINK 정보 — 헤더 40byte + 데이터 24byte×n + 톨게이트ID blob
  const count = dv.getUint16(offset, true);          // +0  UShort 2  RpLink 개수
  const infoType = dv.getUint8(offset + 2);           // +2  Byte 1   정보인덱스 type
  // offset+3: reserved 1byte
  const infoId = readAscii(dv, offset + 4, 4);        // +4  Char 4   정보인덱스 ID
  const initDistance = dv.getInt32(offset + 8, true);  // +8  Int 4    초기탐색 직선거리
  const sessionId = readAscii(dv, offset + 12, 24);   // +12 Char 24  초기탐색 SessionID
  const tollBlobSize = dv.getInt32(offset + 36, true); // +36 Int 4    톨게이트ID 데이터 전체 크기

  const dataStart = offset + 40;
  const items = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 24;
    if (base + 24 > offset + size) break;
    items.push({
      startVxIdx:   dv.getUint16(base, true),      // +0  UShort 2  시작 보간점 Idx
      endVxIdx:     dv.getUint16(base + 2, true),   // +2  UShort 2  마지막 보간점 Idx
      rid:          dv.getInt32(base + 4, true),     // +4  Int 4     RID
      ridTime:      dv.getInt32(base + 8, true),     // +8  Int 4     RID 소요시간(sec)
      meshCode:     dv.getUint16(base + 12, true),   // +12 UShort 2  Mesh Code
      linkId:       dv.getInt32(base + 14, true),    // +14 Int 4     링크ID
      direction:    dv.getUint8(base + 18),           // +18 Byte 1    방향 (0:정, 1:역)
      compareTarget:dv.getUint8(base + 19),           // +19 Byte 1    경로비교대상
      superCruise:  dv.getUint8(base + 20),           // +20 Byte 1    Super Cruise
      // +21~23: reserved 3bytes
    });
  }

  // 톨게이트ID blob 파싱
  let tollgateIds = '';
  if (tollBlobSize > 0) {
    const tollStart = dataStart + count * 24;
    if (tollStart + tollBlobSize <= offset + size) {
      tollgateIds = readString(dv, tollStart, tollBlobSize, charset);
    }
  }

  return {
    header: { count, infoType, infoId, initDistance, sessionId, tollBlobSize },
    items,
    tollgateIds
  };
}

function parseCongestion(dv, offset, size) {
  // TC: 정체구간정보
  const count = dv.getUint16(offset, true);
  const dataStart = offset + 8;
  const items = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 20;
    if (base + 20 > offset + size) break;
    items.push({
      startVxIdx: dv.getUint16(base, true),
      endVxIdx:   dv.getUint16(base + 2, true),
      distance:   dv.getUint16(base + 4, true),
      time:       dv.getUint16(base + 6, true),
    });
  }
  return items;
}

function parseIncidents(dv, offset, size, charset) {
  // UA: 돌발정보
  const count    = dv.getUint16(offset, true);
  const blobSize = dv.getInt32(offset + 8, true);
  const dataStart = offset + 12;
  const blobStart = dataStart + count * 8;
  const items = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 8;
    if (base + 8 > offset + size) break;
    const startVxIdx = dv.getUint16(base, true);
    const contentOff = dv.getUint16(base + 2, true);
    const typeCode   = String.fromCharCode(dv.getUint8(base + 4));
    let content = '';
    if (blobStart + contentOff < offset + size) {
      content = readString(dv, blobStart + contentOff, Math.min(200, offset + size - blobStart - contentOff), charset);
    }
    items.push({ startVxIdx, typeCode, content });
  }
  return items;
}

export function parseRouteSummary(dv, offset, size, charset) {
  // RS7 header: 48 bytes
  const count           = dv.getUint16(offset, true);       // +0  UShort 2  경로요약 정보 개수(n)
  const infoType        = dv.getUint8(offset + 2);           // +2  Byte 1   정보 인덱스 type
  const dataType        = dv.getUint8(offset + 3);           // +3  Byte 1   경로요약 데이터 제공 타입
  const infoId          = readAscii(dv, offset + 4, 4);      // +4  Char 4   정보 인덱스 ID
  const trafficTime     = readAscii(dv, offset + 8, 12);     // +8  Char 12  교통정보제공시간
  const tollFare10      = dv.getUint16(offset + 20, true);   // +20 UShort 2 톨게이트 요금(단위:10원)
  // offset+22: reserved 1byte
  const predictType     = dv.getUint8(offset + 23);          // +23 Byte 1   예측구분코드
  const predictTime     = readAscii(dv, offset + 24, 12);    // +24 Char 12  예측시간정보
  const nameBlobSize    = dv.getInt32(offset + 36, true);     // +36 Int 4    경로요약 명칭 데이터 전체 크기
  const roadNameBlobSize= dv.getInt32(offset + 40, true);     // +40 Int 4    주요 도로 명칭 데이터 전체 크기
  const roadAttr        = dv.getUint8(offset + 44);           // +44 Byte 1   경로내 도로 속성
  const roadNameCount   = dv.getUint16(offset + 45, true);    // +45 UShort 2 주요 도로 명칭 데이터 개수
  const ecoSaving       = dv.getUint8(offset + 47);           // +47 Byte 1   Eco 에너지 저감 값(%)
  // 헤더 합계: 2+1+1+4+12+2+1+1+12+4+4+1+2+1 = 48 bytes

  // 배치: 헤더(48) → 경로요약DATA(32×n) → 주요도로DATA(16×m) → 경로요약명칭blob → 주요도로명칭blob
  const dataStart = offset + 48;
  const roadDataStart = dataStart + count * 32;                        // 주요도로 DATA
  const nameBlobStart = roadDataStart + roadNameCount * 16;            // 경로요약 명칭 blob
  const roadNameBlobStart = nameBlobStart + nameBlobSize;              // 주요도로 명칭 blob

  // 경로요약 DATA: 32byte × count — 먼저 전체 읽기 (TVAS v5.9 p.45)
  //  +0  Byte    구분 (1=Link, 2=Node)
  //  +1  Byte    통제구분코드
  //  +2  2B      reserved
  //  +4  Int     명칭 Offset
  //  +8  Int     구간거리(m)
  //  +12 Int     구간시간(초)
  //  +16 Byte    속도
  //  +17 Char    혼잡도
  //  +18 UShort  시작 보간점
  //  +20 UShort  끝 보간점
  //  +22 Byte    세도로 포함 여부
  //  +23 Byte    회전코드
  //  +24 Int     에너지(W)
  //  +28 Byte    수동충전소
  //  +29 3B      reserved
  const items = [];
  const nameOffsets = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 32;
    if (base + 32 > offset + size) break;
    nameOffsets.push(dv.getInt32(base + 4, true));
    items.push({
      linkNodeType: dv.getUint8(base),
      controlCode:  dv.getUint8(base + 1),
      nameOffset: nameOffsets[i],
      name: '',
      distance:    dv.getInt32(base + 8, true),
      time:        dv.getInt32(base + 12, true),
      speed:       dv.getUint8(base + 16),
      congestion:  String.fromCharCode(dv.getUint8(base + 17)),
      startVxIdx:  dv.getUint16(base + 18, true),
      endVxIdx:    dv.getUint16(base + 20, true),
      narrowRoad:  dv.getUint8(base + 22),
      turnCode:    dv.getUint8(base + 23),
      energy:      dv.getInt32(base + 24, true),
      manualStation: dv.getUint8(base + 28),
    });
  }

  // 명칭 blob에서 이름 읽기: 현재 offset ~ 다음 offset 까지
  for (let i = 0; i < items.length; i++) {
    const curOff = nameOffsets[i];
    const nextOff = (i + 1 < nameOffsets.length) ? nameOffsets[i + 1] : nameBlobSize;
    const namePos = nameBlobStart + curOff;
    const nameLen = nextOff - curOff;
    if (curOff >= 0 && nameLen > 0 && namePos >= 0 && namePos + nameLen <= offset + size) {
      try { items[i].name = readString(dv, namePos, nameLen, charset); } catch(e) { /* skip */ }
    }
  }

  // 주요도로 명칭 DATA: 16byte × roadNameCount
  const roadNames = [];
  for (let i = 0; i < roadNameCount; i++) {
    const base = roadDataStart + i * 16;
    if (base + 16 > offset + size) break;
    const rStartVxIdx   = dv.getUint16(base, true);          // +0  UShort 2 시작 보간점 Idx
    const rEndVxIdx     = dv.getUint16(base + 2, true);       // +2  UShort 2 마지막 보간점 Idx
    const rNameOffset   = dv.getInt32(base + 4, true);         // +4  Int 4    주요도로명칭 데이터 Offset
    // +8~15: reserved 8bytes

    let roadName = '';
    const rnPos = roadNameBlobStart + rNameOffset;
    const rnLen = offset + size - rnPos;
    if (rNameOffset >= 0 && roadNameBlobStart < offset + size && rnPos < offset + size && rnLen > 0) {
      try { roadName = readString(dv, rnPos, Math.min(200, rnLen), charset); } catch(e) { /* skip */ }
    }
    roadNames.push({ startVxIdx: rStartVxIdx, endVxIdx: rEndVxIdx, name: roadName });
  }

  return {
    count, infoId, dataType, trafficTime, tollFare: tollFare10 * 10, predictType, predictTime,
    nameBlobSize, roadNameBlobSize, ecoSaving, roadAttr, roadNameCount, roadNames, items,
  };
}

function parseTruckRestriction(dv, offset, size, type) {
  // WHR/HTR/WTR: 화물차 제한구간
  const count = dv.getUint16(offset, true);
  const dataStart = offset + 8;
  const items = [];
  for (let i = 0; i < count; i++) {
    const base = dataStart + i * 12;
    if (base + 12 > offset + size) break;
    items.push({
      startVxIdx: dv.getUint16(base, true),
      endVxIdx:   dv.getUint16(base + 2, true),
      overFlag:   dv.getUint8(base + 4),
      limit:      type === 'WTR' ? dv.getInt32(base + 5, true) : dv.getUint16(base + 5, true),
    });
  }
  return items;
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
    laneGuidance: null,
    evChargers: null,
    trafficInfo: null,
    waypoints: null,
    rpLinks: null,
    congestion: null,
    incidents: null,
    routeSummary: null,
    truckWidth: null,
    truckHeight: null,
    truckWeight: null,
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
      case 'TL5':
        result.laneGuidance = parseLaneGuidance(dv, absOffset, idx.size);
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
      case 'ES3': case 'ES2':
        result.evChargers = parseEvChargers(dv, absOffset, idx.size, charset);
        break;
      case 'LT2':
        result.trafficInfo = parseTrafficInfo(dv, absOffset, idx.size);
        break;
      case 'WP2':
        result.waypoints = parseWaypoints(dv, absOffset, idx.size, charset);
        break;
      case 'RD5':
        result.rpLinks = parseRpLinks(dv, absOffset, idx.size, charset);
        break;
      case 'TC':
        result.congestion = parseCongestion(dv, absOffset, idx.size);
        break;
      case 'UA':
        result.incidents = parseIncidents(dv, absOffset, idx.size, charset);
        break;
      case 'RS7':
        result.routeSummary = parseRouteSummary(dv, absOffset, idx.size, charset);
        break;
      case 'WHR':
        result.truckWidth = parseTruckRestriction(dv, absOffset, idx.size, 'WHR');
        break;
      case 'HTR':
        result.truckHeight = parseTruckRestriction(dv, absOffset, idx.size, 'HTR');
        break;
      case 'WTR':
        result.truckWeight = parseTruckRestriction(dv, absOffset, idx.size, 'WTR');
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
/**
 * Convert compound PointInTile {tileX, tileY, inX, inY} to WGS84.
 */
export function resolvePointInTile(pit, tileInfoCode) {
  const tile = { xCode: pit.tileX, yCode: pit.tileY };
  const sk = tileToSkCoord(tile, pit.inX, pit.inY, tileInfoCode);
  const besselLon = sk.skX / 360000.0;
  const besselLat = sk.skY / 360000.0;
  if (besselLon < 120 || besselLon > 135 || besselLat < 30 || besselLat > 45) {
    return null;
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
  0: '고속국도', 1: '도시고속', 2: '국도', 3: '국가지원지방도',
  4: '지방도', 5: '주요도로1(6.5차로)', 6: '주요도로2(4.3차로)', 7: '주요도로3(2차로)',
  8: '기타도로1(1차로)', 9: '이면도로', 10: '페리항로', 11: '단지내도로',
  12: '단지내도로2', 16: '일반도로', 20: '번화가링크',
  21: '보행자도로1', 22: '보행자도로2', 23: '보행자도로3', 24: '보행자도로4',
  30: '자전거도로', 31: '자전거도로+인도', 32: '인도', 33: '시설물내인도',
};

const LINK_TYPE_NAMES = {
  0: '미조사', 1: '본선(비분리)', 2: '본선(분리)', 3: '연결로(JC)',
  4: '교차점내링크', 5: '연결로(IC)', 6: 'P-Turn', 7: 'SA링크',
  8: '로터리', 9: '유턴링크', 10: 'P턴링크', 12: '졸음쉼터',
  13: '회전교차로', 14: '교차로내링크',
};

const FACILITY_CODE_NAMES = {
  0: '일반도로', 1: '교량', 2: '터널', 3: '고가도로', 4: '지하도로',
  5: '교차로통과', 6: '철도건널목', 7: '댐/방파제',
  11: '일반보행자도로', 12: '육교', 13: '토끼굴', 14: '지하보도',
  15: '횡단보도', 16: '대형시설물이동통로', 17: '계단', 18: '지하철지하보도',
  19: '경사로', 20: '계단+경사로', 21: '엘리베이터', 22: '대형시설물이동통로',
  90: '한강교량',
};

const GUIDANCE_CODE_NAMES = {
  1: '도곽에 의한 점', 2: '타일에 의한 점', 3: '고속도로 안내없음',
  4: '일반도로 안내없음', 5: '특수 안내없음', 6: 'Y자 오른쪽 안내없음', 7: 'Y자 왼쪽 안내없음',
  11: '직진', 12: '좌회전', 13: '우회전', 14: 'U턴', 15: 'P턴',
  16: '8시방향 좌회전', 17: '10시방향 좌회전', 18: '2시방향 우회전', 19: '4시방향 우회전',
  21: '좌측차로 감소', 22: '좌측차로 증가', 23: '우측차로 감소', 24: '우측차로 증가',
  43: '오른쪽', 44: '왼쪽', 51: '직진방향', 52: '왼쪽차선', 53: '오른쪽차선',
  54: '1차선', 55: '2차선', 56: '3차선', 57: '4차선', 58: '5차선',
  59: '6차선', 60: '7차선', 61: '8차선', 62: '9차선', 63: '10차선',
  65: '녹색차선', 66: '분홍색차선', 67: '파란색차선', 68: '노란색차선',
  69: '왼쪽길', 70: '오른쪽길',
  71: '첫번째 출구', 72: '두번째 출구',
  73: '첫번째 오른쪽길', 74: '두번째 오른쪽길', 75: '첫번째 왼쪽길', 76: '두번째 왼쪽길',
  77: '왼쪽 출구', 78: '오른쪽 출구',
  85: '왼쪽1번출구', 86: '왼쪽2번출구', 87: '왼쪽3번출구', 88: '왼쪽4번출구',
  89: '오른쪽1번출구', 90: '오른쪽2번출구', 91: '오른쪽3번출구', 92: '오른쪽4번출구',
  93: '왼쪽1차선', 94: '왼쪽2차선', 95: '왼쪽3차선', 96: '왼쪽4차선',
  97: '오른쪽1차선', 98: '오른쪽2차선', 99: '오른쪽3차선', 100: '오른쪽4차선',
  101: '우측 고속도로 입구', 102: '좌측 고속도로 입구', 103: '직진 고속도로 입구',
  104: '우측 고속도로 출구', 105: '좌측 고속도로 출구', 106: '직진 고속도로 출구',
  111: '우측 도시고속 입구', 112: '좌측 도시고속 입구', 113: '직진 도시고속 입구',
  114: '우측 도시고속 출구', 115: '좌측 도시고속 출구', 116: '직진 도시고속 출구',
  117: '오른쪽 도로', 118: '왼쪽 도로',
  119: '지하도로', 120: '고가도로', 121: '터널', 122: '교량', 123: '지하도로 옆', 124: '고가도로 옆',
  131: '1시방향', 132: '2시방향', 133: '3시방향', 134: '4시방향',
  135: '5시방향', 136: '6시방향', 137: '7시방향', 138: '8시방향',
  139: '9시방향', 140: '10시방향', 141: '11시방향', 142: '12시방향',
  150: '졸음쉼터', 151: '휴게소', 152: '졸음쉼터2', 160: '전기차 추천충전소',
  170: 'Ferry 진입', 171: 'Ferry 진출',
  200: '출발지', 201: '목적지', 203: '목적지 건너편', 204: '톨게이트',
  211: '횡단보도', 212: '좌측 횡단보도', 213: '우측 횡단보도',
  214: '8시 횡단보도', 215: '10시 횡단보도', 216: '2시 횡단보도', 217: '4시 횡단보도',
  218: '엘리베이터', 233: '직진(임시)',
};

const DANGER_TYPE_NAMES = {
  0: '없음',
  1: '고정식 과속위험', 2: '이동식 과속위험', 3: '사고다발지역',
  4: '급커브구간', 5: '안개지역', 6: '신호과속단속',
  7: '버스전용차로', 8: '갓길운행금지', 9: '낙석위험',
  10: '교통수집구간', 11: '구간단속-시점', 12: '구간단속-종점',
  13: '끼어들기단속', 14: '신호단속', 15: '철도건널목',
  16: '어린이보호구역-시점', 17: '어린이보호구역-종점',
  18: '야생동물출몰', 19: '과속방지턱', 20: '주차단속',
  21: '고정식과속(박스형)', 22: '사고다발(보행자)', 23: '결빙주의',
  24: '노후경유차단속', 25: '터널내차로변경단속',
  26: '가변구간단속-시점', 27: '가변구간단속-종점', 28: '기상청결빙',
  29: '어린이보호구역시점', 30: '어린이보호구역종점',
  31: '장애인보호구역시점', 32: '장애인보호구역종점',
  33: '노인보호구역시점', 34: '노인보호구역종점',
  35: '마을주민보호시점', 36: '마을주민보호종점',
  37: '후면과속단속', 38: '후면신호과속단속',
  39: '화물차높이제한', 40: '화물차중량제한', 41: '화물차폭제한',
  42: '기상청안내점', 43: 'C-ITS설치점', 44: '홍수예보',
  45: '댐방류', 46: '보행자우선구역시작', 47: '보행자우선구역종료',
};

export {
  ROUTE_OPTION_NAMES, ROAD_TYPE_NAMES, LINK_TYPE_NAMES,
  FACILITY_CODE_NAMES, GUIDANCE_CODE_NAMES, DANGER_TYPE_NAMES,
};
