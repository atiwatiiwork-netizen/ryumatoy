/**
 * Fire-and-forget shop-owner notifications (LINE). Never blocks or breaks the calling
 * flow — if LINE isn't configured (no env) the API no-ops. Recipient is resolved
 * SERVER-side (LINE_ADMIN_TO); callers only pass the message text.
 */
export function notifyAdminLine(message: string): void {
  try {
    void fetch('/api/line-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }).catch(() => { /* notification is best-effort */ });
  } catch { /* SSR / fetch unavailable — ignore */ }
}
