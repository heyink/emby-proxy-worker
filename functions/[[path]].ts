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
