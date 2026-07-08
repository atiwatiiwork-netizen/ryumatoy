import { NextResponse } from 'next/server';

/**
 * LINE Messaging API push — notifies the SHOP OWNER's LINE about shop events
 * (new order slip, new remaining-payment slip, new signup).
 *
 * Server-only secrets (set in Vercel):
 *   LINE_CHANNEL_TOKEN — Messaging API channel access token
 *   LINE_ADMIN_TO      — the owner's LINE userId (U...) or a group id (must have added the OA)
 *
 * SECURITY: the recipient is ALWAYS resolved server-side from LINE_ADMIN_TO. The client can
 * only pass { message } — never a target — so nobody can borrow our channel token to push
 * messages to arbitrary LINE users.
 *
 * POST { message: string }
 */
export const runtime = 'edge';

export async function POST(req: Request) {
  const token = process.env.LINE_CHANNEL_TOKEN;
  const to = process.env.LINE_ADMIN_TO;
  if (!token || !to) return NextResponse.json({ ok: false, error: 'LINE not configured' }, { status: 200 }); // silently off until env is set

  let body: { message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const message = (body.message ?? '').slice(0, 1000).trim();
  if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: message }] }),
  });

  return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : 502 });
}
