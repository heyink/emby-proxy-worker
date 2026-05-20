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
