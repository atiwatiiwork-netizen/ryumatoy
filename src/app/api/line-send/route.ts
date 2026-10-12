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

// เพดานต่อผู้ใช้: งานจริงยิงทีละข้อความตอนกดปุ่ม · ลูกค้า 6/นาที (สลิป/สมัคร/ดีลตลาด) · แอดมิน 20/นาที
//   (audit 2026-10-12 M19: เดิมใครล็อกอินก็ยิงข้อความอะไรก็ได้ 20/นาที → ปลอมเป็น "รอไฟนอล" / เผาโควตา LINE ได้)
const WINDOW_MS = 60_000;
const MAX_ADMIN = 20;
const MAX_CUSTOMER = 6;
const hits = new Map<string, { n: number; until: number }>();

function rateLimited(uid: string, max: number): boolean {
  const now = Date.now();
  const cur = hits.get(uid);
  if (!cur || now > cur.until) { hits.set(uid, { n: 1, until: now + WINDOW_MS }); return false; }
  cur.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.until) hits.delete(k);
  return cur.n > max;
}

/** ผู้ส่งเป็นใคร (แถว users ของตัวเอง — อ่านด้วย token ของผู้เรียก ผ่าน RLS) · null = อ่านไม่ได้ */
async function callerMember(token: string, uid: string): Promise<{ is_admin?: boolean; member_code?: string | null; display_name?: string | null } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  try {
    const r = await fetch(`${url}/rest/v1/users?select=is_admin,member_code,display_name&auth_id=eq.${encodeURIComponent(uid)}&limit=1`,
      { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!r.ok) return null;
    const rows = (await r.json()) as { is_admin?: boolean; member_code?: string | null; display_name?: string | null }[];
    return rows[0] ?? null;
  } catch { return null; }
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
  const bearer = (req.headers.get('authorization') ?? '').slice(7).trim();
  const member = await callerMember(bearer, uid);
  const isAdmin = member?.is_admin === true;
  if (rateLimited(uid, isAdmin ? MAX_ADMIN : MAX_CUSTOMER)) return NextResponse.json({ error: 'rate limited' }, { status: 429 });

  let body: { message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const raw = (body.message ?? '').slice(0, isAdmin ? 1000 : 500).trim();
  if (!raw) return NextResponse.json({ error: 'message required' }, { status: 400 });
  // ข้อความจากเครื่องลูกค้า: ต่อท้ายด้วยตัวตนผู้ส่งเสมอ (เซิร์ฟเวอร์เติมเอง ลูกค้าปลอมไม่ได้) — เจ้าของรู้ทันทีว่าใครส่ง
  //   ยังไม่มีรหัสสมาชิก (สมัครใหม่รออนุมัติ) → ห้ามใช้ชื่อเฉยๆ เพราะตั้งชื่อเลียนรหัสสมาชิกคนอื่นได้ (review รอบ 2)
  const who = member?.member_code || `ชื่อ "${(member?.display_name ?? '').slice(0, 40)}" (ยังไม่มีรหัสสมาชิก · ${uid.slice(0, 8)})`;
  const message = isAdmin ? raw : `${raw}\n— ส่งจากบัญชีลูกค้า ${who}`;

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: message }] }),
  });

  return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : 502 });
}
