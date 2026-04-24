import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTrafficResponse,
  buildTrafficUrl,
  buildTrafficPopupHtml,
  colorForAccidentCode,
  categoryKeyForIncident,
  categoryLabel,
  groupIncidentsByCategory,
  CATEGORY_KEYS,
} from '../DltLogViewer/js/traffic-api.js';

// ---- buildTrafficUrl ----------------------------------------------------- //

test('buildTrafficUrl_returns_tmap_top_open_traffic_endpoint', () => {
  const url = buildTrafficUrl({ minLat: 32, minLon: 124, maxLat: 39, maxLon: 132 });
  assert.ok(url.startsWith('https://topopen.tmap.co.kr/tmapv20/traffic/acc?'));
  assert.match(url, /minLat=32/);
  assert.match(url, /minLon=124/);
  assert.match(url, /maxLat=39/);
  assert.match(url, /maxLon=132/);
  assert.match(url, /reqCoordType=WGS84GEO/);
  assert.match(url, /resCoordType=WGS84GEO/);
});

// ---- parseTrafficResponse ------------------------------------------------ //

const SAMPLE = {
  type: 'FeatureCollection',
  geometries: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [127.8268617, 36.5342544] },
      properties: {
        index: 0,
        pointIndex: 0,
        linkId: '',
        isAccidentNode: 'Y',
        name: '공원입구통제소↔세심정\u0000\u0000\u0000\u0000',
        roadName: '법주사로\u0000\u0000\u0000\u0000\u0000\u0000',
        roadType: '일반도로',
        startTime: '202012210000',
        endTime: '202904162359',
        districtLargeCd: '43',
        districtMiddleCd: '720',
        districtSmallCd: '31500',
        description: '보은 법주사로 양방향 전면통제',
        accidentUpperCode: 'E',
        accidentUpperName: '통제',
        accidentDetailCode: 'E02',
        accidentDetailName: '전면통제',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [127.0276, 37.4979] },
      properties: {
        index: 1,
        pointIndex: 1,
        linkId: 'L12345',
        isAccidentNode: 'N',
        name: '강남역',
        roadName: '테헤란로',
        roadType: '일반도로',
        startTime: '202604230900',
        endTime: '202604231800',
        description: '도로 공사',
        accidentUpperCode: 'B',
        accidentUpperName: '공사',
        accidentDetailCode: 'B01',
        accidentDetailName: '도로공사',
      },
    },
  ],
};

test('parseTrafficResponse_returns_array_with_feature_count', () => {
  const incidents = parseTrafficResponse(SAMPLE);
  assert.equal(incidents.length, 2);
});

test('parseTrafficResponse_maps_coordinates_to_lat_lon', () => {
  const [first] = parseTrafficResponse(SAMPLE);
  assert.equal(first.lat, 36.5342544);
  assert.equal(first.lon, 127.8268617);
});

test('parseTrafficResponse_strips_null_padding_from_strings', () => {
  const [first] = parseTrafficResponse(SAMPLE);
  assert.equal(first.name, '공원입구통제소↔세심정');
  assert.equal(first.roadName, '법주사로');
  assert.doesNotMatch(first.name, /\u0000/);
});

test('parseTrafficResponse_preserves_accident_classification', () => {
  const [first] = parseTrafficResponse(SAMPLE);
  assert.equal(first.accidentUpperCode, 'E');
  assert.equal(first.accidentUpperName, '통제');
  assert.equal(first.accidentDetailName, '전면통제');
});

test('parseTrafficResponse_preserves_time_fields', () => {
  const [, second] = parseTrafficResponse(SAMPLE);
  assert.equal(second.startTime, '202604230900');
  assert.equal(second.endTime, '202604231800');
});

test('parseTrafficResponse_handles_empty_collection', () => {
  assert.deepEqual(parseTrafficResponse({ type: 'FeatureCollection', geometries: [] }), []);
});

test('parseTrafficResponse_handles_missing_geometries_field', () => {
  assert.deepEqual(parseTrafficResponse({ type: 'FeatureCollection' }), []);
});

test('parseTrafficResponse_skips_feature_without_coordinates', () => {
  const bad = {
    type: 'FeatureCollection',
    geometries: [
      { type: 'Feature', geometry: null, properties: { name: 'no-geom' } },
      { type: 'Feature', geometry: { type: 'Point' }, properties: { name: 'no-coords' } },
      SAMPLE.geometries[0],
    ],
  };
  const incidents = parseTrafficResponse(bad);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].name, '공원입구통제소↔세심정');
});

test('parseTrafficResponse_tolerates_null_input', () => {
  assert.deepEqual(parseTrafficResponse(null), []);
  assert.deepEqual(parseTrafficResponse(undefined), []);
});

// ---- category helpers ---------------------------------------------------- //

test('CATEGORY_KEYS_covers_known_codes_plus_OTHER_bucket', () => {
  assert.ok(Array.isArray(CATEGORY_KEYS));
  for (const k of ['A', 'B', 'C', 'D', 'E', 'OTHER']) {
    assert.ok(CATEGORY_KEYS.includes(k), `missing category ${k}`);
  }
});

test('categoryKeyForIncident_returns_known_code', () => {
  assert.equal(categoryKeyForIncident({ accidentUpperCode: 'E' }), 'E');
  assert.equal(categoryKeyForIncident({ accidentUpperCode: 'B' }), 'B');
  assert.equal(categoryKeyForIncident({ accidentUpperCode: 'A' }), 'A');
});

test('categoryKeyForIncident_falls_back_to_OTHER_for_unknown', () => {
  assert.equal(categoryKeyForIncident({ accidentUpperCode: 'Z' }), 'OTHER');
  assert.equal(categoryKeyForIncident({ accidentUpperCode: '' }), 'OTHER');
  assert.equal(categoryKeyForIncident({}), 'OTHER');
});

test('categoryLabel_returns_korean_label', () => {
  assert.equal(categoryLabel('A'), '사고');
  assert.equal(categoryLabel('B'), '공사');
  assert.equal(categoryLabel('C'), '행사');
  assert.equal(categoryLabel('D'), '재해');
  assert.equal(categoryLabel('E'), '통제');
  assert.equal(categoryLabel('OTHER'), '기타');
});

test('groupIncidentsByCategory_buckets_incidents_by_key', () => {
  const incidents = parseTrafficResponse(SAMPLE); // first E, second B
  const groups = groupIncidentsByCategory(incidents);
  assert.equal(groups.E.length, 1);
  assert.equal(groups.B.length, 1);
  // every bucket exists (even empty) so UI can render a stable set of toggles.
  for (const k of CATEGORY_KEYS) {
    assert.ok(Array.isArray(groups[k]), `missing bucket ${k}`);
  }
  assert.equal(groups.A.length, 0);
});

test('groupIncidentsByCategory_puts_unknown_into_OTHER', () => {
  const incidents = [
    { lat: 1, lon: 1, accidentUpperCode: 'X' },
    { lat: 1, lon: 1, accidentUpperCode: '' },
  ];
  const groups = groupIncidentsByCategory(incidents);
  assert.equal(groups.OTHER.length, 2);
});

// ---- colorForAccidentCode ------------------------------------------------ //

test('colorForAccidentCode_returns_distinct_color_per_category', () => {
  const e = colorForAccidentCode('E'); // 통제
  const b = colorForAccidentCode('B'); // 공사
  const a = colorForAccidentCode('A'); // 사고
  assert.match(e, /^#[0-9a-fA-F]{6}$/);
  assert.match(b, /^#[0-9a-fA-F]{6}$/);
  assert.match(a, /^#[0-9a-fA-F]{6}$/);
  assert.notEqual(e, b);
  assert.notEqual(e, a);
});

test('colorForAccidentCode_falls_back_to_default_for_unknown', () => {
  const c = colorForAccidentCode('ZZZ');
  assert.match(c, /^#[0-9a-fA-F]{6}$/);
});

// ---- buildTrafficPopupHtml ----------------------------------------------- //

test('buildTrafficPopupHtml_contains_name_and_description', () => {
  const incident = parseTrafficResponse(SAMPLE)[0];
  const html = buildTrafficPopupHtml(incident);
  assert.match(html, /공원입구통제소/);
  assert.match(html, /전면통제/);
  assert.match(html, /법주사로/);
});

test('buildTrafficPopupHtml_container_wraps_long_text_to_stay_inside_popup', () => {
  const longLinkId = 'L' + '1234567890'.repeat(20);
  const incident = {
    lat: 37, lon: 127,
    name: 'x', description: 'y', roadName: '', roadType: '',
    startTime: '', endTime: '',
    linkId: longLinkId,
    accidentUpperCode: 'A', accidentUpperName: '사고',
    accidentDetailCode: '', accidentDetailName: '',
  };
  const html = buildTrafficPopupHtml(incident);
  // long linkId must be rendered...
  assert.match(html, new RegExp(longLinkId));
  // ...and the container must enable word-breaking so it cannot overflow.
  assert.match(html, /class="traffic-popup"[^>]*style="[^"]*(word-break|overflow-wrap)/);
});

test('buildTrafficPopupHtml_escapes_html_special_chars', () => {
  const incident = {
    lat: 37, lon: 127,
    name: '<script>alert(1)</script>',
    description: 'x & y',
    roadName: '', roadType: '',
    startTime: '', endTime: '',
    accidentUpperCode: 'A', accidentUpperName: '사고',
    accidentDetailCode: '', accidentDetailName: '',
  };
  const html = buildTrafficPopupHtml(incident);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /x &amp; y/);
});
