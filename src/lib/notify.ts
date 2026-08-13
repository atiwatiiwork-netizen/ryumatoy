import { supabase } from '@/data/supabaseClient';

/**
 * Fire-and-forget shop-owner notifications (LINE). Never blocks or breaks the calling
 * flow — if LINE isn't configured (no env) the API no-ops. Recipient is resolved
 * SERVER-side (LINE_ADMIN_TO); callers only pass the message text.
 *
 * ⚠ ต้องแนบ token ของคนที่ล็อกอินอยู่ (audit 2026-08-10): /api/line-send ถูกปิดให้เฉพาะ
 * ผู้ใช้ที่ล็อกอินแล้ว ไม่งั้นคนนอกที่รู้แค่ URL เว็บยิงข้อความปลอม/เผาโควตา LINE ได้
 * DNA: ทุก await ที่วิ่งเน็ตต้องมีเพดานเวลา — getSession() เคยค้างตอนกลับจากพักหน้าจอ
 */
export function notifyAdminLine(message: string): void {
  try {
    void (async () => {
      const token = supabase
        ? await Promise.race([
            supabase.auth.getSession().then((r) => r.data.session?.access_token),
            new Promise<undefined>((r) => setTimeout(() => r(undefined), 4_000)),
          ])
        : undefined;
      if (!token) return; // ยังไม่ล็อกอิน (หรือ session ค้าง) — แจ้งเตือนเป็น best-effort อยู่แล้ว
      await fetch('/api/line-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message }),
      });
    })().catch(() => { /* notification is best-effort */ });
  } catch { /* SSR / fetch unavailable — ignore */ }
}
