import { NextResponse } from 'next/server';
import webpush from 'web-push';
import { PUSH_PUBLIC_KEY } from '@/lib/push';

export const runtime = 'nodejs';

/**
 * Send a Web-Push notification to a list of device subscriptions.
 * The caller (browser) supplies the target subscriptions — it can read them via RLS;
 * this route only holds the VAPID PRIVATE key (env), so no Supabase secret is needed here.
 *
 * 🔒 AUTH (ปิดช่องโหว่ 2026-07-25 — เดิมใครก็ยิงได้ ไม่ต้อง login):
 * ต้องแนบ Authorization: Bearer <supabase access token> และ token ต้องใช้ได้จริงกับโปรเจกต์นี้
 * (ตรวจกับ /auth/v1/user). อนุญาตทุกผู้ใช้ที่ล็อกอิน เพราะลูกค้าก็ต้องยิงหาแอดมินได้
 * (เช่น ส่งเรื่องหาของ / จ่ายมัดจำ) แต่คนนอกยิง spam ทุก endpoint ไม่ได้อีกต่อไป
 * + rate limit ต่อผู้ใช้แบบ best-effort กันยิงรัว
 */

// นับเป็น "จำนวนเครื่องที่ยิง" ไม่ใช่ "จำนวนครั้งที่เรียก":
// งานจริงของแอดมิน (กดของถึงไทย 1 รอบ) ยิงทีละคนเพื่อแนบลิงก์ตั๋วรายบุคคล → รอบใหญ่ = 40-100 คำขอรวด
// เพดานเดิม 30 ครั้ง/นาที ทำให้ลูกค้าท้ายแถวไม่ได้รับแจ้งเตือนแบบเงียบๆ (audit v56)
const WINDOW_MS = 60_000;
const MAX_CALLS = 300;     // ต่อผู้ใช้ ต่อนาที
const MAX_DEVICES = 3000;  // เพดานจริงที่กันสแปม (1 คำขอพา endpoint ได้ถึง 500 อยู่แล้ว)
const hits = new Map<string, { n: number; devices: number; until: number }>();

function rateLimited(uid: string, deviceCount: number): boolean {
  const now = Date.now();
  const cur = hits.get(uid);
  if (!cur || now > cur.until) { hits.set(uid, { n: 1, devices: deviceCount, until: now + WINDOW_MS }); return false; }
  cur.n += 1;
  cur.devices += deviceCount;
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.until) hits.delete(k); // กันแมพโตไม่หยุด
  return cur.n > MAX_CALLS || cur.devices > MAX_DEVICES;
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
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) return NextResponse.json({ error: 'VAPID_PRIVATE_KEY not set' }, { status: 503 });

  const uid = await callerUid(req);
  if (!uid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { subs?: { endpoint: string; p256dh: string; auth: string }[]; payload?: { title?: string; body?: string; url?: string } };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const subs = (body.subs ?? []).filter((s) => s?.endpoint && s?.p256dh && s?.auth).slice(0, 500);
  const payload = body.payload ?? {};
  if (subs.length === 0 || !payload.title) return NextResponse.json({ error: 'subs + payload.title required' }, { status: 400 });
  if (rateLimited(uid, subs.length)) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

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
