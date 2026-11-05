// Scripts evaluated inside the scanned page. Kept as plain-JavaScript strings so the
// TypeScript toolchain cannot inject helpers that do not exist in the page context.
// They only read the DOM; nothing is clicked, submitted or modified (apart from the
// screenshot stabilisation stylesheet added by the engine).

export interface ExtractedImage {
  src: string;
  hasAlt: boolean;
  hasWidthAttr: boolean;
  hasHeightAttr: boolean;
  cssSized: boolean;
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  complete: boolean;
  visible: boolean;
  selector: string;
}

export interface Extracted {
  url: string;
  protocol: string;
  title: string | null;
  lang: string | null;
  doctype: string | null;
  metaCharset: boolean;
  characterSet: string;
  viewport: string | null;
  descriptions: string[];
  robots: string[];
  canonicals: { raw: string; resolved: string | null }[];
  headings: { level: number; text: string; selector: string }[];
  duplicateIds: { id: string; count: number }[];
  deprecated: { tag: string; count: number }[];
  links: { href: string; text: string }[];
  malformedLinks: { raw: string; text: string }[];
  images: ExtractedImage[];
  imageCount: number;
  jsonLd: { ok: boolean; error: string | null; snippet: string }[];
  mixed: { tag: string; url: string; kind: 'active' | 'passive' }[];
  forms: { action: string; method: string; hasPassword: boolean; selector: string }[];
  overflow: { scrollWidth: number; innerWidth: number; offenders: { selector: string; right: number; width: number }[] };
  textLength: number;
  visibleHeadings: number;
  resources: { name: string; type: string; encoded: number }[];
}

export const EXTRACT_SCRIPT = String.raw`(() => {
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const selectorOf = (el) => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      let part = node.tagName.toLowerCase();
      if (node.id && document.querySelectorAll('#' + cssEsc(node.id)).length === 1) { parts.unshift(part + '#' + cssEsc(node.id)); break; }
      const cls = Array.from(node.classList || []).filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };
  const abs = (v) => { try { return new URL(v, document.baseURI).href; } catch (e) { return null; } };

  const meta = (name) => Array.from(document.querySelectorAll('meta[name]')).filter((m) => (m.getAttribute('name') || '').toLowerCase() === name).map((m) => m.getAttribute('content') || '');

  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 300).map((h) => ({ level: Number(h.tagName[1]), text: clip(h.textContent, 120), selector: selectorOf(h) }));

  const idCounts = new Map();
  for (const el of document.querySelectorAll('[id]')) { const id = el.id; if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1); }
  const duplicateIds = Array.from(idCounts.entries()).filter(([, c]) => c > 1).slice(0, 25).map(([id, count]) => ({ id: clip(id, 80), count }));

  const deprecated = ['font', 'center', 'marquee', 'blink', 'big', 'strike', 'tt', 'frameset', 'frame', 'acronym', 'applet', 'basefont', 'dir']
    .map((tag) => ({ tag, count: document.getElementsByTagName(tag).length })).filter((d) => d.count > 0);

  const links = [];
  const malformedLinks = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 3000)) {
    const raw = (a.getAttribute('href') || '').trim();
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|sms|data|blob):/i.test(raw)) continue;
    const text = clip(a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '', 80);
    if (/^(htp|htps|http|https):\/?[^/]/i.test(raw) || /^https?:\/\/$/i.test(raw) || /^(hhtp|htttp|ttp)s?:/i.test(raw)) { malformedLinks.push({ raw: clip(raw, 300), text }); continue; }
    const href = abs(raw);
    if (!href) { malformedLinks.push({ raw: clip(raw, 300), text }); continue; }
    if (!/^https?:/i.test(href)) { if (/^h*t+p+s?:/i.test(raw)) malformedLinks.push({ raw: clip(raw, 300), text }); continue; }
    links.push({ href: href.split('#')[0], text });
  }

  const allImgs = Array.from(document.images);
  const images = allImgs.slice(0, 400).map((img) => {
    const r = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    return {
      src: clip(img.currentSrc || img.src || '', 500),
      hasAlt: img.hasAttribute('alt'),
      hasWidthAttr: img.hasAttribute('width'),
      hasHeightAttr: img.hasAttribute('height'),
      cssSized: cs.aspectRatio !== 'auto' && cs.aspectRatio !== '' ,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(r.width),
      renderedHeight: Math.round(r.height),
      complete: img.complete,
      visible: isVisible(img),
      selector: selectorOf(img),
    };
  });

  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20).map((s) => {
    const txt = s.textContent || '';
    try { JSON.parse(txt); return { ok: true, error: null, snippet: clip(txt, 200) }; }
    catch (e) { return { ok: false, error: clip(e.message, 200), snippet: clip(txt, 400) }; }
  });

  const mixed = [];
  if (location.protocol === 'https:') {
    const push = (tag, url, kind) => { if (url && /^http:\/\//i.test(url) && mixed.length < 50) mixed.push({ tag, url: clip(url, 300), kind }); };
    document.querySelectorAll('script[src]').forEach((e) => push('script', e.getAttribute('src'), 'active'));
    document.querySelectorAll('link[rel~="stylesheet"][href]').forEach((e) => push('link', e.getAttribute('href'), 'active'));
    document.querySelectorAll('iframe[src]').forEach((e) => push('iframe', e.getAttribute('src'), 'active'));
    document.querySelectorAll('img[src]').forEach((e) => push('img', e.getAttribute('src'), 'passive'));
    document.querySelectorAll('video[src],audio[src],source[src]').forEach((e) => push(e.tagName.toLowerCase(), e.getAttribute('src'), 'passive'));
  }

  const forms = Array.from(document.forms).slice(0, 50).map((f) => ({
    action: clip(f.getAttribute('action') ? abs(f.getAttribute('action')) : location.href, 300),
    method: (f.getAttribute('method') || 'get').toLowerCase(),
    hasPassword: !!f.querySelector('input[type="password"]'),
    selector: selectorOf(f),
  }));

  // Layout viewport width: on mobile Chrome zooms out overflowing pages, which inflates innerWidth.
  const innerWidth = document.documentElement.clientWidth || window.innerWidth;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const offenders = [];
  if (scrollWidth > innerWidth + 1) {
    const all = Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, 4000);
    const set = new Set();
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.right <= innerWidth + 1 || r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') continue;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX !== 'visible' && p.getBoundingClientRect().right <= innerWidth + 1) { clipped = true; break; }
      }
      if (clipped) continue;
      set.add(el);
    }
    for (const el of set) {
      if (el.parentElement && set.has(el.parentElement)) continue;
      const r = el.getBoundingClientRect();
      offenders.push({ selector: selectorOf(el), right: Math.round(r.right), width: Math.round(r.width) });
      if (offenders.length >= 10) break;
    }
  }

  const resources = (performance.getEntriesByType('resource') || []).filter((e) => e.initiatorType === 'img' || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(e.name))
    .slice(0, 300).map((e) => ({ name: clip(e.name, 500), type: e.initiatorType, encoded: e.encodedBodySize || 0 }));

  const textLength = document.body ? (document.body.innerText || '').replace(/\s+/g, ' ').trim().length : 0;
  const visibleHeadings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(isVisible).length;

  return {
    url: location.href,
    protocol: location.protocol,
    title: document.querySelector('title') ? clip(document.title, 300) : null,
    lang: document.documentElement.hasAttribute('lang') ? document.documentElement.getAttribute('lang') : null,
    doctype: document.doctype ? document.doctype.name : null,
    metaCharset: !!document.querySelector('meta[charset]') || !!Array.from(document.querySelectorAll('meta[http-equiv]')).find((m) => /content-type/i.test(m.getAttribute('http-equiv') || '') && /charset=/i.test(m.getAttribute('content') || '')),
    characterSet: document.characterSet,
    viewport: meta('viewport')[0] ?? null,
    descriptions: meta('description').map((d) => clip(d, 400)),
    robots: meta('robots').concat(meta('googlebot')).map((d) => clip(d, 200)),
    canonicals: Array.from(document.querySelectorAll('link[rel~="canonical"]')).map((l) => ({ raw: clip(l.getAttribute('href') || '', 400), resolved: l.getAttribute('href') ? abs(l.getAttribute('href')) : null })),
    headings,
    duplicateIds,
    deprecated,
    links,
    malformedLinks: malformedLinks.slice(0, 50),
    images,
    imageCount: allImgs.length,
    jsonLd,
    mixed,
    forms,
    overflow: { scrollWidth, innerWidth, offenders },
    textLength,
    visibleHeadings,
    resources,
  };
})()`;

/** Neutralises animation so screenshots are comparable, and hides user-configured dynamic regions. */
export function stabiliseCss(hideSelectors: string[]): string {
  const base =
    '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
  return hideSelectors.length ? `${base}${hideSelectors.join(',')}{visibility:hidden!important}` : base;
}

/** Scrolls through the page once so lazy-loaded images load, then returns to the top. */
export const LAZY_SCROLL_SCRIPT = String.raw`(async () => {
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  const max = Math.min(document.documentElement.scrollHeight, 20000);
  for (let y = 0; y < max; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 150));
  return true;
})()`;
