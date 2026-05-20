import { describe, it, expect } from 'vitest';
import {
  rewriteProxySensitiveRequestHeaders,
  rewriteResponseHeaders,
  copyResponseHeaders,
} from './headers';
import type { Target } from './types';

describe('rewriteProxySensitiveRequestHeaders', () => {
  it('removes X-Forwarded-* headers', () => {
    const headers = new Headers({
      'X-Real-Ip': '1.2.3.4',
      'X-Forwarded-For': '1.2.3.4',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'proxy.example.com',
      'X-Forwarded-Port': '443',
      'X-Forwarded-Prefix': '/custom',
      'Forwarded': 'for=1.2.3.4',
      'Via': '1.1 proxy',
      'Accept': 'application/json',
    });
    rewriteProxySensitiveRequestHeaders(headers, '');
    expect(headers.get('X-Real-Ip')).toBeNull();
    expect(headers.get('X-Forwarded-For')).toBeNull();
    expect(headers.get('X-Forwarded-Proto')).toBeNull();
    expect(headers.get('X-Forwarded-Host')).toBeNull();
    expect(headers.get('X-Forwarded-Port')).toBeNull();
    expect(headers.get('X-Forwarded-Prefix')).toBeNull();
    expect(headers.get('Forwarded')).toBeNull();
    expect(headers.get('Via')).toBeNull();
    expect(headers.get('Accept')).toBe('application/json');
  });

  it('rewrites Referer from proxy format to original', () => {
    const headers = new Headers({
      'Referer': 'https://proxy.example.com/https/emby.example.com/443/web/index.html',
    });
    rewriteProxySensitiveRequestHeaders(headers, '');
    expect(headers.get('Referer')).toBe('https://emby.example.com/web/index.html');
  });

  it('rewrites Origin from proxy format to original', () => {
    const headers = new Headers({
      'Origin': 'https://proxy.example.com/http/emby.local/8096',
    });
    rewriteProxySensitiveRequestHeaders(headers, '');
    expect(headers.get('Origin')).toBe('http://emby.local:8096');
  });
});

describe('rewriteResponseHeaders', () => {
  const target: Target = { scheme: 'https', domain: 'emby.example.com', port: 443, path: '', query: '' };
  const baseURL = 'https://proxy.example.com';

  it('rewrites Location with absolute URL', () => {
    const headers = new Headers({
      'Location': 'https://emby.example.com/web/index.html',
    });
    rewriteResponseHeaders(headers, target, baseURL);
    expect(headers.get('Location')).toBe('https://proxy.example.com/https/emby.example.com/443/web/index.html');
  });

  it('rewrites Content-Location with absolute URL', () => {
    const headers = new Headers({
      'Content-Location': 'http://emby.local:8096/Items',
    });
    rewriteResponseHeaders(headers, target, baseURL);
    expect(headers.get('Content-Location')).toBe('https://proxy.example.com/http/emby.local/8096/Items');
  });

  it('rewrites Location with relative path to proxy URL', () => {
    const headers = new Headers({
      'Location': '/web/index.html',
    });
    rewriteResponseHeaders(headers, target, baseURL);
    expect(headers.get('Location')).toBe('https://proxy.example.com/https/emby.example.com/443/web/index.html');
  });

  it('leaves protocol-relative URLs unchanged', () => {
    const headers = new Headers({
      'Location': '//emby.example.com/path',
    });
    rewriteResponseHeaders(headers, target, baseURL);
    expect(headers.get('Location')).toBe('//emby.example.com/path');
  });
});

describe('copyResponseHeaders', () => {
  it('copies headers and strips Server and X-Powered-By', () => {
    const src = new Headers({
      'Content-Type': 'text/html',
      'Server': 'Emby',
      'X-Powered-By': 'Express',
      'X-Custom': 'value',
    });
    const dst = new Headers();
    copyResponseHeaders(dst, src);
    expect(dst.get('Content-Type')).toBe('text/html');
    expect(dst.get('X-Custom')).toBe('value');
    expect(dst.get('Server')).toBeNull();
    expect(dst.get('X-Powered-By')).toBeNull();
  });
});
