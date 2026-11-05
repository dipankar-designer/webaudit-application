// Turns axe-core results into rule definitions. axe supplies the rule text, impact and
// WCAG tags; common rules get hand-written, plain-language remediation on top.

import type { Remediation, Severity } from '@wpcg/shared';
import type { RuleDef } from './types.js';

export type AxeImpact = 'minor' | 'moderate' | 'serious' | 'critical' | null | undefined;

/** Documented mapping (docs/SEVERITY.md): Critical is reserved for site availability. */
export const AXE_IMPACT_TO_SEVERITY: Record<string, Severity> = {
  critical: 'high',
  serious: 'medium',
  moderate: 'low',
  minor: 'info',
};

/** Rules disabled in axe because a deterministic WebAudit AI rule already reports them. */
export const AXE_DISABLED_RULES = ['document-title', 'html-has-lang', 'html-lang-valid', 'page-has-heading-one', 'heading-order'];

/** axe tags such as "wcag111" → "1.1.1"; "wcag1412" → "1.4.12". */
export function wcagFromTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const m = t.match(/^wcag(\d)(\d)(\d{1,2})$/);
    if (m) out.add(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return [...out].sort();
}

export function wcagLevel(tags: string[]): string | null {
  if (tags.includes('wcag2a') || tags.includes('wcag21a')) return 'A';
  if (tags.includes('wcag2aa') || tags.includes('wcag21aa') || tags.includes('wcag22aa')) return 'AA';
  if (tags.includes('wcag2aaa')) return 'AAA';
  if (tags.includes('best-practice')) return 'Best practice';
  return null;
}

const CURATED: Record<string, Partial<Remediation> & { why: string }> = {
  'image-alt': {
    why: 'Screen reader users hear nothing useful (or the file name) for images without alternative text, and the image adds nothing to search engines.',
    steps: [
      'For each image listed, decide whether it carries information or is decorative.',
      'Informative images: add alt text that says what the image communicates (not "image of…").',
      'Decorative images: use an empty alt attribute (alt="") so screen readers skip them.',
      'In WordPress, set "Alternative Text" in the Media Library for each image, then re-insert or regenerate the block if the page stores old markup.',
    ],
    codeExample: { language: 'html', before: '<img src="team.jpg">', after: '<img src="team.jpg" alt="Our five-person design team at the Dublin office">\n<img src="divider.svg" alt="">' },
    manualReview: 'Only a person can judge whether alt text is accurate and meaningful. WebAudit AI never writes alt text into your site.',
  },
  'color-contrast': {
    why: 'Low-contrast text is hard or impossible to read for people with low vision, colour-blindness, or anyone using a screen in sunlight.',
    steps: [
      'For each element listed, note the foreground and background colours and the measured ratio in the evidence.',
      'Darken the text or lighten the background until the ratio is at least 4.5:1 (3:1 for large text, 24px or 19px bold).',
      'Update the colour in your theme settings or CSS rather than per element.',
    ],
    codeExample: { language: 'css', before: '.btn { color: #9ca3af; background: #ffffff; }', after: '.btn { color: #4b5563; background: #ffffff; } /* 7.6:1 */' },
    manualReview: 'Text on images or gradients cannot always be measured automatically; check those by eye.',
  },
  label: {
    why: 'Form fields without labels are announced as "edit text" by screen readers, so users do not know what to enter.',
    steps: ['Give each field listed a visible <label> connected with for/id, or wrap the field in the label.', 'If a visible label is impossible, add aria-label with the field’s purpose.', 'Placeholder text is not a substitute for a label.'],
    codeExample: { language: 'html', before: '<input type="email" placeholder="Email">', after: '<label for="email">Email address</label>\n<input id="email" type="email" autocomplete="email">' },
  },
  'link-name': {
    why: 'Links without readable text (for example icon-only links) are announced as just "link", so screen reader users cannot tell where they go.',
    steps: ['Add visible text to the link, or an aria-label describing its destination.', 'For icon links, give the icon image alt text or add visually hidden text.'],
    codeExample: { language: 'html', before: '<a href="/cart"><svg …></svg></a>', after: '<a href="/cart" aria-label="View basket"><svg aria-hidden="true" …></svg></a>' },
  },
  'button-name': {
    why: 'Buttons without an accessible name are announced as just "button", so users cannot tell what they do.',
    steps: ['Add visible text to the button, or an aria-label describing its action (for example "Open menu").'],
    codeExample: { language: 'html', before: '<button class="menu-toggle"><span class="icon"></span></button>', after: '<button class="menu-toggle" aria-label="Open menu" aria-expanded="false"><span class="icon" aria-hidden="true"></span></button>' },
  },
  'frame-title': {
    why: 'Screen reader users hear "frame" with no description for embedded maps, videos or forms.',
    steps: ['Add a title attribute to each iframe describing its content, e.g. title="Map of our office".'],
    codeExample: { language: 'html', after: '<iframe src="https://www.youtube.com/embed/…" title="Product demo video"></iframe>' },
  },
  'meta-viewport': {
    why: 'Disabling zoom prevents people with low vision from enlarging text on phones.',
    steps: ['Remove maximum-scale=1 and user-scalable=no from the viewport meta tag.'],
    codeExample: { language: 'html', before: '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">', after: '<meta name="viewport" content="width=device-width, initial-scale=1">' },
  },
  'aria-hidden-focus': {
    why: 'Keyboard users can tab to elements that screen readers have been told to ignore, which is confusing.',
    steps: ['Remove aria-hidden from containers with focusable elements, or make those elements unfocusable (tabindex="-1") while hidden.'],
  },
  'select-name': {
    why: 'Drop-down lists without labels are announced without their purpose.',
    steps: ['Associate a <label> with each <select>, or add aria-label.'],
  },
  'input-image-alt': {
    why: 'Image buttons without alt text are announced without their action.',
    steps: ['Add alt text to <input type="image"> describing what the button does.'],
  },
  list: {
    why: 'Lists that contain non-list children are announced incorrectly by screen readers.',
    steps: ['Make sure <ul> and <ol> only contain <li> (or <script>/<template>) children.'],
  },
  listitem: {
    why: '<li> elements outside a list are not announced as list items.',
    steps: ['Wrap the <li> elements in a <ul> or <ol>.'],
  },
  region: {
    why: 'Content outside landmarks (header, nav, main, footer) is harder to reach with screen reader landmark navigation.',
    steps: ['Wrap page content in semantic landmark elements: <header>, <nav>, <main>, <footer>.'],
  },
  'landmark-one-main': {
    why: 'A <main> landmark lets keyboard and screen reader users jump straight to the content.',
    steps: ['Wrap the main content of the page template in a single <main> element.'],
  },
  'target-size': {
    why: 'Small, tightly packed touch targets are hard to tap accurately, especially for people with motor impairments.',
    steps: ['Make the listed controls at least 24×24 CSS pixels, or add spacing so neighbouring targets do not overlap.'],
  },
  'scrollable-region-focusable': {
    why: 'Keyboard users cannot scroll content inside a scrollable area that cannot receive focus.',
    steps: ['Add tabindex="0" and an accessible name to the scrollable container, or make sure it contains focusable content.'],
  },
  'aria-allowed-attr': { why: 'ARIA attributes not allowed on an element are ignored or misread by assistive technology.', steps: ['Remove the attribute listed or change the element’s role so the attribute is valid.'] },
  'aria-required-children': { why: 'Widgets with missing required child roles are not announced correctly.', steps: ['Add the required child roles listed in the evidence, or use native HTML elements instead of ARIA roles.'] },
  'aria-valid-attr-value': { why: 'Invalid ARIA values are ignored, so the widget state is not announced.', steps: ['Correct the attribute value listed in the evidence (for example aria-expanded must be "true" or "false").'] },
  'nested-interactive': { why: 'Interactive elements inside other interactive elements are not reliably announced or operable.', steps: ['Move the inner link or button outside the outer control.'] },
  'link-in-text-block': { why: 'Links distinguished only by colour cannot be found by people who cannot see the colour difference.', steps: ['Underline links inside paragraphs, or ensure 3:1 contrast with surrounding text plus a non-colour indicator on hover/focus.'] },
};

export interface AxeResultLike {
  id: string;
  impact?: AxeImpact;
  tags: string[];
  description: string;
  help: string;
  helpUrl: string;
}

export function axeRuleDef(r: AxeResultLike, incomplete: boolean): RuleDef {
  const severity = AXE_IMPACT_TO_SEVERITY[r.impact ?? 'moderate'] ?? 'low';
  const wcag = wcagFromTags(r.tags);
  const level = wcagLevel(r.tags);
  const curated = CURATED[r.id];
  const remediation: Remediation = {
    whyItMatters: curated?.why ?? `${r.description}. This affects people using assistive technology such as screen readers, keyboard navigation or magnification.`,
    steps: curated?.steps ?? [
      `Read the rule guidance: ${r.help}.`,
      'Use the selectors in the evidence to locate each affected element in your browser’s developer tools (F12 → Elements, then Ctrl+F and paste the selector).',
      'Apply the fix described in the failure summary for each element, then run a verification scan.',
    ],
    codeExample: curated?.codeExample ?? null,
    verify: [
      'Run a verification scan from this page; axe-core re-runs on the same page and viewport.',
      'Also test the fix manually with a keyboard (Tab/Shift+Tab/Enter) and, if possible, a screen reader.',
    ],
    manualReview:
      curated?.manualReview ??
      'Automated testing finds only part of accessibility barriers. A passing automated check does not mean the page meets WCAG; manual review is still required.',
    references: [{ label: `axe-core rule: ${r.id}`, url: r.helpUrl }],
  };
  return {
    id: incomplete ? `axe-review.${r.id}` : `axe.${r.id}`,
    category: 'accessibility',
    severity,
    title: incomplete ? `Check manually: ${r.help}` : r.help,
    description: r.description,
    detectionMethod: incomplete
      ? 'axe-core flagged elements it could not evaluate automatically (for example text over images). A person must check them.'
      : 'axe-core automated accessibility rules run in Chrome on the rendered page.',
    confidence: incomplete ? 'low' : 'high',
    limitations: incomplete
      ? 'axe-core could not decide automatically. These elements need human review.'
      : 'Automated rules detect only some WCAG failures, and correct-looking markup can still be inaccessible in practice.',
    severityReason: `axe-core rated the impact "${r.impact ?? 'unknown'}"; WebAudit AI maps critical→High, serious→Medium, moderate→Low, minor→Informational.${level ? ` WCAG level: ${level}.` : ''}`,
    scope: 'page',
    check: 'accessibility',
    viewportDependent: false,
    remediation,
    wcag,
    initialStatus: incomplete ? 'needs_review' : 'open',
  };
}
