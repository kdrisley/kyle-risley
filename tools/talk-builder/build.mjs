#!/usr/bin/env node
// Build the SMX Advanced talk page: an illustrated transcript (slide image +
// speaker notes) with an optional fullscreen "present" mode.
//
// Pipeline:
//   1. render each slide of the clean .pptx.pdf to a retina PNG (pdftoppm)
//   2. compress to .webp (cwebp) or fall back to .jpg (sips)
//   3. pull per-slide speaker notes + on-slide text straight out of the .pptx zip
//   4. emit a fully server-rendered index.html (readable with JS disabled)
//
// Re-run any time the deck changes:  node tools/talk-builder/build.mjs
// See tools/talk-builder/README.md for prerequisites.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// Source decks live alongside this script (tools/talk-builder/sources/) so builds
// are reproducible without depending on a local Downloads folder.
const DL = join(dirname(fileURLToPath(import.meta.url)), 'sources');
const PPTX = join(DL, 'Agentic Commerce @ SMX Advanced (Boston, June 2026).pptx');
const PDF = join(DL, 'Agentic Commerce @ SMX Advanced (Boston, June 2026).pptx.pdf'); // clean 16:9 slides

// Per-slide image overrides. The baseline deck export captured a couple of slides
// mid-animation (slide 10's UCP diagram had an empty core; slide 11 had a stray
// confetti emoji). The "PDF Version" deck has these flattened to their final state
// and reads better, so those two pages are sourced from it instead. Notes/order are
// still taken from the baseline deck. { displaySlide: { pdf, page, alt } }
const PDF_FLAT = join(DL, 'PDF Version - Agentic Commerce @ SMX Advanced (Boston, June 2026).pptx.pdf');
const IMAGE_OVERRIDES = {
  10: { pdf: PDF_FLAT, page: 10, alt: 'Universal Commerce Protocol (UCP) — services, capabilities, extensions, and transports' },
  11: { pdf: PDF_FLAT, page: 11, alt: 'The agentic commerce spectrum' },
};

// Per-slide notes overrides. The notes are a verbatim pull of the deck's speaker
// notes — which are a spoken-word transcript. A few read awkwardly as written
// page text (a sentence that trails off onto the next slide, a missing period),
// so we tidy those for legibility without changing wording. `drop: true` removes
// the note entirely (slide 1 is just the speaker self-introducing — redundant on a
// page that already names the speaker). `edits` are exact substring replacements
// applied per paragraph. Generic whitespace tidy (e.g. double spaces) is handled
// in notesParagraphs(). { displaySlide: { drop } | { edits: [[from, to], …] } }
const NOTES_OVERRIDES = {
  1: { drop: true },
  5: { edits: [['There isn’t a single definition, but', 'There isn’t a single definition, but…']] },
  9: { edits: [['standardized access to tools and data,', 'standardized access to tools and data…']] },
  13: { edits: [['but I still choose the product,', 'but I still choose the product.']] },
  36: { edits: [['the previous screenshots were from', 'the previous screenshots were from.']] },
  40: { edits: [['Here’s an example to demonstrate', 'Here’s an example to demonstrate.']] },
  44: { edits: [['for AI visibility: authority', 'for AI visibility: authority.']] },
  51: { edits: [['causing a disapproval or demotion', 'causing a disapproval or demotion.']] },
};

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(REPO, 'talks', 'smx-advanced-2026');
const SLIDES_DIR = join(OUT, 'slides');

const RENDER_DPI = 144; // 960pt slide -> 1920px wide (2x retina)
const IMG_W = 1920;
const IMG_H = 1080;
const WEBP_Q = 82;

// Flip to true to "announce" the talk: drops the noindex meta so it can be indexed.
// Pair with linking the page from the homepage (see index.html "Talks" section).
const ANNOUNCED = true;

const TALK = {
  title: 'Agentic Commerce: Adapting Ecommerce SEO Strategies for the AI Era',
  shortTitle: 'Agentic Commerce',
  speaker: 'Kyle Risley',
  event: 'SMX Advanced, Boston',
  date: 'June 2026',
  intro:
    'My SMX Advanced talk on how AI agents are reshaping ecommerce discovery and ' +
    'checkout — and the SEO playbook for staying visible. Below is every slide with ' +
    'my speaker notes. Hit Present for a fullscreen, slide-by-slide view.',
  url: 'https://kylerisley.com/talks/smx-advanced-2026/',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const have = (cmd) => {
  try { execFileSync('/usr/bin/env', [cmd, '-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const unzipText = (member) => sh('unzip', ['-p', PPTX, member]).toString('utf8');

function decodeXml(s) {
  return s
    .replace(/<a:br\s*\/?>/g, '\n')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x?[0-9a-fA-F]+;/g, (m) => {
      const hex = m[2] === 'x' || m[2] === 'X';
      const code = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    })
    .replace(/&amp;/g, '&');
}
const escHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;');

// Notes: one <a:p> per paragraph, joined runs, dropping the ‹#› slide-number field.
function notesParagraphs(xml) {
  const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => m[1]);
  const out = [];
  for (const p of paras) {
    const runs = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    const line = runs.join('').replace(/‹#›/g, '').replace(/\s+/g, ' ').trim();
    if (line) out.push(line);
  }
  return out;
}
// On-slide text -> a compact alt string.
function slideText(xml) {
  const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
  return runs.join(' ').replace(/\s+/g, ' ').replace(/‹#›/g, '').trim();
}

// ---------------------------------------------------------------------------
// 1. Resolve display order -> slideN.xml -> notesSlideM.xml
// ---------------------------------------------------------------------------
console.log('Resolving slide order from presentation.xml…');
const pres = unzipText('ppt/presentation.xml');
const order = [...pres.matchAll(/<p:sldId [^>]*r:id="(rId\d+)"/g)].map((m) => m[1]);
const presRels = unzipText('ppt/_rels/presentation.xml.rels');
const rid2slide = {};
for (const m of presRels.matchAll(/Id="(rId\d+)"[^>]*Target="slides\/(slide\d+\.xml)"/g)) {
  rid2slide[m[1]] = m[2];
}

const slides = order.map((rid, i) => {
  const n = i + 1; // display number (1-based) == PDF page
  const slideFile = rid2slide[rid];
  const slideNum = slideFile.match(/slide(\d+)\.xml/)[1];
  const srels = unzipText(`ppt/slides/_rels/slide${slideNum}.xml.rels`);
  const noteFile = (srels.match(/notesSlides\/(notesSlide\d+\.xml)/) || [])[1] || null;
  let notes = noteFile ? notesParagraphs(unzipText(`ppt/notesSlides/${noteFile}`)) : [];
  const noteOv = NOTES_OVERRIDES[n];
  if (noteOv?.drop) notes = [];
  else if (noteOv?.edits) {
    notes = notes.map((p) => noteOv.edits.reduce((s, [from, to]) => s.split(from).join(to), p));
  }
  const onSlide = slideText(unzipText(`ppt/slides/${slideFile}`));
  let altCore = onSlide.split(/(?<=[.?!])\s/)[0] || onSlide;
  if (altCore.length > 120) altCore = altCore.slice(0, 117).trimEnd() + '…';
  if (IMAGE_OVERRIDES[n]?.alt) altCore = IMAGE_OVERRIDES[n].alt;
  const alt = altCore ? `Slide ${n}: ${altCore}` : `Slide ${n}`;
  return { n, notes, alt };
});
console.log(`  ${slides.length} slides resolved.`);

// ---------------------------------------------------------------------------
// 2. Render + compress images
// ---------------------------------------------------------------------------
rmSync(SLIDES_DIR, { recursive: true, force: true });
mkdirSync(SLIDES_DIR, { recursive: true });

const work = join(tmpdir(), 'smx-talk-build');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

console.log('Rendering slides from PDF…');
sh('pdftoppm', ['-png', '-r', String(RENDER_DPI), PDF, join(work, 'p')]);
const pngs = readdirSync(work).filter((f) => f.endsWith('.png')).sort();
if (pngs.length !== slides.length) {
  console.warn(`  ! rendered ${pngs.length} pages but resolved ${slides.length} slides`);
}

const useWebp = have('cwebp');
const EXT = useWebp ? 'webp' : 'jpg';
console.log(`Compressing ${pngs.length} images to .${EXT}${useWebp ? '' : ' (cwebp not found — using sips/jpeg)'}…`);
pngs.forEach((png, i) => {
  const src = join(work, png);
  const num = String(i + 1).padStart(2, '0');
  const dst = join(SLIDES_DIR, `slide-${num}.${EXT}`);
  if (useWebp) sh('cwebp', ['-quiet', '-q', String(WEBP_Q), src, '-o', dst]);
  else sh('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', dst]);
});

// Apply per-slide image overrides (sourced from an alternate PDF export).
for (const [n, ov] of Object.entries(IMAGE_OVERRIDES)) {
  const num = String(n).padStart(2, '0');
  const dst = join(SLIDES_DIR, `slide-${num}.${EXT}`);
  sh('pdftoppm', ['-png', '-r', String(RENDER_DPI), '-f', String(ov.page), '-l', String(ov.page),
    ov.pdf, join(work, `override-${num}`)]);
  const rendered = readdirSync(work).find((f) => f.startsWith(`override-${num}`) && f.endsWith('.png'));
  const src = join(work, rendered);
  if (useWebp) sh('cwebp', ['-quiet', '-q', String(WEBP_Q), src, '-o', dst]);
  else sh('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', dst]);
  console.log(`  overrode slide ${n} from ${ov.pdf.split('/').pop()} p${ov.page}`);
}

// Social card from the title slide (16:9, 1200px wide).
console.log('Building og.png…');
sh('sips', ['-Z', '1200', '-s', 'format', 'png', join(work, pngs[0]), '--out', join(OUT, 'og.png')]);
rmSync(work, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 3. Emit index.html
// ---------------------------------------------------------------------------
console.log('Writing index.html…');
const sections = slides.map((s) => {
  const num = String(s.n).padStart(2, '0');
  const notesHtml = s.notes.length
    ? s.notes.map((p) => `        <p>${escHtml(p)}</p>`).join('\n')
    : '        <p class="no-notes">No speaker notes for this slide.</p>';
  const eager = s.n === 1;
  return `      <section class="slide" id="slide-${s.n}" data-n="${s.n}">
    <figure>
      <div class="frame">
        <img src="slides/slide-${num}.${EXT}" width="${IMG_W}" height="${IMG_H}"
             alt="${escHtml(s.alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'}>
        <a class="badge" href="#slide-${s.n}" aria-label="Slide ${s.n}, link">${s.n}</a>
        <button class="present-here" type="button" data-go="${s.n}" aria-label="Present from slide ${s.n}" title="Present from here">⤢</button>
      </div>
      <figcaption class="notes">
${notesHtml}
      </figcaption>
    </figure>
      </section>`;
}).join('\n');

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'PresentationDigitalDocument',
  name: TALK.title,
  about: 'Agentic commerce, ecommerce SEO, AI shopping agents',
  author: { '@type': 'Person', name: TALK.speaker, url: 'https://kylerisley.com/' },
  url: TALK.url,
  inLanguage: 'en',
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
${ANNOUNCED ? '' : '  <meta name="robots" content="noindex">\n'}  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <title>${escHtml(TALK.title)} — ${escHtml(TALK.speaker)}</title>
  <meta name="description" content="${escHtml(TALK.intro)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escHtml(TALK.title)}">
  <meta property="og:description" content="${escHtml(TALK.intro)}">
  <meta property="og:url" content="${TALK.url}">
  <meta property="og:image" content="${TALK.url}og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtml(TALK.title)}">
  <meta name="twitter:description" content="${escHtml(TALK.intro)}">
  <meta name="twitter:image" content="${TALK.url}og.png">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <style>
    :root {
      --accent: #5046e5;
      --accent-light: #ededfd;
      --accent-text: #3f37c9;
      --text: #1a1a1a;
      --text-secondary: #374151;
      --text-tertiary: #6b7280;
      --border: #e5e7eb;
      --border-light: #f3f4f6;
      --surface: #f9fafb;
      --bg: #ffffff;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px; line-height: 1.7; margin: 0;
      color: var(--text); background: var(--bg);
    }
    a { color: var(--accent-text); text-decoration-color: #c7c5f2; text-underline-offset: 3px; }
    a:hover { text-decoration-color: var(--accent-text); }

    /* scroll progress */
    #progress {
      position: fixed; top: 0; left: 0; height: 3px; width: 0;
      background: var(--accent); z-index: 50; transition: width 0.1s linear;
    }

    .wrap { max-width: 860px; margin: 0 auto; padding: 0 20px; }

    header.page { padding: 44px 0 8px; }
    .back { font-size: 13px; letter-spacing: 0.4px; text-transform: uppercase;
      text-decoration: none; color: var(--text-tertiary); }
    .back:hover { color: var(--accent-text); }
    h1 { font-size: 30px; font-weight: 700; letter-spacing: -0.8px;
      line-height: 1.25; margin: 18px 0 8px; }
    .meta { color: var(--text-tertiary); font-size: 15px; margin: 0 0 16px; }
    .meta strong { color: var(--text-secondary); font-weight: 600; }
    .intro { color: var(--text-secondary); font-size: 16px; margin: 0 0 22px; max-width: 70ch; }
    .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .btn {
      display: inline-flex; align-items: center; gap: 7px; font: inherit;
      font-size: 14px; font-weight: 600; cursor: pointer;
      padding: 9px 16px; border-radius: 9px; border: 1px solid var(--accent);
      background: var(--accent); color: #fff; transition: filter 0.15s, transform 0.1s;
    }
    .btn:hover { filter: brightness(1.07); }
    .btn:active { transform: translateY(1px); }
    .btn .key { font-size: 12px; opacity: 0.8; font-weight: 500; }
    .count { color: var(--text-tertiary); font-size: 14px; }

    hr.div { border: none; border-top: 1px solid var(--border); margin: 26px 0 6px; }

    main { padding-bottom: 80px; }
    .slide { padding: 30px 0; border-bottom: 1px solid var(--border-light); scroll-margin-top: 16px; }
    .slide:last-child { border-bottom: none; }
    figure { margin: 0; }
    .frame {
      position: relative; border: 1px solid var(--border); border-radius: 12px;
      overflow: hidden; background: var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .frame img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; }
    .badge {
      position: absolute; top: 10px; left: 10px; min-width: 26px; height: 26px;
      padding: 0 8px; display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 600; border-radius: 999px;
      background: rgba(17,17,24,0.72); color: #fff; text-decoration: none;
      backdrop-filter: blur(4px); opacity: 0; transition: opacity 0.15s;
    }
    .frame:hover .badge, .badge:focus-visible { opacity: 1; }
    .present-here {
      position: absolute; top: 10px; right: 10px; width: 30px; height: 30px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 15px; line-height: 1; cursor: pointer; color: #fff;
      background: rgba(17,17,24,0.72); border: none; border-radius: 8px;
      backdrop-filter: blur(4px); opacity: 0; transition: opacity 0.15s;
    }
    .frame:hover .present-here, .present-here:focus-visible { opacity: 1; }
    .present-here:hover { background: var(--accent); }

    .notes { margin-top: 16px; color: var(--text-secondary); }
    .notes p { margin: 0 0 12px; }
    .notes p:last-child { margin-bottom: 0; }
    .notes .no-notes { color: var(--text-tertiary); font-style: italic; }

    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

    /* ----- Present mode ----- */
    #present { position: fixed; inset: 0; z-index: 100; display: none;
      background: #0b0b0f; color: #e9e9ee; flex-direction: column; }
    #present.open { display: flex; }
    body.presenting { overflow: hidden; }
    #present .bar {
      position: absolute; top: 0; left: 0; height: 3px; background: var(--accent);
      width: 0; z-index: 2; transition: width 0.2s ease;
    }
    #present .top {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; gap: 12px; font-size: 13px; color: #b8b8c4;
    }
    #present .top .t { font-weight: 600; color: #e9e9ee; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    #present .iconbtn {
      background: rgba(255,255,255,0.08); color: #e9e9ee; border: none; cursor: pointer;
      width: 34px; height: 34px; border-radius: 8px; font-size: 16px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    #present .iconbtn:hover { background: rgba(255,255,255,0.16); }
    #present .stage {
      flex: 1; display: grid; grid-template-columns: 1fr 340px; gap: 0; min-height: 0;
    }
    #present.no-notes-view .stage { grid-template-columns: 1fr; }
    #present.no-notes-view .pnotes { display: none; }
    #present .canvas {
      position: relative; display: flex; align-items: center; justify-content: center;
      padding: 8px 64px 16px; min-width: 0; min-height: 0;
    }
    #present .canvas img {
      max-width: 100%; max-height: 100%; object-fit: contain;
      border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    }
    #present .nav {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer;
      background: rgba(255,255,255,0.1); color: #fff; font-size: 22px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
    }
    #present .nav:hover { background: rgba(255,255,255,0.22); }
    #present .nav[disabled] { opacity: 0.25; cursor: default; }
    #present .prev { left: 10px; }
    #present .next { right: 10px; }
    #present .pnotes {
      border-left: 1px solid rgba(255,255,255,0.1); padding: 22px 22px 28px;
      overflow-y: auto; background: #121218; line-height: 1.65;
    }
    #present .pnotes h2 { font-size: 12px; letter-spacing: 0.6px; text-transform: uppercase;
      color: #8b8b98; margin: 0 0 12px; font-weight: 600; }
    #present .pnotes p { margin: 0 0 12px; color: #d4d4dc; }
    #present .pnotes .no-notes { color: #6f6f7c; font-style: italic; }
    #present .foot { text-align: center; padding: 8px 0 14px; font-size: 13px; color: #8b8b98; }
    #present .foot b { color: #e9e9ee; font-weight: 600; }

    @media (max-width: 760px) {
      h1 { font-size: 24px; }
      #present .stage { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
      #present .pnotes { border-left: none; border-top: 1px solid rgba(255,255,255,0.1);
        max-height: 38vh; }
      #present .canvas { padding: 8px 52px 10px; }
      #present.no-notes-view .stage { grid-template-rows: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      #progress, #present .bar { transition: none; }
    }
  </style>
</head>
<body>
  <div id="progress" aria-hidden="true"></div>

  <div class="wrap">
    <header class="page">
      <a class="back" href="/">← kylerisley.com</a>
      <h1>${escHtml(TALK.title)}</h1>
      <p class="meta"><strong>${escHtml(TALK.speaker)}</strong> · ${escHtml(TALK.event)} · ${escHtml(TALK.date)}</p>
      <p class="intro">${escHtml(TALK.intro)}</p>
      <div class="toolbar">
        <button class="btn" id="open-present" type="button">▶ Present <span class="key">↵</span></button>
        <span class="count">${slides.length} slides</span>
      </div>
      <hr class="div">
    </header>
  </div>

  <main class="wrap" id="transcript">
${sections}
  </main>

  <!-- Present mode (progressive enhancement; transcript above works without JS) -->
  <div id="present" role="dialog" aria-modal="true" aria-label="Slide presentation" hidden>
    <div class="bar" id="p-bar"></div>
    <div class="top">
      <span class="t">${escHtml(TALK.shortTitle)}</span>
      <button class="iconbtn" id="p-notes-toggle" type="button" aria-label="Toggle notes" title="Toggle notes (n)">📝</button>
      <button class="iconbtn" id="p-close" type="button" aria-label="Close presentation" title="Close (Esc)">✕</button>
    </div>
    <div class="stage">
      <div class="canvas">
        <button class="nav prev" id="p-prev" type="button" aria-label="Previous slide">‹</button>
        <img id="p-img" alt="">
        <button class="nav next" id="p-next" type="button" aria-label="Next slide">›</button>
      </div>
      <aside class="pnotes" id="p-notes" aria-live="polite">
        <h2>Speaker notes</h2>
        <div id="p-notes-body"></div>
      </aside>
    </div>
    <div class="foot"><b id="p-cur">1</b> / ${slides.length} &nbsp;·&nbsp; ← → to navigate &nbsp;·&nbsp; Esc to close</div>
  </div>

  <script>
  (function () {
    var sections = Array.prototype.slice.call(document.querySelectorAll('.slide'));
    var total = sections.length;
    var data = sections.map(function (s) {
      var img = s.querySelector('img');
      return {
        src: img.getAttribute('src'),
        alt: img.getAttribute('alt'),
        notes: s.querySelector('.notes').innerHTML,
      };
    });

    // ---- scroll progress ----
    var prog = document.getElementById('progress');
    function onScroll() {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      prog.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // ---- present mode ----
    var P = document.getElementById('present');
    var pImg = document.getElementById('p-img');
    var pNotesBody = document.getElementById('p-notes-body');
    var pCur = document.getElementById('p-cur');
    var pBar = document.getElementById('p-bar');
    var pPrev = document.getElementById('p-prev');
    var pNext = document.getElementById('p-next');
    var idx = 0, lastFocus = null, open = false;

    function render() {
      var d = data[idx];
      pImg.src = d.src; pImg.alt = d.alt;
      pNotesBody.innerHTML = d.notes;
      pCur.textContent = idx + 1;
      pBar.style.width = ((idx + 1) / total) * 100 + '%';
      pPrev.disabled = idx === 0;
      pNext.disabled = idx === total - 1;
      history.replaceState(null, '', '#slide-' + (idx + 1));
    }
    function go(i) { idx = Math.max(0, Math.min(total - 1, i)); render(); }

    function openAt(i) {
      idx = Math.max(0, Math.min(total - 1, i));
      lastFocus = document.activeElement;
      P.hidden = false; P.classList.add('open');
      document.body.classList.add('presenting');
      open = true; render();
      document.getElementById('p-close').focus();
    }
    function close() {
      P.classList.remove('open'); P.hidden = true;
      document.body.classList.remove('presenting');
      open = false;
      // leave the hash so you land on the slide you were viewing
      var target = document.getElementById('slide-' + (idx + 1));
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      else if (target) target.scrollIntoView();
    }

    // nearest slide to viewport center, for the header Present button
    function nearestIndex() {
      var mid = scrollY + innerHeight / 2, best = 0, bestD = Infinity;
      sections.forEach(function (s, i) {
        var r = s.getBoundingClientRect();
        var c = scrollY + r.top + r.height / 2;
        var dist = Math.abs(c - mid);
        if (dist < bestD) { bestD = dist; best = i; }
      });
      return best;
    }

    document.getElementById('open-present').addEventListener('click', function () {
      openAt(nearestIndex());
    });
    document.getElementById('p-close').addEventListener('click', close);
    pPrev.addEventListener('click', function () { go(idx - 1); });
    pNext.addEventListener('click', function () { go(idx + 1); });
    document.getElementById('p-notes-toggle').addEventListener('click', function () {
      P.classList.toggle('no-notes-view');
    });

    // per-slide "present from here" buttons
    document.querySelectorAll('.present-here').forEach(function (b) {
      b.addEventListener('click', function () { openAt(parseInt(b.dataset.go, 10) - 1); });
    });

    addEventListener('keydown', function (e) {
      if (!open) {
        if (e.key === 'Enter' && e.target === document.body) { e.preventDefault(); openAt(nearestIndex()); }
        return;
      }
      switch (e.key) {
        case 'Escape': e.preventDefault(); close(); break;
        case 'ArrowRight': case ' ': case 'PageDown': e.preventDefault(); go(idx + 1); break;
        case 'ArrowLeft': case 'PageUp': e.preventDefault(); go(idx - 1); break;
        case 'Home': e.preventDefault(); go(0); break;
        case 'End': e.preventDefault(); go(total - 1); break;
        case 'n': case 'N': P.classList.toggle('no-notes-view'); break;
        case 'f': case 'F':
          if (!document.fullscreenElement) P.requestFullscreen && P.requestFullscreen();
          else document.exitFullscreen && document.exitFullscreen();
          break;
        case 'Tab': { // simple focus trap
          var f = P.querySelectorAll('button:not([disabled])');
          if (!f.length) break;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          break;
        }
      }
    });

    // basic swipe on touch
    var sx = null;
    P.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
    P.addEventListener('touchend', function (e) {
      if (sx === null) return;
      var dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 50) go(idx + (dx < 0 ? 1 : -1));
      sx = null;
    }, { passive: true });
  })();
  </script>
</body>
</html>
`;

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), html, 'utf8');

console.log(`\nDone.\n  ${slides.length} slides -> ${SLIDES_DIR}/slide-NN.${EXT}`);
console.log(`  ${join(OUT, 'index.html')}`);
console.log(`  ${join(OUT, 'og.png')}`);
