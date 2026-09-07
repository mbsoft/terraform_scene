#!/usr/bin/env node
// CLI:  npm run render -- --scene paris-eiffel --style realistic [--to nyc-midtown,london-westminster] [--orbit] [--force]
//       npm run render:all -- --style realistic
import { renderScene, renderAll, renderAnchorOrbit } from './render.js';
import { SCENES, STYLES } from './scenes.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

if (flag('help') || args.length === 0) {
  console.log(`Usage:
  node server/pipeline/run.js --scene <id> --style <id> [--to <id,id>] [--orbit] [--force]
  node server/pipeline/run.js --all --style <id> [--orbit] [--force]

  --orbit   also render the 360° turntable frames (ORBIT_FRAMES Static Images requests per scene)

  node server/pipeline/run.js --scene <id> --anchor-orbit [--anchors 8] [--force]
            photoreal orbit: ORBIT_ANCHORS stylized stills + one generated clip between each
            consecutive pair. Costs <anchors> gpt-image-1 edits AND <anchors> fal video jobs.

Scenes: ${SCENES.map((s) => s.id).join(', ')}
Styles: ${Object.keys(STYLES).join(', ')}`);
  process.exit(0);
}

const styleId = opt('style', 'realistic');
const force = flag('force');
const orbit = flag('orbit');

try {
  if (flag('anchor-orbit')) {
    const sceneId = opt('scene');
    if (!sceneId) throw new Error('--scene is required for --anchor-orbit');
    const anchors = Number(opt('anchors', '')) || undefined;
    const entry = await renderAnchorOrbit({ sceneId, styleId, anchors, force });
    console.log(JSON.stringify(entry.styles[styleId]?.anchorOrbit, null, 2));
  } else if (flag('all')) {
    const m = await renderAll({ styleId, orbit, force });
    console.log(JSON.stringify(m, null, 2));
  } else {
    const sceneId = opt('scene');
    if (!sceneId) throw new Error('--scene is required (or use --all)');
    const transitionsTo = (opt('to', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const entry = await renderScene({ sceneId, styleId, transitionsTo, orbit, force });
    console.log(JSON.stringify(entry, null, 2));
  }
} catch (err) {
  console.error('✖', err.message);
  process.exit(1);
}
