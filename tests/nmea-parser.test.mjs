// NMEA $GPRMC 파싱 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNmeaRmc } from '../DltLogViewer/js/extractor.js';

test('parseNmeaRmc parses sample line from log', () => {
  const line = '$GPRMC,231804.412,A,3731.4598530,N,12641.0831974,E,6.1057,280.7618,280426,,,D,S*12';
  const r = parseNmeaRmc(line);
  assert.ok(r);
  assert.ok(Math.abs(r.lat - (37 + 31.4598530/60)) < 1e-7);
  assert.ok(Math.abs(r.lon - (126 + 41.0831974/60)) < 1e-7);
  assert.equal(r.bearing, 280.7618);
  // 6.1057 knots → m/s 약 3.141
  assert.ok(Math.abs(r.speed - 6.1057 * 0.514444) < 1e-3);
  // 280426 = 2026-04-28, 23:18:04.412 UTC
  assert.equal(r.timestamp.getUTCFullYear(), 2026);
  assert.equal(r.timestamp.getUTCMonth(), 3);   // April (0-indexed)
  assert.equal(r.timestamp.getUTCDate(), 28);
  assert.equal(r.timestamp.getUTCHours(), 23);
  assert.equal(r.timestamp.getUTCMinutes(), 18);
  assert.equal(r.timestamp.getUTCSeconds(), 4);
  assert.equal(r.timestamp.getUTCMilliseconds(), 412);
});

test('parseNmeaRmc handles S latitude / W longitude', () => {
  const line = '$GPRMC,000000,A,3000.0000,S,06000.0000,W,0,0,010120,,,A,S*00';
  const r = parseNmeaRmc(line);
  assert.equal(r.lat, -30);
  assert.equal(r.lon, -60);
});

test('parseNmeaRmc returns null for invalid fix (V)', () => {
  const line = '$GPRMC,231804,V,3731.4598,N,12641.0831,E,0,0,280426,,,N,V*00';
  assert.equal(parseNmeaRmc(line), null);
});

test('parseNmeaRmc returns null for non-RMC sentence', () => {
  assert.equal(parseNmeaRmc('$GPGGA,...'), null);
});

test('parseNmeaRmc returns null for malformed line', () => {
  assert.equal(parseNmeaRmc('garbage'), null);
});

test('parseNmeaRmc handles GN talker id ($GNRMC)', () => {
  const line = '$GNRMC,120000,A,3731.4598530,N,12641.0831974,E,5,90,010125,,,A,S*00';
  const r = parseNmeaRmc(line);
  assert.ok(r);
  assert.ok(Math.abs(r.lat - (37 + 31.4598530/60)) < 1e-7);
});
