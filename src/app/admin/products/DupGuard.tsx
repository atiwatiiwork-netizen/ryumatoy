'use client';

import type { Database, Product } from '@/domain/entities';
import { baht } from '@/lib/theme';

/**
 * ด่านกันลงสินค้าซ้ำ (เจ้าของ 2026-10-16 รอบ 1 · เคส Ringo ลงพรีซ้ำ 2 ตัว 2026-10-12 ต้องรวมด้วย SQL)
 * กติกาเดียวทั้งระบบ = findDuplicateProducts (catalog.ts): ค่ายเดียวกัน + ชื่อตัวละครเดียวกัน + ชนิดเดียวกัน (พรี/พร้อมส่ง)
 * ใช้ที่หน้า "สินค้า" (เพิ่มทีละตัว) และ "พรีหลายรายการ" · แผงลงสินค้าในไลน์ใช้ตัวหาซ้ำตัวเดียวกัน
 */
const STATUS_TH: Record<string, string> = { open: 'เปิดพรี', production: 'ผลิต', shipping: 'เดินทาง', arrived: 'ถึงไทย', delivered: 'ส่งมอบ', closed: 'จบ' };

/** "Ringo - 7 SwordMaster · เปิดพรี · ฿1,690 · ลงเมื่อ 12 ต.ค. 69 · ใบพรี 2 ใบ" */
export function dupLine(db: Database, p: Product): string {
  const tickets = db.tickets.filter((t) => t.product_id === p.id).length;
  const when = p.created_at ? new Date(p.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
  return [p.series_name, p.is_stock ? 'พร้อมส่ง' : (STATUS_TH[p.status] ?? p.status), baht(p.price_total), when && `ลงเมื่อ ${when}`, tickets ? `ใบพรี ${tickets} ใบ` : 'ยังไม่มีใบพรี']
    .filter(Boolean).join(' · ');
}

/** เตือนใต้ช่องชื่อตั้งแต่พิมพ์ (ก่อนถึงปุ่ม) */
export function DupHint({ db, dups, makerName }: { db: Database; dups: Product[]; makerName?: string }) {
  if (dups.length === 0) return null;
  return (
    <span className="mt-1 block text-[11.5px] font-semibold text-[#fbbf24]">
      ⚠ ซ้ำกับ &quot;{dups[0].series_name}&quot;{makerName ? ` (${makerName})` : ''}{dups.length > 1 ? ` และอีก ${dups.length - 1} ตัว` : ''} — ตัวเดียวกันไม่ต้องลงใหม่
      <span className="block font-normal text-ink-faint">{dupLine(db, dups[0])}</span>
    </span>
  );
}

/** กล่องถามตอนกดเพิ่ม: ไปดูตัวเดิม (กรองรายการสินค้าให้ · ร่างยังอยู่) / ลงเป็นตัวใหม่ */
export function DupDialog({ db, name, makerName, dups, editing, onView, onProceed, onClose }: {
  db: Database; name: string; makerName: string; dups: Product[]; editing?: boolean; onView: () => void; onProceed: () => void; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-2xl border border-[#f59e0b]/60 bg-surface-2 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-[14px] font-extrabold text-[#fbbf24]">⚠ มี &quot;{name.trim()}&quot; ของค่าย {makerName} ในระบบแล้ว</div>
        <div className="mt-2 flex flex-col gap-1.5">
          {dups.slice(0, 4).map((p) => <div key={p.id} className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-2 text-[12px]">📦 {dupLine(db, p)}</div>)}
          {dups.length > 4 && <div className="text-[11.5px] text-ink-faint">และอีก {dups.length - 4} ตัว</div>}
        </div>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-muted2">
          {editing
            ? <>กำลังแก้สินค้าเดิมให้ชื่อ/ค่าย/ชนิดชนกับตัวที่มีอยู่ — ระบบจะมีสินค้าชื่อเดียวกัน 2 ตัว<br />ถ้าตั้งใจให้ต่างกัน ให้ตั้งชื่อให้ต่าง เช่น &quot;{name.trim()} (รอบ 2)&quot;</>
            : <>ถ้าเป็นตัวเดียวกัน อย่าลงซ้ำ (ใบพรีจะแยกเป็น 2 ตัว รวมทีหลังต้องใช้ SQL)<br />ถ้าเป็นรอบใหม่/เวอร์ชันใหม่จริง ให้ตั้งชื่อให้ต่างกัน เช่น &quot;{name.trim()} (รอบ 2)&quot;</>}
        </p>
        <div className="mt-3 flex gap-2">
          <button onClick={onView} className="flex-1 rounded-xl border border-subtle bg-surface-4 px-3 py-2.5 text-[12.5px] font-extrabold text-ink">ไปดูตัวเดิม</button>
          <button onClick={onProceed} className="flex-1 rounded-xl bg-cta px-3 py-2.5 text-[12.5px] font-extrabold text-white">{editing ? 'บันทึกชื่อนี้' : 'ลงเป็นตัวใหม่'}</button>
        </div>
      </div>
    </div>
  );
}
