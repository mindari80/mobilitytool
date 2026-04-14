import test from 'node:test';
import assert from 'node:assert/strict';
import {
  skCoordToWgs84,
  wgs84ToSkCoord,
  besselToWgs84,
  fitAffineTransform,
  applyAffineTransform,
} from '../js/coordinate.js';

// ---- skCoordToWgs84 ------------------------------------------------------ //

test('skCoordToWgs84 null input returns null', () => {
  assert.equal(skCoordToWgs84(null, 1), null);
  assert.equal(skCoordToWgs84(1, null), null);
});

test('skCoordToWgs84 Seoul center gives plausible lat/lon', () => {
  // Seoul roughly lon 127.0, lat 37.5 in bessel deg
  // scale 36000 → skX = 127 * 36000, skY = 37.5 * 36000
  const [lat, lon] = skCoordToWgs84(127 * 36000, 37.5 * 36000);
  assert.ok(lat > 37.0 && lat < 38.0, `lat=${lat}`);
  assert.ok(lon > 126.5 && lon < 127.5, `lon=${lon}`);
});

test('skCoordToWgs84 uses 360000 scale for large values', () => {
  // Same geographic point, larger scale
  const [lat1, lon1] = skCoordToWgs84(127 * 36000, 37.5 * 36000);
  const [lat2, lon2] = skCoordToWgs84(127 * 360000, 37.5 * 360000);
  assert.ok(Math.abs(lat1 - lat2) < 1e-6);
  assert.ok(Math.abs(lon1 - lon2) < 1e-6);
});

// ---- wgs84ToSkCoord round-trip ------------------------------------------ //

test('wgs84ToSkCoord round-trips skCoordToWgs84 within 1 meter', () => {
  const skX0 = 127 * 36000;
  const skY0 = 37.5 * 36000;
  const [lat, lon] = skCoordToWgs84(skX0, skY0);
  const [skX, skY] = wgs84ToSkCoord(lat, lon);
  // 1/36000 deg ≈ 3 meters, so integer rounding tolerance is ±1 unit
  assert.ok(Math.abs(skX - skX0) <= 1, `skX diff=${skX - skX0}`);
  assert.ok(Math.abs(skY - skY0) <= 1, `skY diff=${skY - skY0}`);
});

// ---- besselToWgs84 ------------------------------------------------------- //

test('besselToWgs84 shifts coordinates by Helmert parameters', () => {
  const [lat, lon] = besselToWgs84(127.0, 37.5);
  // Bessel → WGS84 shift in Korea roughly −0.00013 lat, +0.0003 lon
  assert.ok(Math.abs(lat - 37.5) < 0.01);
  assert.ok(Math.abs(lon - 127.0) < 0.01);
});

// ---- fitAffineTransform -------------------------------------------------- //

test('fitAffineTransform with <3 samples returns null', () => {
  assert.equal(fitAffineTransform([[0, 0, 0, 0], [1, 1, 1, 1]]), null);
});

test('fitAffineTransform recovers identity mapping', () => {
  const samples = [
    [0, 0, 0, 0],
    [1, 0, 1, 0],
    [0, 1, 0, 1],
    [2, 2, 2, 2],
  ];
  const t = fitAffineTransform(samples);
  assert.ok(t);
  assert.equal(t.basis, 'affine');
  const [lat, lon] = applyAffineTransform(t, 5, 3);
  assert.ok(Math.abs(lon - 5) < 1e-6);
  assert.ok(Math.abs(lat - 3) < 1e-6);
});

test('applyAffineTransform null transform returns null', () => {
  assert.equal(applyAffineTransform(null, 1, 2), null);
});
