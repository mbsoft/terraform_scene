// Orchestrator: keyframe → (stylize) → (loop) → (transitions) → labels, written under data/scenes/.
// Every step is idempotent and cached on disk; delete a file (or pass force) to re-render it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, DATA_DIR } from '../config.js';
import { SCENES, STYLES, getScene, getStyle } from './scenes.js';
import { renderKeyframe } from './keyframes.js';
import { stylizeKeyframe, stylizeEnabled } from './stylize.js';
import { animateLoop, animateTransition, animateEnabled } from './animate.js';
import { fetchLabels } from './labels.js';

export const paths = {
  sceneDir: (sceneId) => path.join(DATA_DIR, sceneId),
  keyframe: (sceneId) => path.join(DATA_DIR, sceneId, 'keyframe.png'),
  labels: (sceneId) => path.join(DATA_DIR, sceneId, 'labels.geojson'),
  styleDir: (sceneId, styleId) => path.join(DATA_DIR, sceneId, styleId),
  styled: (sceneId, styleId) => path.join(DATA_DIR, sceneId, styleId, 'styled.png'),
  loop: (sceneId, styleId) => path.join(DATA_DIR, sceneId, styleId, 'loop.mp4'),
  transition: (sceneId, styleId, toId) => path.join(DATA_DIR, sceneId, styleId, `transition_to_${toId}.mp4`),
  // Orbit frames are raw Static Images renders, so they are style-independent (like keyframe/labels).
  orbitDir: (sceneId) => path.join(DATA_DIR, sceneId, 'orbit'),
  orbitFrame: (sceneId, i) => path.join(DATA_DIR, sceneId, 'orbit', `${String(i).padStart(3, '0')}.png`),
  // Anchor orbit: N stylized stills around the compass, plus a generated clip between each
  // consecutive pair. Style-dependent, so it lives under the style directory.
  anchorDir: (sceneId, styleId) => path.join(DATA_DIR, sceneId, styleId, 'anchors'),
  anchorStill: (sceneId, styleId, i) => path.join(DATA_DIR, sceneId, styleId, 'anchors', `${String(i).padStart(2, '0')}.png`),
  anchorClip: (sceneId, styleId, i) => path.join(DATA_DIR, sceneId, styleId, 'anchors', `clip_${String(i).padStart(2, '0')}.mp4`),
};

const norm360 = (deg) => ((deg % 360) + 360) % 360;

/** The bearing each orbit frame is rendered at: a full turn starting from the scene's own bearing. */
export function orbitBearings(camera, frames = config.orbitFrames) {
  const base = camera.bearing ?? 0;
  return Array.from({ length: frames }, (_, i) => norm360(base + (i * 360) / frames));
}

const exists = (p) => fs.access(p).then(() => true, () => false);

async function cached(file, force, produce, log, label) {
  if (!force && (await exists(file))) {
    log(`  ✓ ${label} (cached)`);
    return fs.readFile(file);
  }
  log(`  … ${label}`);
  const buf = await produce();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
  log(`  ✓ ${label}`);
  return buf;
}

/**
 * Render one scene in one style.
 * @param {object} o
 * @param {string} o.sceneId
 * @param {string} o.styleId
 * @param {string[]} [o.transitionsTo]  scene ids to build flyover transitions to
 * @param {boolean} [o.orbit]  also render the 360° turntable frames for this scene
 * @param {boolean} [o.force]
 * @param {(msg:string)=>void} [o.log]
 */
export async function renderScene({ sceneId, styleId, transitionsTo = [], orbit = false, force = false, log = console.log }) {
  const scene = getScene(sceneId);
  const style = getStyle(styleId);
  log(`▶ ${scene.name} / ${style.name}`);

  const keyframe = await cached(paths.keyframe(sceneId), force, () => renderKeyframe(scene.camera), log, 'keyframe (Mapbox Static Images)');

  const styled = await cached(
    paths.styled(sceneId, styleId),
    force,
    () => stylizeKeyframe(keyframe, style),
    log,
    stylizeEnabled() ? 'stylized keyframe (gpt-image-1)' : 'stylized keyframe (OpenAI key missing → copy of keyframe)',
  );

  if (animateEnabled()) {
    await cached(paths.loop(sceneId, styleId), force, () => animateLoop(styled, style, { log }), log, 'ambient loop (MiniMax on fal)');
    for (const toId of transitionsTo) {
      if (toId === sceneId) continue;
      const toStill = await ensureStyledStill(toId, styleId, force, log);
      await cached(
        paths.transition(sceneId, styleId, toId),
        force,
        () => animateTransition(styled, toStill, style, { log }),
        log,
        `flyover transition → ${toId} (MiniMax on fal)`,
      );
    }
  } else {
    log('  – FAL_KEY missing → skipping loop/transition video (frontend will cross-fade stills)');
  }

  await cached(paths.labels(sceneId), force, async () => Buffer.from(JSON.stringify(await fetchLabels(scene.camera, scene.labelRadius))), log, 'labels (Mapbox Tilequery)');

  if (orbit) await renderOrbit({ sceneId, force, log });

  return manifestEntry(sceneId);
}

/**
 * Render a 360° turntable: one Static Images keyframe per bearing, same center/zoom/pitch.
 * The frontend plays these back while driving map.setBearing(), so labels stay registered
 * to their features through the whole orbit (not just at the endpoints, as with transitions).
 */
export async function renderOrbit({ sceneId, force = false, log = console.log }) {
  const scene = getScene(sceneId);
  const bearings = orbitBearings(scene.camera);
  const dir = paths.orbitDir(sceneId);
  await fs.mkdir(dir, { recursive: true });

  let made = 0;
  let reused = 0;
  for (const [i, bearing] of bearings.entries()) {
    const file = paths.orbitFrame(sceneId, i);
    if (!force && (await exists(file))) { reused++; continue; }
    await fs.writeFile(file, await renderKeyframe({ ...scene.camera, bearing }, { style: config.orbitStyle }));
    made++;
    if (made % 12 === 0) log(`  … orbit frame ${i + 1}/${bearings.length}`);
  }

  // Drop frames left over from a previous (larger) ORBIT_FRAMES so the manifest stays consistent.
  const keep = new Set(bearings.map((_, i) => path.basename(paths.orbitFrame(sceneId, i))));
  for (const f of await fs.readdir(dir)) {
    if (f.endsWith('.png') && !keep.has(f)) await fs.rm(path.join(dir, f), { force: true });
  }

  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ source: 'static-images', style: config.orbitStyle, frames: bearings.length }, null, 2),
  );

  log(`  ✓ orbit (${bearings.length} frames: ${made} rendered, ${reused} cached)`);
  return bearings.length;
}

/**
 * Photoreal orbit by anchor chaining.
 *
 * A frame-sequence orbit is geometrically exact but only ever as photoreal as its source imagery.
 * Stylizing all 72 frames individually is not an option: gpt-image-1 exposes no seed, so every
 * frame is an independent sample and the sequence boils.
 *
 * Instead: stylize only ANCHORS bearings, then let the video model generate the motion between
 * consecutive anchors (image_url = anchor i, end_image_url = anchor i+1). Each clip is pinned to
 * real endpoints, so drift is bounded by one anchor gap rather than accumulating over a full turn.
 * The viewer plays the clips back to back and interpolates the camera bearing across each one.
 *
 * Cost: ANCHORS stylizations + ANCHORS video generations per scene and style.
 */
export async function renderAnchorOrbit({ sceneId, styleId, anchors = config.orbitAnchors, force = false, log = console.log }) {
  const scene = getScene(sceneId);
  const style = getStyle(styleId);
  if (!animateEnabled()) throw new Error('FAL_KEY is not set — the anchor orbit needs the video model');

  const bearings = orbitBearings(scene.camera, anchors);
  log(`▶ ${scene.name} / ${style.name} — anchor orbit (${anchors} anchors, ${360 / anchors}° apart)`);
  await fs.mkdir(paths.anchorDir(sceneId, styleId), { recursive: true });

  // 1. One stylized still per anchor bearing.
  const stills = [];
  for (const [i, bearing] of bearings.entries()) {
    const keyframe = await renderKeyframe({ ...scene.camera, bearing }, { style: config.orbitStyle });
    stills.push(
      await cached(
        paths.anchorStill(sceneId, styleId, i),
        force,
        () => stylizeKeyframe(keyframe, style),
        log,
        `anchor ${i + 1}/${anchors} at ${bearing}° (gpt-image-1)`,
      ),
    );
  }

  // 2. A clip from each anchor to the next, closing the loop back to anchor 0.
  for (let i = 0; i < anchors; i++) {
    const to = (i + 1) % anchors;
    await cached(
      paths.anchorClip(sceneId, styleId, i),
      force,
      () => animateTransition(stills[i], stills[to], style, { log, prompt: orbitPrompt(style, bearings[i], bearings[to]) }),
      log,
      `orbit clip ${i + 1}/${anchors} (${bearings[i]}° → ${bearings[to]}°)`,
    );
  }

  await fs.writeFile(
    path.join(paths.anchorDir(sceneId, styleId), 'meta.json'),
    JSON.stringify({ anchors, bearings, seconds: config.falTransitionSeconds }, null, 2),
  );
  log(`  ✓ anchor orbit (${anchors} stills + ${anchors} clips)`);
  return manifestEntry(sceneId);
}

/** Steer the video model towards an orbit rather than the default fly-between-cities motion. */
function orbitPrompt(style, from, to) {
  return `Aerial orbit around the same landmark: the camera arcs smoothly sideways from a ${from}° view to a ${to}° view, keeping the subject centred and the altitude constant. Continuous circular camera movement, no cuts. ${style.videoPrompt}`;
}

async function ensureStyledStill(sceneId, styleId, force, log) {
  const p = paths.styled(sceneId, styleId);
  if (!force && (await exists(p))) return fs.readFile(p);
  const scene = getScene(sceneId);
  const style = getStyle(styleId);
  const keyframe = await cached(paths.keyframe(sceneId), force, () => renderKeyframe(scene.camera), log, `keyframe for ${sceneId}`);
  return cached(p, force, () => stylizeKeyframe(keyframe, style), log, `stylized keyframe for ${sceneId}`);
}

/** Render every scene in a style, with transitions between consecutive scenes (both directions). */
export async function renderAll({ styleId, orbit = false, force = false, log = console.log }) {
  const ids = SCENES.map((s) => s.id);
  for (let i = 0; i < ids.length; i++) {
    const to = [ids[(i + 1) % ids.length], ids[(i - 1 + ids.length) % ids.length]].filter((x) => x !== ids[i]);
    await renderScene({ sceneId: ids[i], styleId, transitionsTo: to, orbit, force, log });
  }
  return buildManifest();
}

/**
 * Asset URLs carry the file's mtime as ?v=… so a re-render invalidates the browser cache.
 * /data is served with max-age=3600 and re-rendered files keep their path, so without this a
 * changed frame would keep serving from cache for an hour.
 */
async function stamped(file, url) {
  try {
    const { mtimeMs } = await fs.stat(file);
    return `${url}?v=${Math.floor(mtimeMs)}`;
  } catch {
    return url;
  }
}

/** What exists on disk for one scene, as URLs the frontend can load. */
export async function manifestEntry(sceneId) {
  const scene = getScene(sceneId);
  const entry = {
    id: scene.id,
    name: scene.name,
    camera: scene.camera,
    keyframe: (await exists(paths.keyframe(sceneId))) ? await stamped(paths.keyframe(sceneId), `/data/${sceneId}/keyframe.png`) : null,
    labels: (await exists(paths.labels(sceneId))) ? await stamped(paths.labels(sceneId), `/data/${sceneId}/labels.geojson`) : null,
    orbit: null,
    styles: {},
  };

  const orbitDir = paths.orbitDir(sceneId);
  if (await exists(orbitDir)) {
    const frames = (await fs.readdir(orbitDir)).filter((f) => f.endsWith('.png')).sort();
    // Bearings are derived from the frame count actually on disk, so a changed ORBIT_FRAMES
    // can never desynchronise playback from the images.
    if (frames.length) {
      // Frames captured from Mapbox Standard already carry their own lighting; frames from the
      // Static Images API are raw and want the style's colour grade. meta.json says which.
      let meta = { source: 'static-images' };
      try {
        meta = JSON.parse(await fs.readFile(path.join(orbitDir, 'meta.json'), 'utf8'));
      } catch {
        // no meta.json → written before provenance was tracked, i.e. Static Images
      }
      entry.orbit = {
        frames: await Promise.all(frames.map((f) => stamped(path.join(orbitDir, f), `/data/${sceneId}/orbit/${f}`))),
        bearings: orbitBearings(scene.camera, frames.length),
        meta,
      };
    }
  }
  for (const styleId of Object.keys(STYLES)) {
    const dir = paths.styleDir(sceneId, styleId);
    if (!(await exists(dir))) continue;
    const files = await fs.readdir(dir);
    const st = { still: null, loop: null, transitions: {}, anchorOrbit: null };
    for (const f of files) {
      const url = await stamped(path.join(dir, f), `/data/${sceneId}/${styleId}/${f}`);
      if (f === 'styled.png') st.still = url;
      else if (f === 'loop.mp4') st.loop = url;
      else if (f.startsWith('transition_to_') && f.endsWith('.mp4')) {
        st.transitions[f.slice('transition_to_'.length, -'.mp4'.length)] = url;
      }
    }
    const anchorDir = paths.anchorDir(sceneId, styleId);
    if (await exists(anchorDir)) {
      const clips = (await fs.readdir(anchorDir)).filter((f) => f.startsWith('clip_') && f.endsWith('.mp4')).sort();
      if (clips.length) {
        let meta = {};
        try { meta = JSON.parse(await fs.readFile(path.join(anchorDir, 'meta.json'), 'utf8')); } catch { /* older sweep */ }
        st.anchorOrbit = {
          clips: await Promise.all(clips.map((f) => stamped(path.join(anchorDir, f), `/data/${sceneId}/${styleId}/anchors/${f}`))),
          bearings: meta.bearings || orbitBearings(scene.camera, clips.length),
        };
      }
    }

    entry.styles[styleId] = st;
  }
  return entry;
}

export async function buildManifest() {
  return {
    generatedAt: new Date().toISOString(),
    capabilities: { stylize: stylizeEnabled(), animate: animateEnabled() },
    styles: Object.fromEntries(Object.entries(STYLES).map(([id, s]) => [id, { id, name: s.name }])),
    scenes: await Promise.all(SCENES.map((s) => manifestEntry(s.id))),
  };
}
