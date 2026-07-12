/** Shared PWA/standalone detection (used by InstallBellNudge + the install-rate marker in CustomerShell). */

export type Platform = 'ios' | 'android' | 'desktop';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'desktop';
}

/** True when the app is running installed to the home screen (standalone display mode). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}
