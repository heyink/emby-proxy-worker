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
    return serveHTTPProxy(request, result.target, env);
  },
};
