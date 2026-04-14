import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDltTimestamp, medianOf, encodeMarkers } from '../js/dlt-parser.js';

// ---- parseDltTimestamp --------------------------------------------------- //

test('parseDltTimestamp wallclock slash format returns Date', () => {
  const d = parseDltTimestamp('2026/04/06 10:16:43.698');
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 3); // April = 3
  assert.equal(d.getDate(), 6);
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 16);
  assert.equal(d.getSeconds(), 43);
  assert.equal(d.getMilliseconds(), 698);
});

test('parseDltTimestamp wallclock dash format returns Date', () => {
  const d = parseDltTimestamp('2026-04-06 10:16:43');
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 3);
  assert.equal(d.getMilliseconds(), 0);
});

test('parseDltTimestamp wallclock with 6-digit frac truncates to 3 digits', () => {
  const d = parseDltTimestamp('2026/04/06 10:16:43.123456');
  assert.equal(d.getMilliseconds(), 123);
});

test('parseDltTimestamp epoch seconds format returns Date', () => {
  // 1712394000 = 2024-04-06 ~ UTC
  const d = parseDltTimestamp('some log time: 1712394000 blah');
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1712394000 * 1000);
});

test('parseDltTimestamp epoch milliseconds format returns Date', () => {
  const d = parseDltTimestamp('time: 1712394000123');
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1712394000123);
});

test('parseDltTimestamp empty string returns null', () => {
  assert.equal(parseDltTimestamp(''), null);
});

test('parseDltTimestamp text with no timestamp returns null', () => {
  assert.equal(parseDltTimestamp('random log without date'), null);
});

// ---- medianOf ------------------------------------------------------------ //

test('medianOf odd-length array returns middle value', () => {
  assert.equal(medianOf([1, 3, 2]), 2);
});

test('medianOf even-length array returns average of middles', () => {
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
});

test('medianOf empty returns null', () => {
  assert.equal(medianOf([]), null);
});

// ---- encodeMarkers ------------------------------------------------------- //

test('encodeMarkers returns Uint8Array per string', () => {
  const [a, b] = encodeMarkers(['#RpLog', '[MM_RESULT]']);
  assert.ok(a instanceof Uint8Array);
  assert.ok(b instanceof Uint8Array);
  assert.equal(a.length, 6);
  assert.equal(String.fromCharCode(...a), '#RpLog');
});
