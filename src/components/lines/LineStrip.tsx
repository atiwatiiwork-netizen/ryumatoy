'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { isAdminUser } from '@/domain/services/admins';
import { shopLines, lineStates, linesPublicEnabled, memberOpenForPreorder } from '@/domain/services/lines';
import type { Database, ProductLine } from '@/domain/entities';

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
      </div>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 no-scrollbar lg:mx-0 lg:px-0">
        {lines.map((l) => <LineCoverCard key={l.id} db={db} line={l} admin={admin} />)}
      </div>
    </div>
  );
}

function LineCoverCard({ db, line, admin }: { db: Database; line: ProductLine; admin: boolean }) {
  const states = lineStates(db, line, { uid: '' }).filter((s) => s.state.visible);
  const openN = states.filter((s) => memberOpenForPreorder(db, s.member)).length;
  const maker = db.manufacturers.find((m) => m.id === line.maker_id)?.name ?? '';
  return (
    <Link href={`/line/${line.id}`} className="relative block w-[260px] shrink-0 overflow-hidden rounded-card border border-subtle bg-surface-2 lg:w-[300px]">
      <div className="relative aspect-[16/9] bg-stripe">
        {line.cover_url && <img src={line.cover_url} alt="" className="h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
        <span className="absolute left-2 top-2 rounded-md bg-cta px-1.5 py-0.5 text-[10px] font-extrabold text-white">ไลน์</span>
        {admin && !line.active && <span className="absolute right-2 top-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-extrabold text-[#fbbf24]">ร่าง</span>}
        <div className="absolute inset-x-3 bottom-2.5">
          <div className="truncate text-[15px] font-extrabold text-white">{line.name.trim() || 'ไลน์'}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/75">
            <span className="truncate">{maker}</span> · <span className="shrink-0">{states.length} ตัว</span>
            {openN > 0 && <span className="shrink-0 rounded-full bg-[#60a5fa]/25 px-1.5 py-px text-[10px] font-bold text-[#bfdbfe]">เปิดพรี {openN}</span>}
          </div>
        </div>
      </div>
    </Link>
  );
}
