import { Map as MapLibreMap, Popup, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import * as turf from "@turf/turf";

setWorkerUrl(workerUrl);

// 1. Render App Markup including Route Filter UI
document.querySelector("#app").innerHTML = `
  <div id="map"></div>
  <aside class="legend" aria-label="Map legend">
    <h1>Transit Access</h1>
    
    <h2>Filter Routes</h2>
    <div id="route-filter-container">
      <select id="route-select">
        <option value="ALL">All Routes</option>
      </select>
    </div>

    <h2>Distance to Nearest Stop</h2>
    <div class="distance-scale"></div>
    <div class="scale-labels"><span>0 m</span><span>400 m</span><span>800 m</span><span>1.2+ km</span></div>
    <p>Each dot represents about 10 people.</p>

    <h2>Overlapping Route Lines</h2>
    <div class="route-scale"></div>
    <div class="scale-labels"><span>Fewer</span><span>More</span></div>
    <p><span class="stop-key"></span> Bus stop</p>
    <small>Dots are randomly placed within census areas. Distances are straight-line estimates, not walking distances. Route shading shows overlapping shapes, not service frequency.</small>
  </aside>
`;

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].trim().split(",").map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const values = line.trim().split(",").map((v) => v.trim());
    const row = {};
    headers.forEach((header, i) => {
      row[header] = values[i];
    });
    return row;
  });
}

function getActiveServices(calendarRows, exceptionRows, dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  const dayName = [
    "sunday", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday"
  ][date.getUTCDay()];

  const gtfsDate = dateString.replaceAll("-", "");
  const active = new Set();

  for (const row of calendarRows) {
    if (
      row[dayName] === "1" &&
      gtfsDate >= row.start_date &&
      gtfsDate <= row.end_date
    ) {
      active.add(row.service_id);
    }
  }

  for (const row of exceptionRows) {
    if (row.date !== gtfsDate) continue;
    if (row.exception_type === "1") {
      active.add(row.service_id);
    } else if (row.exception_type === "2") {
      active.delete(row.service_id);
    }
  }

  return active;
}

function gtfsTimeToMinutes(time) {
  if (!time) return null;
  const parts = time.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return parts[0] * 60 + parts[1] + parts[2] / 60;
}

async function calculateStopFrequencies(stops, dateString, selectedRouteId = "ALL") {
  const [stopTimesRes, tripsRes, calendarRes, exceptionsRes] = await Promise.all([
    fetch("/data/stop_times.txt"),
    fetch("/data/trips.txt"),
    fetch("/data/calendar.txt"),
    fetch("/data/calendar_dates.txt")
  ]);

  const [stopTimes, trips, calendar, exceptions] = await Promise.all([
    stopTimesRes.text().then(parseCSV),
    tripsRes.text().then(parseCSV),
    calendarRes.text().then(parseCSV),
    exceptionsRes.text().then(parseCSV)
  ]);

  const activeServices = getActiveServices(calendar, exceptions, dateString);
  const tripLookup = new Map();

  for (const trip of trips) {
    if (activeServices.has(trip.service_id)) {
      if (selectedRouteId === "ALL" || trip.route_id === selectedRouteId) {
        tripLookup.set(trip.trip_id, trip);
      }
    }
  }

  const stopStats = new Map();

  for (const row of stopTimes) {
    const trip = tripLookup.get(row.trip_id);
    if (!trip) continue;
    if (row.pickup_type === "1") continue;

    const minutes = gtfsTimeToMinutes(row.departure_time);
    if (minutes === null) continue;

    if (!stopStats.has(row.stop_id)) {
      stopStats.set(row.stop_id, {
        times: [],
        routes: new Set()
      });
    }

    const stats = stopStats.get(row.stop_id);
    stats.times.push(minutes);
    stats.routes.add(trip.route_id);
  }

  stops.features.forEach((stop) => {
    const stats = stopStats.get(stop.properties.stop_id);
    const times = stats?.times.sort((a, b) => a - b) || [];

    let averageHeadway = null;
    if (times.length >= 2) {
      averageHeadway = (times[times.length - 1] - times[0]) / (times.length - 1);
    }

    stop.properties.departures = times.length;
    stop.properties.routeCount = stats?.routes.size || 0;
    stop.properties.averageHeadway = averageHeadway;
  });

  return stops;
}

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

  return {
    type: "FeatureCollection",
    features: dots
  };
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

async function stopsToGeoJson() {
  const response = await fetch("/data/stops.txt");
  const text = await response.text();
  const rows = parseCSV(text);

  const features = rows.map((row) => ({
    type: "Feature",
    properties: {
      stop_id: row.stop_id,
      stop_name: row.stop_name
    },
    geometry: {
      type: "Point",
      coordinates: [Number(row.stop_lon), Number(row.stop_lat)]
    }
  }));

  return { type: "FeatureCollection", features };
}

async function routesToGeoJSON() {
  const [shapesResponse, tripsResponse, routesResponse] = await Promise.all([
    fetch("/data/shapes.txt"),
    fetch("/data/trips.txt"),
    fetch("/data/routes.txt")
  ]);

  const shapesText = await shapesResponse.text();
  const tripsText = await tripsResponse.text();
  const routesText = await routesResponse.text();

  const shapeRows = parseCSV(shapesText);
  const tripRows = parseCSV(tripsText);
  const routeRows = parseCSV(routesText);

  const shapeToRoute = {};
  for (const trip of tripRows) {
    if (trip.shape_id) {
      shapeToRoute[trip.shape_id] = trip.route_id;
    }
  }

  const routeInfo = {};
  for (const route of routeRows) {
    routeInfo[route.route_id] = {
      shortName: route.route_short_name,
      longName: route.route_long_name,
      color: route.route_color || "FF9500"
    };
  }

  const shapes = {};
  for (const row of shapeRows) {
    if (!shapes[row.shape_id]) shapes[row.shape_id] = [];
    shapes[row.shape_id].push(row);
  }

  const features = [];
  for (const [shapeId, points] of Object.entries(shapes)) {
    points.sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence));
    const routeId = shapeToRoute[shapeId];
    const info = routeInfo[routeId] || {};

    features.push({
      type: "Feature",
      properties: {
        shape_id: shapeId,
        route_id: routeId,
        route_short_name: info.shortName,
        route_long_name: info.longName,
        route_color: `#${info.color}`
      },
      geometry: {
        type: "LineString",
        coordinates: points.map((p) => [Number(p.shape_pt_lon), Number(p.shape_pt_lat)])
      }
    });
  }

  return {
    routesGeoJson: { type: "FeatureCollection", features },
    routeList: routeRows
  };
}

// 2. Map Initialization
const map = new MapLibreMap({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [-82.33, 29.65],
  zoom: 12
});

map.on("load", async () => {
  const [rawStops, { routesGeoJson, routeList }, censusData] = await Promise.all([
    stopsToGeoJson(),
    routesToGeoJSON(),
    fetch("/data/populationOfGnv.geojson").then((r) => r.json())
  ]);

  // Populate Dropdown Options
  const routeSelect = document.querySelector("#route-select");
  routeList.sort((a, b) => a.route_short_name.localeCompare(b.route_short_name, undefined, { numeric: true }));
  routeList.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.route_id;
    opt.textContent = `Route ${r.route_short_name} - ${r.route_long_name}`;
    routeSelect.appendChild(opt);
  });

  // Calculate default stop departure stats
  const dateString = "2026-10-20"; // Update to match your GTFS feed calendar range
  const stops = await calculateStopFrequencies(rawStops, dateString, "ALL");

  const populationDots = generatePopulationDots(censusData, 10);
  colorPopulationByDistance(populationDots, stops);

  // Sources
  map.addSource("population-dots", { type: "geojson", data: populationDots });
  map.addSource("stops", { type: "geojson", data: stops });
  map.addSource("route", { type: "geojson", data: routesGeoJson });
  map.addSource("key-places", { type: "geojson", data: "/data/key-places.geojson" });

  // Route Layers
  map.addLayer({
    id: "route-layer",
    type: "line",
    source: "route",
    paint: {
      "line-color": "#173b65",
      "line-opacity": 0.23,
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 4, 16, 6]
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

  // Population Dots Layer
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

  // Stop Frequency Visual Layer
  map.addLayer({
    id: "stop-frequency-layer",
    type: "circle",
    source: "stops",
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["get", "departures"],
        0, 2,
        10, 5,
        30, 9,
        60, 14,
        100, 19
      ],
      "circle-color": [
        "interpolate",
        ["linear"],
        ["get", "departures"],
        0, "#94a3b8",
        10, "#f59e0b",
        30, "#ef4444",
        60, "#8b5cf6",
        100, "#15803d"
      ],
      "circle-opacity": 0.85,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.2
    }
  });

  // Key Places
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

  map.moveLayer("route-layer", "population-dots-layer");

  // Popup Interaction
  map.on("click", "stop-frequency-layer", (e) => {
    const stop = e.features[0];
    const p = stop.properties;

    new Popup()
      .setLngLat(e.lngLat)
      .setHTML(`
        <strong>${p.stop_name}</strong>
        <p style="margin: 4px 0 0;">Daily departures: <b>${p.departures}</b></p>
        <p style="margin: 2px 0 0;">Routes serving stop: <b>${p.routeCount}</b></p>
        <p style="margin: 2px 0 0;">Avg headway: <b>${
          p.averageHeadway === null ? "N/A" : Math.round(p.averageHeadway) + " min"
        }</b></p>
      `)
      .addTo(map);
  });

  // Route Selection Filter Listener
  routeSelect.addEventListener("change", async (e) => {
    const selectedRouteId = e.target.value;

    if (selectedRouteId === "ALL") {
      map.setFilter("route-layer", null);
      map.setFilter("route-number-layer", null);
    } else {
      const filterExpr = ["==", ["get", "route_id"], selectedRouteId];
      map.setFilter("route-layer", filterExpr);
      map.setFilter("route-number-layer", filterExpr);
    }

    // Recalculate stop frequencies for selected route
    const updatedStops = await calculateStopFrequencies(stops, dateString, selectedRouteId);
    map.getSource("stops").setData(updatedStops);
  });
});