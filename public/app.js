import { MediaLayer } from './media-layer.js';

const $ = (s) => document.querySelector(s);
const styleSelect = $('#style-select');
const chips = $('#scene-chips');
const cityChips = $('#city-chips');
const orbitToggle = $('#orbit-toggle');
const statusEl = $('#status');
const emptyEl = $('#empty');

const state = {
  cfg: null,
  manifest: null,
  sceneId: null,
  styleId: localStorage.getItem('terraform.style') || 'realistic',
  cityId: null,
  orbit: false,
  busy: false,
};

const media = new Map(); // url → HTMLVideoElement | HTMLImageElement

// ------------------------------------------------------------------------------------------------
// Bootstrap

const [cfg, manifest] = await Promise.all([fetch('/api/config').then((r) => r.json()), fetch('/api/manifest').then((r) => r.json())]);
state.cfg = cfg;
state.manifest = manifest;
if (!cfg.styles[state.styleId]) state.styleId = Object.keys(cfg.styles)[0];

for (const s of Object.values(cfg.styles)) styleSelect.add(new Option(s.name, s.id, false, s.id === state.styleId));

const firstScene = cfg.scenes[0];
const map = new maplibregl.Map({
  container: 'map',
  style: baseStyle(cfg.mapboxToken),
  center: firstScene.camera.center,
  zoom: firstScene.camera.zoom,
  bearing: firstScene.camera.bearing,
  pitch: firstScene.camera.pitch,
  maxPitch: 60,
  attributionControl: { compact: true },
  interactive: true,
});
// Camera is pinned to the keyframe camera; user input would break the video alignment.
for (const h of ['dragPan', 'scrollZoom', 'boxZoom', 'dragRotate', 'keyboard', 'doubleClickZoom', 'touchZoomRotate']) map[h].disable();

const mediaLayer = new MediaLayer('scene-media');

map.on('load', () => {
  // The label overlay (GeoJSON source + circle/symbol layers + popups) is disabled; the media
  // layer is the only thing drawn over the base map. The labels are still produced by the
  // pipeline and exposed in the manifest, so re-enabling is a frontend-only change.
  map.addLayer(mediaLayer);

  collapseAttribution();
  showScene(firstReadyScene() || firstScene.id, { instant: true });
});

/**
 * MapLibre's `compact: true` attribution still renders *expanded*: _updateCompact() sets the
 * `open` attribute and adds `maplibregl-compact-show`. Strip both to leave just the ⓘ button.
 * Keeping `maplibregl-compact` matters — _updateCompact() short-circuits when that class is
 * already present, so a later resize or attribution update won't pop it back open.
 */
function collapseAttribution() {
  for (const el of document.querySelectorAll('.maplibregl-ctrl-attrib')) {
    el.classList.add('maplibregl-compact');
    el.classList.remove('maplibregl-compact-show');
    el.removeAttribute('open');
  }
}
map.on('error', (e) => { if (e?.error?.message) setStatus(`Map: ${e.error.message}`, 6000); });
renderChips();

// ------------------------------------------------------------------------------------------------
// Base map: Mapbox raster tiles + Mapbox fonts, consumed by MapLibre.

function baseStyle(token) {
  return {
    version: 8,
    glyphs: `https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=${token}`,
    sources: {
      mapbox: {
        type: 'raster',
        tiles: [`https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`],
        tileSize: 512,
        attribution: '© NextBillion © MapLibre © OpenStreetMap contributors © Mapbox',
      },
    },
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0d12' } }, { id: 'mapbox', type: 'raster', source: 'mapbox' }],
  };
}

// ------------------------------------------------------------------------------------------------
// Scenes

/** Scenes grouped by city, in definition order — drives the two-level chip selector. */
function cities() {
  const out = [];
  for (const s of state.cfg.scenes) {
    let c = out.find((x) => x.city === s.city);
    if (!c) out.push((c = { city: s.city, scenes: [] }));
    c.scenes.push(s);
  }
  return out;
}
function cityOf(id) { return state.cfg.scenes.find((s) => s.id === id)?.city || null; }
function scenesInCity(city) { return cities().find((c) => c.city === city)?.scenes || []; }

function sceneEntry(id) { return state.manifest.scenes.find((s) => s.id === id); }
function styleAssets(id) { return sceneEntry(id)?.styles?.[state.styleId] || null; }
function bestStill(id) { return styleAssets(id)?.still || sceneEntry(id)?.keyframe || null; }
function firstReadyScene() { return state.manifest.scenes.find((s) => s.styles?.[state.styleId]?.still || s.keyframe)?.id; }

function getMedia(url) {
  if (media.has(url)) return media.get(url);
  let el;
  const file = url.split('?')[0]; // manifest URLs carry a ?v=<mtime> cache-busting stamp
  if (file.endsWith('.mp4') || file.endsWith('.webm')) {
    el = document.createElement('video');
    el.src = url; el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'auto';
  } else {
    el = new Image();
    el.src = url;
  }
  media.set(url, el);
  return el;
}

function whenReady(el) {
  return new Promise((resolve) => {
    if (el instanceof HTMLVideoElement) {
      if (el.readyState >= 2) return resolve();
      el.addEventListener('loadeddata', () => resolve(), { once: true });
      el.addEventListener('error', () => resolve(), { once: true });
    } else {
      if (el.complete) return resolve();
      el.addEventListener('load', () => resolve(), { once: true });
      el.addEventListener('error', () => resolve(), { once: true });
    }
  });
}

// ------------------------------------------------------------------------------------------------
// 360° orbit: play the pre-rendered bearing sweep while driving the map camera to match, so the
// map projection stays in sync with the pixels on screen for every frame of the turn.

const orbit = { raf: null, token: 0, sceneId: null };

function orbitData(id) { return sceneEntry(id)?.orbit || null; }
function anchorOrbit(id) { return styleAssets(id)?.anchorOrbit || null; }
function orbitAvailable(id) { return Boolean(orbitData(id) || anchorOrbit(id)); }

/**
 * The Orbit control is only meaningful where frames exist, so it is disabled elsewhere.
 * `state.orbit` stays as the user's sticky preference: leaving a location without an orbit and
 * coming back re-enables the toggle still ticked.
 */
function syncOrbitToggle() {
  const available = state.sceneId ? orbitAvailable(state.sceneId) : false;
  orbitToggle.disabled = !available;
  orbitToggle.checked = available && state.orbit;
  const pill = orbitToggle.closest('.pill');
  if (!pill) return;
  pill.classList.toggle('disabled', !available);
  pill.title = available
    ? 'Fly a 360° turntable around this location'
    : `No orbit frames for this location — render them first (npm run render -- --scene ${state.sceneId || '<id>'} --orbit)`;
}

// Orbit frames are raw Static Images renders shared by every style, so the style's look is applied
// at display time as a shader grade. Styled stills and loops are already graded by gpt-image-1 and
// must be shown ungraded, or the grade would be applied twice.
function styleGrade() { return state.cfg.styles[state.styleId]?.grade || null; }

// Frames captured from Mapbox Standard already carry their own lighting from the light preset;
// grading them again blows out the highlights. Only raw Static Images frames get the grade.
function orbitGrade(id) {
  const source = orbitData(id)?.meta?.source || 'static-images';
  return source === 'static-images' ? styleGrade() : null;
}

function stopOrbit({ restore = true } = {}) {
  if (orbit.raf) cancelAnimationFrame(orbit.raf);
  orbit.raf = null;
  orbit.token++; // invalidates any in-flight startOrbit that is still preloading frames
  const id = orbit.sceneId;
  orbit.sceneId = null;
  if (restore && id) {
    const scene = state.cfg.scenes.find((s) => s.id === id);
    if (scene) map.setBearing(scene.camera.bearing ?? 0);
  }
}

async function startOrbit(id) {
  stopOrbit({ restore: false });
  const token = orbit.token;
  const scene = state.cfg.scenes.find((s) => s.id === id);
  if (!scene) return;

  // Prefer the photoreal anchor orbit when this scene+style has one; the frame sequence is the
  // geometrically exact fallback.
  const anchors = anchorOrbit(id);
  if (anchors) return startAnchorOrbit(id, scene, anchors, token);

  const data = orbitData(id);
  if (!data) {
    setStatus(`No orbit frames for "${scene.name}" — run: npm run render -- --scene ${id} --orbit`, 6000);
    return;
  }

  const els = data.frames.map(getMedia);

  // Show frame 0 as soon as it decodes; the full sweep is tens of MB and waiting for all of it
  // would leave the stage blank (showing the bare base map) for seconds.
  await whenReady(els[0]);
  if (token !== orbit.token) return;

  orbit.sceneId = id;
  map.jumpTo({ ...scene.camera, bearing: data.bearings[0] });
  mediaLayer.setGrade(orbitGrade(id));
  mediaLayer.setMedia(els[0]);
  await mediaLayer.fadeTo(1, 300);
  if (token !== orbit.token) return;

  setStatus(`Loading ${els.length} orbit frames…`, 2500);
  await Promise.all(els.map(whenReady));
  if (token !== orbit.token) return; // toggled off, or the scene changed, while preloading

  // Play the sweep as a continuous position rather than a frame index: the bearing is derived
  // straight from it, and adjacent frames are cross-faded. That keeps a slow orbit smooth instead
  // of visibly stepping between discrete bearings, without needing a finer (and much slower) sweep.
  const n = els.length;
  const step = 360 / n;
  const fps = state.cfg.orbit?.fps || 12;
  const base = data.bearings[0];
  const started = performance.now();

  const tick = (now) => {
    if (token !== orbit.token) return;
    const p = ((now - started) / 1000) * fps;
    const i = Math.floor(p) % n;
    const t = p - Math.floor(p);
    mediaLayer.setMedia(els[i], els[(i + 1) % n], t);
    map.setBearing(((base + p * step) % 360 + 360) % 360);
    orbit.raf = requestAnimationFrame(tick);
  };
  orbit.raf = requestAnimationFrame(tick);
}

/**
 * @param {string} id
 * @param {{instant?: boolean, force?: boolean}} [o]  force: re-present the current scene (e.g. after
 *   a mode change) instead of treating it as "already showing" and picking a transition.
 */
/** Resolve once no scene transition is in flight; showScene() drops calls made while busy. */
async function whenIdle() {
  while (state.busy) await new Promise((r) => setTimeout(r, 50));
}

/**
 * Photoreal orbit: play the generated anchor-to-anchor clips back to back, interpolating the map
 * bearing across each one so the camera keeps pace with the arc the model rendered.
 */
async function startAnchorOrbit(id, scene, anchors, token) {
  const els = anchors.clips.map(getMedia);
  await whenReady(els[0]);
  if (token !== orbit.token) return;

  orbit.sceneId = id;
  map.jumpTo({ ...scene.camera, bearing: anchors.bearings[0] });
  mediaLayer.setGrade(null); // these clips are already stylized; grading them would double up
  let i = 0;

  const playFrom = (index) => {
    if (token !== orbit.token) return;
    const el = els[index];
    el.loop = false;
    el.currentTime = 0;
    el.play().catch(() => {});
    mediaLayer.setMedia(el);
    mediaLayer.setOpacity(1);
    el.addEventListener('ended', () => {
      if (token !== orbit.token) return;
      i = (i + 1) % els.length;
      playFrom(i);
    }, { once: true });
  };

  const from = anchors.bearings;
  const span = 360 / els.length;
  const tick = () => {
    if (token !== orbit.token) return;
    const el = els[i];
    const t = el.duration ? Math.min(1, el.currentTime / el.duration) : 0;
    map.setBearing(((from[0] + (i + t) * span) % 360 + 360) % 360);
    orbit.raf = requestAnimationFrame(tick);
  };

  playFrom(0);
  await mediaLayer.fadeTo(1, 300);
  if (token !== orbit.token) return;
  orbit.raf = requestAnimationFrame(tick);
}

async function showScene(id, { instant = false, force = false } = {}) {
  if (state.busy) return;
  const from = force ? null : state.sceneId;
  const scene = state.cfg.scenes.find((s) => s.id === id);
  if (!scene) return;
  state.busy = true;
  state.cityId = scene.city || state.cityId;
  stopOrbit({ restore: false });
  mediaLayer.setGrade(null); // startOrbit() re-applies the style grade if orbit mode takes over
  try {
    const assets = styleAssets(id);
    const loopUrl = assets?.loop || bestStill(id);
    const transitionUrl = from && from !== id ? styleAssets(from)?.transitions?.[id] : null;
    const orbitReady = state.orbit && orbitAvailable(id);

    emptyEl.hidden = Boolean(loopUrl) || orbitReady;

    // Orbit mode owns the camera, so it replaces the fixed-bearing loop and the flyover transition.
    if (orbitReady) {
      state.sceneId = id;
      renderChips();
      startOrbit(id); // not awaited: frame preloading should not hold the busy lock
      return;
    }

    if (!loopUrl) {
      await mediaLayer.fadeTo(0, 250);
      map.jumpTo(scene.camera);
      state.sceneId = id;
      setStatus(`No render for "${scene.name}" yet — run: npm run render -- --scene ${id}`, 5000);
      return;
    }

    const loopEl = getMedia(loopUrl);
    const ready = whenReady(loopEl);

    if (instant || !from) {
      map.jumpTo(scene.camera);
      await ready;
      swapTo(loopEl);
      await mediaLayer.fadeTo(1, 400);
    } else if (transitionUrl) {
      // Real flyover clip: play it while the map camera flies to the new scene underneath.
      const tEl = getMedia(transitionUrl);
      await whenReady(tEl);
      tEl.loop = false; tEl.currentTime = 0;
      const dur = Math.max(1000, (tEl.duration || 5) * 1000);
      swapTo(tEl);
      map.flyTo({ ...scene.camera, duration: dur, essential: true });
      await new Promise((r) => { tEl.addEventListener('ended', r, { once: true }); setTimeout(r, dur + 500); });
      await ready;
      swapTo(loopEl);
    } else {
      // No transition clip: cross-fade stills/loops around a short flyTo.
      await mediaLayer.fadeTo(0, 350);
      map.flyTo({ ...scene.camera, duration: 1800, essential: true });
      await new Promise((r) => map.once('moveend', r));
      await ready;
      swapTo(loopEl);
      await mediaLayer.fadeTo(1, 500);
    }

    state.sceneId = id;
    renderChips();
  } finally {
    state.busy = false;
    syncOrbitToggle(); // also covers the early-return paths above
  }
}

function swapTo(el) {
  if (el instanceof HTMLVideoElement) el.play().catch(() => {});
  mediaLayer.setMedia(el);
  mediaLayer.setOpacity(1);
}

// ------------------------------------------------------------------------------------------------
// UI

function renderChips() {
  const activeCity = state.cityId || cityOf(state.sceneId) || cities()[0]?.city || null;
  state.cityId = activeCity;

  cityChips.innerHTML = '';
  for (const c of cities()) {
    const rendered = c.scenes.filter((s) => bestStill(s.id)).length;
    const b = document.createElement('button');
    b.className = 'chip city' + (c.city === activeCity ? ' active' : '');
    b.textContent = c.city;
    b.title = `${c.scenes.length} location${c.scenes.length === 1 ? '' : 's'} · ${rendered} rendered`;
    b.onclick = () => selectCity(c.city);
    cityChips.appendChild(b);
  }

  syncOrbitToggle();

  chips.innerHTML = '';
  for (const s of scenesInCity(activeCity)) {
    const a = styleAssets(s.id);
    const b = document.createElement('button');
    const hasOrbit = orbitAvailable(s.id);
    b.className = 'chip' + (s.id === state.sceneId ? ' active' : '') + (a?.loop ? ' has-loop' : bestStill(s.id) ? ' has-still' : '') + (hasOrbit ? ' has-orbit' : '');
    b.innerHTML = `<span class="dot"></span>${esc(s.name)}`;
    b.title = (a?.loop ? 'Animated loop ready' : bestStill(s.id) ? 'Still only (no video yet)' : 'Not rendered') + (hasOrbit ? ' · 360° orbit ready' : '');
    b.onclick = () => showScene(s.id);
    chips.appendChild(b);
  }
}

/** Switch city and land on the most-rendered location within it. */
async function selectCity(city) {
  if (city === state.cityId) return;
  state.cityId = city;
  renderChips();
  const list = scenesInCity(city);
  const target = list.find((s) => styleAssets(s.id)?.loop) || list.find((s) => bestStill(s.id)) || list[0];
  if (!target) return;
  await whenIdle();
  await showScene(target.id);
}

styleSelect.onchange = async () => {
  state.styleId = styleSelect.value;
  localStorage.setItem('terraform.style', state.styleId);
  renderChips();
  await whenIdle();
  const id = state.sceneId || firstReadyScene() || state.cfg.scenes[0].id;
  await showScene(id, { instant: true, force: true });
};

orbitToggle.onchange = async (e) => {
  if (e.target.disabled) return;
  state.orbit = e.target.checked;
  await whenIdle();
  const id = state.sceneId || firstReadyScene() || state.cfg.scenes[0].id;
  await showScene(id, { instant: true, force: true });
};

// Rendering is not driven from the UI; use the CLI:
//   npm run render -- --scene <id> --style realistic [--orbit]
// The POST /api/render endpoint and its job polling remain available for scripted use.

let statusTimer;
function setStatus(msg, ms = 3000) {
  statusEl.textContent = msg; statusEl.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.hidden = true), ms);
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
