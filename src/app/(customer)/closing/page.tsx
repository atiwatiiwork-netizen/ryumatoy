'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { openBoards } from '@/domain/services/catalog';
import { Icon } from '@/components/Icon';

/**
 * แท็บ "ปิดพรี" (เจ้าของ 2026-10-08) — กระดานปิดพรีที่เคยเป็นแบนเนอร์ใหญ่บนหน้าแรกย้ายมาอยู่ที่นี่ทั้งหมด
 * หน้ากระดานข้างใน (/board/[id]) ใช้ของเดิม · ปกติแท็บนี้โผล่เฉพาะตอนมีกระดานเปิด แต่เข้าลิงก์ตรงตอนไม่มีก็ต้องไม่พัง
 */
export default function ClosingPage() {
  const db = useDatabase();
  const boards = openBoards(db);
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-3.5 flex items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#16a34a]/15 text-[#4ade80]"><Icon name="bolt" size={19} /></span>
        <div className="flex-1">
          <div className="text-[22px] font-extrabold leading-tight">กำลังปิดพรี</div>
          <div className="text-[12px] text-ink-muted2">จองได้ถึงวันที่ค่ายปิดรับ · ปิดแล้วรอรอบถัดไป</div>
        </div>
        {boards.length > 0 && <span className="rounded-full bg-[#16a34a] px-2.5 py-1 text-[12px] font-bold text-white">{boards.length} กระดาน</span>}
      </div>
      {boards.length === 0 ? (
        <div className="rounded-card border border-subtle bg-surface-2 py-14 text-center text-[13.5px] text-ink-faint">ตอนนี้ไม่มีกระดานที่กำลังปิดพรี</div>
      ) : (
        <div className="flex flex-col gap-4">
          {boards.map((b) => {
            const n = db.products.filter((p) => p.board_id === b.id).length;
            const maker = db.manufacturers.find((m) => m.id === b.maker_id)?.name;
            return (
              <Link key={b.id} href={`/board/${b.id}`} className="block overflow-hidden rounded-2xl border border-[#16a34a]/40 bg-surface-2">
                <div className="relative">
                  <img src={b.poster_url} alt={b.title} loading="lazy" className="block h-auto w-full" />
                  <div className="pointer-events-none absolute left-0 top-0 flex items-center gap-1.5 rounded-br-xl bg-[#16a34a] px-3 py-1.5 text-[11px] font-extrabold tracking-wide text-white [animation:ryuBlink_1.4s_ease-in-out_infinite]">
                    <Icon name="bolt" size={13} /> กำลังปิดพรี
                  </div>
                </div>
                <div className="flex items-center gap-3 px-3.5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-extrabold">{b.title}</div>
                    <div className="text-[12px] text-ink-muted2">{maker ? `${maker} · ` : ''}{n} รายการ</div>
                  </div>
                  <span className="rounded-[10px] bg-cta px-3.5 py-2 text-[12.5px] font-extrabold text-white shadow-cta">กดดูรายการ →</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <style>{`@keyframes ryuBlink{0%,100%{opacity:1}50%{opacity:.28}}`}</style>
    </div>
  );
}
