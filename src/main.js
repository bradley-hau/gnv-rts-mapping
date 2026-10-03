import { Map, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import * as turf from "@turf/turf";

setWorkerUrl(workerUrl);

document.querySelector("#app").innerHTML = `
  <div id="map"></div>
`;

function generatePopulationDots(geojson, peoplePerDot = 1) {
  const dots = [];

  for (const feature of geojson.features) {
    const population = feature.properties.POP100 || 0;
    const dotCount = Math.round(population / peoplePerDot);

    if (dotCount === 0) continue;

    const bbox = turf.bbox(feature);

    let created = 0;

    while (created < dotCount) {
      const randomPoint = turf.randomPoint(1, {
        bbox,
      }).features[0];

      if (turf.booleanPointInPolygon(randomPoint, feature)) {
        randomPoint.properties = {
          populationRepresented: peoplePerDot,
        };

        dots.push(randomPoint);
        created++;
      }
    }
  }

  return {
    type: "FeatureCollection",
    features: dots,
  };
}
function parseCSV(text) {
  const lines = text.trim().split("\n");

  const headers = lines[0]
    .trim()
    .split(",")
    .map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const values = line
      .trim()
      .split(",")
      .map((v) => v.trim());

    const row = {};

    headers.forEach((header, i) => {
      row[header] = values[i];
    });

    return row;
  });
}
async function stopsToGeoJson() {
  const response = await fetch("/data/stops.txt");
  const text = await response.text();

  const rows = parseCSV(text);

  const features = rows.map((row) => ({
    type: "Feature",
    properties: {
      stop_id: row.stop_id,
      stop_name: row.stop_name,
    },
    geometry: {
      type: "Point",
      coordinates: [Number(row.stop_lon), Number(row.stop_lat)],
    },
  }));

  return {
    type: "FeatureCollection",
    features,
  };
}
async function routesToGeoJSON() {
  const [shapesResponse, tripsResponse, routesResponse] = await Promise.all([
    fetch("/data/shapes.txt"),
    fetch("/data/trips.txt"),
    fetch("/data/routes.txt"),
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
      color: route.route_color || "FF9500",
    };
  }
  const shapes = {};

  for (const row of shapeRows) {
    if (!shapes[row.shape_id]) {
      shapes[row.shape_id] = [];
    }

    shapes[row.shape_id].push(row);
  }

  const features = [];

  for (const [shapeId, points] of Object.entries(shapes)) {
    points.sort(
      (a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence),
    );

    const routeId = shapeToRoute[shapeId];

    const info = routeInfo[routeId] || {};

    features.push({
      type: "Feature",

      properties: {
        shape_id: shapeId,
        route_id: routeId,
        route_short_name: info.shortName,
        route_long_name: info.longName,

        route_color: `#${info.color || "FF9500"}`,
      },

      geometry: {
        type: "LineString",

        coordinates: points.map((point) => [
          Number(point.shape_pt_lon),
          Number(point.shape_pt_lat),
        ]),
      },
    });
  }
  console.log(
    routeRows.map((route) => ({
      id: route.route_id,
      name: route.route_short_name,
      color: route.route_color,
    })),
  );
  return {
    type: "FeatureCollection",
    features,
  };
}

const map = new Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [-82.33, 29.65],
  zoom: 12,
});

const response = await fetch("data/populationOfGnv.geojson");
const censusData = await response.json();

const populationDots = generatePopulationDots(censusData, 10);

map.on("load", async () => {
  map.addSource("population-dots", {
    type: "geojson",
    data: populationDots,
  });

  map.addLayer({
    id: "population-dots-layer",
    type: "circle",
    source: "population-dots",

    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        8,
        1,
        12,
        2,
        16,
        5,
      ],

      "circle-color": "#ff3b30",
      "circle-opacity": 0.7,
    },
  });

  const stops = await stopsToGeoJson();

  map.addSource("stops", {
    type: "geojson",
    data: stops,
  });

  map.addLayer({
    id: "stops-layer",
    type: "circle",
    source: "stops",

    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        8,
        1.5,
        12,
        3,
        16,
        7,
      ],

      "circle-color": "#007AFF",
    },
  });

  const routes = await routesToGeoJSON();

  map.addSource("route", {
    type: "geojson",
    data: routes,
  });

  map.addLayer({
    id: "route-layer",
    type: "line",
    source: "route",

    paint: {
      "line-color": ["get", "route_color"],

      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 4, 16, 6],
    },
  });
  map.addSource("key-places", {
    type: "geojson",
    data: "/data/key-places.geojson",
  });
  map.addLayer({
    id: "key-places-layer",
    type: "symbol",
    source: "key-places",

    layout: {
      "text-field": "★",
      "text-size": ["interpolate", ["linear"], ["zoom"], 8, 24, 12, 36, 16, 52],
    },

    paint: {
      "text-color": "#34C759",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });
});
