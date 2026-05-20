import type { Target } from './types';
import { buildTargetURL, inferBaseURL, targetRequestPath } from './target';
import { rewriteProxySensitiveRequestHeaders, rewriteResponseHeaders, copyResponseHeaders } from './headers';
import { shouldRewriteEmbyPath, shouldRewriteEmbyResponse, rewriteBody } from './rewriter';

export async function serveHTTPProxy(request: Request, target: Target): Promise<Response> {
  const start = Date.now();
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
  const isRewritePath = shouldRewriteEmbyPath(target);
  if (isRewritePath) {
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
    const elapsed = Date.now() - start;
    console.log(`[API] ${resp.status} ${request.method} ${target.domain}${targetRequestPath(target)} | rewritten | ${elapsed}ms`);
    return new Response(rewritten, {
      status: resp.status,
      headers: respHeaders,
    });
  }

  const elapsed = Date.now() - start;
  const isMedia = looksLikeMedia(target.path);
  const tag = isMedia ? 'STREAM' : 'PROXY';
  console.log(`[${tag}] ${resp.status} ${request.method} ${target.domain}${targetRequestPath(target)} | ${elapsed}ms`);

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

var mediaExtensions: Record<string, boolean> = {
  mp4: true, mkv: true, avi: true, ts: true, m3u8: true,
  mp3: true, flac: true, aac: true, ogg: true, wav: true,
  jpg: true, jpeg: true, png: true, gif: true, webp: true, ico: true,
  bmp: true, tiff: true, svg: true,
  woff: true, woff2: true, ttf: true, eot: true,
  zip: true, gz: true, br: true, zst: true,
  m4v: true, m4a: true, webm: true, mov: true, wmv: true,
  srt: true, ass: true, ssa: true, vtt: true, sub: true,
};

function looksLikeMedia(path: string): boolean {
  const lower = path.toLowerCase();
  if (
    lower.includes('/videos/') ||
    lower.includes('/audio/') ||
    lower.includes('/images/') ||
    lower.includes('/items/images') ||
    lower.includes('/stream')
  ) {
    return true;
  }
  const dot = path.lastIndexOf('.');
  if (dot >= 0 && dot < path.length - 1) {
    let ext = path.slice(dot + 1).toLowerCase();
    const q = ext.indexOf('?');
    if (q >= 0) ext = ext.slice(0, q);
    return !!mediaExtensions[ext];
  }
  return false;
}
