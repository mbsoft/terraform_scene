// Step 5 (data) — pull nearby POI / place labels with the Mapbox Tilequery API so the
// frontend can draw interactive labels on top of the video layer.
// https://docs.mapbox.com/api/maps/tilequery/
import { requireMapbox } from '../config.js';

const TILESET = 'mapbox.mapbox-streets-v8';

export async function fetchLabels(camera, radius = 800, limit = 50) {
  const token = requireMapbox();
  const [lon, lat] = camera.center;
  const params = new URLSearchParams({
    radius: String(radius),
    limit: String(limit),
    layers: 'poi_label,place_label,natural_label,transit_stop_label',
    geometry: 'point',
    access_token: token,
  });
  const url = `https://api.mapbox.com/v4/${TILESET}/tilequery/${lon},${lat}.json?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tilequery API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const fc = await res.json();

  // Normalise to a compact GeoJSON the frontend can render directly.
  const seen = new Set();
  const features = [];
  for (const f of fc.features || []) {
    const p = f.properties || {};
    const name = p.name_en || p.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    features.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        name,
        layer: p.tilequery?.layer || 'poi_label',
        class: p.class || p.type || '',
        maki: p.maki || 'marker',
        distance: Math.round(p.tilequery?.distance ?? 0),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
