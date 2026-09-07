// Scene definitions: a camera (center/zoom/bearing/pitch) plus a label search radius.
// Add scenes here, or drop a JSON file with the same shape into data/scenes/<id>/scene.json.

// Scenes are grouped by `city` for the two-level selector in the viewer: pick a city, then a
// location within it. Existing ids are kept verbatim — an id is the on-disk folder name under
// data/scenes/, so renaming one orphans everything already rendered for it.
//
// Landmark centres are accurate to a few metres but the framing (zoom/bearing/pitch) is a first
// guess. Open /capture.html, move the camera, and it prints a ready-to-paste camera object.
export const SCENES = [
  // ---- Paris ------------------------------------------------------------------------------
  {
    id: 'paris-eiffel',
    city: 'Paris',
    name: 'Eiffel Tower',
    camera: { center: [2.2945, 48.8584], zoom: 15.2, bearing: 20, pitch: 60 },
    labelRadius: 900,
  },
  {
    id: 'paris-montparnasse',
    city: 'Paris',
    name: 'Montparnasse',
    camera: { center: [2.3219, 48.8422], zoom: 15.3, bearing: -25, pitch: 60 },
    labelRadius: 800,
  },
  {
    id: 'paris-arc-de-triomphe',
    city: 'Paris',
    name: 'Arc de Triomphe',
    camera: { center: [2.295, 48.8738], zoom: 15.6, bearing: 60, pitch: 60 },
    labelRadius: 700,
  },
  {
    id: 'paris-louvre',
    city: 'Paris',
    name: 'Louvre',
    camera: { center: [2.3376, 48.8606], zoom: 15.5, bearing: 105, pitch: 58 },
    labelRadius: 700,
  },

  // ---- New York ---------------------------------------------------------------------------
  {
    id: 'nyc-midtown',
    city: 'New York',
    name: 'Midtown',
    camera: { center: [-73.9857, 40.7484], zoom: 15.4, bearing: -30, pitch: 60 },
    labelRadius: 700,
  },
  {
    id: 'nyc-brooklyn-bridge',
    city: 'New York',
    name: 'Brooklyn Bridge',
    camera: { center: [-73.9969, 40.7061], zoom: 15.3, bearing: 135, pitch: 60 },
    labelRadius: 800,
  },
  {
    id: 'nyc-the-battery',
    city: 'New York',
    name: 'The Battery',
    camera: { center: [-74.017, 40.7033], zoom: 15.4, bearing: 20, pitch: 60 },
    labelRadius: 800,
  },
  {
    id: 'nyc-flatiron',
    city: 'New York',
    name: 'Flatiron Building',
    camera: { center: [-73.9897, 40.7411], zoom: 16, bearing: -60, pitch: 60 },
    labelRadius: 600,
  },

  // ---- Singapore --------------------------------------------------------------------------
  {
    id: 'singapore-marina-bay',
    city: 'Singapore',
    name: 'Marina',
    camera: { center: [103.852, 1.283], zoom: 15.5, bearing: -20, pitch: 60 },
    labelRadius: 800,
  },
  {
    id: 'singapore-merlion-park',
    city: 'Singapore',
    name: 'Merlion Park',
    camera: { center: [103.8545, 1.2868], zoom: 16, bearing: 145, pitch: 60 },
    labelRadius: 600,
  },
  {
    id: 'singapore-changi',
    city: 'Singapore',
    name: 'Changi Airport',
    camera: { center: [103.9893, 1.3644], zoom: 15, bearing: 0, pitch: 58 },
    labelRadius: 1200,
  },

  // ---- London -----------------------------------------------------------------------------
  {
    id: 'london-westminster',
    city: 'London',
    name: 'Westminster',
    camera: { center: [-0.1246, 51.5007], zoom: 15.6, bearing: 45, pitch: 58 },
    labelRadius: 700,
  },
  {
    id: 'london-buckingham-palace',
    city: 'London',
    name: 'Buckingham Palace',
    camera: { center: [-0.1419, 51.5014], zoom: 15.6, bearing: 115, pitch: 60 },
    labelRadius: 700,
  },
  {
    id: 'london-eye',
    city: 'London',
    name: 'London Eye',
    camera: { center: [-0.1195, 51.5033], zoom: 16, bearing: -80, pitch: 60 },
    labelRadius: 600,
  },
  {
    id: 'london-st-pauls',
    city: 'London',
    name: "St Paul's Cathedral",
    camera: { center: [-0.0984, 51.5138], zoom: 15.8, bearing: 25, pitch: 60 },
    labelRadius: 700,
  },
];

/** Cities in scene order, each with its locations — drives the two-level selector. */
export function citiesWithScenes() {
  const byCity = new Map();
  for (const s of SCENES) {
    if (!byCity.has(s.city)) byCity.set(s.city, []);
    byCity.get(s.city).push(s.id);
  }
  return [...byCity].map(([city, scenes]) => ({ city, scenes }));
}

// Style preset: the prompt fed to gpt-image-1 (edit of the keyframe) and, later, to the video model.
// `grade` is a deterministic colour grade applied in the browser (public/media-layer.js) to raw,
// un-stylized media — the 360° orbit frames — so the turntable matches the look of styled.png
// without 72 independent gpt-image-1 edits (which would have no temporal coherence and shimmer).
export const STYLES = {
  realistic: {
    name: 'Realistic',
    imagePrompt:
      'Turn this map render into a photorealistic aerial photograph taken from a helicopter on a clear afternoon. Keep every street, building footprint, river and park exactly where it is. Golden natural light, crisp detail, no text or labels.',
    videoPrompt:
      'Slow, steady aerial drone shot. Subtle camera drift, gentle parallax, cars and boats moving, light clouds. Cinematic, photorealistic, no text.',
    // Golden-hour grade, fitted numerically against paris-eiffel/realistic/styled.png: the params
    // were solved so the label-free orbit frames match that still's mean RGB and luma spread
    // (mean 82/74/58, sd 44). Warm gain, lifted shadows, a soft vignette.
    // These only affect how raw orbit frames are displayed; nothing on disk changes.
    // NB the fit target is not stable: gpt-image-1 exposes no seed, so re-running the stylize step
    // yields a measurably different still (an earlier sample measured 77/64/42, sd 35). Re-fit, or
    // just tune by eye, if styled.png is ever regenerated.
    grade: {
      gamma: 0.82,
      contrast: 1.49,
      gain: [1.2, 0.92, 0.89],
      lift: [0.01, 0.021, 0.0],
      saturation: 1.3,
      vignette: 0.18,
    },
  },
};

export function getScene(id) {
  const s = SCENES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scene "${id}". Known: ${SCENES.map((x) => x.id).join(', ')}`);
  return s;
}

export function getStyle(id) {
  const s = STYLES[id];
  if (!s) throw new Error(`Unknown style "${id}". Known: ${Object.keys(STYLES).join(', ')}`);
  return { id, ...s };
}
