# Terraform — living map scenes you fly between

A small Node/Express + MapLibre project that turns map cameras into AI-animated "living scenes"
and lets you fly between them, or orbit them 360°.

```
scene camera ─▶ Mapbox Static Images (keyframe.png)
             ─▶ OpenAI gpt-image-1 edit          (styled.png)        [optional: OPENAI_API_KEY]
             ─▶ MiniMax H3 Max on fal            (loop.mp4)          [optional: FAL_KEY]
             ─▶ MiniMax first+last frame         (transition_to_X.mp4)
             ─▶ Mapbox Tilequery                 (labels.geojson)
                        │
                        ▼
      MapLibre GL JS: full-viewport video custom layer (colour-graded, cross-faded)
```

Every optional step degrades gracefully: with only a Mapbox token you get styled-less keyframes
that cross-fade between scenes; add the OpenAI key for stylized stills; add the fal key for
animated loops and flyover transitions.

## Setup

```bash
cp .env.example .env      # add MAPBOX_TOKEN (required), OPENAI_API_KEY / FAL_KEY (optional)
npm install
npm start                 # http://localhost:3000
```

Rendering is CLI-only (the viewer has no render buttons):

```bash
npm run render -- --scene paris-eiffel --style realistic --to nyc-midtown
npm run render:all -- --style realistic         # all 15 scenes + transitions between neighbours
npm run render -- --help
```

Outputs are cached under `data/scenes/<scene>/…`; delete a file or pass `--force` to re-render.
Note `--force` re-runs *every* step for that scene, including the paid stylize and video calls —
to redo one thing, delete just that file instead.

### 360° orbit

An orbit is a set of pre-rendered frames, one per bearing, stored per scene under
`data/scenes/<scene>/orbit/`. The viewer plays them back while driving `map.setBearing()` from the
same position, so the map camera stays in step with the imagery through the whole turn.

There are three ways to create them. **Pick one per scene** — they write to the same place and
replace each other.

| | Look | 3D? | Cost | How |
|---|---|---|---|---|
| **A. Static Images sweep** | flat satellite, colour-graded | no | Mapbox requests only | `--orbit` on the CLI |
| **B. Standard 3D capture** | real 3D buildings and landmarks | **yes** | free (browser rendering) | button in `/capture.html` |
| **C. Anchor-chained video** | AI photoreal, like `loop.mp4` | no (2D reinterpretation) | **paid** — image edits + video jobs | `--anchor-orbit` on the CLI |

If you want landmarks that stand up, use **B**. Start there.

---

#### A. Static Images sweep (flat, free, fast)

Renders `ORBIT_FRAMES` keyframes around the scene centre, one per bearing, at the scene's own
`zoom`/`pitch`. Needs only `MAPBOX_TOKEN`.

```bash
npm run render -- --scene paris-eiffel --orbit
npm run render -- --scene paris-eiffel --orbit --force    # re-render frames that already exist
```

Frames are written as `data/scenes/paris-eiffel/orbit/000.png` … `071.png`, plus a `meta.json`
recording `{ "source": "static-images" }`. Budget roughly 70–120 MB per scene for 72 frames
(denser cities compress worse); a method-B capture of the same scene runs larger still, ~150 MB.

These come from `ORBIT_STYLE` (default `mapbox/satellite-v9`), **not** the `KEYFRAME_STYLE` used
elsewhere: `satellite-streets-v12` bakes road names and POI pins into the raster, and no colour
grade can remove them — baked-in labels are what make a frame read as "a map" rather than an aerial
photograph.

The catch: Static Images renders a **flat** map. At pitch 60 you are looking obliquely at a flat
plane, so the Eiffel Tower is painted on the ground rather than standing up. That API does not
support `mapbox/standard`, so 3D cannot come from it at all — that is what method B is for.

#### B. Standard 3D capture (real 3D buildings)

Mapbox GL JS v3 *can* render `mapbox/standard` with 3D objects, so the capture page renders each
bearing in the browser and uploads it.

1. `npm start`, then open <http://localhost:3000/capture.html>
2. Pick the **Scene**
3. Pick the **Basemap**:
   - **Standard Satellite** — real satellite imagery draped over the 3D buildings. Use this for a
     photographic look.
   - **Standard** — the vector basemap. Clean 3D geometry, but pastel cartographic colours.
4. Pick a **Light** preset (`day`, `dawn`, `dusk`, `night`) — this bakes real shadows into the frames
5. Click **Capture 360° orbit**, then click it again to confirm (it replaces existing frames)
6. Wait — it captures every bearing in turn and shows `Captured n/72`. **Stop** aborts part-way.
7. Reload the viewer and tick **Orbit**

It sweeps the same bearings the pipeline would, using the scene's own camera (it ignores whatever
you dragged the map to), so playback is identical to method A — the viewer cannot tell the two
sources apart. Takes a few minutes per scene.

The sweep writes `meta.json` with `{ "source": "mapbox-standard", ... }`. This matters: the viewer
applies the style's colour grade **only** to `static-images` frames. Standard captures are already
lit by their light preset, and grading them again blows out the highlights to white and pink.

#### C. Anchor-chained video orbit (AI photoreal, paid)

`loop.mp4` looks photoreal because `gpt-image-1` reimagined one flat render — but that is a single
2D interpretation with no 3D model behind it, so there is nothing to orbit. Regenerating the
reinterpretation at every bearing does not work either: `gpt-image-1` exposes no seed, so all 72
frames would be independent samples and the sequence would boil.

The workable version is to stylize only a few **anchor** bearings and let the video model generate
the motion between consecutive anchors:

```bash
npm run render -- --scene paris-eiffel --anchor-orbit               # 8 anchors, 45° apart
npm run render -- --scene paris-eiffel --anchor-orbit --anchors 12  # finer, more expensive
```

Each clip is pinned to real endpoints (`image_url` = anchor *i*, `end_image_url` = anchor *i+1*),
so drift is bounded by one anchor gap instead of accumulating over a full turn. Output lands in
`data/scenes/<scene>/<style>/anchors/` as `00.png`…`07.png` plus `clip_00.mp4`…`clip_07.mp4`. The
viewer plays the clips back to back and interpolates the bearing across each one; no `ffmpeg`.

`FAL_KEY` is required — without it the command fails immediately. `OPENAI_API_KEY` is what makes
it *photoreal*: the stylize step degrades silently to passing the raw keyframe through, so with no
OpenAI key you get a video orbit of unstyled satellite frames, which is a slow expensive way to get
method A's look.

This is by far the most expensive thing in the pipeline — `ORBIT_ANCHORS` image edits *and*
`ORBIT_ANCHORS` video jobs per scene and style. Only the anchors are geospatially exact; the model
interpolates between them.

---

#### Using and tuning an orbit

Tick **Orbit** in the viewer. The control is **disabled and dimmed for locations with no orbit
frames**, with a tooltip naming the command that would create them — so it is only offered where it
does something. Your on/off choice is sticky: move to a location without an orbit and the toggle
greys out, move back and it is still ticked. A scene chip also carries a faint blue ring when it has
orbit frames.

If a scene has both an anchor orbit (C) and a frame sequence (A or B), the anchor orbit wins. Orbit
mode owns the camera, so it replaces that scene's ambient loop and flyover transition.

**Speed.** A full turn takes `ORBIT_FRAMES / ORBIT_FPS` seconds. Lower `ORBIT_FPS` to slow it down
(4 → 18s, 2 → 36s; fractional values work down to 0.1). Adjacent frames are cross-faded and the
bearing is driven from a continuous position rather than a frame index, so slow speeds stay smooth
instead of stepping between bearings. Raising `ORBIT_FRAMES` gives finer angular steps at the cost
of a longer sweep. Both are read at server start — restart after editing `.env`.

**Replacing frames.** Methods A/B/C all overwrite. To clear a sweep by hand, delete
`data/scenes/<scene>/orbit/` (or `<style>/anchors/` for method C). Manifest URLs are stamped with
each file's mtime, so a re-render always busts the browser cache — no hard-refresh needed.

**Colour grade.** For `static-images` frames only, the style's look is applied at display time as a
grade in the `MediaLayer` fragment shader (`STYLES.realistic.grade` in `server/pipeline/scenes.js`,
served via `/api/config`). It is deterministic, so the turntable is perfectly stable, costs nothing,
and re-tunes instantly with no re-render. The shipped values were fitted numerically — they solve
for the graded frames matching `realistic/styled.png`'s mean RGB and luma spread. A grade re-tones
imagery but cannot reinterpret it, which is fine for `realistic` (satellite imagery already *is*
photoreal) but would not work for a painterly style.

## Deploying to Cloud Run

```bash
gcloud run deploy terraform-scene \
  --source . --region us-central1 --allow-unauthenticated \
  --memory 2Gi --max-instances 3 \
  --set-env-vars "MAPBOX_TOKEN=pk.…,READ_ONLY=1"
```

The rendered scenes are baked into the image (`COPY data ./data`), so the container is
self-contained — roughly 1 GB of scene data on top of the base image. Rebuild and redeploy to ship
newly rendered scenes.

**`.gcloudignore` is required, not optional.** With no `.gcloudignore`, `gcloud` falls back to
`.gitignore` — which excludes `data/scenes/**/*.png|mp4` — and you would silently deploy an image
with no scene data. The committed `.gcloudignore` excludes `node_modules` and the env files but
deliberately keeps `data/`.

### Large media and the 32 MiB response cap

Cloud Run caps a single HTTP response at 32 MiB. Generated clips routinely exceed that — a 15s
loop at the model's default bitrate is ~50 MB — and a `<video>` element opens playback with
`Range: bytes=0-`, which asks for the whole file and trips the cap (HTTP 500, and the viewer stays
on the bare base map because the layer only fades in once the clip is ready).

`server/index.js` therefore clamps open-ended or oversized range requests on `/data` to 8 MiB
chunks. The browser transparently requests the next chunk as it plays; small files are untouched.

The clips are also far larger than they need to be — around 27 Mbps for 1152×768 — so re-encoding
them (or serving media from a bucket) would cut the image size several-fold and speed up loads.

### Read-only mode

`config.readOnly` disables every endpoint that mutates data or spends money — `/api/render`, the
keyframe upload, and the three orbit-capture endpoints all return 403. It defaults **on** when
`K_SERVICE` is set (i.e. on Cloud Run) and **off** locally, so `capture.html` keeps working on your
machine while a public deployment cannot be used to run up your OpenAI or fal bill. `READ_ONLY=1`
or `READ_ONLY=0` overrides the default either way.

A read-only deployment needs **only** `MAPBOX_TOKEN` — leave `OPENAI_API_KEY` and `FAL_KEY` out of
the service entirely. Note the Mapbox token is served to the browser by `/api/config` (the map tiles
need it client-side), so on a public URL it is visible to anyone: use a `pk.` token restricted to
the deployed origin in the Mapbox account settings.

Rendering stays local — render on your machine, then redeploy.

## Layout

| Path | What |
|---|---|
| `server/pipeline/scenes.js` | Scene cameras grouped by city, and the `realistic` style preset (prompts + orbit colour grade). **Edit this to add scenes/styles.** |
| `server/pipeline/keyframes.js` | Mapbox Static Images API render |
| `server/pipeline/stylize.js` | gpt-image-1 image edit |
| `server/pipeline/animate.js` | fal queue client: loops (`image_url`) and transitions (`image_url` + `end_image_url`) |
| `server/pipeline/labels.js` | Mapbox Tilequery → compact GeoJSON |
| `server/pipeline/render.js` | Orchestrator with on-disk caching; builds the manifest; renders the orbit sweep and the anchor orbit |
| `server/index.js` | Express: static files, `/api/config`, `/api/manifest`, `/api/render` (background jobs; not used by the viewer), keyframe upload, orbit capture endpoints |
| `public/media-layer.js` | MapLibre custom WebGL layer that paints a video/image across the viewport |
| `public/app.js` | Viewer: style picker, city/location chips, transitions, 360° orbit playback |
| `public/capture.html` | Optional: render **Mapbox Standard with 3D landmarks** in Mapbox GL JS v3; capture it as the keyframe, or sweep a full 3D 360° orbit |

## How alignment works

The stage is fixed at the keyframe size (1280×720). The MapLibre camera is pinned to the exact
`center/zoom/bearing/pitch` the keyframe was rendered with, and the video is painted 1:1 across the
viewport. Because MapLibre and the Static Images API share the same projection and default field
of view, anything MapLibre projects lands on the matching pixels of the clip.
During a transition the map `flyTo`s the next camera while the flyover clip plays, then the next
loop takes over — the same idea as the post's "next: ground the flyover transitions" step; the
in-between frames are not yet geospatially accurate, only the endpoints are. A frame-sequence
orbit (methods A and B) does not have this limitation: every frame is a real render at a known
bearing, and the map camera is driven to match it. An anchor-chained orbit (method C) does — only
its anchors are exact.

The label layers (`labels.geojson`, Tilequery) are still produced by the pipeline and listed in the
manifest, but the viewer no longer draws them; re-enabling is a frontend-only change.

## Notes and known limits

- The Static Images API does not (yet) support the `mapbox/standard` style, so 3D landmarks
  cannot come from it — neither for keyframes nor for orbit frames. Use `public/capture.html` to
  render Standard (with landmarks, light presets) client-side and upload that as the scene's
  keyframe, or as a full 3D orbit sweep.
- gpt-image-1 outputs 1536×1024 (3:2); it is stretched onto the 16:9 stage. If that bothers you,
  crop the styled image to 16:9 before animating, or render keyframes at 1280×853.
- The fal model is configurable via `FAL_VIDEO_MODEL`; the default `minimax/h3-max/image-to-video`
  supports both `image_url` and `end_image_url`, which is what the transitions rely on. Its
  `duration` is a whole number of seconds from **5 to 15** (`FAL_LOOP_SECONDS` /
  `FAL_TRANSITION_SECONDS`, clamped in `server/config.js`), and `resolution` is one of
  480P / 768P / 1080P. Clips are cached on disk, so lengthening one means deleting
  `data/scenes/<scene>/<style>/loop.mp4` (or passing `--force`) to pay for a re-render.
- Generated clips are gitignored (`data/scenes/**/*.mp4|png`).
