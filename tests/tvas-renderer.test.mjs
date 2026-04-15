import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRouteArrowSpecs,
  buildLanePopup,
  buildDirectionNameLabels,
  buildRoadNameLabels,
  buildIntersectionNameLabels,
  buildRangeSegments,
  buildCongestionLabels,
} from '../DltLogViewer/js/tvas-renderer.js';

// ---- buildRouteArrowSpecs ------------------------------------------------- //
//
// Pure helper that, given VX coords and the parsed routeSummary.items array,
// produces per-segment arrow specs (latlngs + color) for PolylineDecorator.
// Color is derived from the TVAS congestion code on each item:
//   '4' → #ef4444 (정체 red)
//   '2' → #f97316 (서행 orange)
//   '1' → #22c55e (원활 green)
//   '0' → #38bdf8 (정보없음 sky)
// Unknown codes fall back to sky blue.
//
// Return shape: [{ latlngs: [[lat, lon], ...], color: '#RRGGBB' }, ...]

const RED = '#ef4444';
const ORANGE = '#f97316';
const GREEN = '#22c55e';
const SKY = '#38bdf8';

test('buildRouteArrowSpecs_with_no_items_returns_single_sky_fallback', () => {
  const coords = [
    { lat: 37.5, lon: 127.0 },
    { lat: 37.6, lon: 127.1 },
    { lat: 37.7, lon: 127.2 },
  ];
  const specs = buildRouteArrowSpecs(coords, []);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].color, SKY);
  assert.equal(specs[0].latlngs.length, 3);
  assert.deepEqual(specs[0].latlngs[0], [37.5, 127.0]);
  assert.deepEqual(specs[0].latlngs[2], [37.7, 127.2]);
});

test('buildRouteArrowSpecs_colors_congestion_level_정체_red', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
  ];
  const items = [{ startVxIdx: 0, endVxIdx: 1, congestion: '4' }];
  const specs = buildRouteArrowSpecs(coords, items);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].color, RED);
});

test('buildRouteArrowSpecs_colors_congestion_level_서행_orange', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  const items = [{ startVxIdx: 0, endVxIdx: 1, congestion: '2' }];
  assert.equal(buildRouteArrowSpecs(coords, items)[0].color, ORANGE);
});

test('buildRouteArrowSpecs_colors_congestion_level_원활_green', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  const items = [{ startVxIdx: 0, endVxIdx: 1, congestion: '1' }];
  assert.equal(buildRouteArrowSpecs(coords, items)[0].color, GREEN);
});

test('buildRouteArrowSpecs_colors_congestion_level_정보없음_sky', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  const items = [{ startVxIdx: 0, endVxIdx: 1, congestion: '0' }];
  assert.equal(buildRouteArrowSpecs(coords, items)[0].color, SKY);
});

test('buildRouteArrowSpecs_unknown_congestion_falls_back_to_sky', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  const items = [{ startVxIdx: 0, endVxIdx: 1, congestion: '9' }];
  assert.equal(buildRouteArrowSpecs(coords, items)[0].color, SKY);
});

test('buildRouteArrowSpecs_skips_zero_length_segments', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
    { lat: 37.3, lon: 127.3 },
  ];
  const items = [
    { startVxIdx: 0, endVxIdx: 2, congestion: '1' },  // valid, 3 points
    { startVxIdx: 3, endVxIdx: 2, congestion: '2' },  // reversed → skip
    { startVxIdx: 3, endVxIdx: 3, congestion: '4' },  // single point → skip
  ];
  const specs = buildRouteArrowSpecs(coords, items);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].color, GREEN);
  assert.equal(specs[0].latlngs.length, 3);
});

test('buildRouteArrowSpecs_clamps_endVxIdx_beyond_coords_length', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  const items = [{ startVxIdx: 0, endVxIdx: 99, congestion: '1' }];
  const specs = buildRouteArrowSpecs(coords, items);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].latlngs.length, 2);
  assert.deepEqual(specs[0].latlngs[1], [37.1, 127.1]);
});

test('buildRouteArrowSpecs_preserves_input_order_for_direction_arrows', () => {
  // Direction-sensitive: reversing coords must reverse the latlngs output.
  // This is the invariant that makes the arrow point from origin → destination.
  const forward  = [{ lat: 37.0, lon: 127.0 }, { lat: 37.5, lon: 127.5 }];
  const backward = [{ lat: 37.5, lon: 127.5 }, { lat: 37.0, lon: 127.0 }];
  const fSpec = buildRouteArrowSpecs(forward, []);
  const bSpec = buildRouteArrowSpecs(backward, []);
  assert.deepEqual(fSpec[0].latlngs, [[37.0, 127.0], [37.5, 127.5]]);
  assert.deepEqual(bSpec[0].latlngs, [[37.5, 127.5], [37.0, 127.0]]);
});

test('buildRouteArrowSpecs_multiple_items_produce_colored_segments', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
    { lat: 37.3, lon: 127.3 },
  ];
  const items = [
    { startVxIdx: 0, endVxIdx: 1, congestion: '1' },  // 원활
    { startVxIdx: 1, endVxIdx: 2, congestion: '2' },  // 서행
    { startVxIdx: 2, endVxIdx: 3, congestion: '4' },  // 정체
  ];
  const specs = buildRouteArrowSpecs(coords, items);
  assert.equal(specs.length, 3);
  assert.equal(specs[0].color, GREEN);
  assert.equal(specs[1].color, ORANGE);
  assert.equal(specs[2].color, RED);
});

// ---- buildLanePopup ------------------------------------------------------- //
//
// 차로안내 마커 팝업. 테이블이 가로로 차로(1,2,3,...), 세로로 속성
// (권장/유효/비유효/속성) 으로 배치된 전치 레이아웃.
// 반환값은 HTML 문자열 — assert로 구조적 내용 검증.

function baseLane(overrides = {}) {
  return {
    vxIdx: 10, totalLanes: 3, leftPocket: 0, rightPocket: 0, invalidCount: 0,
    busLaneCode: 0,
    recommendLane: 0b010, recommendAngle: 0,   // 2차로, 직진
    validLane:     0b111, validAngle: 0,       // 전 차로, 직진
    overpassLane: 0, underpassLane: 0, roadTypeCode: 2,
    invalidLanes: [],
    ...overrides,
  };
}
const coord = { lat: 37.5, lon: 127.0 };

// Extract the <td> cells from the row whose row-label <th> matches `label`.
function cellsOfAttrRow(html, label) {
  const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
  const rowRe = new RegExp(`<tr[^>]*>\\s*<th[^>]*>\\s*${label}\\s*<\\/th>([\\s\\S]*?)<\\/tr>`);
  const m = rowRe.exec(table);
  if (!m) return null;
  return [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1]);
}

test('buildLanePopup_header_row_lists_lane_numbers', () => {
  const html = buildLanePopup(baseLane(), coord);
  const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
  // Header row contains lane numbers 1, 2, 3 as <th>
  assert.ok(/<th[^>]*>\s*1\s*<\/th>/.test(table), 'header should have lane 1');
  assert.ok(/<th[^>]*>\s*2\s*<\/th>/.test(table), 'header should have lane 2');
  assert.ok(/<th[^>]*>\s*3\s*<\/th>/.test(table), 'header should have lane 3');
});

test('buildLanePopup_has_four_attribute_rows_labeled_권장_유효_비유효_속성', () => {
  const html = buildLanePopup(baseLane(), coord);
  for (const label of ['권장', '유효', '비유효', '속성']) {
    const cells = cellsOfAttrRow(html, label);
    assert.ok(cells, `row labeled "${label}" must exist`);
    assert.equal(cells.length, 3, `"${label}" row must have one cell per lane (3)`);
  }
});

test('buildLanePopup_has_no_separate_legacy_sections_below_table', () => {
  const tl = baseLane({
    invalidCount: 1,
    invalidLanes: [{ lane: 0b001, angle: 270 }],
  });
  const html = buildLanePopup(tl, coord);
  assert.equal((html.match(/<table/g) || []).length, 1, 'exactly one <table>');
  assert.ok(!/비유효차로\s*\(/.test(html), '"비유효차로 (N건)" legacy section must be removed');
  assert.ok(!/고가진입차로:/.test(html),  '"고가진입차로:" legacy section must be removed');
  assert.ok(!/지하진입차로:/.test(html),  '"지하진입차로:" legacy section must be removed');
});

test('buildLanePopup_invalid_direction_appears_in_correct_lane_column', () => {
  // 1차로만 좌회전 invalid
  const tl = baseLane({
    invalidCount: 1,
    invalidLanes: [{ lane: 0b001, angle: 270 }],
  });
  const html = buildLanePopup(tl, coord);
  const inv = cellsOfAttrRow(html, '비유효');
  assert.ok(inv[0].includes('좌회전'), 'Lane 1 cell in 비유효 row should include 좌회전');
  assert.ok(!inv[1].includes('좌회전'), 'Lane 2 cell should NOT include 좌회전');
  assert.ok(!inv[2].includes('좌회전'), 'Lane 3 cell should NOT include 좌회전');
});

test('buildLanePopup_multiple_invalid_directions_on_same_lane_all_shown', () => {
  // 2차로에 두 방향(270 + 90)이 invalid
  const tl = baseLane({
    invalidCount: 2,
    invalidLanes: [
      { lane: 0b010, angle: 270 },
      { lane: 0b010, angle: 90 },
    ],
  });
  const html = buildLanePopup(tl, coord);
  const inv = cellsOfAttrRow(html, '비유효');
  assert.ok(inv[1].includes('좌회전'), 'Lane 2 cell should include 좌회전');
  assert.ok(inv[1].includes('우회전'), 'Lane 2 cell should include 우회전');
});

test('buildLanePopup_attributes_row_lists_overpass_underpass_and_pockets', () => {
  const tl = baseLane({
    leftPocket: 1,                // 1차로 좌포켓
    overpassLane: 0b010,          // 2차로 고가
    underpassLane: 0b100,         // 3차로 지하
  });
  const html = buildLanePopup(tl, coord);
  const attrs = cellsOfAttrRow(html, '속성');
  assert.ok(attrs[0].includes('좌포켓'), 'Lane 1 속성 cell should include 좌포켓');
  assert.ok(attrs[1].includes('고가'),   'Lane 2 속성 cell should include 고가');
  assert.ok(attrs[2].includes('지하'),   'Lane 3 속성 cell should include 지하');
});

test('buildLanePopup_recommend_row_marks_only_the_recommend_lane', () => {
  // baseLane: recommend = 0b010 (2차로만)
  const html = buildLanePopup(baseLane(), coord);
  const rec = cellsOfAttrRow(html, '권장');
  assert.ok(!rec[0].includes('직진'), 'Lane 1 should not be marked as recommended');
  assert.ok(rec[1].includes('직진'),  'Lane 2 should be marked as recommended');
  assert.ok(!rec[2].includes('직진'), 'Lane 3 should not be marked as recommended');
});

// ---- buildDirectionNameLabels ------------------------------------------- //
//
// 지도에 표시할 "방면 명칭" 라벨 위치 계산. directionNames (DN5) 각 항목은
// `{lastVxIdx, typeCode, name}` 형태. coords[lastVxIdx]에 라벨을 달 수 있도록
// `[{lat, lon, name, typeCode}]` 반환. 비어있는 name / coords 범위를 벗어나는
// 인덱스는 스킵.

test('buildDirectionNameLabels_returns_empty_for_empty_input', () => {
  const coords = [{ lat: 37.5, lon: 127.0 }, { lat: 37.6, lon: 127.1 }];
  assert.deepEqual(buildDirectionNameLabels(coords, []), []);
  assert.deepEqual(buildDirectionNameLabels(coords, null), []);
  assert.deepEqual(buildDirectionNameLabels(coords, undefined), []);
});

test('buildDirectionNameLabels_places_label_at_lastVxIdx_coord', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
  ];
  const dns = [{ lastVxIdx: 2, typeCode: 1, name: '서울' }];
  const labels = buildDirectionNameLabels(coords, dns);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].lat, 37.2);
  assert.equal(labels[0].lon, 127.2);
  assert.equal(labels[0].name, '서울');
  assert.equal(labels[0].typeCode, 1);
});

test('buildDirectionNameLabels_skips_empty_or_whitespace_names', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  const dns = [
    { lastVxIdx: 0, typeCode: 0, name: '' },
    { lastVxIdx: 1, typeCode: 0, name: '   ' },
    { lastVxIdx: 1, typeCode: 2, name: '부산' },
  ];
  const labels = buildDirectionNameLabels(coords, dns);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].name, '부산');
});

test('buildDirectionNameLabels_skips_out_of_bounds_vxIdx', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  const dns = [
    { lastVxIdx: 99, typeCode: 1, name: '강남' },  // out of range
    { lastVxIdx: -1, typeCode: 1, name: '이상' },   // negative
    { lastVxIdx: 0,  typeCode: 1, name: '정상' },
  ];
  const labels = buildDirectionNameLabels(coords, dns);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].name, '정상');
});

// ---- buildRoadNameLabels ------------------------------------------------ //
//
// 도로 명칭 라벨. routeSummary.roadNames 각 항목은 `{startVxIdx, endVxIdx, name}`
// 형태 (경로요약 내부 테이블). 범위의 중앙 지점 (둘 중 하나 인덱스의 대략 중간)
// 에 라벨을 배치 → `[{lat, lon, name}]`. 빈 name / 범위 불량은 스킵.

test('buildRoadNameLabels_returns_empty_for_empty_input', () => {
  const coords = [{ lat: 37.5, lon: 127.0 }, { lat: 37.6, lon: 127.1 }];
  assert.deepEqual(buildRoadNameLabels(coords, []), []);
  assert.deepEqual(buildRoadNameLabels(coords, null), []);
  assert.deepEqual(buildRoadNameLabels(coords, undefined), []);
});

test('buildRoadNameLabels_places_label_at_midpoint_vxIdx', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
    { lat: 37.3, lon: 127.3 },
    { lat: 37.4, lon: 127.4 },
  ];
  // start=0, end=4 → mid=2
  const rns = [{ startVxIdx: 0, endVxIdx: 4, name: '경부고속도로' }];
  const labels = buildRoadNameLabels(coords, rns);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].lat, 37.2);
  assert.equal(labels[0].lon, 127.2);
  assert.equal(labels[0].name, '경부고속도로');
});

test('buildRoadNameLabels_skips_empty_names', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
  ];
  const rns = [
    { startVxIdx: 0, endVxIdx: 2, name: '' },
    { startVxIdx: 0, endVxIdx: 2, name: '  ' },
    { startVxIdx: 0, endVxIdx: 2, name: '강변북로' },
  ];
  const labels = buildRoadNameLabels(coords, rns);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].name, '강변북로');
});

test('buildRoadNameLabels_clamps_endVxIdx_beyond_coords', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.2, lon: 127.2 },
  ];
  // start=0, end=99 → clamped to 1, mid=0
  const rns = [{ startVxIdx: 0, endVxIdx: 99, name: '외곽순환' }];
  const labels = buildRoadNameLabels(coords, rns);
  assert.equal(labels.length, 1);
  // midpoint of [0, 1] = 0 (floor) → coords[0]
  assert.equal(labels[0].lat, 37.0);
  assert.equal(labels[0].name, '외곽순환');
});

test('buildRoadNameLabels_skips_invalid_range', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
  ];
  const rns = [
    { startVxIdx: 5, endVxIdx: 10, name: '범위밖' },     // both out of range
    { startVxIdx: 1, endVxIdx: 0,  name: '역순' },       // start > end
    { startVxIdx: -1, endVxIdx: 1, name: '음수시작' },
    { startVxIdx: 0, endVxIdx: 1,  name: '정상' },
  ];
  const labels = buildRoadNameLabels(coords, rns);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].name, '정상');
});

// ---- buildIntersectionNameLabels ---------------------------------------- //
//
// CN (교차로명칭) 항목은 `{lastVxIdx, name}` 형태. DN5와 유사하지만 typeCode 없음.
// coords[lastVxIdx]에 라벨을 둔다. 빈 이름/범위 밖 인덱스는 스킵.

test('buildIntersectionNameLabels_returns_empty_for_empty_input', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }];
  assert.deepEqual(buildIntersectionNameLabels(coords, []), []);
  assert.deepEqual(buildIntersectionNameLabels(coords, null), []);
  assert.deepEqual(buildIntersectionNameLabels(coords, undefined), []);
});

test('buildIntersectionNameLabels_places_label_at_lastVxIdx', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
  ];
  const items = [{ lastVxIdx: 1, name: '강남역' }];
  const labels = buildIntersectionNameLabels(coords, items);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].lat, 37.1);
  assert.equal(labels[0].lon, 127.1);
  assert.equal(labels[0].name, '강남역');
});

test('buildIntersectionNameLabels_skips_empty_and_out_of_bounds', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  const items = [
    { lastVxIdx: 0, name: '' },
    { lastVxIdx: 99, name: '범위밖' },
    { lastVxIdx: -1, name: '음수' },
    { lastVxIdx: 1, name: '정상' },
  ];
  const labels = buildIntersectionNameLabels(coords, items);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].name, '정상');
});

// ---- buildRangeSegments ------------------------------------------------- //
//
// 범용 헬퍼: `{startVxIdx, endVxIdx, ...}` 형태의 item 배열을 받아 각 item을
// `{latlngs: [[lat,lon],...], item}` 세그먼트로 변환. endVxIdx는 coords
// 범위로 clamp. 유효하지 않은 범위는 스킵. TC/LT2/HW/RD5/WHR 등 공용.

test('buildRangeSegments_returns_empty_for_empty_input', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  assert.deepEqual(buildRangeSegments(coords, []), []);
  assert.deepEqual(buildRangeSegments(coords, null), []);
  assert.deepEqual(buildRangeSegments(coords, undefined), []);
});

test('buildRangeSegments_builds_latlngs_for_valid_range', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
  ];
  const item = { startVxIdx: 0, endVxIdx: 2, payload: 'x' };
  const segs = buildRangeSegments(coords, [item]);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].latlngs, [[37.0, 127.0], [37.1, 127.1], [37.2, 127.2]]);
  // Preserves original item reference for renderer access to extra fields
  assert.equal(segs[0].item, item);
});

test('buildRangeSegments_clamps_endVxIdx_to_coords_length', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
  ];
  const segs = buildRangeSegments(coords, [{ startVxIdx: 0, endVxIdx: 99 }]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].latlngs.length, 2);
  assert.deepEqual(segs[0].latlngs[1], [37.1, 127.1]);
});

// ---- buildCongestionLabels ---------------------------------------------- //
//
// TC 정체구간 라벨 — 각 항목 `{startVxIdx, endVxIdx, distance, time}`에 대해
// 범위 중앙 vx 좌표 + 거리/시간을 반환. 지도 위 칩 라벨로 표시하기 위함.

test('buildCongestionLabels_returns_empty_for_empty_input', () => {
  const coords = [{ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.1 }];
  assert.deepEqual(buildCongestionLabels(coords, []), []);
  assert.deepEqual(buildCongestionLabels(coords, null), []);
  assert.deepEqual(buildCongestionLabels(coords, undefined), []);
});

test('buildCongestionLabels_places_label_at_midpoint_with_distance_time', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
    { lat: 37.3, lon: 127.3 },
    { lat: 37.4, lon: 127.4 },
  ];
  const items = [{ startVxIdx: 0, endVxIdx: 4, distance: 1500, time: 300 }];
  const labels = buildCongestionLabels(coords, items);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].lat, 37.2);  // mid of [0,4] = 2
  assert.equal(labels[0].lon, 127.2);
  assert.equal(labels[0].distance, 1500);
  assert.equal(labels[0].time, 300);
});

test('buildCongestionLabels_clamps_endVxIdx_and_skips_invalid', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
  ];
  const items = [
    { startVxIdx: 0, endVxIdx: 99, distance: 500, time: 60 }, // clamp end → mid of [0,2] = 1
    { startVxIdx: 5, endVxIdx: 9,  distance: 100, time: 30 }, // out of range → skip
    { startVxIdx: 2, endVxIdx: 0,  distance: 100, time: 30 }, // reversed → skip
  ];
  const labels = buildCongestionLabels(coords, items);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].lat, 37.1);  // mid = floor((0+2)/2) = 1
  assert.equal(labels[0].distance, 500);
});

test('buildRangeSegments_skips_invalid_ranges', () => {
  const coords = [
    { lat: 37.0, lon: 127.0 },
    { lat: 37.1, lon: 127.1 },
    { lat: 37.2, lon: 127.2 },
  ];
  const items = [
    { startVxIdx: 2, endVxIdx: 0 },  // reversed → skip
    { startVxIdx: 1, endVxIdx: 1 },  // single point → skip (needs ≥2 points)
    { startVxIdx: -1, endVxIdx: 2 }, // negative start → skip
    { startVxIdx: 5, endVxIdx: 9 },  // start out of range → skip
    { startVxIdx: 0, endVxIdx: 2 },  // valid
  ];
  const segs = buildRangeSegments(coords, items);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].latlngs.length, 3);
});
