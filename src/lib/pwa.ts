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

export type InAppKind = 'line' | 'facebook' | 'instagram' | 'other';

/** Detect an in-app browser (webview) like LINE / Facebook / Instagram, where "Add to Home Screen" and
 *  Web Push are NOT available — the user must open the link in Safari/Chrome first. */
export function inAppBrowser(): { inApp: boolean; kind?: InAppKind } {
  if (typeof navigator === 'undefined') return { inApp: false };
  const ua = navigator.userAgent || '';
  if (/\bLine\//i.test(ua)) return { inApp: true, kind: 'line' };
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return { inApp: true, kind: 'facebook' };
  if (/Instagram/i.test(ua)) return { inApp: true, kind: 'instagram' };
  if (/Messenger|MicroMessenger|TikTok|Snapchat/i.test(ua)) return { inApp: true, kind: 'other' };
  return { inApp: false };
}
