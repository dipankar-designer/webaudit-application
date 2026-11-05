// Outbound HTTP client used by the scanner for page discovery, availability and link checks.
// Every hop is re-validated, DNS is resolved through guardedLookup, and response size,
// redirect count and total time are bounded.

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { BlockedTargetError, assertHostAllowed, effectivePort, guardedLookup } from './ssrf.js';

export type FetchFailureKind =
  | 'blocked'
  | 'dns'
  | 'timeout'
  | 'connection'
  | 'tls'
  | 'too_large'
  | 'too_many_redirects'
  | 'invalid_redirect'
  | 'protocol';

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
  /** Time until this hop's response headers arrived. */
  ms: number;
}

export interface SafeResponse {
  ok: boolean;
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  headers: Record<string, string>;
  body: Buffer | null;
  truncated: boolean;
  redirects: RedirectHop[];
  durationMs: number;
  /** Time to first byte (response headers) of the final hop; null when no response. */
  ttfbMs: number | null;
  failure: { kind: FetchFailureKind; message: string; code?: string } | null;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Read the body only when this returns true for the response content type. */
  readBody?: (contentType: string) => boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** New TCP/TLS connection per request, so timings include connection setup (monitoring). */
  freshConnection?: boolean;
  /**
   * Finish as soon as the status and headers arrive and close the connection instead of draining the
   * body (address checks: a server that answers but sends its page slowly is reachable, just slow).
   */
  headersOnly?: boolean;
}

const agentOptions = { keepAlive: true, maxSockets: 8, lookup: guardedLookup as unknown as http.AgentOptions['lookup'] };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent({ ...agentOptions, rejectUnauthorized: true });

export const textLike = (ct: string) => /text\/|html|xml|json|javascript/i.test(ct) || ct === '';

function classify(err: NodeJS.ErrnoException): { kind: FetchFailureKind; message: string; code?: string } {
  const code = err.code;
  if (err instanceof BlockedTargetError || code === 'EBLOCKEDTARGET') return { kind: 'blocked', message: err.message, code };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return { kind: 'dns', message: 'The domain name could not be resolved.', code };
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || err.name === 'TimeoutError') return { kind: 'timeout', message: 'The server did not respond in time.', code };
  if (code && (code.startsWith('ERR_TLS') || code.includes('CERT') || code === 'EPROTO' || code.startsWith('UNABLE_TO') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'))
    return { kind: 'tls', message: `The HTTPS certificate or TLS connection failed (${code}).`, code };
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EPIPE')
    return { kind: 'connection', message: `The connection failed (${code}).`, code };
  return { kind: 'protocol', message: err.message || 'Request failed.', code };
}

function one(url: URL, opts: Required<Pick<SafeFetchOptions, 'method' | 'timeoutMs' | 'maxBytes'>> & SafeFetchOptions) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer | null; truncated: boolean; headersMs: number }>((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    const agent = opts.freshConnection
      ? url.protocol === 'https:'
        ? new https.Agent({ keepAlive: false, lookup: guardedLookup as never, rejectUnauthorized: true })
        : new http.Agent({ keepAlive: false, lookup: guardedLookup as never })
      : url.protocol === 'https:'
        ? httpsAgent
        : httpAgent;
    const req = mod.request(
      url,
      {
        method: opts.method,
        agent,
        headers: {
          'user-agent': config.SCAN_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'en',
          ...opts.headers,
        },
        timeout: opts.timeoutMs,
        signal: opts.signal,
      },
      (res) => {
        const headersMs = Math.round(performance.now() - t0);
        const status = res.statusCode ?? 0;
        const ct = String(res.headers['content-type'] ?? '').toLowerCase();
        const wantBody = opts.method === 'GET' && !(status >= 300 && status < 400) && (opts.readBody ? opts.readBody(ct) : textLike(ct));
        if (opts.headersOnly && !wantBody) {
          res.destroy();
          resolve({ status, headers: res.headers, body: null, truncated: false, headersMs });
          return;
        }
        if (!wantBody) {
          res.resume();
          res.on('end', () => resolve({ status, headers: res.headers, body: null, truncated: false, headersMs }));
          res.on('error', reject);
          return;
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > opts.maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, Math.max(0, c.length - (size - opts.maxBytes))));
            res.destroy();
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated: true, headersMs });
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => {
          if (!truncated) resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated: false, headersMs });
        });
        stream.on('error', (e) => {
          if (!truncated) reject(e);
        });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

function flattenHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** Fetch a URL with SSRF protection. Never throws for network failures; check `failure`. */
export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const started = Date.now();
  const opts = {
    method: options.method ?? 'GET',
    timeoutMs: options.timeoutMs ?? config.SCAN_PAGE_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? config.SCAN_MAX_RESPONSE_BYTES,
    ...options,
  } as Required<Pick<SafeFetchOptions, 'method' | 'timeoutMs' | 'maxBytes'>> & SafeFetchOptions;
  const maxRedirects = options.maxRedirects ?? config.SCAN_MAX_REDIRECTS;
  const requestedUrl = String(input);
  const redirects: RedirectHop[] = [];
  const base: SafeResponse = {
    ok: false,
    requestedUrl,
    finalUrl: requestedUrl,
    status: null,
    headers: {},
    body: null,
    truncated: false,
    redirects,
    durationMs: 0,
    ttfbMs: null,
    failure: null,
  };

  let current: URL;
  try {
    current = new URL(requestedUrl);
  } catch {
    return { ...base, failure: { kind: 'protocol', message: 'Invalid URL.' } };
  }

  // A single deadline covers all redirect hops.
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  for (let hop = 0; ; hop++) {
    try {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return { ...base, finalUrl: current.href, durationMs: Date.now() - started, failure: { kind: 'invalid_redirect', message: `Redirect to unsupported scheme ${current.protocol}` } };
      }
      assertHostAllowed(current.hostname, effectivePort(current));
      const res = await one(current, { ...opts, signal });
      const headers = flattenHeaders(res.headers);
      const location = headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return { ...base, finalUrl: current.href, status: res.status, headers, durationMs: Date.now() - started, failure: { kind: 'invalid_redirect', message: `Invalid redirect location "${location.slice(0, 200)}"` } };
        }
        redirects.push({ url: current.href, status: res.status, location: next.href, ms: res.headersMs });
        if (hop + 1 > maxRedirects) {
          return { ...base, finalUrl: next.href, status: res.status, headers, durationMs: Date.now() - started, failure: { kind: 'too_many_redirects', message: `More than ${maxRedirects} redirects.` } };
        }
        next.hash = '';
        current = next;
        continue;
      }
      return {
        ...base,
        ok: res.status >= 200 && res.status < 400,
        finalUrl: current.href,
        status: res.status,
        headers,
        body: res.body,
        truncated: res.truncated,
        durationMs: Date.now() - started,
        ttfbMs: res.headersMs,
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const failure = signal.aborted && !(err instanceof BlockedTargetError) && err.code !== 'EBLOCKEDTARGET'
        ? { kind: 'timeout' as const, message: `No complete response within ${Math.round(opts.timeoutMs / 1000)} s.` }
        : classify(err);
      return { ...base, finalUrl: current.href, durationMs: Date.now() - started, failure };
    }
  }
}
