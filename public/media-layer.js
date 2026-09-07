// A MapLibre custom layer that paints a video (or still image) across the whole viewport,
// underneath the label layers. The map camera is pinned to the keyframe camera, so labels
// projected by MapLibre land on the right pixels of the clip.
//
// Usage:
//   const layer = new MediaLayer('scene-media');
//   map.addLayer(layer, 'labels-circle');      // insert below labels
//   layer.setMedia(videoEl | imageEl);         // swap what is shown
//   layer.setMedia(frameA, frameB, 0.4)        // blend between two frames of a sequence
//   layer.setGrade({ saturation: 1.2 })        // colour-grade it (null resets to identity)
//   layer.fadeTo(0, 400).then(...)             // animate opacity

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// The grade uniforms default to identity, so styled stills and loops (which are already graded by
// gpt-image-1) pass through untouched. Only raw media — the orbit frames — gets a grade applied.
const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform sampler2D u_tex2;
uniform float u_mix;
uniform float u_opacity;
uniform float u_gamma;
uniform float u_contrast;
uniform vec3 u_gain;
uniform vec3 u_lift;
uniform float u_saturation;
uniform float u_vignette;
varying vec2 v_uv;
void main() {
  // u_mix blends towards the next frame of an image sequence, so a slow turntable reads as
  // continuous motion rather than stepping between discrete bearings.
  vec3 c = mix(texture2D(u_tex, v_uv).rgb, texture2D(u_tex2, v_uv).rgb, u_mix);

  c = pow(max(c, 0.0), vec3(1.0 / u_gamma));
  c = (c - 0.5) * u_contrast + 0.5;
  c = c * u_gain + u_lift;

  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, u_saturation);

  // Soft circular falloff towards the corners; 0.0 disables it entirely.
  float d = distance(v_uv, vec2(0.5));
  c *= 1.0 - u_vignette * smoothstep(0.35, 0.85, d);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0) * u_opacity;
}`;

/** Neutral grade: every operation above becomes a no-op. */
const IDENTITY_GRADE = { gamma: 1, contrast: 1, gain: [1, 1, 1], lift: [0, 0, 0], saturation: 1, vignette: 0 };

export class MediaLayer {
  constructor(id) {
    this.id = id;
    this.type = 'custom';
    this.renderingMode = '2d';
    this.media = null;
    this.mediaNext = null;
    this.mix = 0;
    this.opacity = 0;
    this.grade = IDENTITY_GRADE;
    this._fade = null;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.aPos = gl.getAttribLocation(prog, 'a_pos');
    this.uTex = gl.getUniformLocation(prog, 'u_tex');
    this.uTex2 = gl.getUniformLocation(prog, 'u_tex2');
    this.uMix = gl.getUniformLocation(prog, 'u_mix');
    this.uOpacity = gl.getUniformLocation(prog, 'u_opacity');
    this.uGamma = gl.getUniformLocation(prog, 'u_gamma');
    this.uContrast = gl.getUniformLocation(prog, 'u_contrast');
    this.uGain = gl.getUniformLocation(prog, 'u_gain');
    this.uLift = gl.getUniformLocation(prog, 'u_lift');
    this.uSaturation = gl.getUniformLocation(prog, 'u_saturation');
    this.uVignette = gl.getUniformLocation(prog, 'u_vignette');

    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const makeTex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    this.tex = makeTex();
    this.tex2 = makeTex();
  }

  onRemove(_map, gl) {
    gl.deleteProgram(this.prog);
    gl.deleteBuffer(this.buf);
    gl.deleteTexture(this.tex);
    gl.deleteTexture(this.tex2);
  }

  /**
   * @param {HTMLVideoElement|HTMLImageElement|null} el
   * @param {HTMLImageElement|null} [next]  optional next frame to blend towards
   * @param {number} [mix]  0 = el, 1 = next
   */
  setMedia(el, next = null, mix = 0) {
    this.media = el;
    this.mediaNext = next;
    this.mix = next ? Math.max(0, Math.min(1, mix)) : 0;
    this.map?.triggerRepaint();
  }

  /**
   * Apply a colour grade to whatever this layer paints. Pass null/undefined to reset to identity.
   * @param {{gamma?:number,contrast?:number,gain?:number[],lift?:number[],saturation?:number,vignette?:number}|null} g
   */
  setGrade(g) {
    this.grade = { ...IDENTITY_GRADE, ...(g || {}) };
    this.map?.triggerRepaint();
  }

  setOpacity(v) {
    this.opacity = Math.max(0, Math.min(1, v));
    this.map?.triggerRepaint();
  }

  /** Tween opacity; resolves when done. */
  fadeTo(target, ms = 400) {
    if (this._fade) this._fade.cancel();
    const from = this.opacity;
    const start = performance.now();
    return new Promise((resolve) => {
      let raf;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / ms);
        const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
        this.setOpacity(from + (target - from) * e);
        if (t < 1) raf = requestAnimationFrame(tick);
        else { this._fade = null; resolve(); }
      };
      this._fade = { cancel: () => { cancelAnimationFrame(raf); this._fade = null; resolve(); } };
      raf = requestAnimationFrame(tick);
    });
  }

  _ready(m) {
    if (!m) return false;
    if (m instanceof HTMLVideoElement) return m.readyState >= 2 && m.videoWidth > 0;
    if (m instanceof HTMLImageElement) return m.complete && m.naturalWidth > 0;
    return false;
  }

  _mediaReady() {
    return this._ready(this.media);
  }

  render(gl) {
    if (this.opacity <= 0 || !this._mediaReady()) return;
    gl.useProgram(this.prog);
    const blend = this.mix > 0 && this._ready(this.mediaNext);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.media);
      gl.activeTexture(gl.TEXTURE1);
      // Unit 1 always needs a complete texture, even when nothing is being blended.
      gl.bindTexture(gl.TEXTURE_2D, blend ? this.tex2 : this.tex);
      if (blend) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.mediaNext);
    } catch (e) {
      return; // cross-origin / not-yet-decodable frame; try again next frame
    }
    const g = this.grade;
    gl.uniform1i(this.uTex, 0);
    gl.uniform1i(this.uTex2, blend ? 1 : 0);
    gl.uniform1f(this.uMix, blend ? this.mix : 0);
    gl.uniform1f(this.uOpacity, this.opacity);
    gl.uniform1f(this.uGamma, g.gamma);
    gl.uniform1f(this.uContrast, g.contrast);
    gl.uniform3fv(this.uGain, g.gain);
    gl.uniform3fv(this.uLift, g.lift);
    gl.uniform1f(this.uSaturation, g.saturation);
    gl.uniform1f(this.uVignette, g.vignette);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Keep repainting while a video is playing so new frames get uploaded.
    if (this.media instanceof HTMLVideoElement && !this.media.paused) this.map.triggerRepaint();
  }
}
