// agent-audit-proxy — Cloudflare Worker that fetches arbitrary public HTML
// pages on behalf of the Agent Audit tool, with defenses against open-proxy
// abuse, SSRF, and resource exhaustion.

const ALLOWED_ORIGIN = 'https://kylerisley.com';
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const ALLOWED_CONTENT_TYPES = [
    /^text\/html/i,
    /^text\/plain/i,
    /^application\/xhtml\+xml/i,
];

const BLOCKED_HOSTS = new Set([
    'localhost',
    '169.254.169.254',
    'metadata.google.internal',
    'metadata.goog',
    'metadata.amazonaws.com',
]);

const PRIVATE_IPV4 = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^127\./,
    /^169\.254\./,
    /^0\./,
    /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
    /^192\.0\.0\./,
    /^192\.0\.2\./,
    /^198\.1[89]\./,
    /^198\.51\.100\./,
    /^203\.0\.113\./,
    /^22[4-9]\./,
    /^23[0-9]\./,
    /^24[0-9]\./,
    /^25[0-5]\./,
];

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        // Custom headers are invisible to cross-origin JS unless explicitly
        // exposed. The llms.txt summary is delivered via these headers.
        'Access-Control-Expose-Headers': 'X-Final-Url, X-Original-Status, X-Llms-Txt-Status, X-Llms-Txt-Bytes, X-Llms-Txt-Present, X-Llms-Txt-Headings',
        'Vary': 'Origin',
    };
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
}

function isPrivateOrBlockedHost(hostname) {
    const h = hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(h)) return true;
    if (h.endsWith('.internal') || h.endsWith('.local')) return true;
    if (/^[\d.]+$/.test(h)) {
        return PRIVATE_IPV4.some(re => re.test(h));
    }
    if (h.includes(':')) {
        if (h === '::1' || h === '::') return true;
        if (/^fc[0-9a-f]{2}:/i.test(h) || /^fd[0-9a-f]{2}:/i.test(h)) return true;
        if (/^fe80:/i.test(h)) return true;
        if (h.startsWith('::ffff:')) {
            const v4 = h.slice(7);
            return PRIVATE_IPV4.some(re => re.test(v4));
        }
    }
    return false;
}

async function verifyTurnstile(token, ip, secret) {
    if (!token) return { ok: false, errors: ['missing-token'] };
    if (!secret) return { ok: false, errors: ['missing-secret-binding'] };
    const body = new FormData();
    body.append('secret', secret);
    body.append('response', token);
    if (ip) body.append('remoteip', ip);
    try {
        const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body,
        });
        const data = await resp.json();
        if (data.success === true) return { ok: true };
        return { ok: false, errors: data['error-codes'] || ['unknown'] };
    } catch (e) {
        return { ok: false, errors: ['fetch-failed: ' + (e.message || 'unknown')] };
    }
}

// Fetches <origin>/llms.txt and returns a small summary. Lighthouse's agentic
// browsing audit checks for this machine-readable summary file; the browser
// can't read it cross-origin (no CORS on arbitrary sites), so we do it here.
// Returns null on any error so a missing/broken llms.txt never fails the audit.
async function summarizeLlmsTxt(pageUrl) {
    let llmsUrl;
    try {
        llmsUrl = new URL('/llms.txt', pageUrl).toString();
    } catch {
        return null;
    }

    // Tighter than the page timeout — llms.txt is an optional extra, so it must
    // not add much latency to the main audit.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const resp = await fetch(llmsUrl, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            cf: { cacheTtl: 0 },
            headers: {
                'User-Agent': 'AgentAuditBot/1.0 (+https://kylerisley.com/tools/agent-audit/)',
                'Accept': 'text/markdown,text/plain;q=0.9,*/*;q=0.5',
                'Accept-Language': 'en',
            },
        });
        clearTimeout(timer);

        if (!resp.ok) {
            return { status: resp.status, present: false, bytes: 0, headings: 0 };
        }

        // Cap the read — llms.txt should be small, and we only need to sniff it.
        const reader = resp.body.getReader();
        const chunks = [];
        let total = 0;
        const CAP = 512 * 1024;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            chunks.push(value);
            if (total > CAP) { await reader.cancel(); break; }
        }
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let text = '';
        for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
        text += decoder.decode();

        // A soft-404 often returns 200 with an HTML error page. Only count the
        // file as present if it isn't an HTML document.
        const looksHtml = /^\s*<(?:!doctype|html|head|body)\b/i.test(text);
        const headings = (text.match(/^#{1,6}\s+\S/gm) || []).length;
        return {
            status: resp.status,
            present: !looksHtml && text.trim().length > 0,
            bytes: total,
            headings,
        };
    } catch {
        clearTimeout(timer);
        return null;
    }
}

async function handleProxy(request, env) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    const token = url.searchParams.get('token');

    if (!target) return json({ error: 'Missing url parameter' }, 400);
    if (!token) return json({ error: 'Missing Turnstile token' }, 400);

    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        return json({ error: 'Invalid URL' }, 400);
    }

    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        return json({ error: 'Only http/https URLs are allowed' }, 400);
    }

    if (isPrivateOrBlockedHost(targetUrl.hostname)) {
        return json({ error: 'Private or internal hosts are blocked' }, 403);
    }

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const verification = await verifyTurnstile(token, ip, env.TURNSTILE_SECRET);
    if (!verification.ok) {
        return json({
            error: 'Turnstile verification failed',
            errorCodes: verification.errors,
        }, 403);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let resp;
    try {
        resp = await fetch(targetUrl.toString(), {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            cf: { cacheTtl: 0 },
            headers: {
                'User-Agent': 'AgentAuditBot/1.0 (+https://kylerisley.com/tools/agent-audit/)',
                'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
                'Accept-Language': 'en',
            },
        });
    } catch (e) {
        clearTimeout(timer);
        return json({ error: `Fetch failed: ${e.message || 'unknown error'}` }, 502);
    }
    clearTimeout(timer);

    const contentType = resp.headers.get('Content-Type') || '';
    if (!ALLOWED_CONTENT_TYPES.some(re => re.test(contentType))) {
        return json({ error: `Disallowed Content-Type: ${contentType || 'unknown'}` }, 415);
    }

    if (!resp.body) {
        return json({ error: 'No response body' }, 502);
    }

    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
            await reader.cancel();
            return json({ error: `Response exceeded ${MAX_BYTES} bytes` }, 413);
        }
        chunks.push(value);
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    let text = '';
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();

    // Check the site's llms.txt off the resolved (post-redirect) origin.
    const llms = await summarizeLlmsTxt(resp.url);

    const headers = {
        'Content-Type': contentType,
        'X-Final-Url': resp.url,
        'X-Original-Status': String(resp.status),
        ...corsHeaders(),
    };
    if (llms) {
        headers['X-Llms-Txt-Status'] = String(llms.status);
        headers['X-Llms-Txt-Present'] = String(llms.present);
        headers['X-Llms-Txt-Bytes'] = String(llms.bytes);
        headers['X-Llms-Txt-Headings'] = String(llms.headings);
    } else {
        headers['X-Llms-Txt-Status'] = 'error';
    }

    return new Response(text, { status: 200, headers });
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const origin = request.headers.get('Origin');
        if (origin && origin !== ALLOWED_ORIGIN) {
            return json({ error: 'Forbidden origin' }, 403);
        }

        const url = new URL(request.url);
        if (url.pathname === '/proxy' && request.method === 'GET') {
            return handleProxy(request, env);
        }
        return json({ error: 'Not found' }, 404);
    },
};
