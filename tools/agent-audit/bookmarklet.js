// Agent Audit — bookmarklet payload
// Loaded into the target page by the javascript: bookmarklet stub.
// Runs full audit (static + computed/rendered) and injects an overlay panel.

(function() {
    'use strict';

    const SEMANTIC_INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'details', 'label']);
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

    // 4. cursor: pointer on actionable elements
    {
        const targets = allInteractive().filter(el => !isVisuallyHidden(el).hidden);
        if (targets.length === 0) {
            addCheck('cursor: pointer on actionable elements', 'skip', 'No visible interactive elements.');
        } else {
            const offenders = targets.filter(el => {
                const tag = el.tagName.toLowerCase();
                // Native form inputs typically use text/default cursors — exclude them
                if (tag === 'input') {
                    const t = (el.getAttribute('type') || 'text').toLowerCase();
                    if (['text', 'email', 'password', 'search', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'time', 'week'].includes(t)) return false;
                }
                if (tag === 'textarea' || tag === 'select') return false;
                const cursor = getComputedStyle(el).cursor;
                return cursor !== 'pointer';
            });
            if (offenders.length === 0) {
                addCheck('cursor: pointer on actionable elements', 'pass', `All ${targets.length} clickable element(s) have cursor: pointer.`);
            } else {
                addCheck(
                    'cursor: pointer on actionable elements',
                    'warn',
                    `${offenders.length} clickable element(s) do not use cursor: pointer.`,
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
        // Elements that are clickable/focusable but visually invisible (opacity:0 or hidden) while still in the layout
        const all = allInteractive();
        const ghosts = all.map(el => {
            const cs = getComputedStyle(el);
            if (cs.display === 'none') return null; // not a ghost — properly hidden
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return null; // collapsed, won't intercept clicks
            if (parseFloat(cs.opacity) === 0) return { el, reason: 'opacity:0 but still occupies space' };
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
                <button class="close" aria-label="Close">×</button>
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

    document.body.appendChild(host);
    window.__agentAuditPanel = host;

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
})();
