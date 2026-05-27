// Agent Audit — URL-mode static checks + bookmarklet wiring

const TURNSTILE_SITE_KEY = '0x4AAAAAADXZibhBkOMDEGKN';
const PROXY_URL = 'https://agent-audit-proxy.kylerisley.com/proxy';

let turnstileWidgetId = null;
let currentTurnstileToken = null;

window.onloadTurnstileCallback = function () {
    if (turnstileWidgetId !== null) return;
    if (!window.turnstile || typeof window.turnstile.render !== 'function') {
        setTimeout(window.onloadTurnstileCallback, 100);
        return;
    }
    turnstileWidgetId = window.turnstile.render('#turnstile', {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token) => {
            currentTurnstileToken = token;
            updateAuditButtonState();
        },
        'error-callback': () => {
            currentTurnstileToken = null;
            updateAuditButtonState();
        },
        'expired-callback': () => {
            currentTurnstileToken = null;
            updateAuditButtonState();
        },
    });
    updateAuditButtonState();
};

function updateAuditButtonState() {
    const btn = document.getElementById('audit-btn');
    if (!btn) return;
    if (!currentTurnstileToken) {
        btn.disabled = true;
        btn.title = 'Complete the verification widget below to enable';
    } else {
        btn.disabled = false;
        btn.title = '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    setupBookmarklet();
    updateAuditButtonState();
    const input = document.getElementById('url-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runUrlAudit();
    });

    waitForTurnstile().then(() => {
        if (turnstileWidgetId === null) window.onloadTurnstileCallback();
    });
});

function waitForTurnstile() {
    return new Promise((resolve) => {
        const check = () => {
            if (window.turnstile && window.turnstile.render) resolve();
            else setTimeout(check, 100);
        };
        check();
    });
}

function consumeTurnstileToken() {
    const token = currentTurnstileToken;
    currentTurnstileToken = null;
    if (window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId);
    }
    updateAuditButtonState();
    return token;
}

function setupBookmarklet() {
    const origin = window.location.origin;
    const path = window.location.pathname.replace(/index\.html$/, '');
    const scriptUrl = origin + path + 'bookmarklet.js';
    const code = "(function(){if(window.__agentAuditPanel){window.__agentAuditPanel.remove();window.__agentAuditPanel=null;return;}var s=document.createElement('script');s.src='" + scriptUrl + "?'+Date.now();s.onerror=function(){alert('Agent Audit: failed to load script.')};document.body.appendChild(s);})();";
    document.getElementById('bookmarklet').href = 'javascript:' + encodeURIComponent(code);
}

async function runUrlAudit() {
    const input = document.getElementById('url-input');
    const btn = document.getElementById('audit-btn');
    const results = document.getElementById('results');

    let url = input.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const token = consumeTurnstileToken();
    if (!token) {
        results.innerHTML = '<div class="error-banner">Please complete the verification widget first.</div>';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Auditing…';
    results.classList.add('active');
    results.innerHTML = '<p style="color:var(--text-tertiary);font-size:14px;padding:8px 0;">Fetching page…</p>';

    try {
        const html = await fetchPageHtml(url, token);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const bodyChildren = doc.body ? doc.body.children.length : 0;
        const checks = runStaticChecks(doc);
        renderResults(results, url, checks, bodyChildren);
    } catch (err) {
        results.innerHTML = `<div class="error-banner">${esc(err.message)}. If the site blocks bots or renders content with JavaScript, try the bookmarklet — it works on any page you can load in your browser.</div>`;
    } finally {
        btn.textContent = 'Audit';
        updateAuditButtonState();
    }
}

async function fetchPageHtml(url, token) {
    const proxyUrl = `${PROXY_URL}?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) {
        let detail = '';
        try {
            const body = await resp.json();
            if (body && body.error) {
                detail = `: ${body.error}`;
                if (body.errorCodes && body.errorCodes.length) {
                    detail += ` [${body.errorCodes.join(', ')}]`;
                }
            }
        } catch { /* ignore */ }
        throw new Error(`Couldn't fetch the page (HTTP ${resp.status}${detail})`);
    }
    return await resp.text();
}

const STATIC_CHECKS = [
    {
        id: 'semantic-html',
        title: 'Semantic HTML for interactive elements',
        run: (doc) => {
            const offenders = [];
            doc.querySelectorAll('[onclick]').forEach(el => {
                const tag = el.tagName.toLowerCase();
                if (!['a', 'button', 'input', 'select', 'textarea', 'summary', 'details', 'label'].includes(tag)) {
                    offenders.push(el);
                }
            });
            if (offenders.length === 0) {
                return { status: 'pass', detail: 'No non-semantic elements with inline onclick handlers in the HTML.' };
            }
            return {
                status: 'warn',
                detail: `${offenders.length} non-semantic element(s) carry onclick handlers. Prefer <button> or <a>.`,
                samples: offenders.slice(0, 5).map(el => trim(el.outerHTML, 240)),
            };
        }
    },
    {
        id: 'label-for',
        title: 'Form inputs have associated labels',
        run: (doc) => {
            const skippedTypes = ['hidden', 'submit', 'button', 'reset', 'image'];
            const inputs = [...doc.querySelectorAll('input, select, textarea')].filter(el => {
                if (el.tagName.toLowerCase() !== 'input') return true;
                return !skippedTypes.includes((el.getAttribute('type') || 'text').toLowerCase());
            });
            if (inputs.length === 0) {
                return { status: 'skip', detail: 'No labelable form inputs on this page.' };
            }
            const unlabeled = inputs.filter(el => !hasLabel(el, doc));
            if (unlabeled.length === 0) {
                return { status: 'pass', detail: `All ${inputs.length} form input(s) have a label, aria-label, or aria-labelledby.` };
            }
            return {
                status: 'fail',
                detail: `${unlabeled.length} of ${inputs.length} form input(s) have no associated label.`,
                samples: unlabeled.slice(0, 5).map(el => trim(el.outerHTML, 240)),
            };
        }
    },
    {
        id: 'custom-interactive-roles',
        title: 'Custom interactive elements have role + tabindex',
        run: (doc) => {
            const candidates = [];
            doc.querySelectorAll('[onclick]').forEach(el => {
                const tag = el.tagName.toLowerCase();
                if (!['a', 'button', 'input', 'select', 'textarea', 'summary', 'details', 'label'].includes(tag)) {
                    candidates.push(el);
                }
            });
            if (candidates.length === 0) {
                return { status: 'skip', detail: 'No custom (non-semantic) interactive elements found in the static HTML.' };
            }
            const offenders = candidates.map(el => {
                const missing = [];
                if (!el.hasAttribute('role')) missing.push('role');
                if (!el.hasAttribute('tabindex')) missing.push('tabindex');
                return { el, missing };
            }).filter(o => o.missing.length > 0);
            if (offenders.length === 0) {
                return { status: 'pass', detail: `All ${candidates.length} custom interactive element(s) have role + tabindex.` };
            }
            return {
                status: 'fail',
                detail: `${offenders.length} of ${candidates.length} custom interactive element(s) missing ARIA attributes.`,
                samples: offenders.slice(0, 5).map(o => `Missing ${o.missing.join(' + ')}:\n${trim(o.el.outerHTML, 200)}`),
            };
        }
    },
    {
        id: 'inline-hidden-interactive',
        title: 'No interactive elements hidden via inline styles',
        run: (doc) => {
            const interactive = doc.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [onclick]');
            if (interactive.length === 0) {
                return { status: 'skip', detail: 'No interactive elements found.' };
            }
            const hidden = [...interactive].filter(el => {
                const s = (el.getAttribute('style') || '').toLowerCase();
                return /display\s*:\s*none/.test(s) || /visibility\s*:\s*hidden/.test(s) || /opacity\s*:\s*0(?![\.\d])/.test(s);
            });
            if (hidden.length === 0) {
                return { status: 'pass', detail: 'No interactive elements have inline display:none / visibility:hidden / opacity:0.' };
            }
            return {
                status: 'warn',
                detail: `${hidden.length} interactive element(s) are hidden inline but still in the DOM.`,
                samples: hidden.slice(0, 5).map(el => trim(el.outerHTML, 240)),
            };
        }
    },
    {
        id: 'lang-attr',
        title: 'Document has a <html lang> attribute',
        run: (doc) => {
            const html = doc.documentElement;
            const lang = html && html.getAttribute('lang');
            if (lang && lang.trim()) {
                return { status: 'pass', detail: `<html lang="${esc(lang)}"> is set.` };
            }
            return { status: 'warn', detail: 'Missing <html lang="…">. Helps agents (and screen readers) interpret content.' };
        }
    },
    {
        id: 'main-landmark',
        title: 'Page has a <main> landmark',
        run: (doc) => {
            const mains = doc.querySelectorAll('main, [role="main"]');
            if (mains.length === 1) {
                return { status: 'pass', detail: 'Exactly one main landmark found.' };
            }
            if (mains.length === 0) {
                return { status: 'warn', detail: 'No <main> element or role="main" found. Landmarks help agents skip nav/footer chrome.' };
            }
            return { status: 'warn', detail: `${mains.length} main landmarks found. Should be exactly one per page.` };
        }
    },
];

function hasLabel(el, doc) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return true;
    const ariaLabelledby = el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
        const ids = ariaLabelledby.split(/\s+/).filter(Boolean);
        if (ids.some(id => doc.getElementById(id))) return true;
    }
    let parent = el.parentElement;
    while (parent) {
        if (parent.tagName && parent.tagName.toLowerCase() === 'label') return true;
        parent = parent.parentElement;
    }
    const id = el.getAttribute('id');
    if (id) {
        const escaped = id.replace(/(["\\])/g, '\\$1');
        if (doc.querySelector(`label[for="${escaped}"]`)) return true;
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return true;
    return false;
}

function runStaticChecks(doc) {
    return STATIC_CHECKS.map(check => ({
        id: check.id,
        title: check.title,
        result: check.run(doc),
    }));
}

function renderResults(container, target, checks, bodyChildren) {
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    checks.forEach(c => counts[c.result.status]++);

    const pills = [];
    if (counts.pass) pills.push(`<span class="pill pill-pass">${counts.pass} pass</span>`);
    if (counts.warn) pills.push(`<span class="pill pill-warn">${counts.warn} warn</span>`);
    if (counts.fail) pills.push(`<span class="pill pill-fail">${counts.fail} fail</span>`);

    const sparseWarning = bodyChildren < 3
        ? `<div class="error-banner" style="background:var(--amber-bg);color:var(--amber);">The fetched HTML has very few elements (${bodyChildren} body children). This page likely renders content with JavaScript, so the static audit can't see most of it. Use the bookmarklet instead.</div>`
        : '';

    container.innerHTML = `
        <div class="results-header">
            <div class="results-target">${esc(target)}</div>
            <div class="results-summary">
                ${pills.join('')}
                <button type="button" class="copy-btn" id="copy-results-btn">Copy results</button>
            </div>
        </div>
        ${sparseWarning}
        ${checks.map(renderCheck).join('')}
        <p style="font-size:12px;color:var(--text-tertiary);margin-top:14px;">URL mode checks static HTML only. For computed cursor, rendered sizes, and ghost-element detection, use the bookmarklet.</p>
    `;

    const copyBtn = container.querySelector('#copy-results-btn');
    copyBtn.addEventListener('click', () => {
        const markdown = formatChecksAsMarkdown(target, checks, counts, 'URL audit (static HTML)');
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
}

function formatChecksAsMarkdown(target, checks, counts, mode) {
    const lines = [];
    lines.push(`# Agent Audit — ${target}`);
    lines.push('');
    const summary = [];
    if (counts.pass) summary.push(`${counts.pass} pass`);
    if (counts.warn) summary.push(`${counts.warn} warn`);
    if (counts.fail) summary.push(`${counts.fail} fail`);
    if (counts.skip) summary.push(`${counts.skip} skip`);
    lines.push(`**${summary.join(' · ')}** — ${mode}`);
    lines.push('');
    lines.push(`_Checked against [Google's AI-agent UX checklist](https://web.dev/articles/ai-agent-site-ux) via [Agent Audit](https://kylerisley.com/tools/agent-audit/)._`);
    lines.push('');

    const label = { pass: '✓ PASS', warn: '! WARN', fail: '✗ FAIL', skip: '– SKIP' };
    for (const check of checks) {
        const r = check.result;
        lines.push(`## ${label[r.status]} — ${check.title}`);
        lines.push('');
        lines.push(r.detail);
        if (r.samples && r.samples.length) {
            lines.push('');
            lines.push('```html');
            lines.push(r.samples.join('\n\n'));
            lines.push('```');
        }
        lines.push('');
    }
    return lines.join('\n').trim() + '\n';
}

function renderCheck(check) {
    const { result } = check;
    const iconChar = { pass: '✓', warn: '!', fail: '✗', skip: '–' }[result.status];
    const samples = result.samples && result.samples.length
        ? `<details class="check-samples"><summary>Show ${result.samples.length} sample${result.samples.length === 1 ? '' : 's'}</summary><pre>${result.samples.map(esc).join('\n\n')}</pre></details>`
        : '';
    return `
        <div class="check">
            <div class="check-icon ${result.status}">${iconChar}</div>
            <div class="check-body">
                <div class="check-title">${esc(check.title)}</div>
                <div class="check-detail">${esc(result.detail)}</div>
                ${samples}
            </div>
        </div>
    `;
}

function trim(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
}

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
