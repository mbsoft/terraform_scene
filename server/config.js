import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data', 'scenes');
export const PUBLIC_DIR = path.join(ROOT, 'public');

/** minimax/h3-max/image-to-video accepts an integer duration in [5, 15]. */
const FAL_DURATION_MIN = 5;
const FAL_DURATION_MAX = 15;
function clampDuration(value, dflt) {
  const n = Math.round(Number(value ?? dflt));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(FAL_DURATION_MAX, Math.max(FAL_DURATION_MIN, n));
}

export const config = {
  port: Number(process.env.PORT || 3000),
  // Read-only mode disables every endpoint that mutates data or spends money on the OpenAI/fal
  // APIs. It defaults ON when running on Cloud Run (which sets K_SERVICE), because a public
  // deployment must not let anyone trigger paid renders or overwrite scene data. Locally it
  // defaults OFF so capture.html keeps working. READ_ONLY=1/0 overrides either way.
  readOnly: process.env.READ_ONLY === '1' || (process.env.READ_ONLY !== '0' && Boolean(process.env.K_SERVICE)),
  mapboxToken: process.env.MAPBOX_TOKEN || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  falKey: process.env.FAL_KEY || '',
  falModel: process.env.FAL_VIDEO_MODEL || 'minimax/h3-max/image-to-video',
  falResolution: process.env.FAL_VIDEO_RESOLUTION || '768P',
  // The model takes an integer 5-15 seconds; clamp here so a bad .env fails fast and locally
  // rather than as a 422 from fal partway through a paid render.
  falLoopSeconds: clampDuration(process.env.FAL_LOOP_SECONDS, 5),
  falTransitionSeconds: clampDuration(process.env.FAL_TRANSITION_SECONDS, 5),
  keyframeStyle: process.env.KEYFRAME_STYLE || 'mapbox/satellite-streets-v12',
  keyframeWidth: Number(process.env.KEYFRAME_WIDTH || 1280),
  keyframeHeight: Number(process.env.KEYFRAME_HEIGHT || 720),
  // Orbit frames use plain satellite imagery, not satellite-streets: street labels and POI pins are
  // baked into the raster by the Static Images API, and no colour grade can remove them — they are
  // what makes a graded orbit still read as "a map" rather than an aerial photograph.
  orbitStyle: process.env.ORBIT_STYLE || 'mapbox/satellite-v9',
  // Anchor orbit: stylized stills around the compass, with a generated clip between each pair.
  orbitAnchors: Math.max(3, Math.min(24, Number(process.env.ORBIT_ANCHORS || 8))),
  // 360° turntable: how many bearings to render, and how fast to play them back in the browser.
  orbitFrames: Math.max(8, Number(process.env.ORBIT_FRAMES || 72)),
  orbitFps: Math.max(0.1, Number(process.env.ORBIT_FPS || 12)),
};

export function requireMapbox() {
  if (!config.mapboxToken) throw new Error('MAPBOX_TOKEN is not set (see .env.example)');
  return config.mapboxToken;
}
