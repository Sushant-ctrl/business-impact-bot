import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PortalView, Role } from '../../shared/types.ts';

export class ApiError extends Error {}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Calls `fn` whenever the server reports a change (any portal, any user). */
export function useLiveUpdates(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('change', () => ref.current());
    return () => es.close();
  }, []);
}

export interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'danger' | 'info';
}

interface PortalCtx {
  view: PortalView;
  role: Role;
  partyId: string;
  /** Runs a portal command. Shows errors as a toast and resolves to null on failure. */
  act: <T = unknown>(method: string, path: string, body?: unknown, success?: string) => Promise<T | null>;
  /** Calls an endpoint without changing data (AI helpers). Throws ApiError on failure. */
  ask: <T>(path: string, body: unknown) => Promise<T>;
  toast: (message: string, tone?: Toast['tone']) => void;
}

const Ctx = createContext<PortalCtx | null>(null);

export function PortalProvider({
  role,
  partyId,
  children,
  onToast,
}: {
  role: Role;
  partyId: string;
  children: ReactNode;
  onToast: (message: string, tone?: Toast['tone']) => void;
}) {
  const [view, setView] = useState<PortalView | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const base = `/api/${role}/${partyId}`;

  // Responses can arrive out of order when several changes land quickly; keep only the newest.
  const accept = useCallback((v: PortalView, n: number) => {
    if (n >= seq.current) setView(v);
  }, []);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      accept(await api<PortalView>('GET', `${base}/view`), n);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, accept]);

  useEffect(() => {
    setView(null);
    refresh();
  }, [refresh]);
  useLiveUpdates(refresh);

  const act = useCallback(
    async <T,>(method: string, path: string, body?: unknown, success?: string) => {
      const n = ++seq.current;
      try {
        const res = await api<{ view?: PortalView } & T>(method, base + path, body ?? {});
        if (res.view) accept(res.view, n);
        if (success) onToast(success, 'success');
        return res as T;
      } catch (e) {
        onToast((e as Error).message, 'danger');
        return null;
      }
    },
    [base, accept, onToast],
  );

  const ask = useCallback(<T,>(path: string, body: unknown) => api<T>('POST', base + path, body), [base]);

  if (error && !view)
    return (
      <div className="center-page">
        <div className="callout callout-danger">Could not load the portal: {error}</div>
      </div>
    );
  if (!view) return <div className="center-page muted">Loading…</div>;
  return <Ctx.Provider value={{ view, role, partyId, act, ask, toast: onToast }}>{children}</Ctx.Provider>;
}

export function usePortal() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePortal outside PortalProvider');
  return ctx;
}
