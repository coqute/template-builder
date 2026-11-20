/** FNV-1a 64비트 — 짧고 안정적인 키 (16자리 16진수) */
export function hash64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const b of new TextEncoder().encode(s)) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
