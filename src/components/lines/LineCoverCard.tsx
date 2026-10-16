'use client';

import Link from 'next/link';
import { lineStates, memberOpenForPreorder, lineToneCounts } from '@/domain/services/lines';
import type { Database, ProductLine } from '@/domain/entities';
import { cx } from '@/components/ui';

/**
 * การ์ดปกไลน์ (รูปหมู่ของค่าย = ทางเข้า) — ตัวเดียวใช้ทั้งหน้าแรก / แถบในหน้าช็อป / หน้ารวม /lines
 * size: 'hero' = รูปเต็ม 3:2 (ไลน์ล่าสุดบนหน้าแรก) · 'wide' = 16:7 ประหยัดที่ · 'rail' = การ์ดในแถบเลื่อน
 * ชิป: "Pre-Order N" ไม่ขึ้นกับสต๊อก (memberOpenForPreorder) · ไม่มีชิปพร้อมส่ง (สต๊อก local ฝั่งลูกค้าเชื่อไม่ได้ · RLS)
 */
export function LineCoverCard({ db, line, size = 'wide', admin, isNew, eager }: {
  db: Database; line: ProductLine; size?: 'hero' | 'wide' | 'rail'; admin?: boolean; isNew?: boolean; eager?: boolean;
}) {
  const states = lineStates(db, line, { uid: '' }).filter((s) => s.state.visible);
  const openN = states.filter((s) => memberOpenForPreorder(db, s.member)).length;
  const tones = lineToneCounts(states);
  const maker = db.manufacturers.find((m) => m.id === line.maker_id)?.name ?? '';
  const fr = line.franchise_id ? db.franchises.find((f) => f.id === line.franchise_id)?.name : undefined;
  const aspect = size === 'hero' ? 'aspect-[3/2]' : size === 'rail' ? 'aspect-[16/9]' : 'aspect-[16/7]';
  return (
    <Link href={`/line/${line.id}`} className={cx('relative block overflow-hidden rounded-card border border-subtle bg-surface-2', size === 'rail' && 'w-[260px] shrink-0 lg:w-[300px]')}>
      <div className={cx('relative bg-stripe', aspect)}>
        {line.cover_url && <img src={line.cover_url} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" className="h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
        <span className="absolute left-2 top-2 rounded-md bg-cta px-1.5 py-0.5 text-[10px] font-extrabold text-white">ไลน์</span>
        {isNew && <span className="absolute right-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-extrabold text-[#fbbf24]">ใหม่</span>}
        {admin && !line.active && <span className="absolute right-2 top-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-extrabold text-[#fbbf24]">ร่าง</span>}
        <div className="absolute inset-x-3 bottom-2.5">
          <div className={cx('truncate font-extrabold text-white', size === 'hero' ? 'text-[18px]' : 'text-[15px]')}>{line.name.trim() || 'ไลน์'}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-white/75">
            <span className="truncate">{maker}{fr ? ` · ${fr}` : ''}</span> · <span className="shrink-0">{states.length} ตัว</span>
            {openN > 0 && <span className="shrink-0 rounded-full bg-[#60a5fa]/25 px-1.5 py-px text-[10px] font-bold text-[#bfdbfe]">Pre-Order {openN}</span>}
            {/* ไม่มีชิป "มีพร้อมส่ง" แล้ว (review ลูกค้า 2026-10-16): การ์ดไม่ได้ถามของเหลือจาก server และลูกค้าเห็นตั๋วแค่ของตัวเอง
                → สูตร local นับขายไม่ครบ ขึ้น "มีพร้อมส่ง" ทั้งที่หมดแล้ว · สถานะของจริงอยู่ในหน้าไลน์ที่ถาม server */}
            {tones.amber > 0 && openN === 0 && <span className="shrink-0 rounded-full bg-[#fbbf24]/25 px-1.5 py-px text-[10px] font-bold text-[#fde68a]">หาของได้</span>}
          </div>
        </div>
      </div>
    </Link>
  );
}
