# Domain Whitelist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable upstream domain allowlist with wildcard support to prevent the Worker from being used as an open proxy.

**Architecture:** New `src/allowlist.ts` module with parsing and matching logic, integrated into `src/main.ts` after target parsing. Env type updated to include `ALLOWED_DOMAINS`.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers

---

### Task 1: Allowlist parsing and matching logic

**Files:**
- Create: `src/allowlist.ts`
- Create: `src/allowlist.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/allowlist.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseAllowlist, isDomainAllowed } from './allowlist';

describe('parseAllowlist', () => {
  it('returns empty array for undefined', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseAllowlist('')).toEqual([]);
  });

  it('parses single domain', () => {
    expect(parseAllowlist('emby.example.com')).toEqual(['emby.example.com']);
  });

  it('parses comma-separated domains', () => {
    expect(parseAllowlist('emby.example.com,*.example.net')).toEqual(['emby.example.com', '*.example.net']);
  });

  it('trims whitespace', () => {
    expect(parseAllowlist(' emby.example.com , *.example.net ')).toEqual(['emby.example.com', '*.example.net']);
  });

  it('ignores empty entries from trailing comma', () => {
    expect(parseAllowlist('emby.example.com,')).toEqual(['emby.example.com']);
  });
});

describe('isDomainAllowed', () => {
  it('allows all when allowlist is empty', () => {
    expect(isDomainAllowed('anything.example.com', [])).toBe(true);
  });

  it('matches exact domain', () => {
    const list = parseAllowlist('emby.example.com');
    expect(isDomainAllowed('emby.example.com', list)).toBe(true);
  });

  it('rejects non-matching domain', () => {
    const list = parseAllowlist('emby.example.com');
    expect(isDomainAllowed('other.example.com', list)).toBe(false);
  });

  it('matches wildcard subdomain', () => {
    const list = parseAllowlist('*.example.net');
    expect(isDomainAllowed('sub.example.net', list)).toBe(true);
  });

  it('matches nested wildcard subdomain', () => {
    const list = parseAllowlist('*.example.net');
    expect(isDomainAllowed('a.b.example.net', list)).toBe(true);
  });

  it('wildcard does not match bare domain', () => {
    const list = parseAllowlist('*.example.net');
    expect(isDomainAllowed('example.net', list)).toBe(false);
  });

  it('is case insensitive', () => {
    const list = parseAllowlist('Emby.Example.COM');
    expect(isDomainAllowed('emby.example.com', list)).toBe(true);
  });

  it('wildcard is case insensitive', () => {
    const list = parseAllowlist('*.Example.NET');
    expect(isDomainAllowed('SUB.EXAMPLE.NET', list)).toBe(true);
  });

  it('matches against multiple entries', () => {
    const list = parseAllowlist('emby.example.com,*.example.net');
    expect(isDomainAllowed('emby.example.com', list)).toBe(true);
    expect(isDomainAllowed('sub.example.net', list)).toBe(true);
    expect(isDomainAllowed('other.org', list)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mac/Code/emby-proxy-worker && npx vitest run src/allowlist.test.ts`
Expected: FAIL — module `./allowlist` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/allowlist.ts`:

```typescript
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function isDomainAllowed(domain: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const lower = domain.toLowerCase();
  for (const entry of allowlist) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.net"
      if (lower.endsWith(suffix) && lower.length > suffix.length) {
        return true;
      }
    } else {
      if (lower === entry) {
        return true;
      }
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mac/Code/emby-proxy-worker && npx vitest run src/allowlist.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
cd /Users/mac/Code/emby-proxy-worker
git add src/allowlist.ts src/allowlist.test.ts
git commit -m "feat: add allowlist parsing and domain matching with wildcard support"
```

---

### Task 2: Integrate allowlist check into Worker

**Files:**
- Modify: `src/types.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Update Env type to include ALLOWED_DOMAINS**

Modify `src/types.ts`:

```typescript
export interface Env {
  WEBSOCKET_PROXY: DurableObjectNamespace;
  ALLOWED_DOMAINS?: string;
}
```

- [ ] **Step 2: Add allowlist check in main.ts**

The check goes after `parseTarget` succeeds and before both WebSocket upgrade and HTTP proxy dispatch. Modify `src/main.ts`:

```typescript
import { parseTarget } from './target';
import { serveHTTPProxy } from './proxy';
import { WebSocketProxy } from './websocket';
import { parseAllowlist, isDomainAllowed } from './allowlist';
import type { Env } from './types';

export { WebSocketProxy };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // Parse target
    const result = parseTarget(url.pathname, url.search.slice(1));
    if (!result.ok) {
      return new Response(result.error, { status: 400 });
    }

    // Domain allowlist check
    const allowlist = parseAllowlist(env.ALLOWED_DOMAINS);
    if (!isDomainAllowed(result.target.domain, allowlist)) {
      console.log(`[AUTH] domain not allowed: ${result.target.domain}`);
      return new Response('domain not allowed', { status: 403 });
    }

    // WebSocket upgrade
    const upgrade = request.headers.get('Upgrade');
    const connection = request.headers.get('Connection') || '';
    const isUpgrade =
      upgrade &&
      upgrade.toLowerCase() === 'websocket' &&
      connection
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .includes('upgrade');

    if (isUpgrade) {
      const id = env.WEBSOCKET_PROXY.idFromName(crypto.randomUUID());
      const stub = env.WEBSOCKET_PROXY.get(id);
      return stub.fetch(request);
    }

    // HTTP proxy
    return serveHTTPProxy(request, result.target);
  },
};
```

- [ ] **Step 3: Run all tests to verify nothing broke**

Run: `cd /Users/mac/Code/emby-proxy-worker && npx vitest run`
Expected: ALL PASS — 76 existing + new allowlist tests

- [ ] **Step 4: Commit**

```bash
cd /Users/mac/Code/emby-proxy-worker
git add src/types.ts src/main.ts
git commit -m "feat: integrate domain allowlist check into Worker request flow"
```
