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
 * ⚠ และต้องล็อกอินก่อนเสมอ (audit 2026-08-10): เดิม route นี้ไม่ตรวจผู้เรียกเลย ใครที่รู้แค่ URL
 * เว็บก็ยิง POST เข้ามาได้ → (ก) ส่งข้อความปลอมหน้าตาเหมือนแจ้งเตือนจริงเข้า LINE เจ้าของ
 * (ข) ยิงวนเผาโควตา LINE จนแจ้งเตือนของจริง (สลิปใหม่/สมาชิกใหม่) เงียบหายทั้งเดือน
 * ใช้กติกาเดียวกับ /api/push-send: Bearer token ของ Supabase + เพดานต่อคนต่อนาที
 *
 * POST { message: string }  ·  headers: Authorization: Bearer <supabase access token>
 */
export const runtime = 'edge';

// เพดานต่อผู้ใช้: งานจริงยิงทีละข้อความตอนกดปุ่ม — 20/นาทีเหลือเฟือ และกันการเผาโควตา
const WINDOW_MS = 60_000;
const MAX_PER_USER = 20;
const hits = new Map<string, { n: number; until: number }>();

function rateLimited(uid: string): boolean {
  const now = Date.now();
  const cur = hits.get(uid);
  if (!cur || now > cur.until) { hits.set(uid, { n: 1, until: now + WINDOW_MS }); return false; }
  cur.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.until) hits.delete(k);
  return cur.n > MAX_PER_USER;
}

async function callerUid(req: Request): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anon) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!r.ok) return null;
    const u = (await r.json()) as { id?: string };
    return u?.id ?? null;
  } catch { return null; }
}

export async function POST(req: Request) {
  const token = process.env.LINE_CHANNEL_TOKEN;
  const to = process.env.LINE_ADMIN_TO;
  if (!token || !to) return NextResponse.json({ ok: false, error: 'LINE not configured' }, { status: 200 }); // silently off until env is set

  const uid = await callerUid(req);
  if (!uid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (rateLimited(uid)) return NextResponse.json({ error: 'rate limited' }, { status: 429 });

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
