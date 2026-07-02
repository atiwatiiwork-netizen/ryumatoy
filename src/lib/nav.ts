'use client';

import { useRouter } from 'next/navigation';

/**
 * DNA rule — BACK NAVIGATION: every back button in the app returns to the page the
 * user actually came from (true browser history), never a hard-coded route. Only when
 * there is no history to go back to (e.g. a page opened from a direct link / new tab)
 * do we fall back to a sensible default.
 *
 * Never use router.push('/somewhere') as a "back" action — that ADDS a history entry
 * and breaks the next back press (this is exactly why checkout→back→cart→back used to
 * bounce to checkout). Always use this hook for back buttons.
 */
export function useSmartBack(fallback = '/') {
  const router = useRouter();
  return () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push(fallback);
  };
}
