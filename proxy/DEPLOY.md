# agent-audit-proxy — deploy guide

A hardened Cloudflare Worker that fetches HTML on behalf of the Agent Audit tool.
Defenses: Turnstile (anti-bot), strict CORS to kylerisley.com, SSRF blocklist
(private IPs / cloud metadata / localhost), 10 s timeout, 2 MB response cap,
GET-only, content-type allowlist (HTML / text / xhtml).

You need to run five things by hand. Everything else (code, config, frontend
wiring) is already in place.

## 1. Authenticate wrangler

```sh
cd proxy
npx wrangler login
```

Opens a browser, sends you to Cloudflare to authorize. One-time.

## 2. Create a Turnstile widget

In the Cloudflare dashboard → **Turnstile** → **Add site**:

- Site name: `Agent Audit`
- Hostnames: `kylerisley.com`
- Widget mode: **Invisible**

Copy the two keys it shows you:
- **Site key** — public, goes in the frontend
- **Secret key** — server-side, goes into the Worker

## 3. Wire the site key into the frontend

Open `tools/agent-audit/audit.js` and replace the placeholder on line ~5:

```js
const TURNSTILE_SITE_KEY = 'REPLACE_WITH_TURNSTILE_SITE_KEY';
```

with the site key from step 2. Commit + push.

## 4. Store the secret key in the Worker

```sh
cd proxy
npx wrangler secret put TURNSTILE_SECRET
```

It will prompt you to paste the secret key from step 2. Stored encrypted; never
appears in source.

## 5. Deploy the Worker

```sh
cd proxy
npx wrangler deploy
```

The `custom_domain = true` route in `wrangler.toml` makes Cloudflare auto-create
the DNS record for `agent-audit-proxy.kylerisley.com` and bind the Worker to it.
First deploy can take ~30 s for the certificate to provision.

Verify:

```sh
curl -i "https://agent-audit-proxy.kylerisley.com/proxy?url=https://example.com&token=x"
# Expect HTTP 403 with {"error":"Turnstile verification failed"} — proves the
# Worker is live and rejecting unverified requests.
```

## 6. (Optional but recommended) Add a WAF rate-limit rule

Dashboard → kylerisley.com zone → **Security** → **WAF** → **Rate limiting rules**
→ **Create rule**:

- Field: `URI Path` contains `/proxy`
- Hostname: `agent-audit-proxy.kylerisley.com`
- Rate: **30 requests per 1 minute** per source IP
- Action: **Block**, duration **10 min**

This catches anyone who somehow gets past Turnstile.

## After deploy

Test from the live tool at https://kylerisley.com/tools/agent-audit/ — enter any
public URL and hit Audit. Turnstile runs invisibly; if it challenges you, solve
once and the audit proceeds.

If you change the Worker code, just run `npx wrangler deploy` again. Secrets and
the custom domain persist across deploys.
