'use client';

import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { marketSandbox } from '@/lib/marketSandbox';
import { hasBell } from '@/domain/services/market';
import { PushToggle } from '@/components/PushToggle';

/**
 * ด่าน "เปิดกระดิ่งก่อน" (เจ้าของ 2026-10-11: "ทั้งผู้ซื้อ ผู้ขาย ต้องเปิดกระดิ่ง ให้เช็คตรงนี้ก่อน ตั้งแต่ตอนลงขาย / ผู้ซื้อที่จะกดซื้อ")
 *   ทุกขั้นของดีล (มีคนจอง · โอนเงิน · คนขายตอบ · ร้านโอนสิทธิ์) แจ้งผ่าน push — ไม่มีกระดิ่ง = พลาดดีล/ปล่อยคนรอ
 *   เปิดกระดิ่ง = มีเครื่องรับแจ้งเตือนผูกกับบัญชี (hasBell · นิยามเดียวกับภารกิจ) · ด่านจริงอยู่ที่ SQL (v84 no_bell)
 *   ใช้ PushToggle ตัวเดียวกับหน้าโปรไฟล์ (มีคำแนะนำ iPhone/ติดตั้งแอปครบ) · โหมดทดลองเล่น = ปุ่มจำลอง (ไม่แตะสิทธิ์จริงของเบราว์เซอร์)
 */
export function useBellOk(): boolean {
  const db = useDatabase();
  const uid = useCurrentUserId();
  return hasBell(db, uid);
}

export function BellGate({ action }: { action: string }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const dispatch = useDispatch();
  const { flash } = useToast();
  if (hasBell(db, uid)) return null;
  const sandbox = !!marketSandbox();
  const fakeOn = () => {
    dispatch((d) => ({ ...d, pushSubscriptions: [...d.pushSubscriptions, { id: `ps-sb-${uid}`, user_id: uid, endpoint: 'sandbox://bell', p256dh: '-', auth: '-', created_at: new Date().toISOString() }] }));
    flash('เปิดกระดิ่งแล้ว 🔔 (จำลอง)');
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-[#fbbf24]/45 bg-[#fbbf24]/[0.08]">
      <div className="px-3.5 pb-2 pt-3">
        <div className="text-[14px] font-bold text-[#fbbf24]">🔔 เปิดกระดิ่งก่อน{action}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted2">
          ทุกขั้นของดีลแจ้งผ่านการแจ้งเตือน — มีคนจอง · โอนเงิน · อีกฝั่งตอบ · ร้านโอนสิทธิ์ ไม่เปิดกระดิ่ง = พลาดดีลหรือปล่อยอีกฝั่งรอ
        </div>
      </div>
      {sandbox ? (
        <button type="button" onClick={fakeOn} className="w-full border-t border-[#fbbf24]/30 px-4 py-3 text-left text-[13px] font-bold text-[#fbbf24]">
          🔔 เปิดกระดิ่ง (จำลอง · โหมดทดลองเล่น)
        </button>
      ) : (
        <div className="border-t border-[#fbbf24]/30 bg-surface-2"><PushToggle userId={uid} /></div>
      )}
    </div>
  );
}
