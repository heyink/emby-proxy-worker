import { describe, it, expect } from 'vitest';
import {
  shouldRewriteEmbyPath,
  shouldRewriteBody,
  shouldRewriteEmbyResponse,
  rewriteBody,
  rewriteSingleURL,
  isURLTerminator,
} from './rewriter';
import type { RewriteEntry } from './rewriter';
import type { Target } from './types';

function t(path: string): Target {
  return { scheme: 'https', domain: 'emby.example.com', port: 443, path, query: '' };
}

describe('shouldRewriteEmbyPath', () => {
  it('matches PlaybackInfo', () => {
    expect(shouldRewriteEmbyPath(t('Items/123/PlaybackInfo'))).toBe(true);
  });
  it('matches /emby/ prefix PlaybackInfo', () => {
    expect(shouldRewriteEmbyPath(t('emby/Items/123/PlaybackInfo'))).toBe(true);
  });
  it('does not match Items list', () => {
    expect(shouldRewriteEmbyPath(t('Items'))).toBe(false);
  });
  it('does not match web path', () => {
    expect(shouldRewriteEmbyPath(t('web/index.html'))).toBe(false);
  });
  it('does not match Sessions/Playing (not Progress)', () => {
    expect(shouldRewriteEmbyPath(t('Sessions/Playing'))).toBe(false);
  });
  it('is case insensitive', () => {
    expect(shouldRewriteEmbyPath(t('EMBY/Items/123/PlaybackInfo'))).toBe(true);
  });
});

describe('shouldRewriteBody', () => {
  it('accepts application/json', () => {
    expect(shouldRewriteBody('application/json')).toBe(true);
  });
  it('accepts application/json with charset', () => {
    expect(shouldRewriteBody('application/json; charset=utf-8')).toBe(true);
  });
  it('accepts text/html', () => {
    expect(shouldRewriteBody('text/html')).toBe(true);
  });
  it('accepts application/javascript', () => {
    expect(shouldRewriteBody('application/javascript')).toBe(true);
  });
  it('rejects image/png', () => {
    expect(shouldRewriteBody('image/png')).toBe(false);
  });
  it('rejects application/octet-stream', () => {
    expect(shouldRewriteBody('application/octet-stream')).toBe(false);
  });
});

describe('shouldRewriteEmbyResponse', () => {
  it('matches PlaybackInfo json', () => {
    expect(shouldRewriteEmbyResponse(t('Items/123/PlaybackInfo'), 'application/json')).toBe(true);
  });
  it('does not match PlaybackInfo with binary content', () => {
    expect(shouldRewriteEmbyResponse(t('Items/123/PlaybackInfo'), 'video/mp4')).toBe(false);
  });
  it('does not match random path', () => {
    expect(shouldRewriteEmbyResponse(t('Users/AuthenticateByName'), 'application/json')).toBe(false);
  });
});

describe('rewriteSingleURL', () => {
  const base = 'https://proxy.example.com';

  it('rewrites https URL', () => {
    expect(rewriteSingleURL('https://emby.example.com/web/index.html?x=1', base))
      .toBe('https://proxy.example.com/https/emby.example.com/443/web/index.html?x=1');
  });

  it('rewrites http URL with custom port', () => {
    expect(rewriteSingleURL('http://emby.local:8096/Items', base))
      .toBe('https://proxy.example.com/http/emby.local/8096/Items');
  });

  it('rewrites third-party CDN URL', () => {
    expect(rewriteSingleURL('https://cdn.example.com/video.mp4', base))
      .toBe('https://proxy.example.com/https/cdn.example.com/443/video.mp4');
  });

  it('leaves relative URL untouched', () => {
    expect(rewriteSingleURL('/Items/1', base)).toBe('/Items/1');
  });

  it('leaves non-http URL untouched', () => {
    expect(rewriteSingleURL('javascript:void(0)', base)).toBe('javascript:void(0)');
  });

  it('handles URL without path', () => {
    expect(rewriteSingleURL('https://example.com', base))
      .toBe('https://proxy.example.com/https/example.com/443/');
  });

  it('handles URL with query only', () => {
    expect(rewriteSingleURL('https://example.com?api_key=1', base))
      .toBe('https://proxy.example.com/https/example.com/443/?api_key=1');
  });
});

describe('rewriteBody', () => {
  const base = 'https://proxy.example.com';

  it('rewrites JSON body with absolute URLs', () => {
    const body = '{"api":"https://emby.example.com/Items/1","fallback":"http://cdn.example.com:8096/video.mp4","relative":"/Items/2"}';
    const want = '{"api":"https://proxy.example.com/https/emby.example.com/443/Items/1","fallback":"https://proxy.example.com/http/cdn.example.com/8096/video.mp4","relative":"/Items/2"}';
    const { result, rewrites } = rewriteBody(body, base);
    expect(result).toBe(want);
    expect(rewrites).toHaveLength(2);
    expect(rewrites[0]).toEqual({ original: 'https://emby.example.com/Items/1', rewritten: 'https://proxy.example.com/https/emby.example.com/443/Items/1' });
  });

  it('rewrites Emby PlaybackInfo MediaSources', () => {
    const body = '{"MediaSources":[{"Id":"ms1","Path":"https://stream-cdn.example.com/videos/123/master.m3u8?MediaSourceId=ms1","TranscodingUrl":"http://transcode-node.example.com:8096/Videos/123/master.m3u8?DeviceId=device-1"}]}';
    const { result, rewrites } = rewriteBody(body, base);
    expect(result).toContain('https://proxy.example.com/https/stream-cdn.example.com/443/videos/123/master.m3u8?MediaSourceId=ms1');
    expect(result).toContain('https://proxy.example.com/http/transcode-node.example.com/8096/Videos/123/master.m3u8?DeviceId=device-1');
    expect(rewrites).toHaveLength(2);
  });

  it('returns unchanged body without URLs', () => {
    const body = '{"relative":"/Items/2"}';
    const { result, rewrites } = rewriteBody(body, base);
    expect(result).toBe(body);
    expect(rewrites).toHaveLength(0);
  });

  it('handles multiple URLs from different hosts', () => {
    const body = 'https://a.example.com/x https://b.example.com/y';
    const want = 'https://proxy.example.com/https/a.example.com/443/x https://proxy.example.com/https/b.example.com/443/y';
    const { result, rewrites } = rewriteBody(body, base);
    expect(result).toBe(want);
    expect(rewrites).toHaveLength(2);
  });

  it('preserves text before and after URL', () => {
    const body = 'prefix https://example.com/a suffix';
    const want = 'prefix https://proxy.example.com/https/example.com/443/a suffix';
    const { result } = rewriteBody(body, base);
    expect(result).toBe(want);
  });

  it('respects JSON string terminators', () => {
    const body = '{"url":"https://example.com/a"}';
    const want = '{"url":"https://proxy.example.com/https/example.com/443/a"}';
    const { result } = rewriteBody(body, base);
    expect(result).toBe(want);
  });

  it('returns empty string unchanged', () => {
    const { result, rewrites } = rewriteBody('', base);
    expect(result).toBe('');
    expect(rewrites).toHaveLength(0);
  });

  it('handles baseURL with forwarded prefix', () => {
    const body = '{"url":"https://example.com/a"}';
    const prefixedBase = 'https://proxy.example.com/custom-prefix';
    const want = '{"url":"https://proxy.example.com/custom-prefix/https/example.com/443/a"}';
    const { result } = rewriteBody(body, prefixedBase);
    expect(result).toBe(want);
  });
});

describe('isURLTerminator', () => {
  it('terminates on double quote', () => {
    expect(isURLTerminator('"')).toBe(true);
  });
  it('terminates on space', () => {
    expect(isURLTerminator(' ')).toBe(true);
  });
  it('terminates on angle bracket', () => {
    expect(isURLTerminator('<')).toBe(true);
  });
  it('does not terminate on letter', () => {
    expect(isURLTerminator('a')).toBe(false);
  });
  it('does not terminate on slash', () => {
    expect(isURLTerminator('/')).toBe(false);
  });
  it('does not terminate on question mark', () => {
    expect(isURLTerminator('?')).toBe(false);
  });
});
