import type { Target } from './types';
import { buildTargetURL, inferBaseURL } from './target';
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
