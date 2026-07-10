import type { Database, PushSubscription as PushRow } from '@/domain/entities';
import { addPushSubscription, removePushSubscriptionByEndpoint } from '@/data/mutations';

/**
 * Web Push helpers. VAPID public key is safe to embed (it only identifies the sender);
 * the PRIVATE key lives server-side only (VAPID_PRIVATE_KEY env, used by /api/push-send).
 *
 * iOS note: works on iOS 16.4+ ONLY when the site is added to the Home Screen (standalone) —
 * in plain Safari `Notification` doesn't exist, so pushSupported() is false and the UI explains.
 */
export const PUSH_PUBLIC_KEY = 'BJNgtqF8a32hBP8ulKvPfqMt5JN0cAO_8RrFjRNKMQ-7j8_127ozkzMU3x75kJwMez9glV6LwAmDzrvGxtAH5I0';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** The device's current subscription, or null. */
export async function currentPushSubscription(): Promise<globalThis.PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  return reg ? reg.pushManager.getSubscription() : null;
}

type Dispatch = (m: (db: Database) => Database) => void;

/** Ask permission + subscribe this device + save the row (must run from a user tap). */
export async function enablePush(userId: string, dispatch: Dispatch): Promise<void> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('denied');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(PUSH_PUBLIC_KEY) as BufferSource });
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error('bad-subscription');
  dispatch(addPushSubscription({ id: `ps-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, user_id: userId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, created_at: new Date().toISOString() }));
}

/** Unsubscribe this device + drop its row. */
export async function disablePush(dispatch: Dispatch): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  dispatch(removePushSubscriptionByEndpoint(sub.endpoint));
  try { await sub.unsubscribe(); } catch { /* endpoint already dead */ }
}

// ── sending (admin session) ──────────────────────────────────────────────────
export type PushPayload = { title: string; body: string; url?: string };

/** Owner-approved wording for the per-customer lot updates (ryuma spec 4.1/4.2). */
export const statusPushPayload = (status: 'shipping' | 'arrived', productName: string): PushPayload =>
  status === 'shipping'
    ? { title: '🚚 ของกำลังเดินทางมาไทย', body: `${productName} ออกจากจีนแล้ว — เริ่มชำระส่วนต่างได้เลย`, url: '/wallet' }
    : { title: '📦 สินค้าถึงไทยแล้ว!', body: `${productName} พร้อมส่ง — ชำระส่วนต่างเพื่อรับของได้เลย`, url: '/wallet' };

export const subsAll = (db: Database): PushRow[] => db.pushSubscriptions;
export const subsForUsers = (db: Database, userIds: string[]): PushRow[] =>
  db.pushSubscriptions.filter((s) => userIds.includes(s.user_id));
/** Every device of every customer holding a ticket on this product. */
export const subsForProductOwners = (db: Database, productId: string): PushRow[] =>
  subsForUsers(db, [...new Set(db.tickets.filter((t) => t.product_id === productId).map((t) => t.owner_id))]);

/** Send a notification to a set of devices, then prune endpoints the browser has revoked.
 *  Fire-and-forget from admin flows — a push must never block or fail the actual save. */
export async function sendPush(subs: PushRow[], payload: PushPayload, dispatch?: Dispatch): Promise<{ sent: number; gone: string[] }> {
  if (subs.length === 0) return { sent: 0, gone: [] };
  const res = await fetch('/api/push-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subs: subs.map((s) => ({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth })), payload }),
  });
  if (!res.ok) throw new Error(`push-send ${res.status}`);
  const out = (await res.json()) as { sent: number; gone: string[] };
  if (dispatch) for (const e of out.gone) dispatch(removePushSubscriptionByEndpoint(e));
  return out;
}
