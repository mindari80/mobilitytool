/**
 * DLT Binary File Parser (JavaScript port of dlt_gpslog_parser4.py)
 * Reads DLT files in the browser using File API (ArrayBuffer, chunked)
 */

'use strict';

const DLT_MARKER = new Uint8Array([0x44, 0x4C, 0x54, 0x01]); // 'DLT\x01'
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB

const WALLCLOCK_RE = /(\d{4})[/\-](\d{2})[/\-](\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/;
const EPOCH_TIME_RE = /\btime:\s*(\d{10,13})\b/;

// ---- Timestamp helpers --------------------------------------------------- //

/**
 * Parse a timestamp from decoded DLT record text.
 * Returns a Date object or null.
 */
export function parseDltTimestamp(text) {
  if (!text.includes('time:') && !text.includes('/') && !text.includes('-')) return null;

  const wm = WALLCLOCK_RE.exec(text);
  if (wm) {
    const [, year, month, day, hour, min, sec, frac] = wm;
    // milliseconds (3 digits)
    const ms = frac ? parseInt(frac.padEnd(3, '0').slice(0, 3), 10) : 0;
    return new Date(+year, +month - 1, +day, +hour, +min, +sec, ms);
  }

  const em = EPOCH_TIME_RE.exec(text);
  if (em) {
    let ts = parseFloat(em[1]);
    if (em[1].length === 13) ts /= 1000.0;
    return new Date(ts * 1000);
  }

  return null;
}

// ---- Low-level binary helpers -------------------------------------------- //

/**
 * Find the first occurrence of DLT\x01 in a Uint8Array starting at fromIndex.
 * Returns the index or -1.
 */
function findMarker(buf, fromIndex = 0) {
  const len = buf.length - 3;
  for (let i = fromIndex; i <= len; i++) {
    if (buf[i] === 0x44 && buf[i + 1] === 0x4C && buf[i + 2] === 0x54 && buf[i + 3] === 0x01) {
      return i;
    }
  }
  return -1;
}

/**
 * Find all marker positions in a Uint8Array.
 * Returns an array of indices.
 */
function findAllMarkers(buf) {
  const positions = [];
  let from = 0;
  while (true) {
    const idx = findMarker(buf, from);
    if (idx < 0) break;
    positions.push(idx);
    from = idx + 4;
  }
  return positions;
}

/**
 * Extract the DLT relative timestamp from a record (bytes 4-11).
 * Returns seconds as a float, or null on error.
 */
function extractRelativeTime(recordBytes) {
  if (recordBytes.length < 12) return null;
  if (recordBytes[0] !== 0x44 || recordBytes[1] !== 0x4C ||
      recordBytes[2] !== 0x54 || recordBytes[3] !== 0x01) return null;

  const view = new DataView(
    recordBytes.buffer,
    recordBytes.byteOffset,
    recordBytes.byteLength
  );
  const seconds = view.getUint32(4, true);      // little-endian
  const microseconds = view.getUint32(8, true);  // little-endian
  if (microseconds >= 1_000_000) return null;
  return seconds + microseconds / 1_000_000;
}

/**
 * Remove null bytes from a Uint8Array and decode as UTF-8.
 */
function decodeRecord(recordBytes) {
  // Filter out 0x00 bytes
  let count = 0;
  for (let i = 0; i < recordBytes.length; i++) {
    if (recordBytes[i] !== 0) count++;
  }
  const clean = new Uint8Array(count);
  let j = 0;
  for (let i = 0; i < recordBytes.length; i++) {
    if (recordBytes[i] !== 0) clean[j++] = recordBytes[i];
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(clean);
}

/**
 * Quick byte-level check: is this record likely interesting?
 * Avoids full decode for records we don't care about.
 */
function isInterestingRecord(recordBytes, interestingMarkers) {
  if (!interestingMarkers || interestingMarkers.length === 0) return true;

  for (const marker of interestingMarkers) {
    if (bytesContain(recordBytes, marker)) return true;
  }

  // JSON-ish fragments (route continuation)
  let hasOpen = false, hasClose = false, quoteCount = 0, hasColon = false;
  for (let i = 0; i < recordBytes.length; i++) {
    const b = recordBytes[i];
    if (b === 0x7B) hasOpen = true;  // {
    if (b === 0x7D) hasClose = true; // }
    if (b === 0x22) quoteCount++;    // "
    if (b === 0x3A) hasColon = true; // :
  }
  if (hasOpen && hasClose && quoteCount >= 2 && hasColon) return true;

  return false;
}

function bytesContain(haystack, needle) {
  if (needle.length === 0) return true;
  const first = needle[0];
  const limit = haystack.length - needle.length;
  for (let i = 0; i <= limit; i++) {
    if (haystack[i] !== first) continue;
    let match = true;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

// Pre-encode interesting marker strings to byte arrays
export function encodeMarkers(strings) {
  return strings.map(s => new TextEncoder().encode(s));
}

// ---- Concat Uint8Arrays -------------------------------------------------- //
function concatUint8(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

// ---- Median helper (mirrors Python's statistics.median usage) ------------ //
export function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---- Main async iterator ------------------------------------------------- //

/**
 * Async generator that yields DLT records from a File object.
 *
 * Each yielded record is:
 *   { text: string, timestamp: Date|null }
 *
 * @param {File} file
 * @param {Function|null} progressCallback  (bytesRead, totalBytes)
 * @param {Uint8Array[]|null} interestingMarkers  pre-encoded byte arrays
 */
export async function* iterateDltRecords(file, progressCallback = null, interestingMarkers = null) {
  const totalSize = file.size;
  let bytesRead = 0;
  let carry = new Uint8Array(0);
  let firstMarkerFound = false;
  const offsetSamples = [];
  let relativeOffset = null; // wallclock - relativeTime

  function buildRecord(recordBytes) {
    if (!isInterestingRecord(recordBytes, interestingMarkers)) return null;

    const text = decodeRecord(recordBytes);
    const wallclock = parseDltTimestamp(text);
    const relativeTime = extractRelativeTime(recordBytes);

    if (wallclock !== null && relativeTime !== null && offsetSamples.length < 512) {
      offsetSamples.push(wallclock.getTime() / 1000 - relativeTime);
      relativeOffset = medianOf(offsetSamples);
    }

    let timestamp = wallclock;
    if (timestamp === null && relativeOffset !== null && relativeTime !== null) {
      timestamp = new Date((relativeTime + relativeOffset) * 1000);
    }

    return { text, timestamp };
  }

  let offset = 0;
  while (offset < totalSize) {
    const end = Math.min(offset + CHUNK_SIZE, totalSize);
    const slice = file.slice(offset, end);
    const ab = await slice.arrayBuffer();
    const chunk = new Uint8Array(ab);
    bytesRead += chunk.length;
    offset += chunk.length;

    if (progressCallback) progressCallback(Math.min(bytesRead, totalSize), totalSize);

    let buffer = concatUint8(carry, chunk);
    const positions = findAllMarkers(buffer);

    if (positions.length === 0) {
      carry = firstMarkerFound
        ? buffer.slice(Math.max(0, buffer.length - 3))
        : buffer;
      continue;
    }

    firstMarkerFound = true;

    // Trim buffer to start at first marker
    if (positions[0] > 0) {
      const shift = positions[0];
      buffer = buffer.slice(shift);
      for (let i = 0; i < positions.length; i++) positions[i] -= shift;
    }

    // We can only emit records for which we know the end (= next marker start)
    if (positions.length === 1) {
      carry = buffer;
      continue;
    }

    for (let i = 0; i < positions.length - 1; i++) {
      const start = positions[i];
      const end2 = positions[i + 1];
      const record = buildRecord(buffer.slice(start, end2));
      if (record !== null) yield record;
    }

    carry = buffer.slice(positions[positions.length - 1]);
  }

  // Flush carry
  if (carry.length > 0) {
    if (carry[0] === 0x44 && carry[1] === 0x4C && carry[2] === 0x54 && carry[3] === 0x01) {
      const record = buildRecord(carry);
      if (record !== null) yield record;
    } else {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(carry);
      const trimmed = text.replace(/\0/g, '').trim();
      if (trimmed) {
        yield { text: trimmed, timestamp: parseDltTimestamp(trimmed) };
      }
    }
  }

  if (progressCallback) progressCallback(totalSize, totalSize);
}
