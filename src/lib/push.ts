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
  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready; // subscribe only on an ACTIVE worker
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('denied');
  // Always start from a FRESH endpoint: if this browser still holds a subscription from a
  // previous login (shared device), reusing its endpoint would collide with the other account's
  // row (unique index) and poison the persist loop. Unsubscribing first forces a new endpoint;
  // the stale row then points at a dead endpoint and gets pruned on the next send (410).
  const old = await reg.pushManager.getSubscription();
  if (old) { try { await old.unsubscribe(); } catch { /* already dead */ } }
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

/** Admin kill-switch per trigger (Push Control page). Missing key = enabled. */
export const pushEnabled = (db: Database, key: string): boolean =>
  db.pushConfig.find((c) => c.key === key)?.enabled ?? true;

/** Devices to receive a NEW-PRODUCT broadcast, honoring each customer's ค่าย/เรื่อง preferences.
 *  No pref row (or an empty dimension) = รับทั้งหมด; both dimensions set = AND. Account events
 *  (order approved, parcel, …) are NOT filtered — only these broadcasts are. */
export function subsForNewProduct(db: Database, product: { manufacturer_id: string; franchise_id: string }): PushRow[] {
  return db.pushSubscriptions.filter((s) => {
    const p = db.pushPrefs.find((x) => x.user_id === s.user_id);
    if (!p) return true;
    const mOk = !p.maker_ids?.length || p.maker_ids.includes(product.manufacturer_id);
    const fOk = !p.franchise_ids?.length || p.franchise_ids.includes(product.franchise_id);
    return mOk && fOk;
  });
}

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
