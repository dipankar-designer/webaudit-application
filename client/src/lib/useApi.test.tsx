import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('./api', () => ({ get: (path: string) => get(path) }));
const { useApi } = await import('./useApi');

beforeEach(() => {
  get.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('useApi', () => {
  it('does not show the previous path’s data as the new path’s, and stays loading until it arrives', async () => {
    let release!: (v: string) => void;
    get.mockImplementation((p: string) => (p === '/a' ? Promise.resolve('A') : new Promise((r) => (release = r))));
    const { result, rerender } = renderHook(({ path }) => useApi<string>(path), { initialProps: { path: '/a' } });
    await waitFor(() => expect(result.current.data).toBe('A'));
    rerender({ path: '/b' });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => release('B'));
    expect(result.current.data).toBe('B');
    expect(result.current.loading).toBe(false);
  });

  it('keeps the previous page visible with keepPrevious (paginated lists)', async () => {
    get.mockImplementation((p: string) => (p === '/p1' ? Promise.resolve('page 1') : new Promise(() => {})));
    const { result, rerender } = renderHook(({ path }) => useApi<string>(path, { keepPrevious: true }), { initialProps: { path: '/p1' } });
    await waitFor(() => expect(result.current.data).toBe('page 1'));
    rerender({ path: '/p2' });
    expect(result.current.data).toBe('page 1');
    expect(result.current.loading).toBe(true);
  });

  it('keeps polling after a failed refresh, and recovers', async () => {
    vi.useFakeTimers();
    get.mockResolvedValueOnce({ running: true, n: 1 }).mockRejectedValueOnce(new Error('502')).mockResolvedValueOnce({ running: true, n: 2 });
    const { result } = renderHook(() => useApi<{ running: boolean; n: number }>('/scan', { pollMs: 1000, shouldPoll: (d) => d.running }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.data?.n).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1000)); // poll fails
    expect(result.current.error).toBeTruthy();
    expect(result.current.data?.n).toBe(1); // last good data stays
    await act(async () => vi.advanceTimersByTimeAsync(1000)); // retried, succeeds
    expect(result.current.data?.n).toBe(2);
    expect(result.current.error).toBeNull();
    expect(get).toHaveBeenCalledTimes(3);
  });
});
