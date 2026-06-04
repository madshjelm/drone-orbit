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

## Audio Files

Upload loopable OGG files to the configured relative paths:

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

Until those files exist, the launch flow generates procedural preview drones in the browser so the interaction can still be tested.
