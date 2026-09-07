// Steps 3/4 — animate stills into video with MiniMax on fal.ai via the queue REST API.
//   loop:       image_url = styled keyframe            → ambient "living scene" clip
//   transition: image_url = scene A, end_image_url = B → flyover between scenes
// Skipped automatically when FAL_KEY is empty (frontend cross-fades stills instead).
// Docs: https://fal.ai/models/minimax/h3-max/image-to-video/api
import { config } from '../config.js';

export function animateEnabled() {
  return Boolean(config.falKey);
}

function toDataUri(buf, mime = 'image/png') {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function falRequest(input, { log = () => {} } = {}) {
  const headers = { Authorization: `Key ${config.falKey}`, 'Content-Type': 'application/json' };
  const submit = await fetch(`https://queue.fal.run/${config.falModel}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  if (!submit.ok) throw new Error(`fal submit ${submit.status}: ${(await submit.text()).slice(0, 500)}`);
  const { request_id, status_url, response_url } = await submit.json();
  log(`fal request ${request_id} queued`);

  const started = Date.now();
  const timeoutMs = 15 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await fetch(`${status_url}?logs=0`, { headers });
    if (!st.ok) throw new Error(`fal status ${st.status}: ${(await st.text()).slice(0, 300)}`);
    const s = await st.json();
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED') throw new Error(`fal request failed: ${JSON.stringify(s).slice(0, 500)}`);
    if (Date.now() - started > timeoutMs) throw new Error('fal request timed out');
    log(`fal ${request_id}: ${s.status}${s.queue_position != null ? ` (queue ${s.queue_position})` : ''}`);
  }
  const out = await fetch(response_url, { headers });
  if (!out.ok) throw new Error(`fal result ${out.status}: ${(await out.text()).slice(0, 300)}`);
  const json = await out.json();
  const videoUrl = json.video?.url;
  if (!videoUrl) throw new Error(`fal result had no video url: ${JSON.stringify(json).slice(0, 300)}`);
  const vid = await fetch(videoUrl);
  if (!vid.ok) throw new Error(`video download ${vid.status}`);
  return Buffer.from(await vid.arrayBuffer());
}

/** Ambient loop for a single scene. */
export async function animateLoop(stillPng, style, opts = {}) {
  return falRequest(
    {
      prompt: `${style.videoPrompt} The camera stays essentially fixed so the clip loops seamlessly.`,
      image_url: toDataUri(stillPng),
      duration: config.falLoopSeconds,
      resolution: config.falResolution,
      prompt_expansion_mode: 'balanced',
    },
    opts,
  );
}

/** Flyover transition from scene A's still to scene B's still (first + last frame). */
export async function animateTransition(fromPng, toPng, style, opts = {}) {
  const prompt =
    opts.prompt ||
    `Aerial flyover: the camera lifts off from the first city view, soars high across landscape and clouds, then descends smoothly into the second city view. ${style.videoPrompt}`;
  return falRequest(
    {
      prompt,
      image_url: toDataUri(fromPng),
      end_image_url: toDataUri(toPng),
      duration: config.falTransitionSeconds,
      resolution: config.falResolution,
      prompt_expansion_mode: 'balanced',
    },
    opts,
  );
}
