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
    if (!token || !secret) return false;
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
        return data.success === true;
    } catch (e) {
        return false;
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
    const verified = await verifyTurnstile(token, ip, env.TURNSTILE_SECRET);
    if (!verified) {
        return json({ error: 'Turnstile verification failed' }, 403);
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

    return new Response(text, {
        status: 200,
        headers: {
            'Content-Type': contentType,
            'X-Final-Url': resp.url,
            'X-Original-Status': String(resp.status),
            ...corsHeaders(),
        },
    });
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
