/**
 * Tests for the UCP Explorer (tools/ucp-explorer/explore.js).
 *
 * Run:  node --test tools/ucp-explorer/
 *
 * Uses Node's built-in test runner (Node 18+) — no dependencies.
 *
 * explore.js is browser code: it expects `document` and `fetch` as globals and
 * runs top-level DOM setup on load. The harness below mocks those globals and
 * evaluates the real source file in a fresh function scope per test, so each
 * test gets isolated module state.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXPLORE_JS = fs.readFileSync(path.join(__dirname, 'explore.js'), 'utf8');

// --- Minimal DOM mock ---------------------------------------------------
function createMockDOM() {
    const logChildren = [];
    const elements = {
        log: {
            innerHTML: '',
            classList: { add() {}, remove() {} },
            appendChild(el) { logChildren.push(el); },
            addEventListener() {},
            get children() { return logChildren; }
        },
        'domain-input': { value: '', addEventListener() {} },
        'go-btn': { disabled: false, addEventListener() {} }
    };

    function makeEl() {
        return {
            className: '', textContent: '', innerHTML: '', id: '',
            children: [],
            appendChild(c) { this.children.push(c); },
            insertBefore(c) { this.children.unshift(c); },
            remove() {},
            scrollIntoView() {},
            addEventListener() {},
            classList: { add() {}, remove() {} }
        };
    }

    global.document = {
        getElementById(id) { return elements[id]; },
        createElement() { return makeEl(); },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };

    return { elements, logChildren };
}

/**
 * Evaluate the real explore.js in a fresh scope with mocked globals.
 * Returns the explorer's internal functions plus the mock DOM handles.
 */
function loadExplorer(fetchImpl) {
    const { elements, logChildren } = createMockDOM();
    global.fetch = fetchImpl || (async () => ({ ok: false, status: 404, text: async () => '' }));

    const factory = new Function(
        EXPLORE_JS +
        '\nreturn { startExploration, phase2, phase3, addStep, updateStep, buildStepHtml,' +
        ' reqResponseHtml, jsonBoxHtml, iconClass, escapeHtml, extractCapabilities,' +
        ' extractMcpEndpoint, extractTools, formatPrice };'
    );

    return { exported: factory(), elements, logChildren };
}

/** A fetch mock that routes by URL substring. */
function routedFetch(routes) {
    const calls = [];
    const impl = async (url, opts) => {
        calls.push({ url, opts });
        for (const [match, response] of routes) {
            if (url.includes(match)) return response;
        }
        return { ok: false, status: 404, text: async () => 'Not Found' };
    };
    impl.calls = calls;
    return impl;
}

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

// --- updateStep(): direct regression test for the `html is not defined` bug ---
//
// updateStep() once contained a stray `step.innerHTML = html;` referencing an
// undefined variable, throwing a ReferenceError on every discovery step and
// breaking the whole explorer. These tests call it directly and fail loudly
// if that regression returns.
describe('updateStep()', () => {
    test('does not throw and renders icon + text (full args)', () => {
        const { exported } = loadExplorer();
        const step = global.document.createElement('div');

        assert.doesNotThrow(() => {
            exported.updateStep(step, '✓', 'Found it!', 'GET / → HTTP 200', { a: 1 }, { b: 2 });
        });

        assert.match(step.innerHTML, /Found it!/);
        assert.match(step.innerHTML, /step-icon-pass/);
    });

    test('does not throw when called with only 3 args (phase2 error path)', () => {
        // This is the exact call shape that failed for the user:
        //   updateStep(step, '✗', `Error fetching UCP manifest: ...`)
        const { exported } = loadExplorer();
        const step = global.document.createElement('div');

        assert.doesNotThrow(() => {
            exported.updateStep(step, '✗', 'Error fetching UCP manifest: boom');
        });

        assert.match(step.innerHTML, /Error fetching UCP manifest: boom/);
        assert.match(step.innerHTML, /step-icon-fail/);
    });

    test('overwrites prior step content', () => {
        const { exported } = loadExplorer();
        const step = global.document.createElement('div');
        step.innerHTML = '<span>loading…</span>';

        exported.updateStep(step, '✓', 'done');

        assert.doesNotMatch(step.innerHTML, /loading/);
        assert.match(step.innerHTML, /done/);
    });
});

// --- buildStepHtml() ----------------------------------------------------
describe('buildStepHtml()', () => {
    test('renders header with text and mapped icon class', () => {
        const { exported } = loadExplorer();
        const html = exported.buildStepHtml('✓', 'hello', null, null, null);
        assert.match(html, /step-icon-pass/);
        assert.match(html, /hello/);
    });

    test('includes Request and Response toggles only when provided', () => {
        const { exported } = loadExplorer();

        const plain = exported.buildStepHtml('–', 't', 'd', null, null);
        assert.doesNotMatch(plain, /<summary>Request<\/summary>/);

        const withBoth = exported.buildStepHtml('✓', 't', 'd', { req: 1 }, { res: 1 });
        assert.match(withBoth, /<summary>Request<\/summary>/);
        assert.match(withBoth, /<summary>Response<\/summary>/);
    });

    test('Request and Response in one group share a name (mutually exclusive)', () => {
        const { exported } = loadExplorer();
        const html = exported.buildStepHtml('✓', 't', 'd', { req: 1 }, { res: 1 });

        const names = [...html.matchAll(/<details class="step-raw" name="([^"]+)"/g)].map(m => m[1]);
        assert.equal(names.length, 2, 'expected two named <details>');
        assert.equal(names[0], names[1], 'both toggles in a pair must share a name');
    });

    test('separate toggle groups get distinct names', () => {
        const { exported } = loadExplorer();
        const first = exported.buildStepHtml('✓', 't', 'd', { req: 1 }, { res: 1 });
        const second = exported.buildStepHtml('✓', 't', 'd', { req: 1 }, { res: 1 });

        const nameOf = h => h.match(/name="([^"]+)"/)[1];
        assert.notEqual(nameOf(first), nameOf(second), 'distinct groups must not share a name');
    });

    test('Request/Response boxes carry copy and expand controls', () => {
        const { exported } = loadExplorer();
        const html = exported.buildStepHtml('✓', 't', 'd', { a: 1 }, { b: 2 });

        assert.match(html, /class="json-box" data-label="Request"/);
        assert.match(html, /class="json-box" data-label="Response"/);
        assert.equal((html.match(/json-copy/g) || []).length, 2, 'a copy button per box');
        assert.equal((html.match(/json-expand/g) || []).length, 2, 'an expand button per box');
    });
});

// --- reqResponseHtml() --------------------------------------------------
describe('reqResponseHtml()', () => {
    test('wraps both request and response in a json-box with controls', () => {
        const { exported } = loadExplorer();
        const html = exported.reqResponseHtml({ query: 'x' }, { ok: true });

        const labels = [...html.matchAll(/class="json-box" data-label="([^"]+)"/g)].map(m => m[1]);
        assert.deepEqual(labels, ['Request', 'Response']);
        assert.equal((html.match(/json-copy/g) || []).length, 2);
        assert.equal((html.match(/json-expand/g) || []).length, 2);
    });
});

// --- addStep() ----------------------------------------------------------
describe('addStep()', () => {
    test('creates a step, appends it to the log, and returns it', () => {
        const { exported, logChildren } = loadExplorer();
        const step = exported.addStep('⏳', 'Checking...');
        assert.equal(step.className, 'step');
        assert.equal(logChildren.length, 1);
        assert.equal(logChildren[0], step);
    });
});

// --- startExploration() -------------------------------------------------
describe('startExploration()', () => {
    test('does nothing when the domain input is empty', async () => {
        const fetchMock = routedFetch([]);
        const { exported, elements, logChildren } = loadExplorer(fetchMock);
        elements['domain-input'].value = '   ';

        await exported.startExploration();

        assert.equal(fetchMock.calls.length, 0);
        assert.equal(logChildren.length, 0);
    });

    test('strips protocol and trailing slashes from the domain', async () => {
        const fetchMock = routedFetch([
            ['.well-known/ucp', jsonResponse({ mcp: { endpoint: 'https://example.com/api/ucp/mcp' } })],
            ['mcp', jsonResponse({ result: { tools: [{ name: 'search_catalog' }] } })]
        ]);
        const { exported, elements } = loadExplorer(fetchMock);
        elements['domain-input'].value = 'https://example.com///';

        await exported.startExploration();

        assert.match(
            fetchMock.calls[0].url,
            new RegExp(encodeURIComponent('https://example.com/.well-known/ucp'))
        );
    });

    test('disables the button during exploration and re-enables it after', async () => {
        const { exported, elements } = loadExplorer(routedFetch([]));
        elements['domain-input'].value = 'example.com';

        // startExploration sets goBtn.disabled = true synchronously, before any await.
        const pending = exported.startExploration();
        assert.equal(elements['go-btn'].disabled, true);

        await pending;
        assert.equal(elements['go-btn'].disabled, false);
    });

    test('runs UCP discovery then MCP interaction on success', async () => {
        const fetchMock = routedFetch([
            ['.well-known/ucp', jsonResponse({
                services: { shopping: { capabilities: { checkout: {} }, transport: 'mcp', endpoint: 'https://shop.example.com/api/ucp/mcp' } }
            })],
            ['mcp', jsonResponse({ result: { tools: [{ name: 'search_catalog' }, { name: 'get_cart' }] } })]
        ]);
        const { exported, elements } = loadExplorer(fetchMock);
        elements['domain-input'].value = 'shop.example.com';

        await exported.startExploration();

        // UCP discovery + at least one MCP tools/list call.
        assert.ok(fetchMock.calls.length >= 2, `expected >= 2 fetches, got ${fetchMock.calls.length}`);
        assert.match(fetchMock.calls[0].url, /well-known%2Fucp/);
    });

    test('falls back to /api/ucp/mcp when no UCP manifest exists', async () => {
        const fetchMock = routedFetch([
            ['.well-known/ucp', { ok: false, status: 404, text: async () => 'Not Found' }],
            ['mcp', jsonResponse({ result: { tools: [{ name: 'search_catalog' }] } })]
        ]);
        const { exported, elements } = loadExplorer(fetchMock);
        elements['domain-input'].value = 'store.example.com';

        await exported.startExploration();

        const triedFallback = fetchMock.calls.some(c =>
            c.url.includes(encodeURIComponent('store.example.com/api/ucp/mcp')));
        assert.ok(triedFallback, `expected a fallback call; got ${fetchMock.calls.map(c => c.url).join(', ')}`);
    });

    test('handles network errors without throwing', async () => {
        const { exported, elements } = loadExplorer(async () => { throw new Error('Network failure'); });
        elements['domain-input'].value = 'unreachable.example.com';

        await assert.doesNotReject(() => exported.startExploration());
        assert.equal(elements['go-btn'].disabled, false);
    });

    test('handles invalid JSON in the UCP manifest without throwing', async () => {
        const fetchMock = routedFetch([
            ['.well-known/ucp', { ok: true, status: 200, text: async () => 'not json {{{' }]
        ]);
        const { exported, elements } = loadExplorer(fetchMock);
        elements['domain-input'].value = 'badjson.example.com';

        await assert.doesNotReject(() => exported.startExploration());
        assert.equal(elements['go-btn'].disabled, false);
    });
});

// --- extractCapabilities() ---------------------------------------------
describe('extractCapabilities()', () => {
    test('extracts namespaced capabilities from services', () => {
        const { exported } = loadExplorer();
        const caps = exported.extractCapabilities({
            services: { shopping: { capabilities: { checkout: {}, catalog: {} } }, payments: { capabilities: { stripe: {} } } }
        });
        assert.deepEqual(caps.sort(), ['payments.stripe', 'shopping.catalog', 'shopping.checkout']);
    });

    test('extracts a top-level capabilities array', () => {
        const { exported } = loadExplorer();
        assert.deepEqual(exported.extractCapabilities({ capabilities: ['checkout', 'catalog'] }), ['checkout', 'catalog']);
    });

    test('returns an empty array when there are no capabilities', () => {
        const { exported } = loadExplorer();
        assert.deepEqual(exported.extractCapabilities({}), []);
    });
});

// --- extractMcpEndpoint() ----------------------------------------------
describe('extractMcpEndpoint()', () => {
    test('reads a top-level transport/endpoint pair', () => {
        const { exported } = loadExplorer();
        assert.equal(exported.extractMcpEndpoint({ transport: 'mcp', endpoint: 'https://s.com/mcp' }, 's.com'), 'https://s.com/mcp');
    });

    test('reads mcp.endpoint', () => {
        const { exported } = loadExplorer();
        assert.equal(exported.extractMcpEndpoint({ mcp: { endpoint: 'https://s.com/api/mcp' } }, 's.com'), 'https://s.com/api/mcp');
    });

    test('reads an mcp service endpoint', () => {
        const { exported } = loadExplorer();
        assert.equal(
            exported.extractMcpEndpoint({ services: { shopping: { transport: 'mcp', endpoint: 'https://s.com/svc/mcp' } } }, 's.com'),
            'https://s.com/svc/mcp'
        );
    });

    test('falls back to the default Shopify convention', () => {
        const { exported } = loadExplorer();
        assert.equal(exported.extractMcpEndpoint({}, 'mystore.com'), 'https://mystore.com/api/ucp/mcp');
    });
});

// --- extractTools() -----------------------------------------------------
describe('extractTools()', () => {
    test('reads result.tools', () => {
        const { exported } = loadExplorer();
        assert.deepEqual(exported.extractTools({ result: { tools: [{ name: 'a' }] } }), [{ name: 'a' }]);
    });

    test('reads a top-level tools array', () => {
        const { exported } = loadExplorer();
        assert.deepEqual(exported.extractTools({ tools: [{ name: 'x' }] }), [{ name: 'x' }]);
    });

    test('reads a result array', () => {
        const { exported } = loadExplorer();
        assert.deepEqual(exported.extractTools({ result: [{ name: 'y' }] }), [{ name: 'y' }]);
    });

    test('returns an empty array for an unrecognized shape', () => {
        const { exported } = loadExplorer();
        assert.deepEqual(exported.extractTools({ nope: true }), []);
    });
});
