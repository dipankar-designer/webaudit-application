// Minimal robots.txt parser (RFC 9309 semantics: longest matching rule wins, Allow wins ties,
// "*" wildcards and "$" end anchors supported).

export interface RobotsRules {
  groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[];
  sitemaps: string[];
}

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules['groups'] = [];
  const sitemaps: string[] = [];
  let current: RobotsRules['groups'][number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/).slice(0, 5000)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (!current) continue;
      if (key === 'disallow' && value === '') continue; // empty Disallow = allow all
      current.rules.push({ allow: key === 'allow', path: value });
    } else if (key === 'sitemap') {
      sitemaps.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function patternToRegex(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

/** Whether `pathAndQuery` may be crawled by the given agent token. */
export function isAllowed(robots: RobotsRules, pathAndQuery: string, agentToken = 'webauditaibot'): boolean {
  const token = agentToken.toLowerCase();
  let group = robots.groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  group ??= robots.groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (!patternToRegex(r.path).test(pathAndQuery)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}
