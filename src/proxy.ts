import type { Env, Target } from './types';
import { buildTargetURL, inferBaseURL, targetRequestPath } from './target';
import { rewriteProxySensitiveRequestHeaders, rewriteResponseHeaders, copyResponseHeaders } from './headers';
import { shouldRewriteEmbyPath, shouldRewriteEmbyResponse, rewriteBody } from './rewriter';

export async function serveHTTPProxy(request: Request, target: Target, env: Env): Promise<Response> {
  const start = Date.now();
  const baseURL = env.REWRITE_BASE_URL
    || (env.SECRET_PREFIX ? `${inferBaseURL(request)}/${env.SECRET_PREFIX}` : inferBaseURL(request));
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
    const { result, rewrites } = rewriteBody(body, baseURL);
    const elapsed = Date.now() - start;
    console.log(`[API] ${resp.status} ${request.method} ${target.domain}${targetRequestPath(target)} | rewritten | ${rewrites.length} URLs | ${elapsed}ms`);
    for (const r of rewrites) {
      console.log(`[REWRITE] ${r.original} -> ${r.rewritten}`);
    }
    return new Response(result, {
      status: resp.status,
      headers: respHeaders,
    });
  }

  const elapsed = Date.now() - start;
  const isMedia = looksLikeVideoStream(target.path);
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

var videoExtensions: Record<string, boolean> = {
  mp4: true, mkv: true, avi: true, ts: true, m3u8: true,
  m4v: true, webm: true, mov: true, wmv: true,
};

function looksLikeVideoStream(path: string): boolean {
  const lower = path.toLowerCase();
  if (
    lower.includes('/videos/') ||
    lower.includes('/stream')
  ) {
    return true;
  }
  const dot = path.lastIndexOf('.');
  if (dot >= 0 && dot < path.length - 1) {
    let ext = path.slice(dot + 1).toLowerCase();
    const q = ext.indexOf('?');
    if (q >= 0) ext = ext.slice(0, q);
    return !!videoExtensions[ext];
  }
  return false;
}
