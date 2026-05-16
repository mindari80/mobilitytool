// RpLog REQ multi-chunk JSON 정리 + 파싱 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAndParseRpReqBuffer, advanceJsonDepth, stripDltBinaryPrefix } from '../DltLogViewer/js/extractor.js';

test('cleanAndParseRpReqBuffer parses single-line JSON', () => {
  const r = cleanAndParseRpReqBuffer('{"lat":37.5,"lon":127.0}');
  assert.equal(r.parseError, null);
  assert.deepEqual(r.parsed, { lat: 37.5, lon: 127.0 });
});

test('cleanAndParseRpReqBuffer strips real newlines between chunks', () => {
  // 멀티 청크가 \n으로 합쳐진 경우 (DLT 라인 경계 사이 newline)
  const r = cleanAndParseRpReqBuffer('{"a":1,\n"b":2,\n"c":"x"}');
  assert.equal(r.parseError, null);
  assert.deepEqual(r.parsed, { a: 1, b: 2, c: 'x' });
});

test('cleanAndParseRpReqBuffer preserves escaped \\n inside string values', () => {
  // gpsTraceData 처럼 문자열 안에 base64+\\n 가 있는 경우 → \\n 은 escape 시퀀스로 유지되어야 JSON 파싱 성공
  const raw = '{"gpsTraceData":"AAA\\nBBB\\nCCC=="}';
  const r = cleanAndParseRpReqBuffer(raw);
  assert.equal(r.parseError, null);
  assert.equal(r.parsed.gpsTraceData, 'AAA\nBBB\nCCC==');
});

test('cleanAndParseRpReqBuffer returns parseError for invalid JSON', () => {
  const r = cleanAndParseRpReqBuffer('{"lat":37.5,"lon":}');
  assert.ok(r.parseError);
  assert.equal(r.parsed, null);
});

test('cleanAndParseRpReqBuffer returns parseError when truncated', () => {
  const r = cleanAndParseRpReqBuffer('{"lat":37.5,"lon":127.0');  // closing } missing
  assert.ok(r.parseError);
});

test('cleanAndParseRpReqBuffer handles array continuations', () => {
  // 청크 사이에 줄바꿈만 있고 구조는 유효한 경우
  const r = cleanAndParseRpReqBuffer('{"arr":[1,2,\n3,4,\n5]}');
  assert.deepEqual(r.parsed, { arr: [1, 2, 3, 4, 5] });
});

// ---- advanceJsonDepth ---- //

test('advanceJsonDepth tracks balanced braces to 0', () => {
  const s = advanceJsonDepth('{"a":1,"b":[2,3]}', { depth: 0, inString: false, escape: false });
  assert.equal(s.depth, 0);
});

test('advanceJsonDepth partial chunk leaves depth > 0', () => {
  const s = advanceJsonDepth('{"a":1,"b":[2,3', { depth: 0, inString: false, escape: false });
  assert.equal(s.depth, 2); // { + [
});

test('advanceJsonDepth ignores braces inside strings', () => {
  const s = advanceJsonDepth('{"a":"{not real}"}', { depth: 0, inString: false, escape: false });
  assert.equal(s.depth, 0);
});

test('advanceJsonDepth handles split chunks across calls', () => {
  let s = { depth: 0, inString: false, escape: false };
  s = advanceJsonDepth('{"a":"hello', s);
  assert.equal(s.inString, true);
  s = advanceJsonDepth(' world","b":[1,2,3]}', s);
  assert.equal(s.depth, 0);
});

// ---- stripDltBinaryPrefix ---- //

test('stripDltBinaryPrefix removes DLT header before JSON chunk', () => {
  // 실제 DLT 출력 예: DLT 매직 + ECU/AppId/CtxId + 컨트롤 바이트 + 실제 페이로드
  const raw = 'DLTÿ\bIjIDCEWÿ5AALDLCAT,"departRoadType":"None"';
  assert.equal(stripDltBinaryPrefix(raw), ',"departRoadType":"None"');
});

test('stripDltBinaryPrefix removes replacement chars (UTF-8 fallback)', () => {
  // 유효하지 않은 UTF-8 바이트가 � 로 디코딩된 경우
  const raw = '�\bXIDCE�chunk_start_here';
  assert.equal(stripDltBinaryPrefix(raw), 'chunk_start_here');
});

test('stripDltBinaryPrefix keeps clean text intact', () => {
  const clean = '{"a":1}';
  assert.equal(stripDltBinaryPrefix(clean), clean);
});

test('stripDltBinaryPrefix preserves tab/newline within payload', () => {
  // 페이로드 안의 tab/newline 은 제어문자지만 제거하지 않아야 함
  const raw = 'text with\ttab and\nnewline';
  assert.equal(stripDltBinaryPrefix(raw), 'text with\ttab and\nnewline');
});

test('advanceJsonDepth escape sequence in string preserves state', () => {
  let s = { depth: 0, inString: false, escape: false };
  // 백슬래시 자체로 끝나는 청크 → 다음 청크의 첫 글자가 escape 됨
  s = advanceJsonDepth('{"a":"\\', s);
  assert.equal(s.inString, true);
  assert.equal(s.escape, true);
  s = advanceJsonDepth('""}', s);  // 첫 " 는 escape 됨, 두 번째 " 가 string 종료
  assert.equal(s.depth, 0);
});
