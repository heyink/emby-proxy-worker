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
  'CF-Connecting-IP',
  'CF-IPCountry',
  'CF-Ray',
  'CF-Visitor',
  'CF-Worker',
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
    let unp = unproxyURL(origin, forwardedPrefix);
    if (unp.endsWith('/')) unp = unp.slice(0, -1);
    headers.set('Origin', unp);
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
