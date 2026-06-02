// Agent Audit — bookmarklet payload
// Loaded into the target page by the javascript: bookmarklet stub.
// Runs full audit (static + computed/rendered) and injects an overlay panel.

(async function() {
    'use strict';

    // <details> is intentionally excluded: it's a container; the actual click
    // target is the <summary> inside it, which is in this set on its own.
    const SEMANTIC_INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label']);
    const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'combobox', 'searchbox', 'slider', 'spinbutton', 'textbox']);

    function isSemanticInteractive(el) {
        const tag = el.tagName.toLowerCase();
        if (!SEMANTIC_INTERACTIVE_TAGS.has(tag)) return false;
        if (tag === 'a' && !el.hasAttribute('href')) return false;
        if (tag === 'input') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (type === 'hidden') return false;
        }
        return true;
    }

    function isCustomInteractive(el) {
        if (isSemanticInteractive(el)) return false;
        const role = el.getAttribute('role');
        if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
        if (el.hasAttribute('onclick')) return true;
        const ti = el.getAttribute('tabindex');
        if (ti !== null && parseInt(ti, 10) >= 0) return true;
        return false;
    }

    function isAnyInteractive(el) {
        return isSemanticInteractive(el) || isCustomInteractive(el);
    }

    function allInteractive() {
        const out = [];
        document.querySelectorAll('*').forEach(el => {
            if (isAnyInteractive(el)) out.push(el);
        });
        return out;
    }

    function isVisuallyHidden(el) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none') return { hidden: true, reason: 'display:none' };
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return { hidden: true, reason: `visibility:${cs.visibility}` };
        if (parseFloat(cs.opacity) === 0) return { hidden: true, reason: 'opacity:0' };
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return { hidden: true, reason: 'zero-size' };
        return { hidden: false };
    }

    function hasLabel(el) {
        const al = el.getAttribute('aria-label');
        if (al && al.trim()) return true;
        const alb = el.getAttribute('aria-labelledby');
        if (alb) {
            const ids = alb.split(/\s+/).filter(Boolean);
            if (ids.some(id => document.getElementById(id))) return true;
        }
        let p = el.parentElement;
        while (p) {
            if (p.tagName && p.tagName.toLowerCase() === 'label') return true;
            p = p.parentElement;
        }
        const id = el.getAttribute('id');
        if (id) {
            try {
                const escaped = id.replace(/(["\\])/g, '\\$1');
                if (document.querySelector(`label[for="${escaped}"]`)) return true;
            } catch (e) { /* ignore selector errors */ }
        }
        const title = el.getAttribute('title');
        if (title && title.trim()) return true;
        return false;
    }

    // Media that declares its size lets the browser reserve space before the
    // resource loads, so it doesn't reflow (the dominant cause of CLS). Even in
    // rendered mode, computed width/height can't tell "sized by CSS" from "sized
    // by loaded content", so we rely on the reliable signals: width+height attrs
    // or a CSS aspect-ratio.
    function hasExplicitDimensions(el) {
        if (el.hasAttribute('width') && el.hasAttribute('height')) return true;
        const ar = getComputedStyle(el).aspectRatio;
        if (ar && ar !== 'auto') return true;
        return false;
    }

    function snippet(el) {
        const clone = el.cloneNode(false);
        const html = clone.outerHTML;
        return html.length > 240 ? html.slice(0, 240) + '…' : html;
    }

    function selectorPath(el) {
        if (!el) return '';
        if (el.id) return '#' + el.id;
        const tag = el.tagName.toLowerCase();
        const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return tag + cls;
    }

    // --- Checks ---

    const checks = [];

    function addCheck(title, status, detail, samples) {
        checks.push({ title, status, detail, samples: samples || [] });
    }

    // 1. Semantic HTML
    {
        const interactives = allInteractive();
        const custom = interactives.filter(isCustomInteractive);
        if (custom.length === 0) {
            addCheck('Semantic HTML for interactive elements', 'pass', 'No custom (non-semantic) interactive elements found.');
        } else {
            addCheck(
                'Semantic HTML for interactive elements',
                'warn',
                `${custom.length} interactive element(s) are not semantic <button>/<a>/<input>. Agents may still read them via ARIA, but native semantics are stronger.`,
                custom.slice(0, 8).map(snippet)
            );
        }
    }

    // 2. Form labels
    {
        const inputs = [...document.querySelectorAll('input, select, textarea')].filter(el => {
            if (el.tagName.toLowerCase() !== 'input') return true;
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            return !['hidden', 'submit', 'button', 'reset', 'image'].includes(t);
        });
        if (inputs.length === 0) {
            addCheck('Form inputs have associated labels', 'skip', 'No labelable form inputs on this page.');
        } else {
            const unlabeled = inputs.filter(el => !hasLabel(el));
            if (unlabeled.length === 0) {
                addCheck('Form inputs have associated labels', 'pass', `All ${inputs.length} form input(s) have a label, aria-label, or aria-labelledby.`);
            } else {
                addCheck(
                    'Form inputs have associated labels',
                    'fail',
                    `${unlabeled.length} of ${inputs.length} form input(s) have no associated label.`,
                    unlabeled.slice(0, 8).map(snippet)
                );
            }
        }
    }

    // 3. Custom interactives have role + tabindex
    {
        const customs = allInteractive().filter(isCustomInteractive);
        if (customs.length === 0) {
            addCheck('Custom interactive elements have role + tabindex', 'skip', 'No custom interactive elements to evaluate.');
        } else {
            const offenders = customs.map(el => {
                const missing = [];
                if (!el.hasAttribute('role')) missing.push('role');
                const ti = el.getAttribute('tabindex');
                if (ti === null) missing.push('tabindex');
                return { el, missing };
            }).filter(o => o.missing.length > 0);
            if (offenders.length === 0) {
                addCheck('Custom interactive elements have role + tabindex', 'pass', `All ${customs.length} custom interactive element(s) have role + tabindex.`);
            } else {
                addCheck(
                    'Custom interactive elements have role + tabindex',
                    'fail',
                    `${offenders.length} of ${customs.length} custom interactive element(s) missing required ARIA attributes.`,
                    offenders.slice(0, 8).map(o => `Missing ${o.missing.join(' + ')}:\n${snippet(o.el)}`)
                );
            }
        }
    }

    // 4. cursor: pointer (or another deliberate cursor) on actionable elements
    {
        const targets = allInteractive().filter(el => !isVisuallyHidden(el).hidden);
        if (targets.length === 0) {
            addCheck('Deliberate cursor on actionable elements', 'skip', 'No visible interactive elements.');
        } else {
            const offenders = targets.filter(el => {
                const tag = el.tagName.toLowerCase();
                // Native text-entry inputs use the text cursor — that's correct.
                if (tag === 'input') {
                    const t = (el.getAttribute('type') || 'text').toLowerCase();
                    if (['text', 'email', 'password', 'search', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'time', 'week'].includes(t)) return false;
                }
                if (tag === 'textarea' || tag === 'select') return false;
                // Disabled controls should show cursor: not-allowed, not pointer.
                if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
                // Accept any deliberate non-default cursor (grab, move, zoom-in,
                // crosshair, not-allowed, etc.) as a conscious developer choice.
                // Only the inherited defaults are flagged.
                const cursor = getComputedStyle(el).cursor;
                return cursor === 'auto' || cursor === 'default';
            });
            if (offenders.length === 0) {
                addCheck('Deliberate cursor on actionable elements', 'pass', `All ${targets.length} clickable element(s) have a deliberate cursor (pointer or another non-default).`);
            } else {
                addCheck(
                    'Deliberate cursor on actionable elements',
                    'warn',
                    `${offenders.length} clickable element(s) use the inherited default cursor.`,
                    offenders.slice(0, 8).map(el => `cursor: ${getComputedStyle(el).cursor}\n${snippet(el)}`)
                );
            }
        }
    }

    // 5. Interactive elements >= 8 sq pixels
    {
        const targets = allInteractive().filter(el => !isVisuallyHidden(el).hidden);
        if (targets.length === 0) {
            addCheck('Interactive elements ≥ 8 sq pixels', 'skip', 'No visible interactive elements.');
        } else {
            const tiny = targets.filter(el => {
                const r = el.getBoundingClientRect();
                return r.width * r.height < 8;
            });
            if (tiny.length === 0) {
                addCheck('Interactive elements ≥ 8 sq pixels', 'pass', `All ${targets.length} visible interactive element(s) are larger than 8 sq pixels.`);
            } else {
                addCheck(
                    'Interactive elements ≥ 8 sq pixels',
                    'fail',
                    `${tiny.length} visible interactive element(s) have an area < 8 sq pixels.`,
                    tiny.slice(0, 8).map(el => {
                        const r = el.getBoundingClientRect();
                        return `${r.width.toFixed(1)} × ${r.height.toFixed(1)} = ${(r.width * r.height).toFixed(1)} px²\n${snippet(el)}`;
                    })
                );
            }
        }
    }

    // 6. No ghost interactive elements
    {
        const all = allInteractive();
        const ghosts = all.map(el => {
            const cs = getComputedStyle(el);
            if (cs.display === 'none') return null;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return null;
            // Styled-input pattern: native input hidden by opacity:0 with a styled
            // overlay on top. The aria-label signals it's intentional + accessible,
            // so we don't flag it as a ghost. Without aria-label this would be the
            // dangerous "invisible button on top of content" anti-pattern.
            const hasAccessibleName =
                (el.getAttribute('aria-label') || '').trim() ||
                (el.getAttribute('aria-labelledby') || '').trim();
            if (parseFloat(cs.opacity) === 0) {
                if (hasAccessibleName) return null;
                return { el, reason: 'opacity:0 but still occupies space (no aria-label)' };
            }
            if (cs.visibility === 'hidden') return { el, reason: 'visibility:hidden but still in layout' };
            return null;
        }).filter(Boolean);
        if (ghosts.length === 0) {
            addCheck('No "ghost" interactive elements', 'pass', 'No invisible-but-clickable interactive elements detected.');
        } else {
            addCheck(
                'No "ghost" interactive elements',
                'warn',
                `${ghosts.length} interactive element(s) are visually invisible but still in the layout. May confuse vision-based agents.`,
                ghosts.slice(0, 8).map(g => `${g.reason}\n${snippet(g.el)}`)
            );
        }
    }

    // 7. <html lang>
    {
        const lang = document.documentElement.getAttribute('lang');
        if (lang && lang.trim()) {
            addCheck('Document has <html lang>', 'pass', `<html lang="${lang}"> is set.`);
        } else {
            addCheck('Document has <html lang>', 'warn', 'Missing <html lang="…">.');
        }
    }

    // 8. <main> landmark
    {
        const mains = document.querySelectorAll('main, [role="main"]');
        if (mains.length === 1) {
            addCheck('Page has a <main> landmark', 'pass', 'Exactly one main landmark.');
        } else if (mains.length === 0) {
            addCheck('Page has a <main> landmark', 'warn', 'No <main> or role="main" found. Landmarks help agents skip chrome.');
        } else {
            addCheck('Page has a <main> landmark', 'warn', `${mains.length} main landmarks found. Should be exactly one.`);
        }
    }

    // 9. Media dimensions (layout stability / CLS)
    {
        const media = [...document.querySelectorAll('img, iframe, video, embed, object')]
            .filter(el => !isVisuallyHidden(el).hidden);
        if (media.length === 0) {
            addCheck('Media has explicit dimensions (layout stability)', 'skip', 'No visible images, video, or embeds.');
        } else {
            const offenders = media.filter(el => !hasExplicitDimensions(el));
            if (offenders.length === 0) {
                addCheck('Media has explicit dimensions (layout stability)', 'pass', `All ${media.length} visible media element(s) reserve space via width/height or aspect-ratio.`);
            } else {
                addCheck(
                    'Media has explicit dimensions (layout stability)',
                    'warn',
                    `${offenders.length} of ${media.length} visible media element(s) declare no width/height attribute and no CSS aspect-ratio. Undimensioned media shifts the layout as it loads (CLS), moving targets out from under an agent mid-task.`,
                    offenders.slice(0, 8).map(snippet)
                );
            }
        }
    }

    // 10. WebMCP (experimental, informational)
    {
        const signals = [];
        if (document.querySelector('script[type="application/mcp+json"], script[type="application/webmcp+json"], script[type="text/mcp"]')) signals.push('<script type="…mcp…">');
        if (document.querySelector('link[rel~="mcp"], link[rel~="webmcp"]')) signals.push('<link rel="mcp">');
        if (document.querySelector('meta[name="mcp"], meta[name="webmcp"]')) signals.push('<meta name="webmcp">');
        if (navigator.modelContext) signals.push('navigator.modelContext');
        if (window.webmcp) signals.push('window.webmcp');
        if (signals.length === 0) {
            addCheck('WebMCP interface (experimental)', 'skip', 'No WebMCP declarations found. WebMCP (machine-readable definitions of what page controls do) is experimental and not yet required — informational only.');
        } else {
            addCheck('WebMCP interface (experimental)', 'pass', `WebMCP signal(s) detected: ${signals.join(', ')}. This exposes your interactive elements to agents explicitly.`);
        }
    }

    // 11. llms.txt — same-origin here, so we can read it directly.
    {
        let info = null;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            const r = await fetch(location.origin + '/llms.txt', { signal: ctrl.signal });
            clearTimeout(timer);
            if (r.ok) {
                const text = await r.text();
                const looksHtml = /^\s*<(?:!doctype|html|head|body)\b/i.test(text);
                if (!looksHtml && text.trim().length) {
                    info = { present: true, kb: (text.length / 1024).toFixed(1), headings: (text.match(/^#{1,6}\s+\S/gm) || []).length };
                } else {
                    info = { present: false, status: r.status };
                }
            } else {
                info = { present: false, status: r.status };
            }
        } catch (e) { info = null; }
        if (!info) {
            addCheck('llms.txt summary file', 'skip', "Couldn't fetch /llms.txt (network error, CSP, or blocked).");
        } else if (info.present) {
            addCheck('llms.txt summary file', 'pass', `Found /llms.txt (${info.kb} KB${info.headings ? `, ${info.headings} markdown heading${info.headings === 1 ? '' : 's'}` : ''}). Gives agents a machine-readable map of your content.`);
        } else {
            addCheck('llms.txt summary file', 'skip', `No /llms.txt found (HTTP ${info.status}). Optional — an emerging convention for summarizing a site to language models.`);
        }
    }

    // --- Build the overlay panel using Shadow DOM ---

    const host = document.createElement('div');
    host.setAttribute('data-agent-audit', '');
    host.style.cssText = 'all: initial; position: fixed; top: 20px; right: 20px; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    checks.forEach(c => counts[c.status]++);

    const pills = [];
    if (counts.pass) pills.push(`<span class="pill pill-pass">${counts.pass} pass</span>`);
    if (counts.warn) pills.push(`<span class="pill pill-warn">${counts.warn} warn</span>`);
    if (counts.fail) pills.push(`<span class="pill pill-fail">${counts.fail} fail</span>`);

    shadow.innerHTML = `
        <style>
            :host { all: initial; }
            * { box-sizing: border-box; }
            .panel {
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 14px;
                line-height: 1.5;
                color: #1a1a1a;
                background: #fff;
                width: 420px;
                max-width: calc(100vw - 40px);
                max-height: calc(100vh - 40px);
                border-radius: 12px;
                box-shadow: 0 24px 60px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(0, 0, 0, 0.05);
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }
            .header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 14px 16px;
                border-bottom: 1px solid #e5e7eb;
                flex-shrink: 0;
            }
            .title {
                font-size: 15px;
                font-weight: 700;
            }
            .pills {
                display: flex;
                gap: 6px;
                flex-wrap: wrap;
            }
            .pill {
                font-size: 12px;
                font-weight: 600;
                padding: 3px 8px;
                border-radius: 999px;
            }
            .pill-pass { background: #ecfdf5; color: #16a34a; }
            .pill-warn { background: #fffbeb; color: #d97706; }
            .pill-fail { background: #fef2f2; color: #dc2626; }
            .header-actions {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .copy-btn {
                font-size: 12px;
                font-weight: 500;
                padding: 4px 10px;
                background: #fff;
                color: #4b5563;
                border: 1px solid #e5e7eb;
                border-radius: 999px;
                cursor: pointer;
                transition: background 0.15s, color 0.15s, border-color 0.15s;
            }
            .copy-btn:hover {
                background: #ededfd;
                color: #3f37c9;
                border-color: #ededfd;
            }
            .copy-btn.copied {
                background: #ecfdf5;
                color: #16a34a;
                border-color: #ecfdf5;
            }
            .close {
                background: transparent;
                border: none;
                font-size: 20px;
                line-height: 1;
                color: #6b7280;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 6px;
            }
            .close:hover { background: #f3f4f6; color: #1a1a1a; }
            .body {
                overflow-y: auto;
                padding: 4px 16px 16px;
                flex: 1;
            }
            .check {
                padding: 12px 0;
                border-bottom: 1px solid #f3f4f6;
                display: flex;
                gap: 10px;
            }
            .check:last-child { border-bottom: none; }
            .icon {
                font-size: 12px;
                width: 20px;
                height: 20px;
                flex-shrink: 0;
                text-align: center;
                line-height: 20px;
                border-radius: 50%;
                font-weight: 700;
            }
            .icon.pass { background: #ecfdf5; color: #16a34a; }
            .icon.warn { background: #fffbeb; color: #d97706; }
            .icon.fail { background: #fef2f2; color: #dc2626; }
            .icon.skip { background: #f3f4f6; color: #6b7280; }
            .check-body { flex: 1; min-width: 0; }
            .check-title { font-size: 14px; font-weight: 600; }
            .check-detail { font-size: 13px; color: #4b5563; margin-top: 2px; }
            details { margin-top: 6px; }
            summary {
                font-size: 12px;
                color: #6b7280;
                cursor: pointer;
                user-select: none;
            }
            summary:hover { color: #3f37c9; }
            pre {
                font-family: "SF Mono", "Fira Code", Menlo, monospace;
                font-size: 11px;
                line-height: 1.5;
                background: #1e1e1e;
                color: #d4d4d4;
                border-radius: 6px;
                padding: 10px;
                margin-top: 6px;
                overflow-x: auto;
                white-space: pre-wrap;
                word-break: break-word;
                max-height: 180px;
                overflow-y: auto;
            }
            .footer {
                font-size: 11px;
                color: #6b7280;
                padding: 10px 16px;
                border-top: 1px solid #f3f4f6;
                background: #f9fafb;
                flex-shrink: 0;
            }
            .footer a { color: #3f37c9; }
        </style>
        <div class="panel">
            <div class="header">
                <div>
                    <div class="title">Agent Audit</div>
                    <div class="pills">${pills.join('')}</div>
                </div>
                <div class="header-actions">
                    <button class="copy-btn" type="button">Copy results</button>
                    <button class="close" aria-label="Close">×</button>
                </div>
            </div>
            <div class="body">
                ${checks.map(c => `
                    <div class="check">
                        <div class="icon ${c.status}">${({pass:'✓',warn:'!',fail:'✗',skip:'–'})[c.status]}</div>
                        <div class="check-body">
                            <div class="check-title">${esc(c.title)}</div>
                            <div class="check-detail">${esc(c.detail)}</div>
                            ${c.samples.length ? `<details><summary>Show ${c.samples.length} sample${c.samples.length === 1 ? '' : 's'}</summary><pre>${c.samples.map(esc).join('\n\n')}</pre></details>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="footer">
                Click the bookmarklet again to close. Checks based on <a href="https://web.dev/articles/ai-agent-site-ux" target="_blank">web.dev/articles/ai-agent-site-ux</a>.
            </div>
        </div>
    `;

    shadow.querySelector('.close').addEventListener('click', () => {
        host.remove();
        window.__agentAuditPanel = null;
    });

    const copyBtn = shadow.querySelector('.copy-btn');
    copyBtn.addEventListener('click', () => {
        const markdown = formatMarkdown();
        navigator.clipboard.writeText(markdown).then(() => {
            copyBtn.textContent = 'Copied!';
            copyBtn.classList.add('copied');
            setTimeout(() => {
                copyBtn.textContent = 'Copy results';
                copyBtn.classList.remove('copied');
            }, 1800);
        }).catch(() => {
            copyBtn.textContent = 'Copy failed';
            setTimeout(() => { copyBtn.textContent = 'Copy results'; }, 1800);
        });
    });

    document.body.appendChild(host);
    window.__agentAuditPanel = host;

    function formatMarkdown() {
        const lines = [];
        lines.push(`# Agent Audit — ${location.href}`);
        lines.push('');
        const summary = [];
        if (counts.pass) summary.push(`${counts.pass} pass`);
        if (counts.warn) summary.push(`${counts.warn} warn`);
        if (counts.fail) summary.push(`${counts.fail} fail`);
        if (counts.skip) summary.push(`${counts.skip} skip`);
        lines.push(`**${summary.join(' · ')}** — Bookmarklet audit (rendered DOM)`);
        lines.push('');
        lines.push(`_Checked against [Google's AI-agent UX checklist](https://web.dev/articles/ai-agent-site-ux) via [Agent Audit](https://kylerisley.com/tools/agent-audit/)._`);
        lines.push('');
        const label = { pass: '✓ PASS', warn: '! WARN', fail: '✗ FAIL', skip: '– SKIP' };
        for (const c of checks) {
            lines.push(`## ${label[c.status]} — ${c.title}`);
            lines.push('');
            lines.push(c.detail);
            if (c.samples && c.samples.length) {
                lines.push('');
                lines.push('```html');
                lines.push(c.samples.join('\n\n'));
                lines.push('```');
            }
            lines.push('');
        }
        return lines.join('\n').trim() + '\n';
    }

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
})();
