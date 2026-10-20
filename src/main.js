import { Map as MapLibreMap, Popup, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import "./route-filter.css";
import * as turf from "@turf/turf";

setWorkerUrl(workerUrl);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const SERVICE_DATE = "2026-10-20"; // Must fall inside your GTFS feed's calendar range
const PEOPLE_PER_DOT = 10;
const NO_MATCH = ["==", ["get", "route_id"], "\u0000"];

const DATE_LABEL = new Date(`${SERVICE_DATE}T12:00:00Z`).toLocaleDateString(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC"
});

const state = {
  selectedRouteIds: new Set(), // Set of selected route IDs (empty = ALL)
  searchText: "",
  distanceToSelectedOnly: false
};

// Data state
let routes = [];
const routeById = new Map();
const routeOrder = new Map();
let routesGeoJson = null;
let baseStops = null;
let allStops = null;
let currentStops = null;
let serviceIndex = null;
let populationDots = null;
let lastDistanceKey = null;
let activePopup = null;

// ---------------------------------------------------------------------------
// 1. App Markup
// ---------------------------------------------------------------------------
document.querySelector("#app").innerHTML = `
  <div id="map"></div>
  <aside class="legend" aria-label="Map controls and legend">
    <h1>Transit Access</h1>

    <section class="route-filter" aria-labelledby="route-filter-heading">
      <div class="route-filter__header">
        <h2 id="route-filter-heading">Routes</h2>
        <div class="route-filter__actions">
          <button type="button" id="route-select-all" class="pill-button">Select all</button>
          <button type="button" id="route-clear" class="pill-button" hidden>Clear selection</button>
        </div>
      </div>
      <label class="visually-hidden" for="route-search">Search routes by number or name</label>
      <input id="route-search" type="search" placeholder="Search by number or name…" autocomplete="off" disabled />
      <div id="route-list" class="route-list" role="group" aria-label="Bus routes">
        <p class="route-status">Loading routes…</p>
      </div>
      <p id="route-empty" class="route-status" hidden></p>
      <div id="route-summary" class="route-summary" hidden aria-live="polite"></div>
      <p class="route-hint">Tip: Check multiple routes to compare coverage. Press Esc to reset filters.</p>
    </section>

    <h2 id="distance-heading">Distance to Nearest Stop</h2>
    <label id="distance-toggle-wrap" class="distance-toggle" hidden>
      <input type="checkbox" id="distance-toggle" />
      <span>Measure to selected routes' stops only</span>
    </label>
    <div class="distance-scale"></div>
    <div class="scale-labels"><span>0 m</span><span>400 m</span><span>800 m</span><span>1.2+ km</span></div>
    <p>Each dot represents about ${PEOPLE_PER_DOT} people.</p>

    <h2>Overlapping Route Lines</h2>
    <div class="route-scale"></div>
    <div class="scale-labels"><span>Fewer</span><span>More</span></div>
    <p><span class="stop-key"></span> Bus stop</p>
    <small>Dots are randomly placed within census areas. Distances are straight-line estimates, not walking distances. Route shading shows overlapping shapes, not service frequency. Service figures are for ${DATE_LABEL}.</small>
  </aside>
`;

const searchEl = document.querySelector("#route-search");
const routeListEl = document.querySelector("#route-list");
const routeEmptyEl = document.querySelector("#route-empty");
const summaryEl = document.querySelector("#route-summary");
const selectAllBtn = document.querySelector("#route-select-all");
const clearBtn = document.querySelector("#route-clear");
const distanceHeading = document.querySelector("#distance-heading");
const distanceToggleWrap = document.querySelector("#distance-toggle-wrap");
const distanceToggle = document.querySelector("#distance-toggle");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function routeLabel(route) {
  return `Route ${route.shortName || route.id}`;
}

function routeBadge(route, tag = "span", props = {}) {
  const badge = el(tag, { ...props, className: "route-badge" }, route.shortName || route.id);
  badge.style.setProperty("--route-color", route.color);
  badge.style.setProperty("--route-text", route.textColor);
  return badge;
}

function formatClock(minutes) {
  const total = Math.round(minutes);
  const nextDay = total >= 1440;
  const h24 = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h24 >= 12 ? "PM" : "AM"}${nextDay ? " (next day)" : ""}`;
}

function normalizeColor(value, fallback) {
  const hex = (value || "").replace(/^#/, "").trim();
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : fallback;
}

function readableTextColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance > 0.6 ? "#111827" : "#ffffff";
}

function sortRouteIds(ids) {
  return ids.sort((a, b) => (routeOrder.get(a) ?? 1e9) - (routeOrder.get(b) ?? 1e9));
}

// ---------------------------------------------------------------------------
// GTFS Loading & Parsing
// ---------------------------------------------------------------------------
function splitCSVLine(line) {
  if (!line.includes('"')) return line.split(",");
  const values = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      values.push(field);
      field = "";
    } else field += ch;
  }
  values.push(field);
  return values;
}

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headers = splitCSVLine(lines[0] || "").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = splitCSVLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (values[j] ?? "").trim();
    rows.push(row);
  }
  return rows;
}

const gtfsCache = new Map();
function loadGtfs(name, { optional = false } = {}) {
  if (!gtfsCache.has(name)) {
    gtfsCache.set(
      name,
      fetch(`/data/${name}.txt`).then((res) => {
        if (!res.ok) {
          if (optional) return [];
          throw new Error(`Could not load ${name}.txt (HTTP ${res.status})`);
        }
        return res.text().then(parseCSV);
      })
    );
  }
  return gtfsCache.get(name);
}

function getActiveServices(calendarRows, exceptionRows, dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  const dayName = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][date.getUTCDay()];

  const gtfsDate = dateString.replaceAll("-", "");
  const active = new Set();

  for (const row of calendarRows) {
    if (row[dayName] === "1" && gtfsDate >= row.start_date && gtfsDate <= row.end_date) {
      active.add(row.service_id);
    }
  }

  for (const row of exceptionRows) {
    if (row.date !== gtfsDate) continue;
    if (row.exception_type === "1") active.add(row.service_id);
    else if (row.exception_type === "2") active.delete(row.service_id);
  }

  return active;
}

function gtfsTimeToMinutes(time) {
  if (!time) return null;
  const parts = time.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] * 60 + parts[1] + parts[2] / 60;
}

async function buildServiceIndex(dateString) {
  const [stopTimes, trips, calendar, exceptions] = await Promise.all([
    loadGtfs("stop_times"),
    loadGtfs("trips"),
    loadGtfs("calendar", { optional: true }),
    loadGtfs("calendar_dates", { optional: true })
  ]);

  const activeServices = getActiveServices(calendar, exceptions, dateString);
  const activeTrips = new Map();
  for (const trip of trips) {
    if (activeServices.has(trip.service_id)) activeTrips.set(trip.trip_id, trip);
  }

  const stopRouteTimes = new Map();
  const routeStats = new Map();
  const tripStart = new Map();

  for (const row of stopTimes) {
    const trip = activeTrips.get(row.trip_id);
    if (!trip) continue;
    const minutes = gtfsTimeToMinutes(row.departure_time || row.arrival_time);

    if (minutes !== null) {
      const prev = tripStart.get(row.trip_id);
      if (prev === undefined || minutes < prev) tripStart.set(row.trip_id, minutes);

      let stats = routeStats.get(trip.route_id);
      if (!stats) {
        stats = { first: Infinity, last: -Infinity, startsByDirection: new Map() };
        routeStats.set(trip.route_id, stats);
      }
      if (minutes < stats.first) stats.first = minutes;
      if (minutes > stats.last) stats.last = minutes;
    }

    if (row.pickup_type === "1") continue;

    let byRoute = stopRouteTimes.get(row.stop_id);
    if (!byRoute) {
      byRoute = new Map();
      stopRouteTimes.set(row.stop_id, byRoute);
    }
    let entry = byRoute.get(trip.route_id);
    if (!entry) {
      entry = { count: 0, times: [] };
      byRoute.set(trip.route_id, entry);
    }
    entry.count++;
    if (minutes !== null) entry.times.push(minutes);
  }

  for (const [tripId, start] of tripStart) {
    const trip = activeTrips.get(tripId);
    const stats = routeStats.get(trip.route_id);
    const direction = trip.direction_id || "0";
    if (!stats.startsByDirection.has(direction)) stats.startsByDirection.set(direction, []);
    stats.startsByDirection.get(direction).push(start);
  }

  for (const stats of routeStats.values()) {
    let tripCount = 0;
    const gaps = [];
    for (const starts of stats.startsByDirection.values()) {
      tripCount += starts.length;
      if (starts.length >= 2) {
        starts.sort((a, b) => a - b);
        gaps.push((starts[starts.length - 1] - starts[0]) / (starts.length - 1));
      }
    }
    stats.tripCount = tripCount;
    stats.avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  }

  return { stopRouteTimes, routeStats };
}

async function stopsToGeoJson() {
  const rows = await loadGtfs("stops");
  const features = rows
    .map((row) => ({
      type: "Feature",
      properties: { stop_id: row.stop_id, stop_name: row.stop_name },
      geometry: { type: "Point", coordinates: [Number(row.stop_lon), Number(row.stop_lat)] }
    }))
    .filter((f) => f.geometry.coordinates.every(Number.isFinite));

  return { type: "FeatureCollection", features };
}

async function routesToGeoJSON() {
  const [shapeRows, tripRows, routeRows] = await Promise.all([
    loadGtfs("shapes"),
    loadGtfs("trips"),
    loadGtfs("routes")
  ]);

  const routeList = routeRows.map((row) => {
    const color = normalizeColor(row.route_color, "#FF9500");
    return {
      id: row.route_id,
      shortName: row.route_short_name || "",
      longName: row.route_long_name || "",
      color,
      textColor: normalizeColor(row.route_text_color, readableTextColor(color))
    };
  });
  routeList.sort((a, b) => (a.shortName || a.id).localeCompare(b.shortName || b.id, undefined, { numeric: true }));
  const infoById = new Map(routeList.map((r) => [r.id, r]));

  const shapeToRoute = {};
  for (const trip of tripRows) {
    if (trip.shape_id) shapeToRoute[trip.shape_id] = trip.route_id;
  }

  const shapes = {};
  for (const row of shapeRows) {
    if (!shapes[row.shape_id]) shapes[row.shape_id] = [];
    shapes[row.shape_id].push(row);
  }

  const features = [];
  for (const [shapeId, points] of Object.entries(shapes)) {
    const route = infoById.get(shapeToRoute[shapeId]);
    if (!route || points.length < 2) continue;
    points.sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence));

    features.push({
      type: "Feature",
      properties: {
        shape_id: shapeId,
        route_id: route.id,
        route_short_name: route.shortName,
        route_long_name: route.longName,
        route_color: route.color
      },
      geometry: {
        type: "LineString",
        coordinates: points.map((p) => [Number(p.shape_pt_lon), Number(p.shape_pt_lat)])
      }
    });
  }

  return { routesGeoJson: { type: "FeatureCollection", features }, routes: routeList };
}

// Builds stop features based on the set of selected route IDs (empty set = ALL)
function buildStopFeatures(selectedSet) {
  const features = [];
  const isAll = selectedSet.size === 0;

  for (const stop of baseStops.features) {
    const served = serviceIndex.stopRouteTimes.get(stop.properties.stop_id);
    if (!served) continue;

    const allRouteIds = sortRouteIds([...served.keys()]);
    let departures = 0;
    let times = [];
    let matchingRoutesCount = 0;

    for (const [rId, entry] of served.entries()) {
      if (isAll || selectedSet.has(rId)) {
        departures += entry.count;
        times = times.concat(entry.times);
        matchingRoutesCount++;
      }
    }

    if (departures === 0 && !isAll) continue; // Skip stops not served by active selection

    times.sort((a, b) => a - b);

    features.push({
      type: "Feature",
      geometry: stop.geometry,
      properties: {
        ...stop.properties,
        departures,
        routeCount: isAll ? allRouteIds.length : matchingRoutesCount,
        routeIds: allRouteIds.join("|"),
        averageHeadway: times.length >= 2 ? (times[times.length - 1] - times[0]) / (times.length - 1) : null
      }
    });
  }

  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Population Dots
// ---------------------------------------------------------------------------
function generatePopulationDots(geojson, peoplePerDot = 1) {
  const dots = [];

  for (const feature of geojson.features) {
    const population = feature.properties.POP100 || 0;
    const dotCount = Math.round(population / peoplePerDot);
    if (dotCount === 0) continue;

    const bbox = turf.bbox(feature);
    let created = 0;

    while (created < dotCount) {
      const randomPoint = turf.randomPoint(1, { bbox }).features[0];
      if (turf.booleanPointInPolygon(randomPoint, feature)) {
        randomPoint.properties = { populationRepresented: peoplePerDot };
        dots.push(randomPoint);
        created++;
      }
    }
  }

  return { type: "FeatureCollection", features: dots };
}

function colorPopulationByDistance(dots, stops) {
  const toVector = ([longitude, latitude]) => {
    const lat = (latitude * Math.PI) / 180;
    const lon = (longitude * Math.PI) / 180;
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  };

  const stopVectors = stops.features.map((stop) => toVector(stop.geometry.coordinates));

  for (const dot of dots.features) {
    const point = toVector(dot.geometry.coordinates);
    let nearestSquared = Infinity;

    for (const stop of stopVectors) {
      const squared = (point[0] - stop[0]) ** 2 + (point[1] - stop[1]) ** 2 + (point[2] - stop[2]) ** 2;
      if (squared < nearestSquared) nearestSquared = squared;
    }

    dot.properties.stopDistanceMeters = stopVectors.length
      ? 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(nearestSquared) / 2))
      : null;
  }
}

// ---------------------------------------------------------------------------
// 2. Map Setup
// ---------------------------------------------------------------------------
const map = new MapLibreMap({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [-82.33, 29.65],
  zoom: 12
});

map.on("load", async () => {
  try {
    await init();
  } catch (err) {
    console.error(err);
    routeListEl.replaceChildren(
      el(
        "p",
        { className: "route-status route-status--error" },
        `Couldn't load route data. Check that the GTFS files are in /data. (${err.message})`
      )
    );
  }
});

async function init() {
  const [rawStops, routeData, censusData, index] = await Promise.all([
    stopsToGeoJson(),
    routesToGeoJSON(),
    fetch("/data/populationOfGnv.geojson").then((r) => r.json()),
    buildServiceIndex(SERVICE_DATE)
  ]);

  baseStops = rawStops;
  routesGeoJson = routeData.routesGeoJson;
  routes = routeData.routes;
  routes.forEach((route, i) => {
    routeById.set(route.id, route);
    routeOrder.set(route.id, i);
  });
  serviceIndex = index;

  allStops = buildStopFeatures(new Set());
  currentStops = allStops;

  populationDots = generatePopulationDots(censusData, PEOPLE_PER_DOT);
  colorPopulationByDistance(populationDots, allStops);
  lastDistanceKey = "ALL";

  addSourcesAndLayers();
  wireMapInteractions();
  wireControls();
  renderRouteList();

  const initialRoutes = readHashRoutes();
  if (initialRoutes.length > 0) {
    initialRoutes.forEach((id) => state.selectedRouteIds.add(id));
    updateRouteSelection({ fit: true });
  }
}

function addSourcesAndLayers() {
  map.addSource("population-dots", { type: "geojson", data: populationDots });
  map.addSource("stops", { type: "geojson", data: currentStops });
  map.addSource("route", { type: "geojson", data: routesGeoJson });
  map.addSource("key-places", { type: "geojson", data: "/data/key-places.geojson" });

  const zoomWidth = (z8, z12, z16) => ["interpolate", ["linear"], ["zoom"], 8, z8, 12, z12, 16, z16];
  const roundLines = { "line-join": "round", "line-cap": "round" };

  map.addLayer({
    id: "route-layer",
    type: "line",
    source: "route",
    layout: roundLines,
    paint: {
      "line-color": "#173b65",
      "line-opacity": 0.23,
      "line-opacity-transition": { duration: 300 },
      "line-width": zoomWidth(2, 4, 6)
    }
  });

  map.addLayer({
    id: "population-dots-layer",
    type: "circle",
    source: "population-dots",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2, 16, 5],
      "circle-color": [
        "case",
        ["==", ["get", "stopDistanceMeters"], null],
        "#89929a",
        [
          "interpolate",
          ["linear"],
          ["get", "stopDistanceMeters"],
          0, "#008577",
          400, "#8ebf87",
          800, "#efac48",
          1200, "#cf443c"
        ]
      ],
      "circle-opacity": 0.7
    }
  });

  map.addLayer({
    id: "route-selected-casing",
    type: "line",
    source: "route",
    filter: NO_MATCH,
    layout: roundLines,
    paint: { "line-color": "#ffffff", "line-opacity": 0.9, "line-width": zoomWidth(5, 9, 13) }
  });

  map.addLayer({
    id: "route-selected-layer",
    type: "line",
    source: "route",
    filter: NO_MATCH,
    layout: roundLines,
    paint: { "line-color": ["get", "route_color"], "line-width": zoomWidth(3, 5, 8) }
  });

  map.addLayer({
    id: "route-hit-layer",
    type: "line",
    source: "route",
    paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 14 }
  });

  map.addLayer({
    id: "stop-frequency-layer",
    type: "circle",
    source: "stops",
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["get", "departures"],
        0, 2, 10, 5, 30, 9, 60, 14, 100, 19
      ],
      "circle-color": [
        "interpolate", ["linear"], ["get", "departures"],
        0, "#94a3b8", 10, "#f59e0b", 30, "#ef4444", 60, "#8b5cf6", 100, "#15803d"
      ],
      "circle-opacity": 0.85,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.2
    }
  });

  map.addLayer({
    id: "route-number-layer",
    type: "symbol",
    source: "route",
    layout: {
      "symbol-placement": "line",
      "text-field": ["get", "route_short_name"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 14, 14, 18, 18],
      "text-keep-upright": true,
      "text-padding": 8
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "#173b65",
      "text-halo-width": 2,
      "text-halo-blur": 0.25
    }
  });

  map.addLayer({
    id: "key-places-layer",
    type: "symbol",
    source: "key-places",
    layout: {
      "text-field": "★",
      "text-size": ["interpolate", ["linear"], ["zoom"], 8, 24, 12, 36, 16, 52]
    },
    paint: {
      "text-color": "#34C759",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5
    }
  });
}

// ---------------------------------------------------------------------------
// Multi-Route Selection Logic
// ---------------------------------------------------------------------------
function toggleRoute(routeId) {
  if (state.selectedRouteIds.has(routeId)) {
    state.selectedRouteIds.delete(routeId);
  } else {
    state.selectedRouteIds.add(routeId);
  }
  updateRouteSelection({ fit: false });
}

function updateRouteSelection({ fit = false } = {}) {
  const isAll = state.selectedRouteIds.size === 0;
  activePopup?.remove();

  currentStops = isAll ? allStops : buildStopFeatures(state.selectedRouteIds);
  map.getSource("stops").setData(currentStops);

  applyRouteSelectionToMap();
  updateDistanceColors();

  clearBtn.hidden = isAll;
  distanceToggleWrap.hidden = isAll;
  updateRouteListSelection();
  renderSummary();
  syncHash();

  if (fit && !isAll) fitToSelectedRoutes();
}

function applyRouteSelectionToMap() {
  const isAll = state.selectedRouteIds.size === 0;

  if (isAll) {
    map.setPaintProperty("route-layer", "line-opacity", 0.23);
    map.setFilter("route-selected-casing", NO_MATCH);
    map.setFilter("route-selected-layer", NO_MATCH);
    map.setFilter("route-number-layer", null);
    map.setPaintProperty("route-number-layer", "text-halo-color", "#173b65");
    map.setPaintProperty("route-number-layer", "text-color", "#ffffff");
  } else {
    const selectedArray = Array.from(state.selectedRouteIds);
    const filterMatch = ["in", ["get", "route_id"], ["literal", selectedArray]];

    map.setPaintProperty("route-layer", "line-opacity", 0.08);
    map.setFilter("route-selected-casing", filterMatch);
    map.setFilter("route-selected-layer", filterMatch);
    map.setFilter("route-number-layer", filterMatch);
  }
}

function fitPadding() {
  const base = 48;
  const padding = { top: base, bottom: base, left: base, right: base };
  const mapRect = map.getContainer().getBoundingClientRect();
  const legendRect = document.querySelector(".legend").getBoundingClientRect();

  if (window.innerWidth > 700 && legendRect.width) {
    const legendOnLeft = legendRect.left + legendRect.width / 2 < mapRect.left + mapRect.width / 2;
    if (legendOnLeft) padding.left += Math.max(0, legendRect.right - mapRect.left);
    else padding.right += Math.max(0, mapRect.right - legendRect.left);
  }
  if (padding.left + padding.right > mapRect.width * 0.8) {
    padding.left = padding.right = base;
  }
  return padding;
}

function fitToSelectedRoutes() {
  if (state.selectedRouteIds.size === 0) return;
  const selectedArray = Array.from(state.selectedRouteIds);
  const shapes = routesGeoJson.features.filter((f) => selectedArray.includes(f.properties.route_id));
  const target = shapes.length ? { type: "FeatureCollection", features: shapes } : currentStops;
  if (!target.features.length) return;

  const [west, south, east, north] = turf.bbox(target);
  map.fitBounds(
    [
      [west, south],
      [east, north]
    ],
    { padding: fitPadding(), maxZoom: 15, duration: 800 }
  );
}

function updateDistanceColors() {
  const useSelected = state.distanceToSelectedOnly && state.selectedRouteIds.size > 0;
  const key = useSelected ? Array.from(state.selectedRouteIds).sort().join(",") : "ALL";

  distanceHeading.textContent = useSelected
    ? `Distance to Selected Routes' Stops`
    : "Distance to Nearest Stop";

  if (key === lastDistanceKey) return;
  colorPopulationByDistance(populationDots, useSelected ? currentStops : allStops);
  map.getSource("population-dots").setData(populationDots);
  lastDistanceKey = key;
}

function readHashRoutes() {
  const match = location.hash.match(/routes=([^&]+)/);
  if (!match) return [];
  return decodeURIComponent(match[1]).split(",").filter((id) => routeById.has(id));
}

function syncHash() {
  const url = new URL(location.href);
  if (state.selectedRouteIds.size === 0) {
    url.hash = "";
  } else {
    const ids = Array.from(state.selectedRouteIds).sort().join(",");
    url.hash = `routes=${encodeURIComponent(ids)}`;
  }
  history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------
// Sidebar UI & List Rendering
// ---------------------------------------------------------------------------
function renderRouteList() {
  const query = state.searchText.trim().toLowerCase();
  const matches = routes.filter(
    (r) =>
      !query ||
      r.shortName.toLowerCase().includes(query) ||
      r.longName.toLowerCase().includes(query) ||
      `route ${r.shortName}`.toLowerCase().includes(query)
  );

  routeListEl.replaceChildren(
    ...matches.map((route) => {
      const trips = serviceIndex.routeStats.get(route.id)?.tripCount || 0;
      const isSelected = state.selectedRouteIds.has(route.id);

      const checkbox = el("input", {
        type: "checkbox",
        checked: isSelected,
        ariaLabel: `Select ${routeLabel(route)}`
      });

      const item = el(
        "label",
        {
          className: `route-item${trips ? "" : " is-inactive"}${isSelected ? " is-selected" : ""}`,
          "data-route-id": route.id,
          title: trips
            ? `${routeLabel(route)}: ${trips} trips on ${DATE_LABEL}`
            : `${routeLabel(route)}: no trips scheduled on ${DATE_LABEL}`
        },
        checkbox,
        routeBadge(route),
        el("span", { className: "route-item__name" }, route.longName || routeLabel(route)),
        el("span", { className: "route-item__meta" }, trips ? `${trips} trips` : "No service")
      );

      item.style.setProperty("--route-color", route.color);

      checkbox.addEventListener("change", () => {
        toggleRoute(route.id);
      });

      return item;
    })
  );

  routeEmptyEl.hidden = matches.length > 0;
  if (!matches.length) routeEmptyEl.textContent = `No routes match "${state.searchText.trim()}".`;
}

function updateRouteListSelection() {
  for (const item of routeListEl.querySelectorAll(".route-item")) {
    const id = item.dataset.routeId;
    const isSelected = state.selectedRouteIds.has(id);
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = isSelected;
    item.classList.toggle("is-selected", isSelected);
  }
}

function renderSummary() {
  const selectedCount = state.selectedRouteIds.size;
  if (selectedCount === 0) {
    summaryEl.hidden = true;
    summaryEl.replaceChildren();
    return;
  }

  let totalTrips = 0;
  let totalStops = currentStops.features.length;

  state.selectedRouteIds.forEach((id) => {
    totalTrips += serviceIndex.routeStats.get(id)?.tripCount || 0;
  });

  summaryEl.replaceChildren(
    el(
      "div",
      { className: "route-summary__title" },
      el("h3", {}, `${selectedCount} Route${selectedCount > 1 ? "s" : ""} Selected`)
    ),
    el("dl", {}, [
      [el("dt", {}, "Stops served"), el("dd", {}, String(totalStops))],
      [el("dt", {}, `Combined daily trips`), el("dd", {}, String(totalTrips))]
    ]),
    el(
      "div",
      { className: "route-summary__actions" },
      el("button", { type: "button", className: "pill-button", onClick: fitToSelectedRoutes }, "Zoom to selection")
    )
  );
  summaryEl.hidden = false;
}

function wireControls() {
  searchEl.disabled = false;

  searchEl.addEventListener("input", () => {
    state.searchText = searchEl.value;
    renderRouteList();
  });

  selectAllBtn.addEventListener("click", () => {
    routes.forEach((r) => state.selectedRouteIds.add(r.id));
    updateRouteSelection({ fit: true });
  });

  clearBtn.addEventListener("click", () => {
    state.selectedRouteIds.clear();
    updateRouteSelection({ fit: false });
  });

  distanceToggle.addEventListener("change", () => {
    state.distanceToSelectedOnly = distanceToggle.checked;
    updateDistanceColors();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (activePopup) return activePopup.remove();
    if (state.selectedRouteIds.size > 0) {
      state.selectedRouteIds.clear();
      updateRouteSelection({ fit: false });
    }
  });

  window.addEventListener("hashchange", () => {
    const ids = readHashRoutes();
    state.selectedRouteIds = new Set(ids);
    updateRouteSelection({ fit: false });
  });
}

// ---------------------------------------------------------------------------
// Map Interactions & Popups
// ---------------------------------------------------------------------------
function openPopup(lngLat, content) {
  activePopup?.remove();
  const popup = new Popup({ maxWidth: "280px" }).setLngLat(lngLat).setDOMContent(content).addTo(map);
  popup.on("close", () => {
    if (activePopup === popup) activePopup = null;
  });
  activePopup = popup;
}

function routeChips(routeIds) {
  return el(
    "div",
    { className: "popup-routes" },
    routeIds.map((id) => {
      const route = routeById.get(id);
      const isSelected = state.selectedRouteIds.has(id);
      return routeBadge(route, "button", {
        type: "button",
        title: `Toggle ${routeLabel(route)}${route.longName ? ` – ${route.longName}` : ""}`,
        "aria-pressed": String(isSelected),
        onClick: () => toggleRoute(id)
      });
    })
  );
}

function showStopPopup(feature, lngLat) {
  const p = feature.properties;
  const routeIds = p.routeIds ? String(p.routeIds).split("|").filter((id) => routeById.has(id)) : [];
  const hasFilter = state.selectedRouteIds.size > 0;
  const headway = typeof p.averageHeadway === "number" ? `${Math.round(p.averageHeadway)} min` : "N/A";

  openPopup(
    lngLat,
    el(
      "div",
      { className: "map-popup" },
      el("strong", {}, p.stop_name || "Bus stop"),
      el("p", {}, hasFilter ? "Selected departures: " : "Daily departures: ", el("b", {}, String(p.departures ?? 0))),
      el("p", {}, "Avg headway: ", el("b", {}, headway)),
      el("p", {}, "Routes serving stop: ", el("b", {}, String(p.routeCount ?? 0))),
      routeIds.length ? routeChips(routeIds) : null
    )
  );
}

function wireMapInteractions() {
  map.on("click", (e) => {
    const stop = map.queryRenderedFeatures(e.point, { layers: ["stop-frequency-layer"] })[0];
    if (stop) return showStopPopup(stop, e.lngLat);

    const routeIds = [
      ...new Set(
        map.queryRenderedFeatures(e.point, { layers: ["route-hit-layer"] }).map((f) => f.properties.route_id)
      )
    ].filter((id) => routeById.has(id));

    if (routeIds.length === 1) {
      toggleRoute(routeIds[0]);
    } else if (routeIds.length > 1) {
      openPopup(
        e.lngLat,
        el(
          "div",
          { className: "map-popup" },
          el("strong", {}, `${routeIds.length} routes run here`),
          el("p", { className: "map-popup__hint" }, "Click a route to toggle selection:"),
          routeChips(sortRouteIds(routeIds))
        )
      );
    }
  });

  for (const layer of ["stop-frequency-layer", "route-hit-layer"]) {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
}