'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { isAdminUser } from '@/domain/services/admins';
import { shopLines, linesPublicEnabled, isNewLine } from '@/domain/services/lines';
import { LineCoverCard } from './LineCoverCard';

/**
 * แถบ "ไลน์" บนหน้าช็อป — การ์ดใช้รูปหมู่ของค่ายเป็นปก กดแล้วเข้าหน้าไลน์ (เจ้าของ 2026-10-07)
 * ลูกค้า: โชว์เมื่อสวิตช์ใหญ่เปิด + ไลน์ไม่ใช่ร่าง + มีรูปปก + มีตัวที่เห็นได้ (shopLines) · ไม่มี = ไม่วาดอะไรเลย
 * แอดมิน: เห็นทุกไลน์พร้อมป้าย "ร่าง"/"แอดมินเห็นคนเดียว" — ลองในหน้าร้านจริงก่อนเปิด
 * ชิปนับบนการ์ดนับ "ตัวที่เปิดรับพรีอยู่" (memberOpenForPreorder — ไม่ขึ้นกับสต๊อก) — ตัวเลขสต๊อกฝั่งลูกค้าต้องมาจาก
 * server ซึ่งถามในหน้าไลน์เท่านั้น (การ์ดไม่ถาม) จึงไม่โชว์จำนวนพร้อมส่งบนการ์ด
 */
export function LineStrip({ makerId, franchiseId, query }: { makerId?: string | null; franchiseId?: string | null; query?: string }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const lines = shopLines(db, uid, { makerId, franchiseId, query });
  if (lines.length === 0) return null;
  const admin = isAdminUser(db, uid);
  const pub = linesPublicEnabled(db);
  return (
    <div className="mb-6">
      <div className="mb-2.5 flex items-center gap-2 text-[15px] font-extrabold lg:text-base">
        <span className="h-4 w-1 rounded-full bg-primary-bright" /> ไลน์ · ดูทั้งชุด
        {admin && !pub && <span className="rounded-md bg-[#f59e0b]/15 px-2 py-0.5 text-[10.5px] font-bold text-[#fbbf24]">แอดมินเห็นคนเดียว</span>}
        <Link href="/lines" className="ml-auto text-[12.5px] font-semibold text-primary-soft">ดูทั้งหมด →</Link>
      </div>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 no-scrollbar lg:mx-0 lg:px-0">
        {lines.map((l) => <LineCoverCard key={l.id} db={db} line={l} size="rail" admin={admin} isNew={isNewLine(l)} />)}
      </div>
    </div>
  );
}
