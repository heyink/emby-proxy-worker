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

    const start = Date.now();
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
      const elapsed = Date.now() - start;
      console.error(`[WS] upstream connection failed ${target.domain} | ${elapsed}ms`, err);
      server.close(1011, 'upstream connection failed');
      return new Response(null, { status: 101, webSocket: client });
    }

    const upstreamWS = upstreamResp.webSocket;
    if (!upstreamWS) {
      console.error(`[WS] upstream did not upgrade ${target.domain}`);
      server.close(1011, 'upstream did not upgrade to websocket');
      return new Response(null, { status: 101, webSocket: client });
    }
    upstreamWS.accept();

    let bytesUp = 0;
    let bytesDown = 0;

    // Forward: client → upstream
    server.addEventListener('message', (event) => {
      try {
        const data = event.data as string | ArrayBuffer;
        upstreamWS.send(data);
        bytesUp += typeof data === 'string' ? data.length : data.byteLength;
      } catch {
        upstreamWS.close(1011, 'send failed');
      }
    });

    // Forward: upstream → client
    upstreamWS.addEventListener('message', (event) => {
      try {
        const data = event.data as string | ArrayBuffer;
        server.send(data);
        bytesDown += typeof data === 'string' ? data.length : data.byteLength;
      } catch {
        server.close(1011, 'send failed');
      }
    });

    // Close propagation
    const logClose = (side: string, code: number, reason: string) => {
      const elapsed = Date.now() - start;
      console.log(`[WS] ${side} closed ${target.domain} | code ${code} | up ${formatBytes(bytesUp)} | down ${formatBytes(bytesDown)} | ${elapsed}ms`);
    };

    server.addEventListener('close', (event) => {
      logClose('client', event.code, event.reason);
      try { upstreamWS.close(event.code, event.reason); } catch {}
    });
    upstreamWS.addEventListener('close', (event) => {
      logClose('upstream', event.code, event.reason);
      try { server.close(event.code, event.reason); } catch {}
    });

    server.addEventListener('error', () => {
      console.error(`[WS] client error ${target.domain}`);
      try { upstreamWS.close(1011, 'client error'); } catch {}
    });
    upstreamWS.addEventListener('error', () => {
      console.error(`[WS] upstream error ${target.domain}`);
      try { server.close(1011, 'upstream error'); } catch {}
    });

    const elapsed = Date.now() - start;
    console.log(`[WS] connected ${target.domain} | handshake ${elapsed}ms`);

    return new Response(null, { status: 101, webSocket: client });
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
  return `${bytes} B`;
}
