import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT, DATA_DIR, PUBLIC_DIR } from './config.js';
import { SCENES, STYLES, getScene, getStyle } from './pipeline/scenes.js';
import { renderScene, renderAll, buildManifest, paths, orbitBearings } from './pipeline/render.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/data', express.static(DATA_DIR, { maxAge: '1h' }));
app.use('/vendor/maplibre-gl', express.static(path.join(ROOT, 'node_modules', 'maplibre-gl', 'dist'), { maxAge: '1d' }));

// Public config for the browser (the Mapbox token is needed client-side for tiles).
app.get('/api/config', (_req, res) => {
  res.json({
    mapboxToken: config.mapboxToken,
    capabilities: { stylize: Boolean(config.openaiKey), animate: Boolean(config.falKey) },
    orbit: { frames: config.orbitFrames, fps: config.orbitFps },
    readOnly: config.readOnly,
    scenes: SCENES,
    styles: Object.fromEntries(Object.entries(STYLES).map(([id, s]) => [id, { id, name: s.name, grade: s.grade || null }])),
  });
});

app.get('/api/manifest', async (_req, res, next) => {
  try { res.json(await buildManifest()); } catch (e) { next(e); }
});

// Every mutating / paid endpoint sits behind this. See config.readOnly.
function writable(_req, res, next) {
  if (config.readOnly) {
    return res.status(403).json({ error: 'This deployment is read-only: rendering and capture are disabled.' });
  }
  next();
}

// ---- Render jobs (run in the background; poll /api/jobs/:id) --------------------------------
const jobs = new Map();
let jobSeq = 0;

function startJob(fn, meta) {
  const id = String(++jobSeq);
  const job = { id, ...meta, status: 'running', log: [], startedAt: new Date().toISOString(), result: null, error: null };
  jobs.set(id, job);
  const log = (msg) => { job.log.push(msg); console.log(`[job ${id}] ${msg}`); };
  fn(log)
    .then((r) => { job.status = 'done'; job.result = r; })
    .catch((e) => { job.status = 'failed'; job.error = e.message; log(`✖ ${e.message}`); })
    .finally(() => { job.finishedAt = new Date().toISOString(); });
  return job;
}

app.post('/api/render', writable, (req, res) => {
  const { scene, style = 'realistic', to = [], all = false, orbit = false, force = false } = req.body || {};
  try {
    getStyle(style);
    if (!all) getScene(scene);
    const job = all
      ? startJob((log) => renderAll({ styleId: style, orbit, force, log }), { scene: '*', style })
      : startJob((log) => renderScene({ sceneId: scene, styleId: style, transitionsTo: to, orbit, force, log }), { scene, style });
    res.status(202).json({ jobId: job.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/jobs', (_req, res) => res.json([...jobs.values()].map(({ log, ...j }) => ({ ...j, lines: log.length }))));
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'no such job' });
  res.json(job);
});

// ---- Orbit capture (from public/capture.html) ---------------------------------------------------
// The Static Images API renders a flat map, so its orbit frames have no 3D buildings. Mapbox GL JS
// v3 can render mapbox/standard with show3dObjects client-side; these endpoints let the capture page
// sweep the same bearings renderOrbit() would use and upload each frame in its place.

app.get('/api/scenes/:id/orbit-plan', (req, res) => {
  try {
    const scene = getScene(req.params.id);
    const bearings = orbitBearings(scene.camera);
    res.json({ scene: scene.id, camera: scene.camera, frames: bearings.length, bearings });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.delete('/api/scenes/:id/orbit', writable, async (req, res, next) => {
  try {
    const scene = getScene(req.params.id);
    await fs.rm(paths.orbitDir(scene.id), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/scenes/:id/orbit/meta', writable, async (req, res, next) => {
  try {
    const scene = getScene(req.params.id);
    const { source = 'mapbox-standard', style = null, light = null } = req.body || {};
    const dir = paths.orbitDir(scene.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ source, style, light }, null, 2));
    res.json({ ok: true, source, style, light });
  } catch (e) { next(e); }
});

app.post('/api/scenes/:id/orbit/:index', writable, express.raw({ type: 'image/png', limit: '40mb' }), async (req, res, next) => {
  try {
    const scene = getScene(req.params.id);
    const total = orbitBearings(scene.camera).length;
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      return res.status(400).json({ error: `index must be an integer in [0, ${total})` });
    }
    if (!req.body?.length) return res.status(400).json({ error: 'expected image/png body' });
    const file = paths.orbitFrame(scene.id, index);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, req.body);
    res.json({ ok: true, index, bytes: req.body.length });
  } catch (e) { next(e); }
});

// ---- Keyframe upload (from public/capture.html, which renders Mapbox Standard 3D landmarks) ----
app.post('/api/scenes/:id/keyframe', writable, express.raw({ type: 'image/png', limit: '40mb' }), async (req, res, next) => {
  try {
    const scene = getScene(req.params.id);
    if (!req.body?.length) return res.status(400).json({ error: 'expected image/png body' });
    const file = paths.keyframe(scene.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, req.body);
    // A new keyframe invalidates every derived still/clip for this scene.
    for (const styleId of Object.keys(STYLES)) await fs.rm(paths.styleDir(scene.id, styleId), { recursive: true, force: true });
    res.json({ ok: true, keyframe: `/data/${scene.id}/keyframe.png`, bytes: req.body.length });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`Terraform → http://localhost:${config.port}`);
  console.log(`  Mapbox: ${config.mapboxToken ? 'ok' : 'MISSING'}  OpenAI: ${config.openaiKey ? 'ok' : 'off'}  fal: ${config.falKey ? 'ok' : 'off'}`);
  console.log(`  mode: ${config.readOnly ? 'READ-ONLY (render/capture endpoints disabled)' : 'writable'}`);
});
