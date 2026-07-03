'use client';

import { createContext, useContext, useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Database } from '@/domain/entities';
import { store, type Mutation } from '@/data/store';

/**
 * React binding for the central store (same pattern as the Vite build, now a
 * client component). Components read with `useDatabase()` and write with
 * `useDispatch()`; they never hold their own copy of business data.
 */
const StoreContext = createContext(store);

export function DataProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void store.init();
    // Auto-refresh so customers see approvals / new products without a manual reload. Uses the
    // idle-guarded reload (never clobbers unsaved edits or the cart, which lives outside the store).
    const refresh = () => { if (document.visibilityState === 'visible') void store.reloadIfIdle(); };
    const onFocus = () => void store.reloadIfIdle();
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', onFocus);
    const timer = setInterval(refresh, 40_000); // gentle poll while the tab is open
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, []);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore() {
  return useContext(StoreContext);
}

export function useDatabase(): Database {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}

export function useReady(): boolean {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.isReady, s.isReady);
}

export function useDispatch() {
  const s = useStore();
  return useCallback((mutation: Mutation) => s.update(mutation), [s]);
}
