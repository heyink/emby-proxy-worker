# Domain Whitelist Design

**Goal:** Prevent the Worker from being used as an open proxy by restricting which upstream domains can be proxied.

**Architecture:** Check the parsed target domain against a configurable allowlist before forwarding any request. Support exact match and `*.domain` wildcard patterns.

---

## Configuration

Environment variable `ALLOWED_DOMAINS` set in Cloudflare Dashboard, comma-separated:

```
emby.example.com,*.example.net,emby2.example.org
```

- When unset or empty: no restriction, all domains allowed (backward compatible)
- When set: only matched domains are proxied, others get `403 Forbidden`

## Matching Rules

- **Exact match**: `emby.example.com` matches only `emby.example.com`
- **Wildcard match**: `*.example.net` matches any subdomain (`sub.example.net`, `a.b.example.net`)
- Wildcards only support leading `*.` prefix — no mid-string or trailing wildcards
- Matching is case-insensitive

## Integration Point

In `src/main.ts`, after `parseTarget` succeeds and before proxy dispatch (both HTTP and WebSocket):

1. Read `env.ALLOWED_DOMAINS`
2. If empty/undefined → allow all
3. Parse into allowlist entries (split by `,`, trim whitespace)
4. Check `target.domain` against entries
5. No match → return `403 Forbidden` with body `domain not allowed` and log `[AUTH] domain not allowed: <domain>`

## Files

- Modify `src/main.ts` — add domain check in fetch handler
- Create `src/allowlist.ts` — allowlist parsing and matching logic
- Create `src/allowlist.test.ts` — unit tests

## Testing

- Exact match: pass/fail
- Wildcard match: single subdomain, nested subdomain, no match
- Case insensitivity
- Empty/unset ALLOWED_DOMAINS → allow all
- Multiple entries in allowlist
- Whitespace handling in config string
