# talk-builder

Generates the SMX Advanced talk page at `talks/smx-advanced-2026/` — an illustrated
transcript (slide image + speaker notes) with an optional fullscreen **Present** mode.

## Rebuild

```sh
node tools/talk-builder/build.mjs
```

This regenerates `talks/smx-advanced-2026/index.html`, `slides/slide-NN.webp` (×55),
and `og.png`. The generated `index.html` is server-rendered — the transcript is fully
readable with JavaScript disabled; Present mode is progressive enhancement layered on top.

## Sources

The deck files are committed in **`tools/talk-builder/sources/`** so builds are
reproducible without a local Downloads folder (paths are constants at the top of
`build.mjs`):

- **`…(Boston, June 2026).pptx.pdf`** — the clean 16:9 slides (no notes baked in).
  This is the image source for 53 of the 55 slides.
- **`…(Boston, June 2026).pptx`** — a zip; speaker notes are pulled from
  `ppt/notesSlides/notesSlideN.xml`, mapped to display order via `presentation.xml` +
  per-slide rels. Alt text comes from each slide's on-slide text.
- **`PDF Version - …(Boston, June 2026).pptx.pdf`** — an export with animations
  flattened to their final state; slides 10 & 11 are sourced from here (they were
  captured mid-animation in the baseline export). See `IMAGE_OVERRIDES` in `build.mjs`.

If the deck changes, drop the new file(s) into `sources/` and update the `PPTX` /
`PDF` / `PDF_FLAT` constants (and `IMAGE_OVERRIDES`) in `build.mjs` as needed.

## Prerequisites

- `pdftoppm` (poppler) and `sips` (built into macOS) — required.
- `cwebp` (`brew install webp`) — recommended for small, crisp images. If absent, the
  build automatically falls back to optimized JPEG via `sips` (`slide-NN.jpg`), and the
  generated `<img>` tags use the matching extension.

## Notes

- The page is `<meta name="robots" content="noindex">` and is **not** linked from the
  homepage, `llms.txt`, or any sitemap — it's reachable only by direct URL. To announce
  it later: remove the `noindex` meta in `build.mjs`'s template, add a homepage/llms.txt
  link, and rebuild.
- Edit copy (title, intro, event/date) via the `TALK` object near the top of `build.mjs`,
  then rerun — don't hand-edit the generated `index.html`, as it's overwritten on rebuild.
