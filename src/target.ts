import type { Target } from './types';

export type ParseResult = { ok: true; target: Target } | { ok: false; error: string };

export function parseTarget(pathname: string, query: string): ParseResult {
  const withoutQuery = pathname.split('?')[0];
  const trimmed = withoutQuery.startsWith('/') ? withoutQuery.slice(1) : withoutQuery;
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
