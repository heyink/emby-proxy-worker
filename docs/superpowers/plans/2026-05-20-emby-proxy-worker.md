# Emby Proxy Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Go Emby reverse proxy to a Cloudflare Pages Function with Durable Objects for WebSocket support.

**Architecture:** Pages Functions catch-all route in `functions/[[path]].ts` dispatches HTTP requests to `src/proxy.ts` and WebSocket upgrades to a Durable Object in `src/websocket.ts`. URL parsing, header cleaning, and response body rewriting are pure TypeScript modules in `src/`.

**Tech Stack:** TypeScript, Cloudflare Workers Runtime, Durable Objects, Vitest

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Dependencies and scripts |
| `tsconfig.json` | TypeScript config |
| `wrangler.toml` | Cloudflare Worker/Pages config + DO binding |
| `vitest.config.ts` | Test runner config |
| `src/types.ts` | Shared type definitions (Target, Env) |
| `src/target.ts` | URL path parsing, target URL building, baseURL inference |
| `src/target.test.ts` | Tests for target.ts |
| `src/headers.ts` | Request/response header cleaning and rewriting |
| `src/headers.test.ts` | Tests for headers.ts |
| `src/rewriter.ts` | Response body absolute URL rewriting |
| `src/rewriter.test.ts` | Tests for rewriter.ts |
| `src/proxy.ts` | HTTP reverse proxy logic |
| `src/websocket.ts` | WebSocket Durable Object |
| `functions/[[path]].ts` | Pages Functions catch-all entry point |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "emby-proxy-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler pages dev -- npx http-server public",
    "deploy": "wrangler pages deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250109.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts", "functions/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create wrangler.toml**

```toml
name = "emby-proxy-worker"
compatibility_date = "2024-12-01"

[[durable_objects.bindings]]
name = "WEBSOCKET_PROXY"
class_name = "WebSocketProxy"

[[migrations]]
tag = "v1"
new_unique_class = "WebSocketProxy"
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Install dependencies**

Run: `cd ~/Code/emby-proxy-worker && npm install`
Expected: dependencies installed, node_modules created

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold project with wrangler, vitest, typescript"
```

---

### Task 2: Types + Target Parsing

**Files:**
- Create: `src/types.ts`
- Create: `src/target.ts`
- Create: `src/target.test.ts`

- [ ] **Step 1: Write types.ts**

```typescript
export interface Target {
  scheme: string;
  domain: string;
  port: number;
  path: string;
  query: string;
}

export interface Env {
  WEBSOCKET_PROXY: DurableObjectNamespace;
}
```

- [ ] **Step 2: Write target.test.ts**

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseTarget,
  buildTargetURL,
  targetRequestPath,
  buildProxyURL,
  inferBaseURL,
  unproxyURL,
  sanitizeForwardedPrefix,
  stripForwardedPrefix,
  firstHeaderValue,
} from './target';

describe('parseTarget', () => {
  it('parses valid https path', () => {
    const result = parseTarget('/https/emby.example.com/443/web/index.html', '');
    expect(result).toEqual({
      ok: true,
      target: {
        scheme: 'https',
        domain: 'emby.example.com',
        port: 443,
        path: 'web/index.html',
        query: '',
      },
    });
  });

  it('parses valid http path with custom port', () => {
    const result = parseTarget('/http/emby.local/8096/emby/Items?api_key=xxx', 'api_key=xxx');
    expect(result).toEqual({
      ok: true,
      target: {
        scheme: 'http',
        domain: 'emby.local',
        port: 8096,
        path: 'emby/Items',
        query: 'api_key=xxx',
      },
    });
  });

  it('parses path without trailing path segments', () => {
    const result = parseTarget('/https/emby.example.com/443', '');
    expect(result).toEqual({
      ok: true,
      target: {
        scheme: 'https',
        domain: 'emby.example.com',
        port: 443,
        path: '',
        query: '',
      },
    });
  });

  it('rejects root path', () => {
    const result = parseTarget('/', '');
    expect(result).toEqual({ ok: false, error: 'usage: /{scheme}/{domain}/{port}/{path}' });
  });

  it('rejects missing port', () => {
    const result = parseTarget('/https/emby.example.com', '');
    expect(result).toEqual({ ok: false, error: 'usage: /{scheme}/{domain}/{port}/{path}' });
  });

  it('rejects invalid scheme', () => {
    const result = parseTarget('/ftp/emby.example.com/21/', '');
    expect(result).toEqual({ ok: false, error: 'scheme must be http or https, got: ftp' });
  });

  it('rejects invalid port', () => {
    const result = parseTarget('/https/emby.example.com/abc/', '');
    expect(result).toEqual({ ok: false, error: 'invalid port: abc' });
  });

  it('rejects port out of range', () => {
    const result = parseTarget('/https/emby.example.com/99999/', '');
    expect(result).toEqual({ ok: false, error: 'invalid port: 99999' });
  });

  it('preserves query string', () => {
    const result = parseTarget('/https/emby.example.com/443/search', 'q=test&page=1');
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.query).toBe('q=test&page=1');
  });

  it('normalizes scheme to lowercase', () => {
    const result = parseTarget('/HTTPS/emby.example.com/443/', '');
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.scheme).toBe('https');
  });
});

describe('buildTargetURL', () => {
  it('builds URL with custom port', () => {
    const url = buildTargetURL({ scheme: 'http', domain: 'emby.local', port: 8096, path: 'emby/Items', query: 'api_key=x' });
    expect(url).toBe('http://emby.local:8096/emby/Items?api_key=x');
  });

  it('builds URL with default port', () => {
    const url = buildTargetURL({ scheme: 'https', domain: 'emby.example.com', port: 443, path: '', query: '' });
    expect(url).toBe('https://emby.example.com:443/');
  });
});

describe('targetRequestPath', () => {
  it('returns / for empty path', () => {
    expect(targetRequestPath({ scheme: 'https', domain: 'a.com', port: 443, path: '', query: '' })).toBe('/');
  });

  it('prepends / for non-empty path', () => {
    expect(targetRequestPath({ scheme: 'https', domain: 'a.com', port: 443, path: 'web/index.html', query: '' })).toBe('/web/index.html');
  });
});

describe('buildProxyURL', () => {
  it('builds proxy URL with path', () => {
    const url = buildProxyURL(
      'https://proxy.example.com',
      { scheme: 'https', domain: 'emby.example.com', port: 443, path: '', query: '' },
      '/web/index.html',
    );
    expect(url).toBe('https://proxy.example.com/https/emby.example.com/443/web/index.html');
  });
});

describe('inferBaseURL', () => {
  it('uses X-Forwarded-Proto and X-Forwarded-Host', () => {
    const req = new Request('http://localhost/', {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'proxy.example.com',
      },
    });
    expect(inferBaseURL(req)).toBe('https://proxy.example.com');
  });

  it('falls back to Host header', () => {
    const req = new Request('http://localhost/', {
      headers: { Host: 'fallback.example.com' },
    });
    expect(inferBaseURL(req)).toBe('http://fallback.example.com');
  });

  it('includes X-Forwarded-Prefix', () => {
    const req = new Request('http://localhost/', {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'proxy.example.com',
        'X-Forwarded-Prefix': '/custom',
      },
    });
    expect(inferBaseURL(req)).toBe('https://proxy.example.com/custom');
  });
});

describe('unproxyURL', () => {
  it('converts proxy URL back to original', () => {
    const url = unproxyURL('https://proxy.example.com/https/emby.example.com/443/web/index.html', '');
    expect(url).toBe('https://emby.example.com/web/index.html');
  });

  it('converts proxy URL with custom port', () => {
    const url = unproxyURL('https://proxy.example.com/http/emby.local/8096/emby/Items?api_key=x', '');
    expect(url).toBe('http://emby.local:8096/emby/Items?api_key=x');
  });

  it('returns raw URL if not a proxy URL', () => {
    const url = unproxyURL('https://random.example.com/path', '');
    expect(url).toBe('https://random.example.com/path');
  });
});

describe('sanitizeForwardedPrefix', () => {
  it('returns empty for empty string', () => {
    expect(sanitizeForwardedPrefix('')).toBe('');
  });
  it('returns empty for bare slash', () => {
    expect(sanitizeForwardedPrefix('/')).toBe('');
  });
  it('returns prefixed path for valid prefix', () => {
    expect(sanitizeForwardedPrefix('/custom')).toBe('/custom');
  });
  it('trims trailing slashes', () => {
    expect(sanitizeForwardedPrefix('/custom/')).toBe('/custom');
  });
  it('prepends slash if missing', () => {
    expect(sanitizeForwardedPrefix('custom')).toBe('/custom');
  });
});

describe('firstHeaderValue', () => {
  it('returns first value before comma', () => {
    expect(firstHeaderValue('https, http')).toBe('https');
  });
  it('returns empty for empty string', () => {
    expect(firstHeaderValue('')).toBe('');
  });
});

describe('stripForwardedPrefix', () => {
  it('strips prefix from path', () => {
    expect(stripForwardedPrefix('/custom/https/a.com/443/', '/custom')).toBe('/https/a.com/443/');
  });
  it('returns unchanged path if prefix does not match', () => {
    expect(stripForwardedPrefix('/other/path', '/custom')).toBe('/other/path');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/Code/emby-proxy-worker && npx vitest run src/target.test.ts`
Expected: FAIL — module `./target` not found

- [ ] **Step 4: Write target.ts implementation**

```typescript
import type { Target } from './types';

export type ParseResult = { ok: true; target: Target } | { ok: false; error: string };

export function parseTarget(pathname: string, query: string): ParseResult {
  const trimmed = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (!trimmed) {
    return { ok: false, error: 'usage: /{scheme}/{domain}/{port}/{path}' };
  }
  const parts = trimmed.split('/');
  if (parts.length < 3) {
    return { ok: false, error: 'usage: /{scheme}/{domain}/{port}/{path}' };
  }
  const scheme = parts[0].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, error: `scheme must be http or https, got: ${scheme}` };
  }
  const domain = parts[1];
  if (!domain) {
    return { ok: false, error: 'domain is required' };
  }
  const port = parseInt(parts[2], 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    return { ok: false, error: `invalid port: ${parts[2]}` };
  }
  const remaining = parts.length >= 4 ? parts.slice(3).join('/') : '';
  return { ok: true, target: { scheme, domain, port, path: remaining, query } };
}

export function targetRequestPath(target: Target): string {
  return target.path ? '/' + target.path : '/';
}

export function buildTargetURL(target: Target): string {
  const host = target.domain;
  let url = `${target.scheme}://${host}:${target.port}${targetRequestPath(target)}`;
  if (target.query) {
    url += '?' + target.query;
  }
  return url;
}

export function isDefaultPort(scheme: string, port: number): boolean {
  return (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
}

export function buildProxyURL(baseURL: string, target: Target, path: string): string {
  const p = path === '' || path.startsWith('/') ? path : '/' + path;
  return `${baseURL}/${target.scheme}/${target.domain}/${target.port}${p}`;
}

export function inferBaseURL(request: Request): string {
  const proto = firstHeaderValue(request.headers.get('X-Forwarded-Proto') || '');
  const scheme = proto === 'http' || proto === 'https' ? proto : 'http';
  let host = firstHeaderValue(request.headers.get('X-Forwarded-Host') || '');
  if (!host || /[/\\\s\r\n]/.test(host)) {
    host = request.headers.get('Host') || '';
  }
  const prefix = sanitizeForwardedPrefix(request.headers.get('X-Forwarded-Prefix') || '');
  return prefix ? `${scheme}://${host}${prefix}` : `${scheme}://${host}`;
}

export function sanitizeForwardedPrefix(raw: string): string {
  const commaIdx = raw.indexOf(',');
  let prefix = (commaIdx >= 0 ? raw.slice(0, commaIdx) : raw).trim();
  if (!prefix || prefix === '/') return '';
  if (!prefix.startsWith('/')) prefix = '/' + prefix;
  prefix = prefix.replace(/\/+$/, '');
  if (!prefix || prefix === '/') return '';
  if (/[\\?#/\x00-\x20\x7f]/.test(prefix.slice(1))) return '';
  return prefix;
}

export function unproxyURL(raw: string, forwardedPrefix: string): string {
  try {
    const url = new URL(raw);
    const pathToParse = stripForwardedPrefix(url.pathname, forwardedPrefix);
    const result = parseTarget(pathToParse, url.search.slice(1));
    if (!result.ok) return raw;
    const t = result.target;
    const portStr = isDefaultPort(t.scheme, t.port) ? '' : `:${t.port}`;
    return `${t.scheme}://${t.domain}${portStr}${targetRequestPath(t)}${t.query ? '?' + t.query : ''}`;
  } catch {
    return raw;
  }
}

export function stripForwardedPrefix(path: string, forwardedPrefix: string): string {
  const prefix = sanitizeForwardedPrefix(forwardedPrefix);
  if (!prefix) return path;
  if (path === prefix) return '/';
  if (!path.startsWith(prefix + '/')) return path;
  const trimmed = path.slice(prefix.length);
  return trimmed || '/';
}

export function firstHeaderValue(raw: string): string {
  if (!raw) return '';
  const idx = raw.indexOf(',');
  const val = idx >= 0 ? raw.slice(0, idx) : raw;
  return val.trim().toLowerCase();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Code/emby-proxy-worker && npx vitest run src/target.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/target.ts src/target.test.ts
git commit -m "feat: add target URL parsing with tests"
```

---

### Task 3: URL Rewriting

**Files:**
- Create: `src/rewriter.ts`
- Create: `src/rewriter.test.ts`

- [ ] **Step 1: Write rewriter.test.ts**

```typescript
import { describe, it, expect } from 'vitest';
import {
  shouldRewriteEmbyPath,
  shouldRewriteBody,
  shouldRewriteEmbyResponse,
  rewriteBody,
  rewriteSingleURL,
  isURLTerminator,
} from './rewriter';
import type { Target } from './types';

function t(path: string): Target {
  return { scheme: 'https', domain: 'emby.example.com', port: 443, path, query: '' };
}

describe('shouldRewriteEmbyPath', () => {
  it('matches PlaybackInfo', () => {
    expect(shouldRewriteEmbyPath(t('Items/123/PlaybackInfo'))).toBe(true);
  });
  it('matches /emby/ prefix PlaybackInfo', () => {
    expect(shouldRewriteEmbyPath(t('emby/Items/123/PlaybackInfo'))).toBe(true);
  });
  it('matches Sessions/Playing/Progress', () => {
    expect(shouldRewriteEmbyPath(t('emby/Sessions/Playing/Progress'))).toBe(true);
  });
  it('matches Sessions/Playing/Progress without emby prefix', () => {
    expect(shouldRewriteEmbyPath(t('Sessions/Playing/Progress'))).toBe(true);
  });
  it('does not match Items list', () => {
    expect(shouldRewriteEmbyPath(t('Items'))).toBe(false);
  });
  it('does not match web path', () => {
    expect(shouldRewriteEmbyPath(t('web/index.html'))).toBe(false);
  });
  it('does not match Sessions/Playing (not Progress)', () => {
    expect(shouldRewriteEmbyPath(t('Sessions/Playing'))).toBe(false);
  });
  it('is case insensitive', () => {
    expect(shouldRewriteEmbyPath(t('EMBY/Items/123/PlaybackInfo'))).toBe(true);
  });
});

describe('shouldRewriteBody', () => {
  it('accepts application/json', () => {
    expect(shouldRewriteBody('application/json')).toBe(true);
  });
  it('accepts application/json with charset', () => {
    expect(shouldRewriteBody('application/json; charset=utf-8')).toBe(true);
  });
  it('accepts text/html', () => {
    expect(shouldRewriteBody('text/html')).toBe(true);
  });
  it('accepts application/javascript', () => {
    expect(shouldRewriteBody('application/javascript')).toBe(true);
  });
  it('rejects image/png', () => {
    expect(shouldRewriteBody('image/png')).toBe(false);
  });
  it('rejects application/octet-stream', () => {
    expect(shouldRewriteBody('application/octet-stream')).toBe(false);
  });
});

describe('shouldRewriteEmbyResponse', () => {
  it('matches PlaybackInfo json', () => {
    expect(shouldRewriteEmbyResponse(t('Items/123/PlaybackInfo'), 'application/json')).toBe(true);
  });
  it('does not match PlaybackInfo with binary content', () => {
    expect(shouldRewriteEmbyResponse(t('Items/123/PlaybackInfo'), 'video/mp4')).toBe(false);
  });
  it('does not match random path', () => {
    expect(shouldRewriteEmbyResponse(t('Users/AuthenticateByName'), 'application/json')).toBe(false);
  });
});

describe('rewriteSingleURL', () => {
  const base = 'https://proxy.example.com';

  it('rewrites https URL', () => {
    expect(rewriteSingleURL('https://emby.example.com/web/index.html?x=1', base))
      .toBe('https://proxy.example.com/https/emby.example.com/443/web/index.html?x=1');
  });

  it('rewrites http URL with custom port', () => {
    expect(rewriteSingleURL('http://emby.local:8096/Items', base))
      .toBe('https://proxy.example.com/http/emby.local/8096/Items');
  });

  it('rewrites third-party CDN URL', () => {
    expect(rewriteSingleURL('https://cdn.example.com/video.mp4', base))
      .toBe('https://proxy.example.com/https/cdn.example.com/443/video.mp4');
  });

  it('leaves relative URL untouched', () => {
    expect(rewriteSingleURL('/Items/1', base)).toBe('/Items/1');
  });

  it('leaves non-http URL untouched', () => {
    expect(rewriteSingleURL('javascript:void(0)', base)).toBe('javascript:void(0)');
  });

  it('handles URL without path', () => {
    expect(rewriteSingleURL('https://example.com', base))
      .toBe('https://proxy.example.com/https/example.com/443/');
  });

  it('handles URL with query only', () => {
    expect(rewriteSingleURL('https://example.com?api_key=1', base))
      .toBe('https://proxy.example.com/https/example.com/443/?api_key=1');
  });
});

describe('rewriteBody', () => {
  const base = 'https://proxy.example.com';

  it('rewrites JSON body with absolute URLs', () => {
    const body = '{"api":"https://emby.example.com/Items/1","fallback":"http://cdn.example.com:8096/video.mp4","relative":"/Items/2"}';
    const want = '{"api":"https://proxy.example.com/https/emby.example.com/443/Items/1","fallback":"https://proxy.example.com/http/cdn.example.com/8096/video.mp4","relative":"/Items/2"}';
    expect(rewriteBody(body, base)).toBe(want);
  });

  it('rewrites Emby PlaybackInfo MediaSources', () => {
    const body = '{"MediaSources":[{"Id":"ms1","Path":"https://stream-cdn.example.com/videos/123/master.m3u8?MediaSourceId=ms1","TranscodingUrl":"http://transcode-node.example.com:8096/Videos/123/master.m3u8?DeviceId=device-1"}]}';
    const result = rewriteBody(body, base);
    expect(result).toContain('https://proxy.example.com/https/stream-cdn.example.com/443/videos/123/master.m3u8?MediaSourceId=ms1');
    expect(result).toContain('https://proxy.example.com/http/transcode-node.example.com/8096/Videos/123/master.m3u8?DeviceId=device-1');
  });

  it('returns unchanged body without URLs', () => {
    const body = '{"relative":"/Items/2"}';
    expect(rewriteBody(body, base)).toBe(body);
  });

  it('handles multiple URLs from different hosts', () => {
    const body = 'https://a.example.com/x https://b.example.com/y';
    const want = 'https://proxy.example.com/https/a.example.com/443/x https://proxy.example.com/https/b.example.com/443/y';
    expect(rewriteBody(body, base)).toBe(want);
  });

  it('preserves text before and after URL', () => {
    const body = 'prefix https://example.com/a suffix';
    const want = 'prefix https://proxy.example.com/https/example.com/443/a suffix';
    expect(rewriteBody(body, base)).toBe(want);
  });

  it('respects JSON string terminators', () => {
    const body = '{"url":"https://example.com/a"}';
    const want = '{"url":"https://proxy.example.com/https/example.com/443/a"}';
    expect(rewriteBody(body, base)).toBe(want);
  });

  it('returns empty string unchanged', () => {
    expect(rewriteBody('', base)).toBe('');
  });

  it('handles baseURL with forwarded prefix', () => {
    const body = '{"url":"https://example.com/a"}';
    const prefixedBase = 'https://proxy.example.com/custom-prefix';
    const want = '{"url":"https://proxy.example.com/custom-prefix/https/example.com/443/a"}';
    expect(rewriteBody(body, prefixedBase)).toBe(want);
  });
});

describe('isURLTerminator', () => {
  it('terminates on double quote', () => {
    expect(isURLTerminator('"')).toBe(true);
  });
  it('terminates on space', () => {
    expect(isURLTerminator(' ')).toBe(true);
  });
  it('terminates on angle bracket', () => {
    expect(isURLTerminator('<')).toBe(true);
  });
  it('does not terminate on letter', () => {
    expect(isURLTerminator('a')).toBe(false);
  });
  it('does not terminate on slash', () => {
    expect(isURLTerminator('/')).toBe(false);
  });
  it('does not terminate on question mark', () => {
    expect(isURLTerminator('?')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Code/emby-proxy-worker && npx vitest run src/rewriter.test.ts`
Expected: FAIL — module `./rewriter` not found

- [ ] **Step 3: Write rewriter.ts implementation**

```typescript
import type { Target } from './types';
import { targetRequestPath } from './target';

const REWRITABLE_TYPES = [
  'application/json',
  'text/html',
  'text/xml',
  'text/plain',
  'application/xml',
  'application/xhtml',
  'text/javascript',
  'application/javascript',
];

export function shouldRewriteEmbyPath(target: Target): boolean {
  const path = targetRequestPath(target).toLowerCase();
  return (
    ((path.startsWith('/emby/items/') || path.startsWith('/items/')) && path.endsWith('/playbackinfo')) ||
    path === '/emby/sessions/playing/progress' ||
    path === '/sessions/playing/progress'
  );
}

export function shouldRewriteBody(contentType: string): boolean {
  const idx = contentType.indexOf(';');
  let mediaType = (idx >= 0 ? contentType.slice(0, idx) : contentType).trim().toLowerCase();
  return REWRITABLE_TYPES.includes(mediaType);
}

export function shouldRewriteEmbyResponse(target: Target, contentType: string): boolean {
  return shouldRewriteBody(contentType) && shouldRewriteEmbyPath(target);
}

export function isURLTerminator(c: string): boolean {
  return '"\'<> \t\n\r`(){}[]\\|^'.includes(c);
}

export function rewriteBody(body: string, baseURL: string): string {
  if (!body.includes('http')) return body;

  let out = '';
  let i = 0;
  while (i < body.length) {
    const remaining = body.slice(i);
    const httpPos = remaining.indexOf('http://');
    const httpsPos = remaining.indexOf('https://');

    let pos = -1;
    let schemeLen = 0;
    if (httpPos >= 0 && (httpsPos < 0 || httpPos <= httpsPos)) {
      if (httpsPos >= 0 && httpsPos === httpPos) {
        pos = httpsPos;
        schemeLen = 8;
      } else {
        pos = httpPos;
        schemeLen = 7;
      }
    } else if (httpsPos >= 0) {
      pos = httpsPos;
      schemeLen = 8;
    }

    if (pos < 0) {
      out += remaining;
      break;
    }

    out += remaining.slice(0, pos);

    const urlStart = i + pos;
    let urlEnd = urlStart + schemeLen;
    while (urlEnd < body.length && !isURLTerminator(body[urlEnd])) {
      urlEnd++;
    }

    const raw = body.slice(urlStart, urlEnd);
    out += rewriteURLFast(raw, schemeLen, baseURL);
    i = urlEnd;
  }

  return out;
}

export function rewriteSingleURL(rawURL: string, baseURL: string): string {
  let schemeLen = 0;
  if (rawURL.startsWith('https://')) {
    schemeLen = 8;
  } else if (rawURL.startsWith('http://')) {
    schemeLen = 7;
  } else {
    return rawURL;
  }
  return rewriteURLFast(rawURL, schemeLen, baseURL);
}

function rewriteURLFast(raw: string, schemeLen: number, baseURL: string): string {
  const afterScheme = raw.slice(schemeLen);
  let pathIdx = afterScheme.length;
  const slashIdx = afterScheme.indexOf('/');
  if (slashIdx >= 0 && slashIdx < pathIdx) pathIdx = slashIdx;
  const queryIdx = afterScheme.indexOf('?');
  if (queryIdx >= 0 && queryIdx < pathIdx) pathIdx = queryIdx;
  const fragmentIdx = afterScheme.indexOf('#');
  if (fragmentIdx >= 0 && fragmentIdx < pathIdx) pathIdx = fragmentIdx;

  let hostPort: string;
  let pathAndQuery: string;
  if (pathIdx < afterScheme.length) {
    hostPort = afterScheme.slice(0, pathIdx);
    pathAndQuery = afterScheme.slice(pathIdx);
    if (pathAndQuery[0] === '?' || pathAndQuery[0] === '#') {
      pathAndQuery = '/' + pathAndQuery;
    }
  } else {
    hostPort = afterScheme;
    pathAndQuery = '/';
  }

  if (!hostPort) return raw;

  let host: string;
  let portStr: string;
  if (hostPort[0] === '[') {
    const bracketEnd = hostPort.indexOf(']');
    if (bracketEnd < 0) return raw;
    host = hostPort.slice(1, bracketEnd);
    const rest = hostPort.slice(bracketEnd + 1);
    portStr = rest.startsWith(':') ? rest.slice(1) : '';
  } else {
    const colonIdx = hostPort.lastIndexOf(':');
    if (colonIdx >= 0) {
      host = hostPort.slice(0, colonIdx);
      portStr = hostPort.slice(colonIdx + 1);
    } else {
      host = hostPort;
      portStr = '';
    }
  }

  if (!host) return raw;

  const scheme = schemeLen === 8 ? 'https' : 'http';
  let port = scheme === 'https' ? 443 : 80;
  if (portStr) {
    const p = parseInt(portStr, 10);
    if (!isNaN(p) && p > 0 && p <= 65535) port = p;
  }

  return `${baseURL}/${scheme}/${host}/${port}${pathAndQuery}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Code/emby-proxy-worker && npx vitest run src/rewriter.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/rewriter.ts src/rewriter.test.ts
git commit -m "feat: add response body URL rewriting with tests"
```

---

### Task 4: Header Processing

**Files:**
- Create: `src/headers.ts`
- Create: `src/headers.test.ts`

- [ ] **Step 1: Write headers.test.ts**

```typescript
import { describe, it, expect } from 'vitest';
import {
  rewriteProxySensitiveRequestHeaders,
  rewriteResponseHeaders,
  copyResponseHeaders,
} from './headers';
import type { Target } from './types';

describe('rewriteProxySensitiveRequestHeaders', () => {
  it('removes X-Forwarded-* headers', () => {
    const headers = new Headers({
      'X-Real-Ip': '1.2.3.4',
      'X-Forwarded-For': '1.2.3.4',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'proxy.example.com',
      'X-Forwarded-Port': '443',
      'X-Forwarded-Prefix': '/custom',
      'Forwarded': 'for=1.2.3.4',
      'Via': '1.1 proxy',
      'Accept': 'application/json',
    });
    rewriteProxySensitiveRequestHeaders(headers, '');
    expect(headers.get('X-Real-Ip')).toBeNull();
    expect(headers.get('X-Forwarded-For')).toBeNull();
    expect(headers.get('X-Forwarded-Proto')).toBeNull();
    expect(headers.get('X-Forwarded-Host')).toBeNull();
    expect(headers.get('X-Forwarded-Port')).toBeNull();
    expect(headers.get('X-Forwarded-Prefix')).toBeNull();
    expect(headers.get('Forwarded')).toBeNull();
    expect(headers.get('Via')).toBeNull();
    expect(headers.get('Accept')).toBe('application/json');
  });

  it('rewrites Referer from proxy format to original', () => {
    const headers = new Headers({
      'Referer': 'https://proxy.example.com/https/emby.example.com/443/web/index.html',
    });
    rewriteProxySensitiveRequestHeaders(headers, '');
    expect(headers.get('Referer')).toBe('https://emby.example.com/web/index.html');
  });

  it('rewrites Origin from proxy format to original', () => {
    const headers = new Headers({
      'Origin': 'https://proxy.example.com/http/emby.local/8096',
    });
    rewriteProxySensitiveRequestHeaders(headers, '');
    expect(headers.get('Origin')).toBe('http://emby.local:8096');
  });
});

describe('rewriteResponseHeaders', () => {
  const target: Target = { scheme: 'https', domain: 'emby.example.com', port: 443, path: '', query: '' };
  const baseURL = 'https://proxy.example.com';

  it('rewrites Location with absolute URL', () => {
    const headers = new Headers({
      'Location': 'https://emby.example.com/web/index.html',
    });
    rewriteResponseHeaders(headers, target, baseURL);
    expect(headers.get('Location')).toBe('https://proxy.example.com/https/emby.example.com/443/web/index.html');
  });

  it('rewrites Content-Location with absolute URL', () => {
    const headers = new Headers({
      'Content-Location': 'http://emby.local:8096/Items',
    });
    rewriteResponseHeaders(headers, target, baseURL);
    expect(headers.get('Content-Location')).toBe('https://proxy.example.com/http/emby.local/8096/Items');
  });

  it('rewrites Location with relative path to proxy URL', () => {
    const headers = new Headers({
      'Location': '/web/index.html',
    });
    rewriteResponseHeaders(headers, target, baseURL);
    expect(headers.get('Location')).toBe('https://proxy.example.com/https/emby.example.com/443/web/index.html');
  });

  it('leaves protocol-relative URLs unchanged', () => {
    const headers = new Headers({
      'Location': '//emby.example.com/path',
    });
    rewriteResponseHeaders(headers, target, baseURL);
    expect(headers.get('Location')).toBe('//emby.example.com/path');
  });
});

describe('copyResponseHeaders', () => {
  it('copies headers and strips Server and X-Powered-By', () => {
    const src = new Headers({
      'Content-Type': 'text/html',
      'Server': 'Emby',
      'X-Powered-By': 'Express',
      'X-Custom': 'value',
    });
    const dst = new Headers();
    copyResponseHeaders(dst, src);
    expect(dst.get('Content-Type')).toBe('text/html');
    expect(dst.get('X-Custom')).toBe('value');
    expect(dst.get('Server')).toBeNull();
    expect(dst.get('X-Powered-By')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Code/emby-proxy-worker && npx vitest run src/headers.test.ts`
Expected: FAIL — module `./headers` not found

- [ ] **Step 3: Write headers.ts implementation**

```typescript
import type { Target } from './types';
import { buildProxyURL, unproxyURL } from './target';
import { rewriteSingleURL } from './rewriter';

const STRIP_REQUEST_HEADERS = [
  'X-Real-Ip',
  'X-Forwarded-For',
  'X-Forwarded-Proto',
  'X-Forwarded-Host',
  'X-Forwarded-Port',
  'X-Forwarded-Prefix',
  'Forwarded',
  'Via',
];

const STRIP_RESPONSE_HEADERS = ['Server', 'X-Powered-By'];

export function rewriteProxySensitiveRequestHeaders(headers: Headers, forwardedPrefix: string): void {
  for (const name of STRIP_REQUEST_HEADERS) {
    headers.delete(name);
  }
  const ref = headers.get('Referer');
  if (ref) {
    headers.set('Referer', unproxyURL(ref, forwardedPrefix));
  }
  const origin = headers.get('Origin');
  if (origin) {
    headers.set('Origin', unproxyURL(origin, forwardedPrefix));
  }
}

export function rewriteResponseHeaders(headers: Headers, target: Target, baseURL: string): void {
  const loc = headers.get('Location');
  if (loc) {
    headers.set('Location', rewriteHeaderURL(loc, target, baseURL));
  }
  const cl = headers.get('Content-Location');
  if (cl) {
    headers.set('Content-Location', rewriteHeaderURL(cl, target, baseURL));
  }
}

function rewriteHeaderURL(rawURL: string, target: Target, baseURL: string): string {
  if (rawURL.startsWith('https://') || rawURL.startsWith('http://')) {
    return rewriteSingleURL(rawURL, baseURL);
  }
  if (rawURL.startsWith('//')) return rawURL;
  if (rawURL.startsWith('/')) {
    return buildProxyURL(baseURL, target, rawURL);
  }
  return rawURL;
}

export function copyResponseHeaders(dst: Headers, src: Headers): void {
  src.forEach((value, key) => {
    dst.set(key, value);
  });
  for (const name of STRIP_RESPONSE_HEADERS) {
    dst.delete(name);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Code/emby-proxy-worker && npx vitest run src/headers.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run all tests together**

Run: `cd ~/Code/emby-proxy-worker && npx vitest run`
Expected: ALL PASS across all test files

- [ ] **Step 6: Commit**

```bash
git add src/headers.ts src/headers.test.ts
git commit -m "feat: add request/response header processing with tests"
```

---

### Task 5: HTTP Proxy

**Files:**
- Create: `src/proxy.ts`

- [ ] **Step 1: Write proxy.ts**

```typescript
import type { Target } from './types';
import { parseTarget, buildTargetURL, inferBaseURL, targetRequestPath } from './target';
import { rewriteProxySensitiveRequestHeaders, rewriteResponseHeaders, copyResponseHeaders } from './headers';
import { shouldRewriteEmbyPath, shouldRewriteEmbyResponse, rewriteBody } from './rewriter';

export async function serveHTTPProxy(request: Request, target: Target): Promise<Response> {
  const baseURL = inferBaseURL(request);
  const targetURL = buildTargetURL(target);

  const outgoing = new Request(targetURL, {
    method: request.method,
    body: request.body,
    redirect: 'manual',
  });

  // Copy request headers
  request.headers.forEach((value, key) => {
    outgoing.headers.set(key, value);
  });
  outgoing.headers.set('Host', `${target.domain}:${target.port}`);

  const forwardedPrefix = request.headers.get('X-Forwarded-Prefix') || '';
  rewriteProxySensitiveRequestHeaders(outgoing.headers, forwardedPrefix);

  // Force identity encoding for rewrite paths so we get plaintext
  if (shouldRewriteEmbyPath(target)) {
    outgoing.headers.set('Accept-Encoding', 'identity');
  }

  const resp = await fetch(outgoing);

  const respHeaders = new Headers();
  copyResponseHeaders(respHeaders, resp.headers);
  rewriteResponseHeaders(respHeaders, target, baseURL);

  const contentType = resp.headers.get('Content-Type') || '';
  const contentEncoding = (resp.headers.get('Content-Encoding') || '').trim().toLowerCase();
  const safeEncoding = !contentEncoding || contentEncoding === 'identity';

  if (
    shouldRewriteEmbyResponse(target, contentType) &&
    safeEncoding &&
    responseAllowsBody(request.method, resp.status)
  ) {
    const body = await resp.text();
    const rewritten = rewriteBody(body, baseURL);
    return new Response(rewritten, {
      status: resp.status,
      headers: respHeaders,
    });
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: respHeaders,
  });
}

function responseAllowsBody(method: string, statusCode: number): boolean {
  if (method === 'HEAD') return false;
  if (statusCode >= 100 && statusCode < 200) return false;
  return statusCode !== 204 && statusCode !== 304;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd ~/Code/emby-proxy-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: add HTTP reverse proxy logic"
```

---

### Task 6: WebSocket Durable Object

**Files:**
- Create: `src/websocket.ts`

- [ ] **Step 1: Write websocket.ts**

```typescript
import type { Env } from './types';
import { parseTarget, buildTargetURL } from './target';
import { rewriteProxySensitiveRequestHeaders } from './headers';

export class WebSocketProxy extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const result = parseTarget(url.pathname, url.search.slice(1));
    if (!result.ok) {
      return new Response(result.error, { status: 400 });
    }
    const target = result.target;

    // Accept the client WebSocket
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }

    const clientPair = new WebSocketPair();
    const [client, server] = [clientPair[0], clientPair[1]];
    this.ctx.acceptWebSocket(server);

    // Connect to upstream
    const targetURL = buildTargetURL(target);
    const upstreamHeaders = new Headers();
    request.headers.forEach((value, key) => {
      upstreamHeaders.set(key, value);
    });
    upstreamHeaders.set('Host', `${target.domain}:${target.port}`);
    upstreamHeaders.set('Upgrade', 'websocket');
    upstreamHeaders.set('Connection', 'Upgrade');

    const forwardedPrefix = request.headers.get('X-Forwarded-Prefix') || '';
    rewriteProxySensitiveRequestHeaders(upstreamHeaders, forwardedPrefix);

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(targetURL, {
        headers: upstreamHeaders,
      });
    } catch (err) {
      server.close(1011, 'upstream connection failed');
      return new Response(null, { status: 101, webSocket: client });
    }

    const upstreamWS = upstreamResp.webSocket;
    if (!upstreamWS) {
      server.close(1011, 'upstream did not upgrade to websocket');
      return new Response(null, { status: 101, webSocket: client });
    }
    upstreamWS.accept();

    // Forward: client → upstream
    server.addEventListener('message', (event) => {
      try {
        upstreamWS.send(event.data as string | ArrayBufferLike);
      } catch {
        upstreamWS.close(1011, 'send failed');
      }
    });

    // Forward: upstream → client
    upstreamWS.addEventListener('message', (event) => {
      try {
        server.send(event.data as string | ArrayBufferLike);
      } catch {
        server.close(1011, 'send failed');
      }
    });

    // Close propagation
    server.addEventListener('close', (event) => {
      try { upstreamWS.close(event.code, event.reason); } catch {}
    });
    upstreamWS.addEventListener('close', (event) => {
      try { server.close(event.code, event.reason); } catch {}
    });

    server.addEventListener('error', () => {
      try { upstreamWS.close(1011, 'client error'); } catch {}
    });
    upstreamWS.addEventListener('error', () => {
      try { server.close(1011, 'upstream error'); } catch {}
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd ~/Code/emby-proxy-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/websocket.ts
git commit -m "feat: add WebSocket Durable Object for bidirectional proxying"
```

---

### Task 7: Entry Point

**Files:**
- Create: `functions/[[path]].ts`

- [ ] **Step 1: Write functions/[[path]].ts**

```typescript
import { parseTarget } from '../src/target';
import { serveHTTPProxy } from '../src/proxy';
import { WebSocketProxy } from '../src/websocket';
import type { Env } from '../src/types';

export { WebSocketProxy };

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
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

  // WebSocket upgrade
  const upgrade = request.headers.get('Upgrade');
  const connection = request.headers.get('Connection') || '';
  const isUpgrade = upgrade && upgrade.toLowerCase() === 'websocket' &&
    connection.toLowerCase().split(',').map(s => s.trim()).includes('upgrade');

  if (isUpgrade) {
    const id = env.WEBSOCKET_PROXY.idFromName(crypto.randomUUID());
    const stub = env.WEBSOCKET_PROXY.get(id);
    return stub.fetch(request);
  }

  // HTTP proxy
  return serveHTTPProxy(request, result.target);
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd ~/Code/emby-proxy-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add functions/
git commit -m "feat: add Pages Functions entry point with health check and routing"
```

---

### Task 8: Smoke Test with wrangler dev

- [ ] **Step 1: Start local dev server**

Run: `cd ~/Code/emby-proxy-worker && npx wrangler pages dev -- npx http-server public`
Expected: Server starts on localhost:8788

- [ ] **Step 2: Test health check**

Run: `curl -i http://localhost:8788/health`
Expected: `200 OK`, body `ok`

- [ ] **Step 3: Test root path rejection**

Run: `curl -i http://localhost:8788/`
Expected: `400 Bad Request`, body contains usage message

- [ ] **Step 4: Test invalid scheme**

Run: `curl -i http://localhost:8788/ftp/example.com/21/`
Expected: `400 Bad Request`, body contains "scheme must be http or https"

- [ ] **Step 5: Test proxy to external HTTP endpoint**

Run: `curl -i http://localhost:8788/https/httpbin.org/443/get`
Expected: `200 OK` with JSON response from httpbin.org

- [ ] **Step 6: Test header stripping**

Run: `curl -i -H "X-Forwarded-For: 1.2.3.4" -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: proxy.example.com" http://localhost:8788/https/httpbin.org/443/headers`
Expected: JSON response should NOT contain `X-Forwarded-For` in the echoed headers

- [ ] **Step 7: Run all unit tests**

Run: `cd ~/Code/emby-proxy-worker && npx vitest run`
Expected: ALL PASS

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "test: verify smoke tests pass"
```
