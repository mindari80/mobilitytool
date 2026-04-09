/**
 * Web Worker for SHP parsing + coordinate transformation.
 * Runs off the main thread to avoid page freeze.
 */
'use strict';

importScripts('https://unpkg.com/shpjs@4.0.4/dist/shp.js');

// ---- GCS_Tokyo (Bessel 1841) → WGS84 ------------------------------------ //
// EPSG:1838 — Korea South (dx=-147, dy=506, dz=687.5)

const BESSEL_a  = 6377397.155;
const BESSEL_e2 = (() => { const f = 1/299.1528128;  return 2*f - f*f; })();
const WGS84_a   = 6378137.0;
const WGS84_e2  = (() => { const f = 1/298.257223563; return 2*f - f*f; })();
const DX = -147.0, DY = 506.0, DZ = 687.5;

function besselToWgs84(lon, lat) {
  const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
  const sinφ = Math.sin(φ), cosφ = Math.cos(φ);
  const N = BESSEL_a / Math.sqrt(1 - BESSEL_e2 * sinφ * sinφ);
  const X2 = N * cosφ * Math.cos(λ) + DX;
  const Y2 = N * cosφ * Math.sin(λ) + DY;
  const Z2 = N * (1 - BESSEL_e2) * sinφ + DZ;
  const λ2 = Math.atan2(Y2, X2);
  const p  = Math.sqrt(X2*X2 + Y2*Y2);
  let φ2 = Math.atan2(Z2, p * (1 - WGS84_e2));
  for (let i = 0; i < 10; i++) {
    const Nw = WGS84_a / Math.sqrt(1 - WGS84_e2 * Math.sin(φ2) ** 2);
    φ2 = Math.atan2(Z2 + WGS84_e2 * Nw * Math.sin(φ2), p);
  }
  return [λ2 * 180 / Math.PI, φ2 * 180 / Math.PI];
}

function transformGeom(geom) {
  if (!geom) return geom;
  const tr = ([lng, lat]) => besselToWgs84(lng, lat);
  switch (geom.type) {
    case 'Point':           return { ...geom, coordinates: tr(geom.coordinates) };
    case 'LineString':      return { ...geom, coordinates: geom.coordinates.map(tr) };
    case 'MultiLineString': return { ...geom, coordinates: geom.coordinates.map(r => r.map(tr)) };
    case 'MultiPoint':      return { ...geom, coordinates: geom.coordinates.map(tr) };
    default:                return geom;
  }
}

// ---- Bbox --------------------------------------------------------------- //

function featureBbox(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = ([lng, lat]) => {
    if (lng < w) w = lng; if (lat < s) s = lat;
    if (lng > e) e = lng; if (lat > n) n = lat;
  };
  if (!geom) return [0, 0, 0, 0];
  switch (geom.type) {
    case 'Point':           visit(geom.coordinates); break;
    case 'LineString':      geom.coordinates.forEach(visit); break;
    case 'MultiLineString': geom.coordinates.forEach(r => r.forEach(visit)); break;
    case 'MultiPoint':      geom.coordinates.forEach(visit); break;
  }
  return [w, s, e, n];
}

// ---- Message handler ---------------------------------------------------- //

self.onmessage = function ({ data: { shpBuf, dbfBuf } }) {
  try {
    postMessage({ type: 'progress', pct: 25, msg: '[2/4] 지오메트리 파싱 중...' });
    const geometries = shp.parseShp(shpBuf);

    let attributes = [];
    if (dbfBuf) {
      postMessage({ type: 'progress', pct: 45, msg: '[3/4] DBF 속성 읽는 중...' });
      attributes = shp.parseDbf(dbfBuf);
    } else {
      postMessage({ type: 'progress', pct: 50, msg: '[3/4] DBF 없음' });
    }

    postMessage({ type: 'progress', pct: 65, msg: '[4/4] 좌표 변환 중...' });

    const total = geometries.length;
    const data  = new Array(total);
    for (let i = 0; i < total; i++) {
      const geom = transformGeom(geometries[i]);
      data[i] = {
        feature: { type: 'Feature', geometry: geom, properties: attributes[i] || {} },
        bbox: featureBbox(geom),
      };
    }

    postMessage({ type: 'progress', pct: 90, msg: '결과 전송 중...' });
    postMessage({ type: 'done', data });
  } catch (err) {
    postMessage({ type: 'error', msg: err.message || String(err) });
  }
};
