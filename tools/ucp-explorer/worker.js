// Cloudflare Worker: UCP Explorer Proxy
// Deploy this to your Cloudflare account and bind KV namespace UCP_EXPLORER_CONFIG
// Set a KV key "allowed_paths" with a JSON array of allowed path prefixes

const DEFAULT_ALLOWED_PATHS = [
  '/.well-known/ucp',
  '/.well-known/agent-skills/',
  '/.well-known/skills/',
  '/api/ucp/mcp',
  '/api/mcp',
  '/robots.txt',
  '/llms.txt',
  '/agents.md'
];

async function getAllowedPaths(env) {
  if (env.UCP_EXPLORER_CONFIG) {
    const stored = await env.UCP_EXPLORER_CONFIG.get('allowed_paths');
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        // Fall through to defaults
      }
    }
  }
  return DEFAULT_ALLOWED_PATHS;
}

function isPathAllowed(pathname, allowedPaths) {
  return allowedPaths.some(allowed => pathname === allowed || pathname.startsWith(allowed));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing "url" query parameter' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    // Only allow HTTPS
    if (parsed.protocol !== 'https:') {
      return new Response(JSON.stringify({ error: 'Only HTTPS URLs are allowed' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    // Check path against allowlist
    const allowedPaths = await getAllowedPaths(env);
    if (!isPathAllowed(parsed.pathname, allowedPaths)) {
      return new Response(JSON.stringify({ error: 'Path not allowed', allowed: allowedPaths }), {
        status: 403,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    // Proxy the request
    const fetchOptions = {
      method: request.method,
      headers: {
        'User-Agent': 'UCP-Explorer/1.0 (https://kylerisley.com/tools/ucp-explorer/)',
        'Accept': 'application/json, text/plain, */*'
      }
    };

    // Forward body for POST requests
    if (request.method === 'POST') {
      fetchOptions.body = await request.text();
      fetchOptions.headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(targetUrl, fetchOptions);
      const body = await response.text();

      return new Response(body, {
        status: response.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': response.headers.get('Content-Type') || 'text/plain',
          'X-Proxy-Status': response.status.toString()
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Failed to fetch target URL', details: e.message }), {
        status: 502,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }
  }
};
