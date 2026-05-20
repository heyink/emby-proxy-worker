import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import { parseTarget, buildTargetURL } from './target';
import { rewriteProxySensitiveRequestHeaders } from './headers';

export class WebSocketProxy extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const result = parseTarget(url.pathname, url.search.slice(1));
    if (!result.ok) {
      return new Response(result.error, { status: 400 });
    }
    const target = result.target;

    // Accept the client WebSocket
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }

    const clientPair = new WebSocketPair();
    const [client, server] = [clientPair[0], clientPair[1]];
    this.ctx.acceptWebSocket(server);

    // Connect to upstream
    const targetURL = buildTargetURL(target);
    const upstreamHeaders = new Headers();
    request.headers.forEach((value, key) => {
      upstreamHeaders.set(key, value);
    });
    upstreamHeaders.set('Host', `${target.domain}:${target.port}`);
    upstreamHeaders.set('Upgrade', 'websocket');
    upstreamHeaders.set('Connection', 'Upgrade');

    const forwardedPrefix = request.headers.get('X-Forwarded-Prefix') || '';
    rewriteProxySensitiveRequestHeaders(upstreamHeaders, forwardedPrefix);

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(targetURL, {
        headers: upstreamHeaders,
      });
    } catch (err) {
      server.close(1011, 'upstream connection failed');
      return new Response(null, { status: 101, webSocket: client });
    }

    const upstreamWS = upstreamResp.webSocket;
    if (!upstreamWS) {
      server.close(1011, 'upstream did not upgrade to websocket');
      return new Response(null, { status: 101, webSocket: client });
    }
    upstreamWS.accept();

    // Forward: client → upstream
    server.addEventListener('message', (event) => {
      try {
        upstreamWS.send(event.data as string | ArrayBuffer);
      } catch {
        upstreamWS.close(1011, 'send failed');
      }
    });

    // Forward: upstream → client
    upstreamWS.addEventListener('message', (event) => {
      try {
        server.send(event.data as string | ArrayBuffer);
      } catch {
        server.close(1011, 'send failed');
      }
    });

    // Close propagation
    server.addEventListener('close', (event) => {
      try { upstreamWS.close(event.code, event.reason); } catch {}
    });
    upstreamWS.addEventListener('close', (event) => {
      try { server.close(event.code, event.reason); } catch {}
    });

    server.addEventListener('error', () => {
      try { upstreamWS.close(1011, 'client error'); } catch {}
    });
    upstreamWS.addEventListener('error', () => {
      try { server.close(1011, 'upstream error'); } catch {}
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
