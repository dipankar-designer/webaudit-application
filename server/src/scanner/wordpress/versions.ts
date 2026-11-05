// PHP-style version comparison, matching how WordPress orders versions: "1.0-beta" < "1.0-RC1"
// < "1.0" < "1.0-pl1". Missing trailing components compare as 0, so "5.0" equals "5.0.0".

const LOWER_TIERS: Record<string, number> = { dev: 0, alpha: 1, a: 1, beta: 2, b: 2, rc: 3 };
const NUMBER_TIER = 5;
const HIGHER_TIERS: Record<string, number> = { pl: 6, p: 6 };

function components(version: string): string[] {
  return version
    .trim()
    .replace(/[_\-+]/g, '.')
    .replace(/[^0-9.]+/g, (m) => `.${m}.`)
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '')
    .split('.')
    .filter((s) => s.length > 0);
}

function tier(c: string): number {
  if (/^\d+$/.test(c)) return NUMBER_TIER;
  const lower = c.toLowerCase();
  if (lower in LOWER_TIERS) return LOWER_TIERS[lower] + 1;
  if (lower in HIGHER_TIERS) return HIGHER_TIERS[lower];
  return 0;
}

function compareComponent(a: string, b: string): number {
  const ta = tier(a);
  const tb = tier(b);
  if (ta === NUMBER_TIER && tb === NUMBER_TIER) {
    const na = BigInt(a);
    const nb = BigInt(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (ta !== tb) return ta < tb ? -1 : 1;
  return 0;
}

/** Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const ca = components(a);
  const cb = components(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const r = compareComponent(ca[i] ?? '0', cb[i] ?? '0');
    if (r !== 0) return r;
  }
  return 0;
}

/** True for strings that look like a real version number (not "trunk", not empty). */
export const isVersionLike = (v: string | null | undefined): v is string => !!v && v.length <= 32 && /^\d+(\.\d+){0,4}([.-]?[a-z]+\d*)?$/i.test(v.trim());

/** WPVulnerability operator semantics: lt, le, gt, ge, eq. */
export function satisfies(version: string, op: string | null | undefined, bound: string | null | undefined): boolean {
  if (!op || !bound) return true;
  const c = compareVersions(version, bound);
  switch (op.toLowerCase()) {
    case 'lt':
      return c < 0;
    case 'le':
      return c <= 0;
    case 'gt':
      return c > 0;
    case 'ge':
      return c >= 0;
    case 'eq':
      return c === 0;
    default:
      return false;
  }
}
