import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SessionDTO } from '@wpcg/shared';
import { ApiError, get, onUnauthorised, post, setCsrfToken } from './api';

interface SessionContextValue {
  session: SessionDTO | null;
  loading: boolean;
  refresh: () => Promise<SessionDTO | null>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await get<SessionDTO>('/auth/me');
      setCsrfToken(s.csrfToken);
      setSession(s);
      return s;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.warn('Session check failed', e);
      setSession(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await post('/auth/logout').catch(() => {});
    setCsrfToken('');
    setSession(null);
  }, []);

  useEffect(() => {
    void refresh();
    return onUnauthorised(() => setSession(null));
  }, [refresh]);

  return <SessionContext.Provider value={{ session, loading, refresh, logout }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
