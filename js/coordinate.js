/**
 * Coordinate conversion utilities.
 * Ported from dlt_gpslog_parser4.py
 *
 * SK (Bessel-based) → WGS84 via ECEF 3-parameter Helmert shift
 * Fallback: affine/quadratic regression from observed calibration samples
 */

'use strict';

const WGS84_A = 6378137.0;
const WGS84_RF = 298.257223563;
const WGS84_B = WGS84_A - WGS84_A / WGS84_RF;

const BESSEL_A = 6377397.155;
const BESSEL_RF = 299.1528128;
const BESSEL_B = BESSEL_A - BESSEL_A / BESSEL_RF;

const B2W_DX = -147.0;
const B2W_DY = 506.0;
const B2W_DZ = 687.0;

// ---- ECEF helpers -------------------------------------------------------- //

function geodToEcef(latDeg, lonDeg, h, a, b) {
  const latR = latDeg * Math.PI / 180;
  const lonR = lonDeg * Math.PI / 180;
  const f = (a - b) / a;
  const e2 = 2 * f - f * f;
  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  return [
    (N + h) * Math.cos(latR) * Math.cos(lonR),
    (N + h) * Math.cos(latR) * Math.sin(lonR),
    (N * (1 - e2) + h) * Math.sin(latR),
  ];
}

function ecefToGeod(x, y, z, a, b) {
  const p = Math.sqrt(x * x + y * y);
  const f = (a - b) / a;
  const e2 = 2 * f - f * f;
  const e2b = (a * a - b * b) / (b * b);
  const theta = Math.atan((z * a) / (p * b));
  const latR = Math.atan(
    (z + e2b * b * Math.sin(theta) ** 3) /
    (p - e2 * a * Math.cos(theta) ** 3)
  );
  const lonR = Math.atan2(y, x);
  const h = p / Math.cos(latR) - a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  return [latR * 180 / Math.PI, lonR * 180 / Math.PI, h];
}

export function besselToWgs84(lonDeg, latDeg) {
  let [x, y, z] = geodToEcef(latDeg, lonDeg, 0.0, BESSEL_A, BESSEL_B);
  x += B2W_DX; y += B2W_DY; z += B2W_DZ;
  const [latWgs, lonWgs] = ecefToGeod(x, y, z, WGS84_A, WGS84_B);
  return [latWgs, lonWgs];
}

// ---- SK coordinate → Bessel degree --------------------------------------- //

function skTobesselDeg(value) {
  if (value == null) return null;
  const scale = Math.abs(value) >= 10_000_000 ? 360000.0 : 36000.0;
  return value / scale;
}

export function skCoordToWgs84(skX, skY) {
  if (skX == null || skY == null) return null;
  const bLon = skTobesselDeg(skX);
  const bLat = skTobesselDeg(skY);
  if (bLon == null || bLat == null) return null;
  return besselToWgs84(bLon, bLat); // returns [lat, lon]
}

// ---- Affine/quadratic regression fallback -------------------------------- //

function affineFeatures(x, y) { return [x, y, 1.0]; }
function quadraticFeatures(x, y) { return [x*x, y*y, x*y, x, y, 1.0]; }

/**
 * Solve Ax = b via Gaussian elimination.
 * Returns solution vector or null.
 */
function solveLinear(A, b) {
  const n = A.length;
  // Build augmented matrix
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return null;

    const pivot = M[col][col];
    for (let k = col; k <= n; k++) M[col][k] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }
  return M.map(row => row[n]);
}

/**
 * Fit affine (≥3 samples) or quadratic (≥6 samples) transform from
 * (x, y) → (lon, lat) samples.
 *
 * @param {Array<[x, y, lon, lat]>} samples
 * @returns {{ basis, lonCoeffs, latCoeffs } | null}
 */
export function fitAffineTransform(samples) {
  let featFn, basisName;
  if (samples.length >= 6) {
    featFn = quadraticFeatures; basisName = 'quadratic';
  } else if (samples.length >= 3) {
    featFn = affineFeatures; basisName = 'affine';
  } else {
    return null;
  }

  const fSize = featFn(samples[0][0], samples[0][1]).length;
  const N = Array.from({ length: fSize }, () => new Array(fSize).fill(0));
  const vLon = new Array(fSize).fill(0);
  const vLat = new Array(fSize).fill(0);

  for (const [x, y, lon, lat] of samples) {
    const f = featFn(x, y);
    for (let r = 0; r < fSize; r++) {
      vLon[r] += f[r] * lon;
      vLat[r] += f[r] * lat;
      for (let c = 0; c < fSize; c++) N[r][c] += f[r] * f[c];
    }
  }

  const lonCoeffs = solveLinear(N.map(r => [...r]), vLon);
  const latCoeffs = solveLinear(N.map(r => [...r]), vLat);
  if (!lonCoeffs || !latCoeffs) return null;
  return { basis: basisName, lonCoeffs, latCoeffs };
}

/**
 * Apply a fitted transform to (x, y).
 * Returns [lat, lon] or null.
 */
export function applyAffineTransform(transform, x, y) {
  if (!transform) return null;
  const f = transform.basis === 'quadratic'
    ? quadraticFeatures(x, y)
    : affineFeatures(x, y);
  const lon = transform.lonCoeffs.reduce((s, c, i) => s + c * f[i], 0);
  const lat = transform.latCoeffs.reduce((s, c, i) => s + c * f[i], 0);
  return [lat, lon];
}
