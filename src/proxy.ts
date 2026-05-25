import type { Env, Target } from './types';
import { buildTargetURL, inferBaseURL, targetRequestPath } from './target';
import { rewriteProxySensitiveRequestHeaders, rewriteResponseHeaders, copyResponseHeaders } from './headers';
import { shouldRewriteEmbyPath, shouldRewriteEmbyResponse, rewriteBody, type RewriteEntry } from './rewriter';

export async function serveHTTPProxy(request: Request, target: Target, env: Env): Promise<Response> {
  const start = Date.now();
  const baseURL = env.REWRITE_BASE_URL
    || (env.SECRET_PREFIX ? `${inferBaseURL(request)}/${env.SECRET_PREFIX}` : inferBaseURL(request));
  const targetURL = buildTargetURL(target);

  const methodHasBody = !['GET', 'HEAD'].includes(request.method.toUpperCase());
  const outgoing = new Request(targetURL, {
    method: request.method,
    body: methodHasBody ? request.body : undefined,
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
  const headerRewrites = rewriteResponseHeaders(respHeaders, target, baseURL);

  const allRewrites: RewriteEntry[] = [...headerRewrites];
  let responseBody: string | null = null;

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
    responseBody = result;
    allRewrites.push(...rewrites);
  }

  const elapsed = Date.now() - start;
  console.log(`[PROXY] ${resp.status} ${request.method} ${target.domain}${targetRequestPath(target)} | ${allRewrites.length} rewrites | ${elapsed}ms`);
  for (const r of allRewrites) {
    console.log(`[REWRITE] ${r.original} -> ${r.rewritten}`);
  }

  if (responseBody !== null) {
    return new Response(responseBody, {
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
