# Drone Orbit

Drone Orbit is a single-page ambient soundscape for GitHub Pages. A spacecraft flies around a double-ring circle of fifths: major keys on the outer orbit and relative minors on the inner orbit. The ship's position drives both the canvas glow and the Web Audio mix.

## Local Run

Serve the repository root with any static file server. The app uses only relative paths and has no build step.

```bash
python -m http.server 8000
```

## GitHub Pages

The repository includes `.github/workflows/pages.yml`, which deploys the static root to GitHub Pages on pushes to `main`.

Project URL once Pages is active:

```text
https://madshjelm.github.io/drone-orbit/
```

WordPress/Elementor fullscreen iframe:

```html
<iframe
  src="https://madshjelm.github.io/drone-orbit/"
  style="position: fixed; inset: 0; width: 100vw; height: 100dvh; border: none; margin: 0; padding: 0; z-index: 9999;"
  allow="autoplay; fullscreen">
</iframe>
```

The app prioritizes stable foreground audio on Android. Android Chrome and
iframe embeds use direct Web Audio output; the hidden media-element sink remains
best-effort for non-Android media controls/background behavior.

## Audio Files

Upload loopable files to the configured relative paths. For best compatibility,
provide the same stem in this order:

```text
audio/<ring>/<key>.webm  WebM/Opus, 48 kHz stereo, 96-128 kbps
audio/<ring>/<key>.ogg   OGG/Vorbis, 48 kHz stereo
audio/<ring>/<key>.m4a   MP4/AAC, 48 kHz stereo, 128 kbps
audio/<ring>/<key>.mp3   Optional MP3 fallback
```

The current app ships fallback WebM/Opus and M4A/AAC files for the existing
`C`, `D`, and `G` major loops. Keep replacement files exactly loopable; if an
encoded fallback adds padding, update the region `loopDuration` metadata in
`src/config.js` to the intended OGG loop length. When adding a new key, also add
its `audio/<ring>/<key>` stem to `availableAudioStems` in `src/config.js` so the
app fetches it.

Configured key stems:

```text
audio/major/C.ogg
audio/major/G.ogg
audio/major/D.ogg
audio/major/A.ogg
audio/major/E.ogg
audio/major/B.ogg
audio/major/Gb.ogg
audio/major/Db.ogg
audio/major/Ab.ogg
audio/major/Eb.ogg
audio/major/Bb.ogg
audio/major/F.ogg

audio/minor/Am.ogg
audio/minor/Em.ogg
audio/minor/Bm.ogg
audio/minor/Fsharpm.ogg
audio/minor/Csharpm.ogg
audio/minor/Gsharpm.ogg
audio/minor/Ebm.ogg
audio/minor/Bbm.ogg
audio/minor/Fm.ogg
audio/minor/Cm.ogg
audio/minor/Gm.ogg
audio/minor/Dm.ogg
```

Missing audio files are treated as silent regions.

## Diagnostics

Append `?diagnostics=1` to the app URL during device testing to show runtime
profile, selected audio format, output mode, active voices, decode/fetch
failures, loop-padding trims, and long-frame counts.
