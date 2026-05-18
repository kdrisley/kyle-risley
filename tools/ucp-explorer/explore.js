/* exported getProductDetails, searchCatalog, searchPolicies, switchTab */
// The functions above are invoked from inline onclick= handlers in generated
// HTML, so ESLint cannot see those references.

// Configuration
const PROXY_BASE = 'https://ucp-proxy.kylerisley.com';
let currentDomain = '';
let mcpEndpoint = '';
// Counter for naming Request/Response <details> pairs. Both toggles in a pair
// share a name so the browser keeps only one open at a time; each pair gets a
// unique name so toggles in different steps don't interfere.
let toggleGroupSeq = 0;

// UI helpers
const log = document.getElementById('log');
const domainInput = document.getElementById('domain-input');
const goBtn = document.getElementById('go-btn');

domainInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startExploration();
});

// Delegated handler for the copy/expand controls on every JSON box. The log
// element is stable across re-renders, so a single listener covers all boxes,
// including ones added later by updateStep() and the interactive panels.
log.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.json-copy');
    if (copyBtn) { copyJsonBox(copyBtn); return; }
    const expandBtn = e.target.closest('.json-expand');
    if (expandBtn) { openJsonModal(expandBtn.closest('.json-box')); return; }
});

function addPhaseLabel(text) {
    const el = document.createElement('div');
    el.className = 'phase-label';
    el.textContent = text;
    log.appendChild(el);
}

function iconClass(icon) {
    if (icon === '✓') return 'step-icon-pass';
    if (icon === '✗') return 'step-icon-fail';
    if (icon === '–') return 'step-icon-neutral';
    return 'step-icon-loading';
}

function formatRaw(data) {
    if (!data) return '';
    return escapeHtml(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

// --- JSON box: copy + expand controls ---------------------------------------

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const EXPAND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
const SHRINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>';

// Renders a JSON box: a <pre> plus a copy and an expand button. `label`
// ("Request"/"Response") is carried on data-label for use as the modal title.
function jsonBoxHtml(label, data) {
    return `<div class="json-box" data-label="${label}">
        <div class="json-box-actions">
            <button type="button" class="json-action json-copy" title="Copy" aria-label="Copy">${COPY_ICON}</button>
            <button type="button" class="json-action json-expand" title="Expand" aria-label="Expand">${EXPAND_ICON}</button>
        </div>
        <pre>${formatRaw(data)}</pre>
    </div>`;
}

// Copies text to the clipboard and briefly flashes the button as confirmation.
// navigator.clipboard is undefined outside secure contexts (e.g. file://).
function copyText(text, btn) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = COPY_ICON;
        }, 1200);
    }).catch(() => {});
}

function copyJsonBox(btn) {
    const box = btn.closest('.json-box');
    const pre = box && box.querySelector('pre');
    if (pre) copyText(pre.textContent, btn);
}

// The expanded JSON viewer is a single lazily-created overlay, shared by every
// box. Building it on first use keeps module load free of document.body access.
let jsonModal = null;

function getJsonModal() {
    if (jsonModal) return jsonModal;
    jsonModal = document.createElement('div');
    jsonModal.className = 'json-modal';
    jsonModal.hidden = true;
    jsonModal.innerHTML = `
        <div class="json-modal-backdrop"></div>
        <div class="json-modal-panel" role="dialog" aria-modal="true" aria-label="JSON viewer">
            <div class="json-modal-header">
                <span class="json-modal-title"></span>
                <div class="json-modal-actions">
                    <button type="button" class="json-action json-modal-copy" title="Copy" aria-label="Copy">${COPY_ICON}</button>
                    <button type="button" class="json-action json-modal-shrink" title="Shrink" aria-label="Shrink">${SHRINK_ICON}</button>
                </div>
            </div>
            <pre class="json-modal-content"></pre>
        </div>`;
    document.body.appendChild(jsonModal);

    jsonModal.querySelector('.json-modal-backdrop').addEventListener('click', closeJsonModal);
    jsonModal.querySelector('.json-modal-shrink').addEventListener('click', closeJsonModal);
    jsonModal.querySelector('.json-modal-copy').addEventListener('click', (e) => {
        copyText(jsonModal.querySelector('.json-modal-content').textContent, e.currentTarget);
    });
    return jsonModal;
}

function escCloseModal(e) {
    if (e.key === 'Escape') closeJsonModal();
}

function openJsonModal(box) {
    const pre = box && box.querySelector('pre');
    if (!pre) return;
    const modal = getJsonModal();
    modal.querySelector('.json-modal-title').textContent = box.dataset.label || 'JSON';
    modal.querySelector('.json-modal-content').innerHTML = syntaxHighlight(pre.textContent);
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', escCloseModal);
}

function closeJsonModal() {
    if (!jsonModal || jsonModal.hidden) return;
    jsonModal.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', escCloseModal);
}

function buildStepHtml(icon, text, detail, req, raw) {
    let html = `<div class="step-header">
        <span class="step-icon ${iconClass(icon)}">${icon}</span>
        <span class="step-text">${text}</span>
    </div>`;

    if (detail) {
        html += `<div class="step-detail">${detail}</div>`;
    }

    if (req || raw) {
        const groupName = `step-toggle-${++toggleGroupSeq}`;
        html += '<div class="step-toggles">';
        if (req) {
            html += `<details class="step-raw" name="${groupName}">
                <summary>Request</summary>
                ${jsonBoxHtml('Request', req)}
            </details>`;
        }
        if (raw) {
            html += `<details class="step-raw" name="${groupName}">
                <summary>Response</summary>
                ${jsonBoxHtml('Response', raw)}
            </details>`;
        }
        html += '</div>';
    }

    return html;
}

function addStep(icon, text, detail, raw, req) {
    const step = document.createElement('div');
    step.className = 'step';
    step.innerHTML = buildStepHtml(icon, text, detail, req, raw);
    log.appendChild(step);
    step.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return step;
}

function updateStep(step, icon, text, detail, raw, req) {
    step.innerHTML = buildStepHtml(icon, text, detail, req, raw);
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Proxy fetch
async function proxyFetch(url, options = {}) {
    const proxyUrl = `${PROXY_BASE}?url=${encodeURIComponent(url)}`;
    const resp = await fetch(proxyUrl, options);
    return resp;
}

// Main exploration flow
async function startExploration() {
    const domain = domainInput.value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!domain) return;

    currentDomain = domain;
    mcpEndpoint = '';
    log.innerHTML = '';
    log.classList.add('active');
    goBtn.disabled = true;

    try {
        await phase2(domain);
        await delay(300);
        await phase3(domain);
    } catch (e) {
        addStep('✗', `Unexpected error: ${e.message}`);
    }

    goBtn.disabled = false;
}

// Phase 1: UCP discovery
async function phase2(domain) {
    addPhaseLabel('UCP Profile Discovery');

    const ucpUrl = `https://${domain}/.well-known/ucp`;
    const ucpReq = { method: 'GET', url: ucpUrl };
    const step = addStep('⏳', `Checking for a UCP profile at <code>/.well-known/ucp</code>...`, `GET ${ucpUrl}`, null, ucpReq);
    try {
        const resp = await proxyFetch(ucpUrl);
        if (resp.ok) {
            const text = await resp.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                updateStep(step, '✗', `Found a file at <code>/.well-known/ucp</code> but it is not valid JSON.`, `GET ${ucpUrl} → HTTP ${resp.status} | Response is not valid JSON`, text, ucpReq);
                return;
            }

            const capabilities = extractCapabilities(data);
            const mcpUrl = extractMcpEndpoint(data, domain);

            let detail = `GET ${ucpUrl} → HTTP ${resp.status}`;
            if (capabilities.length > 0) {
                detail += ` | Capabilities: ${capabilities.join(', ')}`;
            }
            if (mcpUrl) {
                detail += ` | MCP endpoint: ${mcpUrl}`;
                mcpEndpoint = mcpUrl;
            }

            updateStep(step, '✓',
                'Found it! This store publishes a UCP manifest.',
                detail,
                data,
                ucpReq
            );
        } else {
            updateStep(step, '✗', `No UCP manifest found at this domain. This store may not have UCP enabled yet.`, `GET ${ucpUrl} → HTTP ${resp.status}`, null, ucpReq);

            await delay(300);
            const fallbackUrl = `https://${domain}/api/ucp/mcp`;
            const fallbackBody = { jsonrpc: '2.0', method: 'tools/list', id: 1, params: { _meta: { 'ucp-agent': { profile: 'https://kylerisley.com/tools/ucp-explorer/agent-profile.json' } } } };
            const fallbackReq = { method: 'POST', url: fallbackUrl, headers: { 'Content-Type': 'application/json' }, body: fallbackBody };
            const step2 = addStep('⏳', `Trying Shopify MCP endpoint convention: <code>/api/ucp/mcp</code>...`, `POST ${fallbackUrl}`, null, fallbackReq);
            try {
                const mcpResp = await proxyFetch(fallbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(fallbackBody)
                });
                if (mcpResp.ok) {
                    mcpEndpoint = fallbackUrl;
                    updateStep(step2, '✓', `MCP endpoint found at <code>/api/ucp/mcp</code> (no UCP manifest, but endpoint responds).`, `POST ${fallbackUrl} → HTTP ${mcpResp.status}`, null, fallbackReq);
                } else {
                    updateStep(step2, '✗', `No MCP endpoint responding at the standard Shopify path either.`, `POST ${fallbackUrl} → HTTP ${mcpResp.status}`, null, fallbackReq);
                }
            } catch (e) {
                updateStep(step2, '✗', `Could not connect to MCP endpoint.`, `POST ${fallbackUrl} → Connection failed`, null, fallbackReq);
            }
        }
    } catch (e) {
        updateStep(step, '✗', `Error fetching UCP manifest: ${e.message}`);
    }
}

// Phase 3: MCP interaction
async function phase3(domain) {
    const endpoints = [];
    if (mcpEndpoint) endpoints.push(mcpEndpoint);
    // Always try both standard and UCP endpoints
    const candidates = [
        `https://${domain}/api/mcp`,
        `https://${domain}/api/ucp/mcp`
    ];
    for (const c of candidates) {
        if (!endpoints.includes(c)) endpoints.push(c);
    }

    addPhaseLabel('MCP Interaction');

    let connected = false;
    for (const endpoint of endpoints) {
        const toolsListBody = {
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 1,
            params: {
                _meta: {
                    'ucp-agent': {
                        profile: 'https://kylerisley.com/tools/ucp-explorer/agent-profile.json'
                    }
                }
            }
        };
        const mcpReq = { method: 'POST', url: endpoint, headers: { 'Content-Type': 'application/json' }, body: toolsListBody };
        const step = addStep('⏳', `Connecting to MCP endpoint at <code>${endpoint}</code>...`, `POST ${endpoint} | Method: tools/list`, null, mcpReq);

        try {
            const resp = await proxyFetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(toolsListBody)
            });

        if (!resp.ok) {
            updateStep(step, '–', `Endpoint returned HTTP ${resp.status}. Trying next endpoint...`, `POST ${endpoint} → HTTP ${resp.status}`, null, mcpReq);
            await delay(300);
            continue;
        }

        const text = await resp.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            updateStep(step, '–', `Endpoint responded (HTTP ${resp.status}) but not with valid JSON. Trying next...`, `POST ${endpoint} → HTTP ${resp.status} | Invalid JSON`, text, mcpReq);
            await delay(300);
            continue;
        }

        const tools = extractTools(data);
        if (tools.length > 0) {
            mcpEndpoint = endpoint;
            updateStep(step, '✓',
                `Connected! This store's MCP server offers <strong>${tools.length}</strong> tools:`,
                `POST ${endpoint} → HTTP 200 | ${tools.length} tools discovered`,
                data,
                mcpReq
            );

            renderToolCards(step, tools);

            await delay(300);
            showInteractiveSection(tools);

            connected = true;
            break;
        } else {
            updateStep(step, '–', `Connected (HTTP 200) but no tools were listed in the response.`, `POST ${endpoint} → HTTP 200 | 0 tools returned`, data, mcpReq);
            await delay(300);
            continue;
        }
    } catch (e) {
        updateStep(step, '–', `Could not connect to <code>${endpoint}</code>.`, `POST ${endpoint} → Connection failed: ${e.message}`, null, mcpReq);
        await delay(300);
        continue;
    }
    }

    if (!connected) {
        addStep('✗', 'Could not connect to any MCP endpoint. The store might restrict agent access or not have MCP enabled.');
    }
}

// Tool cards
const TOOL_META = {
    search_catalog: { label: 'Search Catalog', short: 'Search products by keyword', interactive: true },
    get_product_details: { label: 'Product Details', short: 'Look up a product by ID', interactive: true },
    search_shop_policies_and_faqs: { label: 'Policies & FAQs', short: 'Ask about store policies', interactive: true },
    get_cart: { label: 'Get Cart', short: 'Retrieve cart contents', interactive: false },
    update_cart: { label: 'Update Cart', short: 'Add/remove cart items', interactive: false }
};

function renderToolCards(step, tools) {
    const grid = document.createElement('div');
    grid.className = 'tool-grid';
    tools.forEach(t => {
        const meta = TOOL_META[t.name] || { label: t.name, short: '', interactive: false };
        const card = document.createElement('div');
        card.className = 'tool-card' + (meta.interactive ? ' interactive' : '');
        card.innerHTML = `
            <div class="tool-name">${escapeHtml(meta.label)}</div>
            <div class="tool-desc">${escapeHtml(meta.short)}</div>
            <span class="tool-badge ${meta.interactive ? 'try-it' : 'info'}">${meta.interactive ? 'Try it' : 'Available'}</span>
        `;
        if (meta.interactive) {
            card.addEventListener('click', () => {
                const tabId = t.name === 'search_catalog' ? 'catalog' :
                              t.name === 'search_shop_policies_and_faqs' ? 'policies' : 'catalog';
                switchTab(tabId);
                document.querySelector('.interact-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
        grid.appendChild(card);
    });
    step.appendChild(grid);
}

function showInteractiveSection(tools) {
    const hasSearch = tools.some(t => t.name === 'search_catalog');
    const hasPolicies = tools.some(t => t.name === 'search_shop_policies_and_faqs');

    if (!hasSearch && !hasPolicies) return;

    const section = document.createElement('div');
    section.className = 'interact-section';

    let tabsHtml = '<div class="interact-tabs">';
    if (hasSearch) tabsHtml += '<button class="interact-tab active" onclick="switchTab(\'catalog\')">Search Catalog</button>';
    if (hasPolicies) tabsHtml += `<button class="interact-tab${hasSearch ? '' : ' active'}" onclick="switchTab('policies')">Policies & FAQs</button>`;
    tabsHtml += '</div>';

    let panelsHtml = '';
    if (hasSearch) {
        panelsHtml += `
            <div class="interact-panel active" id="panel-catalog">
                <p class="hint">Search this store's product catalog. Click any product to see full details.</p>
                <div class="query-row">
                    <input type="text" id="search-input" placeholder="e.g. hot sauce, gift sets, seasonings...">
                    <button onclick="searchCatalog()">Search</button>
                </div>
                <div class="filter-row">
                    <input type="number" id="price-min" min="0" step="0.01" placeholder="Min price">
                    <input type="number" id="price-max" min="0" step="0.01" placeholder="Max price">
                    <span class="filter-hint" id="price-hint">Optional price range</span>
                </div>
                <div class="results-area" id="catalog-results"></div>
            </div>
        `;
    }
    if (hasPolicies) {
        panelsHtml += `
            <div class="interact-panel${hasSearch ? '' : ' active'}" id="panel-policies">
                <p class="hint">Ask a question about this store's policies, shipping, returns, or services.</p>
                <div class="query-row">
                    <input type="text" id="policy-input" placeholder="e.g. What is your return policy?">
                    <button onclick="searchPolicies()">Ask</button>
                </div>
                <div class="results-area" id="policy-results"></div>
            </div>
        `;
    }

    const jsonPaneHtml = `
        <div class="json-pane" id="json-pane">
            <div class="json-pane-header">Raw Response</div>
            <pre id="json-pane-content">Make a request to see the raw JSON response here.</pre>
        </div>
    `;

    section.innerHTML = tabsHtml + panelsHtml + jsonPaneHtml;
    log.appendChild(section);

    ['search-input', 'price-min', 'price-max'].forEach((id) => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') searchCatalog();
        });
    });
    document.getElementById('policy-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchPolicies();
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.interact-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.interact-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`panel-${tabId}`);
    if (panel) {
        panel.classList.add('active');
        const tabs = document.querySelectorAll('.interact-tab');
        tabs.forEach(t => {
            if ((tabId === 'catalog' && t.textContent === 'Search Catalog') ||
                (tabId === 'policies' && t.textContent === 'Policies & FAQs')) {
                t.classList.add('active');
            }
        });
    }
}

// JSON pane helper with syntax highlighting
function updateJsonPane(data) {
    const pane = document.getElementById('json-pane-content');
    if (pane) {
        const raw = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        pane.innerHTML = syntaxHighlight(raw);
    }
}

function syntaxHighlight(json) {
    return escapeHtml(json).replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        function (match) {
            let cls = 'json-number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'json-key';
                    // Remove the trailing colon from the span, add it outside
                    return '<span class="' + cls + '">' + match.slice(0, -1) + '</span>:';
                } else {
                    cls = 'json-string';
                }
            } else if (/true|false/.test(match)) {
                cls = 'json-bool';
            } else if (/null/.test(match)) {
                cls = 'json-null';
            }
            return '<span class="' + cls + '">' + match + '</span>';
        }
    );
}

// MCP tool call helper
let callId = 10;
function buildMcpRequest(toolName, args) {
    return {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: callId++,
        params: {
            name: toolName,
            arguments: {
                meta: { 'ucp-agent': { profile: 'https://kylerisley.com/tools/ucp-explorer/agent-profile.json' } },
                ...args
            }
        }
    };
}

function mcpCallWithBody(reqBody) {
    return proxyFetch(mcpEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
    });
}

function reqResponseHtml(reqBody, resData) {
    const groupName = `step-toggle-${++toggleGroupSeq}`;
    return `<div class="step-toggles">
        <details class="step-raw" name="${groupName}">
            <summary>Request</summary>
            ${jsonBoxHtml('Request', { method: 'POST', url: mcpEndpoint, headers: { 'Content-Type': 'application/json' }, body: reqBody })}
        </details>
        <details class="step-raw" name="${groupName}">
            <summary>Response</summary>
            ${jsonBoxHtml('Response', resData)}
        </details>
    </div>`;
}

// Catalog search
async function searchCatalog() {
    const query = document.getElementById('search-input').value.trim();
    if (!query) return;

    const results = document.getElementById('catalog-results');
    results.innerHTML = '<span class="loading-dot">Searching...</span>';

    const catalog = { query, pagination: { limit: 10 } };
    // filters.price amounts are ISO 4217 minor units (e.g. cents); the UI takes
    // major units and assumes a 2-decimal currency, correct for USD/EUR/GBP/etc.
    const priceFilter = {};
    const minVal = parseFloat(document.getElementById('price-min')?.value);
    const maxVal = parseFloat(document.getElementById('price-max')?.value);
    if (!isNaN(minVal) && minVal >= 0) priceFilter.min = Math.round(minVal * 100);
    if (!isNaN(maxVal) && maxVal >= 0) priceFilter.max = Math.round(maxVal * 100);
    if (priceFilter.min !== undefined || priceFilter.max !== undefined) {
        catalog.filters = { price: priceFilter };
    }

    const reqBody = buildMcpRequest('search_catalog', { catalog });

    try {
        const resp = await mcpCallWithBody(reqBody);
        const data = await resp.json();
        const products = extractProducts(data);

        const cur = (products.find(p => p.currency) || {}).currency;
        const priceHint = document.getElementById('price-hint');
        if (priceHint) priceHint.textContent = cur ? `Price range in ${cur}` : 'Optional price range';

        updateJsonPane(data);

        let html = '';
        if (products.length > 0) {
            html += products.map(p => `
                <div class="product-card" onclick="getProductDetails('${escapeHtml(p.id || '')}')">
                    ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}">` : ''}
                    <div class="product-info">
                        <div class="name">${escapeHtml(p.name)}</div>
                        ${p.price ? `<div class="price">${escapeHtml(p.price)}</div>` : ''}
                        ${p.variantCount ? `<div class="variants">${p.variantCount} variant${p.variantCount > 1 ? 's' : ''}</div>` : ''}
                        ${p.id ? '<span class="view-details">View full details</span>' : ''}
                    </div>
                </div>
            `).join('');
        } else {
            html += `<div class="step-detail">No products found for "${escapeHtml(query)}".</div>`;
        }
        html += reqResponseHtml(reqBody, data);
        results.innerHTML = html;
    } catch (e) {
        results.innerHTML = `<div class="step-detail">Search failed: ${escapeHtml(e.message)}</div>` + reqResponseHtml(reqBody, { error: e.message });
    }
}

// Product details
async function getProductDetails(productId) {
    if (!productId) return;

    const results = document.getElementById('catalog-results');
    const existing = document.getElementById('product-detail-view');
    if (existing) existing.remove();

    const detail = document.createElement('div');
    detail.id = 'product-detail-view';
    detail.className = 'product-detail';
    detail.innerHTML = '<div class="detail-loading"><span class="loading-dot">Fetching product details via get_product_details...</span></div>';
    results.insertBefore(detail, results.firstChild);
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const reqBody = buildMcpRequest('get_product_details', { product_id: productId });

    try {
        const resp = await mcpCallWithBody(reqBody);
        const data = await resp.json();
        updateJsonPane(data);
        const product = extractProductDetail(data);

        let html = '<div class="product-detail-header">';
        if (product.image) {
            html += `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">`;
        }
        html += '<div class="detail-meta">';
        html += `<h3>${escapeHtml(product.name)}</h3>`;
        if (product.price) html += `<div class="detail-row"><span class="detail-label">Price:</span> ${escapeHtml(product.price)}</div>`;
        if (product.totalVariants) html += `<div class="detail-row"><span class="detail-label">Variants:</span> ${product.totalVariants}</div>`;
        if (product.options && product.options.length > 0) {
            html += `<div class="detail-row"><span class="detail-label">Options:</span> ${product.options.map(o => escapeHtml(o)).join(' · ')}</div>`;
        }
        html += '</div></div>';

        if (product.description) {
            const cleanDesc = product.description.replace(/<[^>]*>/g, '');
            html += `<div class="detail-desc">${escapeHtml(cleanDesc)}</div>`;
        }

        if (product.url) {
            html += `<a href="${escapeHtml(product.url)}" target="_blank" rel="noopener" class="pdp-link">View on ${escapeHtml(currentDomain)}</a>`;
        }

        html += reqResponseHtml(reqBody, data);
        detail.innerHTML = html;
    } catch (e) {
        detail.innerHTML = `<div class="detail-loading">Failed to load details: ${escapeHtml(e.message)}</div>` + reqResponseHtml(reqBody, { error: e.message });
    }
}

// Policies search
async function searchPolicies() {
    const query = document.getElementById('policy-input').value.trim();
    if (!query) return;

    const results = document.getElementById('policy-results');
    results.innerHTML = '<span class="loading-dot">Looking up policy...</span>';

    const reqBody = buildMcpRequest('search_shop_policies_and_faqs', { query });

    try {
        const resp = await mcpCallWithBody(reqBody);
        const data = await resp.json();
        updateJsonPane(data);
        const qaPairs = extractPolicyQA(data);

        let html = '';
        if (qaPairs.length > 0) {
            html += `<div class="policy-answer">${qaPairs.map(qa =>
                `<div class="policy-qa"><div class="pq">${escapeHtml(qa.question)}</div><div class="pa">${escapeHtml(qa.answer)}</div></div>`
            ).join('')}</div>`;
        } else {
            const answer = extractPolicyAnswer(data);
            html += `<div class="policy-answer">${escapeHtml(answer)}</div>`;
        }
        html += reqResponseHtml(reqBody, data);
        results.innerHTML = html;
    } catch (e) {
        results.innerHTML = `<div class="step-detail">Policy lookup failed: ${escapeHtml(e.message)}</div>` + reqResponseHtml(reqBody, { error: e.message });
    }
}

// Parsing helpers

function extractCapabilities(ucpData) {
    const caps = [];
    if (ucpData.services) {
        for (const [key, val] of Object.entries(ucpData.services)) {
            if (val.capabilities) {
                caps.push(...Object.keys(val.capabilities).map(c => `${key}.${c}`));
            } else {
                caps.push(key);
            }
        }
    }
    if (ucpData.capabilities) {
        caps.push(...(Array.isArray(ucpData.capabilities) ? ucpData.capabilities : Object.keys(ucpData.capabilities)));
    }
    return caps;
}

function extractMcpEndpoint(ucpData, domain) {
    // Look for MCP transport in various possible structures
    if (ucpData.transport === 'mcp' && ucpData.endpoint) return ucpData.endpoint;
    if (ucpData.mcp && ucpData.mcp.endpoint) return ucpData.mcp.endpoint;
    if (ucpData.services) {
        for (const svc of Object.values(ucpData.services)) {
            if (svc.transport === 'mcp' && svc.endpoint) return svc.endpoint;
            if (svc.mcp && svc.mcp.endpoint) return svc.mcp.endpoint;
        }
    }
    // Default Shopify convention
    return `https://${domain}/api/ucp/mcp`;
}

function extractTools(data) {
    if (data.result && data.result.tools) return data.result.tools;
    if (data.tools) return data.tools;
    if (data.result && Array.isArray(data.result)) return data.result;
    return [];
}

function formatPrice(val) {
    if (val === undefined || val === null) return '';
    if (typeof val === 'object' && val.amount !== undefined) {
        // Amount in cents (e.g. 1299) or dollars (e.g. 12.99)
        const amt = Number(val.amount);
        const formatted = amt >= 100 && Number.isInteger(amt) ? (amt / 100).toFixed(2) : amt.toFixed(2);
        return `$${formatted}`;
    }
    if (typeof val === 'number') return `$${val.toFixed(2)}`;
    if (typeof val === 'string') return val.startsWith('$') ? val : `$${val}`;
    return String(val);
}

function extractProducts(data) {
    const products = [];
    let source = null;

    if (data.result && data.result.structuredContent && data.result.structuredContent.products) {
        source = data.result.structuredContent.products;
    } else if (data.result && data.result.content) {
        for (const block of (Array.isArray(data.result.content) ? data.result.content : [])) {
            if (block.type === 'text') {
                try {
                    const parsed = JSON.parse(block.text);
                    if (parsed.products) source = parsed.products;
                } catch (e) {}
            }
        }
    }

    if (source && Array.isArray(source)) {
        for (const p of source.slice(0, 10)) {
            let img = p.image_url || p.imageUrl || p.image || p.featuredImage || (p.images && p.images[0]) || '';
            const imgUrl = typeof img === 'string' ? img : (img.url || img.src || '');

            let price = '';
            let currency = '';
            if (p.price_range) {
                const minP = formatPrice(p.price_range.min);
                const maxP = formatPrice(p.price_range.max);
                const cur = p.price_range.currency || (p.price_range.min && p.price_range.min.currency) || '';
                currency = cur;
                price = minP;
                if (maxP && maxP !== minP) price += ` – ${maxP}`;
                if (cur) price += ` ${cur}`;
            } else if (p.price) {
                currency = (typeof p.price === 'object' && p.price.currencyCode) || '';
                price = typeof p.price === 'object' ? `${p.price.amount} ${p.price.currencyCode || ''}` : String(p.price);
            }

            products.push({
                id: p.product_id || p.id || p.productId || '',
                name: p.title || p.name || 'Unnamed product',
                price: price,
                currency: currency,
                image: imgUrl,
                variantCount: p.total_variants || p.variantCount || (p.variants && p.variants.length) || 0,
                url: p.url || ''
            });
        }
    }

    return products;
}

function extractProductDetail(data) {
    let p = null;
    if (data.result && data.result.structuredContent && data.result.structuredContent.product) {
        p = data.result.structuredContent.product;
    } else if (data.result && data.result.content) {
        for (const block of (Array.isArray(data.result.content) ? data.result.content : [])) {
            if (block.type === 'text') {
                try {
                    const parsed = JSON.parse(block.text);
                    if (parsed.product) p = parsed.product;
                    else if (parsed.title || parsed.name) p = parsed;
                } catch (e) {}
            }
        }
    }
    if (!p) p = {};

    // Extract image
    let image = p.image_url || p.imageUrl || '';
    if (!image && p.images && p.images.length > 0) {
        image = typeof p.images[0] === 'string' ? p.images[0] : (p.images[0].url || p.images[0].src || '');
    }
    if (!image && p.featuredImage) {
        image = typeof p.featuredImage === 'string' ? p.featuredImage : (p.featuredImage.url || '');
    }

    // Extract price
    let price = '';
    if (p.price_range) {
        price = p.price_range.min !== undefined ? `$${p.price_range.min}` : '';
        if (p.price_range.max && p.price_range.max !== p.price_range.min) {
            price += ` – $${p.price_range.max}`;
        }
        if (p.price_range.currency) price += ` ${p.price_range.currency}`;
    } else if (p.price) {
        price = typeof p.price === 'object' ? `${p.price.amount} ${p.price.currencyCode || ''}` : String(p.price);
    }

    return {
        name: p.title || p.name || 'Unknown product',
        description: p.description || p.descriptionHtml || '',
        price: price,
        url: p.url || '',
        image: image,
        totalVariants: p.total_variants || p.totalVariants || (p.variants && p.variants.length) || 0,
        options: p.options ? p.options.filter(o => !(o.name === 'Title' && o.values && o.values.length === 1 && o.values[0] === 'Default Title')).map(o => `${o.name}: ${(o.values || []).join(', ')}`) : [],
        variants: p.variants || []
    };
}

function extractPolicyQA(data) {
    // Try to parse Q&A pairs from content blocks
    if (data.result && data.result.content) {
        for (const block of (Array.isArray(data.result.content) ? data.result.content : [])) {
            if (block.type === 'text') {
                try {
                    const parsed = JSON.parse(block.text);
                    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].question) {
                        return parsed;
                    }
                } catch (e) {}
            }
        }
    }
    if (data.result && data.result.structuredContent && Array.isArray(data.result.structuredContent)) {
        if (data.result.structuredContent[0] && data.result.structuredContent[0].question) {
            return data.result.structuredContent;
        }
    }
    return [];
}

function extractPolicyAnswer(data) {
    if (data.result && data.result.content) {
        for (const block of (Array.isArray(data.result.content) ? data.result.content : [])) {
            if (block.type === 'text') return block.text;
        }
    }
    if (data.result && data.result.structuredContent && data.result.structuredContent.answer) {
        return data.result.structuredContent.answer;
    }
    if (data.result && typeof data.result === 'string') return data.result;
    return 'No answer returned.';
}
