---
title: "Video-as-Code: Deterministic Motion-Graphics Pipeline for Agent-Produced Product Videos"
date: 2026-07-28
category: design-patterns
module: video-production
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "agent must produce video but cannot drive GUI tools (Reve, Veo 3, Premiere)"
  - "product explainer or pitch video is requested from a coding agent"
  - "animation must be frame-accurate and reproducible, not wall-clock CSS"
  - "narration (VO) duration must drive per-scene animation timelines"
  - "a long multi-thousand-frame render needs cheap pre-flight QA"
tags: [video-as-code, motion-graphics, deterministic-animation, playwright-frame-capture, ffmpeg, tts-narration, probe-qa, svg-animation]
---

# Video-as-Code: Deterministic Motion-Graphics Pipeline for Agent-Produced Product Videos

## Context

An agent needed to produce a product explainer video entirely with local tooling — no video-generation SaaS, no screen recording, no editor. The accepted pipeline emerged after two rejections that established the content bar:

1. **Iteration 1** — static slide screenshots with ffmpeg `zoompan` (Ken Burns). Rejected: "why doesn't it move."
2. **Iteration 2** — animated-text HTML slides with a deterministic time engine. Rejected: "I don't just want the slides being shown, I want animation." (auto memory [claude]: the user's bar is Aegis/Watchman-style visual models of the system in motion, never slide decks)
3. **Iteration 3** — SVG motion-graphics scenes that *model the system doing its job*: tickets flowing through a DAG into worker lanes, a gate arch where a failing ticket flashes red and bounces back for retry, event dots streaming into a ledger column, a factory consuming a prompt token and emitting an app window. Accepted.
4. **Iteration 4** — restructure/rebrand pass where voiceover was synthesized and measured *first*, and every scene timeline was retimed against measured durations.

The full toolchain is committed in the private artifacts repo (`gstack-artifacts-jaynyasg`) under `projects/jaynyasg-SoftwareFactoryAI/video/build/`:

- `scenes_animated.html` — one HTML file, one SVG scene per section, driven by `window.setTime(t)`
- `tts2.ps1` — Windows System.Speech TTS per scene, writes `durations.json`
- `frames2.js` — Playwright steps `t` at 12 fps and screenshots each frame; `--probe` mode for QA
- `music.ps1` — procedural ambient music WAV via C# `Add-Type`
- `assemble2.ps1` — ffmpeg per-scene clips, concat, music mix, loudnorm, fades

## Guidance

### 1. Content bar: animate the system, never the text

Every scene must be an animated *model* of the system doing its job — an object moving through a process. Text fading in over a background is a slide, not an animation, and will be rejected. The unit of design is "what object travels where, and what happens to it": a ticket enters a lane, hits a gate, fails, turns red, bounces back, retries, turns green, passes. From `scenes_animated.html` (the fail/retry bounce):

```js
// helpers: $ = getElementById, O = set opacity, T = set translate transform;
// seg/lerp defined in section 2
// T-04 fail: flash the tests label red at 17.4, ticket4 bounces back
var g3 = $('s4-g3');
if (t > 17.4 && t < 19.2) g3.setAttribute('fill', '#EF4444');
var t4 = $('s4-t4');
var bounce = seg(t, 17.6, 1.2);
if (bounce > 0 && bounce < 1) {
  O(t4, 1);
  // 1 - Math.abs(1 - 2p) = triangle wave: 0→1→0, an out-and-back path
  T(t4, lerp(640, 1060, 1 - Math.abs(1 - 2 * bounce)), lerp(430, 500, 1 - Math.abs(1 - 2 * bounce)));
  t4.querySelector('rect').setAttribute('fill', '#EF4444');
} else if (t >= 18.8 && t < 21.0) {
  // retry: refill lane 1 quickly then pass green
  O(t4, 1); T(t4, 640, 430);
  t4.querySelector('rect').setAttribute('fill', seg(t, 19.8, 1.0) > 0 ? '#4ADE80' : '#F59E0B');
}
```

### 2. Determinism: every pixel is a pure function of t

All animation goes through `window.setTime(t)`. No CSS animations or transitions (they run on the wall clock and drift against frame stepping), no `Date.now()`, no raw `Math.random()`. Same `t` in → same pixels out, which makes any single scene re-renderable in isolation after a fix. The whole engine is a small helper vocabulary plus per-scene updater functions:

```js
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function seg(t, t0, d) { return clamp01((t - t0) / d); }   // 0..1 over [t0, t0+d]
function ez(p) { return 1 - Math.pow(1 - p, 3); }          // ease-out cubic
function lerp(a, b, p) { return a + (b - a) * p; }
// deterministic pseudo-random from integer seed (NOT Math.random)
function rnd(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

window.setTime = function (t) {
  if (active) driftGrid(active, t);
  var u = updaters[sceneNum];
  if (u) u(t);
};
```

Even "random" texture (scribble lines, jitter) uses the seeded `rnd(n)` so probes and full renders match.

### 3. Audio-first timing: measure VO, then key the animation

Never guess scene lengths. Synthesize voiceover per scene first, measure each WAV, write `durations.json`, and only then author/retime the scene timelines against those numbers (scene length = VO + 0.7 s pad). From `tts2.ps1` — a 44.1 kHz 16-bit mono WAV's duration is just `(bytes - 44) / (44100 × 2)`:

```powershell
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($s in $scenes) {
  $wav = Join-Path $dir ("vo{0:d2}.wav" -f $s.id)
  $synth.SetOutputToWaveFile($wav, $fmt)
  $synth.Speak($s.text)
  $synth.SetOutputToNull()
  $bytes = (Get-Item $wav).Length
  $sec = [math]::Round(($bytes - 44) / (44100.0 * 2), 2)
  $durations += [pscustomobject]@{ scene = $s.id; seconds = $sec }
}
ConvertTo-Json @($durations) | Set-Content (Join-Path $dir "durations.json")
```

`durations.json` is *ordered* — it is the single source of truth consumed by both frame capture and assembly, so scene order and length can never disagree between stages.

### 4. Frame capture: step time, screenshot, 12 fps in / 30 fps out

Playwright loads each scene's page once, then steps `t` and screenshots. 12 fps input frames encoded at `-r 30` read smooth for motion-graphics (large easing moves, not fast action). Use `deviceScaleFactor: 2` only if the output will later be zoomed (zoompan needs resolution headroom). From `frames2.js`:

```js
for (const { scene, seconds } of durations) {
  const total = seconds + TAIL_PAD;   // TAIL_PAD = 0.7
  const url = pageUrl + '?scene=' + scene;   // scene selected via query param
  await page.goto(url, { waitUntil: 'networkidle' });
  const n = Math.ceil(total * FPS);   // FPS = 12
  for (let f = 0; f < n; f++) {
    await page.evaluate((t) => window.setTime(t), f / FPS);
    await page.screenshot({ path: framePath(scene, f), type: 'jpeg', quality: 92 });
  }
}
```

Also wire `page.on('pageerror', ...)` — a silent JS error otherwise produces thousands of frozen frames.

### 5. Probe QA before the full render

A full capture is ~3,000 frames. Before committing to it, capture 3 stills per scene at 25/55/85% of each timeline and eyeball them — this catches z-order bugs, invisible overlaps, and mistimed events for pennies:

```js
if (probe) {
  for (const frac of [0.25, 0.55, 0.85]) {
    await page.evaluate((t) => window.setTime(t), total * frac);
    await page.screenshot({ path: probePath(scene, frac), type: 'jpeg', quality: 92 });
  }
  continue;
}
```

### 6. Assembly: per-scene clips, concat, music under, loudnorm

Encode each scene as its own clip (frames + its VO, `-af apad -shortest` so audio pads to the video), concat with the demuxer, then mix procedural music ~14 dB under the VO and normalize. From `assemble2.ps1`:

```powershell
$i = "{0:d2}" -f $s.scene   # zero-padded to match tts2.ps1's vo{0:d2}.wav
ffmpeg -y -loglevel error `
    -framerate 12 -i (Join-Path $dir "frames\s$i\f%04d.jpg") `
    -i (Join-Path $dir "vo$i.wav") `
    -af apad -shortest `
    -c:v libx264 -r 30 -preset medium -crf 19 -pix_fmt yuv420p `
    -c:a aac -b:a 192k `
    (Join-Path $clips "c$i.mp4")

ffmpeg -y -loglevel error -i $narrated -i (Join-Path $dir "music.wav") `
    -filter_complex "[1:a]volume=1.4,afade=t=in:st=0:d=1.5,afade=t=out:st=${mFade}:d=4[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[mix];[mix]loudnorm=I=-16:TP=-1.5:LRA=11[a]" `
    -vf "fade=t=in:st=0:d=0.6,fade=t=out:st=${vFade}:d=1.2" `
    -map 0:v -map "[a]" ...
```

Key details: `amix ... normalize=0` (default amix halves both inputs — normalize=0 keeps VO at full level with music quiet under it), `loudnorm=I=-16:TP=-1.5:LRA=11` for streaming-standard loudness, video fade in/out computed from measured total duration. The `volume=1.4` boost looks like it contradicts "music under the VO" — it was tuned by ear against this quiet music bed (peaks around −17 dB); the invariant to preserve is the resulting ~14 dB gap under voice, not the multiplier. The music itself is a ~100-line C# class compiled inline with `Add-Type` (`music.ps1`) — pad chords, sub pulse, sparse kick, occasional bell — so the bed is royalty-free by construction and exactly the video's length.

## Why This Matters

- **The content bar is the difference between two rejections and an acceptance.** Both failed iterations were technically fine; they failed on *what* was animated. Knowing "objects moving through a process, never text fading in" up front saves two full build-review cycles.
- **Determinism is what makes iteration cheap.** Because pixels are a pure function of `t`, a bug fix in one scene means re-rendering only that scene's frames, and probes are guaranteed to match the final render. CSS animations would make every capture a race against the wall clock.
- **Audio-first timing eliminates the worst failure mode of narrated video** — animation and narration drifting apart. TTS duration cannot be predicted from text length; measuring the WAVs and treating `durations.json` as the shared contract means capture and assembly can never disagree.
- **Probe QA converts an expensive visual failure into a cheap one.** A z-order or overlap bug found after a full 3,000-frame capture and encode costs an hour; found in 39 probe stills it costs a minute.
- **Everything is local and reproducible.** System.Speech, Playwright, ffmpeg, and inline C# are all free and offline; the entire video rebuilds from source files with no accounts, uploads, or licensing questions.

## When to Apply

- Producing explainer/demo/marketing video for a software product with local tooling only.
- Any narrated video where animation must sync to voiceover — synthesize and measure audio first, always.
- Any frame-stepped capture of web content (Playwright/Puppeteer screenshots into ffmpeg) — the determinism rules apply even outside video (e.g., visual regression of animated UI).
- Rendering diagrams or motion graphics for downstream editors — note Premiere cannot import SVG (see gotchas).
- NOT the right tool when photorealistic or camera-style footage is required — this pipeline is for diagrammatic motion graphics of systems and data flows.

## Examples

**Scene as system model (accepted iteration).** The pipeline scene renders the actual product behavior: five gate labels light amber as tickets pass, the tests gate flashes red at t=17.4, ticket T-04 bounces back along the reverse path, sits in its lane, flips green on retry, and travels through — all keyed to the narration line "Watch T zero four: it fails the tests gate, bounces back, and retries with bounded attempts." The narration and animation describe the same event at the same second because the scene was retimed to the measured 28.94 s VO in `durations.json`.

**Run order.** `& tts2.ps1` (VO + durations.json) → author/retime scene updaters → `node frames2.js --probe` (inspect stills) → `node frames2.js` (full capture) → `& music.ps1 -DurationSeconds <total>` (`<total>` = sum of durations.json + 0.7 s pad per scene, rounded up) → `& assemble2.ps1`.

**Gotchas (all hit in this build):**

- **pnpm transitive deps aren't at node_modules root.** Playwright came in transitively; `require('playwright')` fails. What worked in this build (version-pinned, breaks on upgrade):
  ```js
  const { chromium } = require(path.join(repoRoot, 'node_modules', '.pnpm',
    'playwright@1.61.1', 'node_modules', 'playwright'));
  ```
  The durable fix is adding `playwright` as a direct devDependency (or resolving it from the package that owns it via `require.resolve`).
- **Windows script execution.** Spawning `powershell -ExecutionPolicy Bypass -File x.ps1` from a child process can be policy-blocked; running `& .\x.ps1` inside the current pwsh session works (RemoteSigned permits local scripts).
- **SVG z-order is document order.** Moving elements defined before static boxes render *under* them. Fix at build time by re-appending: `['s4-t1', ..., 's4-t5'].forEach(function (id) { svg4.appendChild($(id)); });`
- **CSS class beats SVG presentation attribute.** A stylesheet rule like `.wired { stroke: #355248; }` overrides `stroke="..."` on the element; use inline `style="stroke: ..."` when you need a one-off color.
- **Premiere does not import SVG.** For diagrams handed to an editor, render to 4x transparent PNG: `mmdc -s 4 -b transparent`.
- **TTS brand puns garble.** On-screen brand is "SoftwAIre Pump"; the TTS input says "Software Pump" so pronunciation stays clean. Same trick for initialisms: the script spells "A P I", "Next J S", "C L I".
- **Converging elements stack invisibly.** Multiple objects animated to identical destination coordinates overlap into what looks like one object — stagger the destinations by a few pixels.
- **amix silently halves your VO** unless you pass `normalize=0`; keep music roughly 14 dB under voice and let `loudnorm` set the final level.

## Related

- Build sources, all four video cuts, and the Reve/Veo 3/Premiere production kit: private artifacts repo `gstack-artifacts-jaynyasg`, `projects/jaynyasg-SoftwareFactoryAI/video/` (commit `83315cf`).
- Reference quality bar: `Capstone - Aegis/slides/watchman-pitch/build_watchman_action_pitch_video.ps1` (per-frame GDI+ variant of the same idea).
- No related docs in this repo's `docs/` tree and no GitHub issues (searched 2026-07-28).
