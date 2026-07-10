import { NextResponse } from 'next/server';
import webpush from 'web-push';
import { PUSH_PUBLIC_KEY } from '@/lib/push';

export const runtime = 'nodejs';

/**
 * Send a Web-Push notification to a list of device subscriptions.
 * The caller (admin browser) supplies the target subscriptions — it can read them via RLS;
 * this route only holds the VAPID PRIVATE key (env), so no Supabase secret is needed here.
 * Returns endpoints the push service reported gone (404/410) so the caller can prune them.
 */
export async function POST(req: Request) {
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) return NextResponse.json({ error: 'VAPID_PRIVATE_KEY not set' }, { status: 503 });

  let body: { subs?: { endpoint: string; p256dh: string; auth: string }[]; payload?: { title?: string; body?: string; url?: string } };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const subs = (body.subs ?? []).filter((s) => s?.endpoint && s?.p256dh && s?.auth).slice(0, 500);
  const payload = body.payload ?? {};
  if (subs.length === 0 || !payload.title) return NextResponse.json({ error: 'subs + payload.title required' }, { status: 400 });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@ryumatoy.app', PUSH_PUBLIC_KEY, priv);
  const json = JSON.stringify({ title: payload.title, body: payload.body ?? '', url: payload.url ?? '/' });

  let sent = 0;
  const gone: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, json, { TTL: 86400 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint); // device revoked → caller prunes the row
      // other errors (throttling, network) are dropped silently — a promo push is best-effort
    }
  }));

  return NextResponse.json({ sent, gone });
}
