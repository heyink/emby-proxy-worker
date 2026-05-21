export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function isDomainAllowed(domain: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const lower = domain.toLowerCase();
  for (const entry of allowlist) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.net"
      if (lower.endsWith(suffix) && lower.length > suffix.length) {
        return true;
      }
    } else {
      if (lower === entry) {
        return true;
      }
    }
  }
  return false;
}
