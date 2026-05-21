import { describe, it, expect } from 'vitest';
import { parseAllowlist, isDomainAllowed } from './allowlist';

describe('parseAllowlist', () => {
  it('returns empty array for undefined', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseAllowlist('')).toEqual([]);
  });

  it('parses single domain', () => {
    expect(parseAllowlist('emby.example.com')).toEqual(['emby.example.com']);
  });

  it('parses comma-separated domains', () => {
    expect(parseAllowlist('emby.example.com,*.example.net')).toEqual(['emby.example.com', '*.example.net']);
  });

  it('trims whitespace', () => {
    expect(parseAllowlist(' emby.example.com , *.example.net ')).toEqual(['emby.example.com', '*.example.net']);
  });

  it('ignores empty entries from trailing comma', () => {
    expect(parseAllowlist('emby.example.com,')).toEqual(['emby.example.com']);
  });
});

describe('isDomainAllowed', () => {
  it('allows all when allowlist is empty', () => {
    expect(isDomainAllowed('anything.example.com', [])).toBe(true);
  });

  it('matches exact domain', () => {
    const list = parseAllowlist('emby.example.com');
    expect(isDomainAllowed('emby.example.com', list)).toBe(true);
  });

  it('rejects non-matching domain', () => {
    const list = parseAllowlist('emby.example.com');
    expect(isDomainAllowed('other.example.com', list)).toBe(false);
  });

  it('matches wildcard subdomain', () => {
    const list = parseAllowlist('*.example.net');
    expect(isDomainAllowed('sub.example.net', list)).toBe(true);
  });

  it('matches nested wildcard subdomain', () => {
    const list = parseAllowlist('*.example.net');
    expect(isDomainAllowed('a.b.example.net', list)).toBe(true);
  });

  it('wildcard does not match bare domain', () => {
    const list = parseAllowlist('*.example.net');
    expect(isDomainAllowed('example.net', list)).toBe(false);
  });

  it('is case insensitive', () => {
    const list = parseAllowlist('Emby.Example.COM');
    expect(isDomainAllowed('emby.example.com', list)).toBe(true);
  });

  it('wildcard is case insensitive', () => {
    const list = parseAllowlist('*.Example.NET');
    expect(isDomainAllowed('SUB.EXAMPLE.NET', list)).toBe(true);
  });

  it('matches against multiple entries', () => {
    const list = parseAllowlist('emby.example.com,*.example.net');
    expect(isDomainAllowed('emby.example.com', list)).toBe(true);
    expect(isDomainAllowed('sub.example.net', list)).toBe(true);
    expect(isDomainAllowed('other.org', list)).toBe(false);
  });

  it('rejects mid-string wildcard', () => {
    const list = parseAllowlist('foo*.bar.com');
    expect(isDomainAllowed('foo.bar.com', list)).toBe(false);
  });

  it('rejects bare wildcard', () => {
    const list = parseAllowlist('*');
    expect(isDomainAllowed('anything.com', list)).toBe(false);
  });
});
