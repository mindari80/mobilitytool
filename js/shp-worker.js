/**
 * Web Worker for SHP parsing only.
 * Coordinate transformation is done lazily on the main thread
 * per viewport to avoid upfront bulk work.
 */
'use strict';

importScripts('https://unpkg.com/shpjs@4.0.4/dist/shp.js');

// ---- Raw bbox (GCS_Tokyo coords — close enough for viewport filtering) --- //

function rawBbox(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = ([x, y]) => {
    if (x < w) w = x; if (y < s) s = y;
    if (x > e) e = x; if (y > n) n = y;
  };
  if (!geom) return [0, 0, 0, 0];
  switch (geom.type) {
    case 'Point':           visit(geom.coordinates); break;
    case 'LineString':      geom.coordinates.forEach(visit); break;
    case 'MultiLineString': geom.coordinates.forEach(r => r.forEach(visit)); break;
    case 'MultiPoint':      geom.coordinates.forEach(visit); break;
  }
  return [w === Infinity ? 0 : w, s === Infinity ? 0 : s, e, n];
}

// ---- Message handler ---------------------------------------------------- //

const CHUNK_SIZE = 10000;

self.onmessage = async function ({ data: { shpBuf, dbfBuf } }) {
  try {
    postMessage({ type: 'progress', pct: 30, msg: '[2/3] 지오메트리 파싱 중...' });
    const geometries = shp.parseShp(shpBuf);
    const total = geometries.length;

    let attributes = [];
    if (dbfBuf) {
      postMessage({ type: 'progress', pct: 55, msg: '[3/3] DBF 속성 읽는 중...' });
      attributes = shp.parseDbf(dbfBuf);
    }

    postMessage({ type: 'progress', pct: 70, msg: `공간 인덱스 생성 중... (0 / ${total.toLocaleString()})` });

    // Send raw features + raw bbox in chunks
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      const end   = Math.min(start + CHUNK_SIZE, total);
      const chunk = [];

      for (let i = start; i < end; i++) {
        chunk.push({
          rawFeature: { type: 'Feature', geometry: geometries[i], properties: attributes[i] || {} },
          rawBbox: rawBbox(geometries[i]),
          wgs84: null,   // filled lazily on main thread
        });
      }

      const pct = 70 + Math.round((end / total) * 28);
      postMessage({
        type: 'chunk',
        data: chunk,
        pct,
        msg: `공간 인덱스 생성 중... (${end.toLocaleString()} / ${total.toLocaleString()})`,
      });

      await new Promise(r => setTimeout(r, 0));
    }

    postMessage({ type: 'done', total });
  } catch (err) {
    postMessage({ type: 'error', msg: err.message || String(err) });
  }
};
