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
