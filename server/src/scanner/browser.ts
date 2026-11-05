// Headless Chrome for scans. One browser per worker process; one isolated context per page visit.
// All browser traffic goes through the SSRF-filtering egress proxy.

import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { config } from '../config.js';
import { startEgressProxy, type EgressProxy } from '../security/egressProxy.js';
import type { Viewport } from './types.js';

let browserPromise: Promise<Browser> | null = null;
let proxy: EgressProxy | null = null;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome(): string | undefined {
  if (config.CHROME_PATH) return config.CHROME_PATH;
  const system = CANDIDATES.find((p) => fs.existsSync(p));
  if (system) return system;
  // Playwright-managed Chromium (e.g. the official mcr.microsoft.com/playwright image).
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    /* not installed */
  }
  return undefined;
}

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      proxy ??= await startEgressProxy();
      const executablePath = findChrome();
      const browser = await chromium.launch({
        // Without an explicit path Playwright uses its own downloaded Chromium (e.g. in the official Docker image).
        executablePath,
        headless: true,
        proxy: { server: proxy.url },
        args: [
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-default-apps',
          '--mute-audio',
          // Keep WebRTC from opening UDP paths that bypass the proxy.
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
      });
      browser.on('disconnected', () => {
        browserPromise = null;
      });
      return browser;
    })().catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

export async function newContext(viewport: Viewport): Promise<BrowserContext> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.mobile ? 2 : 1,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    serviceWorkers: 'block',
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    // The site's own CSP stays in force so CSP-related failures show up as they would for visitors.
    bypassCSP: false,
    locale: 'en-GB',
    permissions: [],
    userAgent: undefined,
  });
  // Belt and braces: refuse non-web schemes even if a page tries to reach them.
  await ctx.route(/^(?!https?:|data:|blob:)/i, (route) => route.abort('blockedbyclient'));
  return ctx;
}

export async function browserVersion(): Promise<string | null> {
  try {
    return (await getBrowser()).version();
  } catch {
    return null;
  }
}

export async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  if (p) await (await p.catch(() => null))?.close().catch(() => {});
  if (proxy) {
    await proxy.close();
    proxy = null;
  }
}

/** Starts (once) and returns the egress proxy, for other Chrome instances such as Lighthouse's. */
export async function getEgressProxy(): Promise<EgressProxy> {
  proxy ??= await startEgressProxy();
  return proxy;
}

export function proxyStats() {
  return proxy?.stats ?? null;
}
