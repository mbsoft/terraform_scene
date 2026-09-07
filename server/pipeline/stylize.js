// Step 2 — decorate the keyframe with OpenAI gpt-image-1 (image edit) according to the chosen style.
// Skipped automatically when OPENAI_API_KEY is empty: the raw keyframe is used instead.
import { config } from '../config.js';

export function stylizeEnabled() {
  return Boolean(config.openaiKey);
}

/**
 * @param {Buffer} keyframePng
 * @param {{imagePrompt: string}} style
 * @returns {Promise<Buffer>} PNG
 */
export async function stylizeKeyframe(keyframePng, style, opts = {}) {
  if (!stylizeEnabled()) return keyframePng;

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', style.imagePrompt);
  form.append('size', opts.size || '1536x1024'); // landscape; closest to a 16:9 keyframe
  form.append('quality', opts.quality || 'high');
  form.append('image', new Blob([keyframePng], { type: 'image/png' }), 'keyframe.png');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI images/edits ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI response had no b64_json');
  return Buffer.from(b64, 'base64');
}
