// Step 1 — render a keyframe of the scene camera with the Mapbox Static Images API.
// https://docs.mapbox.com/api/maps/static-images/
import { config, requireMapbox } from '../config.js';

export function staticImageUrl(camera, opts = {}) {
  const token = requireMapbox();
  const style = opts.style || config.keyframeStyle; // e.g. mapbox/satellite-streets-v12
  const w = Math.min(1280, opts.width || config.keyframeWidth);
  const h = Math.min(1280, opts.height || config.keyframeHeight);
  const [lon, lat] = camera.center;
  const pitch = Math.min(60, camera.pitch ?? 0);
  const bearing = camera.bearing ?? 0;
  const pos = `${lon},${lat},${camera.zoom},${bearing},${pitch}`;
  const params = new URLSearchParams({ access_token: token, attribution: 'false', logo: 'false' });
  return `https://api.mapbox.com/styles/v1/${style}/static/${pos}/${w}x${h}@2x?${params}`;
}

export async function renderKeyframe(camera, opts = {}) {
  const url = staticImageUrl(camera, opts);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Static Images API ${res.status}: ${body.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer()); // PNG
}
