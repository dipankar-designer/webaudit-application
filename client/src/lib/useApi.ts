import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api';

export interface ApiState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Longest wait between retries when a polled request keeps failing. */
const MAX_RETRY_MS = 60_000;

/**
 * Loads `path` and keeps it fresh. `pollMs` re-fetches while `shouldPoll(data)` is true
 * (e.g. while a scan is running). Pass `null` as the path to skip loading.
 *
 * Data and errors belong to the path they were loaded for: after the path changes (another tab,
 * range, scan) the previous answer is not returned as if it were the new one, and `loading` stays
 * true until the new answer arrives. `keepPrevious` opts out for paginated lists, which keep showing
 * the previous page (dimmed) while the next one loads.
 *
 * A failed poll keeps retrying (backing off up to a minute) while the last good data still wants
 * polling, so one network blip or server restart does not freeze a live view.
 */
export function useApi<T>(path: string | null, opts: { pollMs?: number; shouldPoll?: (d: T) => boolean; keepPrevious?: boolean } = {}): ApiState<T> {
  const [result, setResult] = useState<{ path: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ path: string; error: unknown } | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastGood: T | null = null;
    let failures = 0;
    const load = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const d = await get<T>(path, ctrl.signal);
        if (ctrl.signal.aborted) return;
        lastGood = d;
        failures = 0;
        setResult({ path, data: d });
        setFailure(null);
        const { pollMs, shouldPoll } = optsRef.current;
        if (pollMs && shouldPoll?.(d)) timer = setTimeout(() => void load(false), pollMs);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setFailure({ path, error: e });
        const { pollMs, shouldPoll } = optsRef.current;
        if (pollMs && lastGood !== null && shouldPoll?.(lastGood)) {
          failures++;
          timer = setTimeout(() => void load(false), Math.min(pollMs * 2 ** (failures - 1), MAX_RETRY_MS));
        }
      } finally {
        // An aborted run (unmount, path change, StrictMode re-run) must not touch state the next run owns.
        if (first && !ctrl.signal.aborted) setLoading(false);
      }
    };
    void load(true);
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = !!path && result?.path === path;
  const data = current || (opts.keepPrevious && path) ? (result?.data ?? null) : null;
  const error = path && failure?.path === path ? failure.error : null;
  // Until this path has an answer (data or error), it is still loading.
  const settled = current || (!!path && failure?.path === path);
  return { data, error, loading: path ? loading || !settled : false, reload };
}
