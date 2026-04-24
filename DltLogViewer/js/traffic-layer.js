/**
 * Traffic incident overlay — fetches TMAP top-open traffic API and renders
 * colored circle markers grouped by accident category so the UI can toggle
 * each category independently.
 */

'use strict';

import { getMap } from './map-viewer.js';
import {
  buildTrafficUrl,
  parseTrafficResponse,
  buildTrafficPopupHtml,
  colorForAccidentCode,
  categoryKeyForIncident,
  categoryLabel,
  groupIncidentsByCategory,
  CATEGORY_KEYS,
} from './traffic-api.js';

const categoryLayers = {};           // cat key -> L.layerGroup
const categoryVisible = {};          // cat key -> boolean
for (const k of CATEGORY_KEYS) categoryVisible[k] = true;

let currentIncidents = [];
let currentCounts = {};              // cat key -> number
let onCountsChange = null;

function ensureCategoryLayers() {
  const map = getMap();
  if (!map) return false;
  for (const k of CATEGORY_KEYS) {
    if (!categoryLayers[k]) categoryLayers[k] = L.layerGroup();
    if (categoryVisible[k] && !map.hasLayer(categoryLayers[k])) {
      categoryLayers[k].addTo(map);
    }
  }
  return true;
}

function clearAllCategoryLayers() {
  for (const k of CATEGORY_KEYS) {
    if (categoryLayers[k]) categoryLayers[k].clearLayers();
  }
}

function renderIncidents(incidents) {
  if (!ensureCategoryLayers()) return;
  clearAllCategoryLayers();
  const groups = groupIncidentsByCategory(incidents);
  const counts = {};
  for (const k of CATEGORY_KEYS) {
    counts[k] = groups[k].length;
    for (const inc of groups[k]) {
      const color = colorForAccidentCode(inc.accidentUpperCode);
      const marker = L.circleMarker([inc.lat, inc.lon], {
        radius: 6,
        color: '#111827',
        weight: 1.2,
        fillColor: color,
        fillOpacity: 0.9,
      });
      marker.bindPopup(buildTrafficPopupHtml(inc), { maxWidth: 340 });
      marker.bindTooltip(
        inc.accidentDetailName || inc.accidentUpperName || categoryLabel(k),
        { direction: 'top', offset: [0, -6] },
      );
      marker.addTo(categoryLayers[k]);
    }
  }
  currentCounts = counts;
  if (onCountsChange) onCountsChange(counts);
}

/**
 * Fetch traffic incidents for given bounds and render them.
 * If bounds is omitted, uses the map's current view.
 * @param {{minLat:number,minLon:number,maxLat:number,maxLon:number}=} bounds
 * @returns {Promise<{count:number, counts:Object}>}
 */
export async function loadTraffic(bounds) {
  const map = getMap();
  if (!map) throw new Error('map not initialised');
  let b = bounds;
  if (!b) {
    const v = map.getBounds();
    b = {
      minLat: v.getSouth(),
      minLon: v.getWest(),
      maxLat: v.getNorth(),
      maxLon: v.getEast(),
    };
  }
  const url = buildTrafficUrl(b);
  const res = await fetch(url, { method: 'GET', mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const incidents = parseTrafficResponse(json);
  currentIncidents = incidents;
  renderIncidents(incidents);
  return { count: incidents.length, counts: currentCounts };
}

/** Remove all traffic markers from the map. */
export function clearTraffic() {
  currentIncidents = [];
  clearAllCategoryLayers();
  currentCounts = {};
  if (onCountsChange) onCountsChange(currentCounts);
}

/** Show/hide a single category layer. */
export function toggleTrafficCategory(categoryKey, visible) {
  const map = getMap();
  if (!map) return;
  if (!CATEGORY_KEYS.includes(categoryKey)) return;
  categoryVisible[categoryKey] = !!visible;
  const layer = categoryLayers[categoryKey];
  if (!layer) return;
  if (visible) {
    if (!map.hasLayer(layer)) layer.addTo(map);
  } else if (map.hasLayer(layer)) {
    map.removeLayer(layer);
  }
}

/** Show/hide every category at once (master switch). */
export function toggleTrafficLayer(visible) {
  for (const k of CATEGORY_KEYS) toggleTrafficCategory(k, visible);
}

/** Register a callback that receives the latest { cat: count } map. */
export function setTrafficCountsListener(cb) { onCountsChange = cb; }

export function getTrafficIncidents() { return currentIncidents.slice(); }
export function getTrafficCounts() { return { ...currentCounts }; }
