// Passive WordPress fingerprinting from page HTML and headers (no network requests here).

import * as cheerio from 'cheerio';

export interface ComponentMarks {
  assetVersions: Set<string>;
  urls: Set<string>;
}

export interface WordPressMarkers {
  markers: string[];
  strong: boolean;
  generatorVersion: string | null;
  /** Version counts read from ?ver= on wp-includes assets (the most common one is usually core). */
  coreAssetVersions: Map<string, number>;
  plugins: Map<string, ComponentMarks>;
  themes: Map<string, ComponentMarks>;
  installPath: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const WP_PATH = /(?:^|\/)wp-(content|includes)\/(?:(plugins|themes)\/([^/?#"'\s]+)\/)?/i;

export function emptyMarkers(): WordPressMarkers {
  return { markers: [], strong: false, generatorVersion: null, coreAssetVersions: new Map(), plugins: new Map(), themes: new Map(), installPath: null };
}

/** Adds what one page reveals to the accumulated markers. */
export function collectMarkers(acc: WordPressMarkers, html: string, pageUrl: URL, headers: Record<string, string> = {}): void {
  const $ = cheerio.load(html);
  const add = (m: string) => {
    if (!acc.markers.includes(m)) acc.markers.push(m);
  };

  const generator = $('meta[name="generator" i]')
    .map((_, el) => $(el).attr('content') ?? '')
    .get()
    .find((c) => /wordpress/i.test(c));
  if (generator) {
    add(`Generator tag "${generator.slice(0, 60)}"`);
    acc.strong = true;
    acc.generatorVersion ??= generator.match(/WordPress\s+(\d+(?:\.\d+){0,3})/i)?.[1] ?? null;
  }
  if (/rel="?https:\/\/api\.w\.org\/"?/i.test(headers.link ?? '') || $('link[rel="https://api.w.org/"]').length) {
    add('WordPress REST API discovery link');
    acc.strong = true;
  }

  const urls: string[] = [];
  $('link[href], script[src], img[src], source[src], a[href]').each((_, el) => {
    const v = $(el).attr('href') ?? $(el).attr('src');
    if (v) urls.push(v);
  });
  $('img[srcset], source[srcset]').each((_, el) => {
    for (const part of ($(el).attr('srcset') ?? '').split(',')) urls.push(part.trim().split(/\s+/)[0]);
  });
  for (const m of html.matchAll(/(?:https?:)?\\?\/\\?\/[^"'\s<>()]+?wp-(?:content|includes)\\?\/[^"'\s<>()]+|\/wp-(?:content|includes)\/[^"'\s<>()]+/gi)) urls.push(m[0].replace(/\\\//g, '/'));

  let sawContent = false;
  let sawIncludes = false;
  for (const raw of urls.slice(0, 5000)) {
    let u: URL;
    try {
      u = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (u.hostname !== pageUrl.hostname) continue; // only this site's own files identify its components
    const m = u.pathname.match(WP_PATH);
    if (!m) continue;
    acc.installPath ??= u.pathname.slice(0, u.pathname.toLowerCase().indexOf(`wp-${m[1].toLowerCase()}/`)) || '/';
    if (m[1].toLowerCase() === 'includes') {
      sawIncludes = true;
      const v = u.searchParams.get('ver');
      if (v && /^\d+\.\d+(\.\d+)?$/.test(v)) acc.coreAssetVersions.set(v, (acc.coreAssetVersions.get(v) ?? 0) + 1);
      continue;
    }
    sawContent = true;
    const kind = m[2]?.toLowerCase();
    let slug: string | null = null;
    try {
      slug = m[3] ? decodeURIComponent(m[3]).toLowerCase() : null;
    } catch {
      slug = null;
    }
    if (!kind || !slug || !SLUG.test(slug)) continue;
    const map = kind === 'plugins' ? acc.plugins : acc.themes;
    const entry = map.get(slug) ?? { assetVersions: new Set<string>(), urls: new Set<string>() };
    const v = u.searchParams.get('ver');
    if (v && /^\d+(\.\d+){0,4}$/.test(v)) entry.assetVersions.add(v);
    if (entry.urls.size < 3) entry.urls.add(u.pathname);
    map.set(slug, entry);
  }
  if (sawContent) add('Files served from /wp-content/');
  if (sawIncludes) add('Files served from /wp-includes/');
  if (sawContent && sawIncludes) acc.strong = true;
}

/** "Stable tag:" from a plugin readme.txt — only when the file really is a WordPress readme. */
export function parsePluginReadme(text: string): { name: string | null; stableTag: string | null } | null {
  const head = text.slice(0, 4000);
  const nameMatch = head.match(/^\s*===\s*(.+?)\s*===\s*$/m);
  if (!nameMatch && !/^\s*(Contributors|Tags|Requires at least|Tested up to|Stable tag)\s*:/im.test(head)) return null;
  return { name: nameMatch?.[1]?.slice(0, 100) ?? null, stableTag: head.match(/^\s*Stable tag\s*:\s*([^\s]+)\s*$/im)?.[1] ?? null };
}

/** "Theme Name:" and "Version:" from a theme's style.css header. */
export function parseThemeStylesheet(text: string): { name: string | null; version: string | null } | null {
  const head = text.slice(0, 8000);
  const name = head.match(/^[\s*]*Theme Name\s*:\s*(.+?)\s*$/im)?.[1] ?? null;
  if (!name) return null;
  return { name: name.slice(0, 100), version: head.match(/^[\s*]*Version\s*:\s*([^\s*]+)\s*$/im)?.[1] ?? null };
}

/** WordPress version from an RSS feed <generator>. */
export function parseFeedGenerator(text: string): string | null {
  return text.match(/<generator>\s*https?:\/\/wordpress\.org\/\?v=(\d+(?:\.\d+){0,3})\s*<\/generator>/i)?.[1] ?? null;
}
