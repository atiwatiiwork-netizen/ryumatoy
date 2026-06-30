import { NextResponse } from 'next/server';

/**
 * LINE Messaging API push (PRD §15). Server-only — the channel token is a secret
 * (set LINE_CHANNEL_TOKEN in Vercel), never exposed to the browser.
 *
 * POST { to: string, message: string }
 */
export const runtime = 'edge';

export async function POST(req: Request) {
  const token = process.env.LINE_CHANNEL_TOKEN;
  if (!token) return NextResponse.json({ error: 'LINE_CHANNEL_TOKEN not set' }, { status: 500 });

  let body: { to?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!body.to || !body.message) return NextResponse.json({ error: 'to and message required' }, { status: 400 });

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: body.to, messages: [{ type: 'text', text: body.message }] }),
  });

  return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : 502 });
}
