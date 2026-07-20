'use client';

import { useEffect, type ReactNode } from 'react';
import { DataProvider } from '@/state/DataProvider';
import { AuthProvider } from '@/state/AuthProvider';
import { CartProvider } from '@/state/CartProvider';
import { ToastProvider } from '@/state/ToastProvider';

/**
 * STALE-DEPLOY GUARD (resume hang #7b): a PWA resumed days later still runs the OLD build's HTML,
 * whose lazy chunks (/_next/static/...) 404 after we deploy a new version — tapping a link then
 * hangs on a dead navigation / white screen. A failed chunk import is unrecoverable in-page; the
 * only fix is a reload (fresh HTML + fresh chunk urls). Loop-guarded like ProfileGate's auto-reload
 * (max 2 bursts / 2 min) so a truly-broken network can't reload-spin.
 */
function useStaleDeployReload() {
  useEffect(() => {
    const isChunkError = (msg: string) =>
      /Loading chunk .* failed|ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg);
    const reloadOnce = () => {
      try {
        const g = JSON.parse(sessionStorage.getItem('ryuma_chunk_reload') ?? '{"n":0,"ts":0}') as { n: number; ts: number };
        const stale = Date.now() - g.ts > 120_000;
        if (g.n < 2 || stale) {
          sessionStorage.setItem('ryuma_chunk_reload', JSON.stringify({ n: stale ? 1 : g.n + 1, ts: Date.now() }));
          window.location.reload();
        }
      } catch { window.location.reload(); }
    };
    const onError = (e: ErrorEvent) => { if (isChunkError(e.message ?? '')) reloadOnce(); };
    const onRejection = (e: PromiseRejectionEvent) => {
      const m = e.reason instanceof Error ? `${e.reason.name} ${e.reason.message}` : String(e.reason ?? '');
      if (isChunkError(m)) reloadOnce();
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);
}

/** Client-side provider stack shared by the whole app. */
export function Providers({ children }: { children: ReactNode }) {
  useStaleDeployReload();
  return (
    <DataProvider>
      <AuthProvider>
        <CartProvider>
          <ToastProvider>{children}</ToastProvider>
        </CartProvider>
      </AuthProvider>
    </DataProvider>
  );
}
