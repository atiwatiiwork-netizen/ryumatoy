'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDatabase, useReady } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useSmartBack } from '@/lib/nav';
import { isAdminUser } from '@/domain/services/admins';
import { shopLines, linesPublicEnabled, isNewLine, lineVisibleTo, memberProducts } from '@/domain/services/lines';
import { filterProducts } from '@/domain/services/catalog';
import type { Database } from '@/domain/entities';
import { Icon } from '@/components/Icon';
import { BackBar, Chip } from '@/components/ui';
import { LineCoverCard } from '@/components/lines/LineCoverCard';
import { ProductCard } from '@/components/ProductCard';
import Link from 'next/link';

/** หน้ารวมไลน์อัป (เจ้าของ 2026-10-08) — ฟิลเตอร์ค่าย/เรื่อง/คำค้นอยู่ใน URL (แชร์ลิงก์ได้ เช่น /lines?maker=ks)
 *  ลูกค้าเห็นเฉพาะไลน์ที่เปิดแล้ว (shopLines ตัดสิน) · ยังไม่เปิดสวิตช์ = หน้าว่างพร้อมปุ่มกลับ ไม่บอกว่ามีอะไรซ่อนอยู่ */
export default function LinesPage() {
  return <Suspense fallback={null}><LinesInner /></Suspense>;
}

function LinesInner() {
  const db = useDatabase();
  const ready = useReady();
  const uid = useCurrentUserId();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const goBack = useSmartBack('/');
  const [makerId, setMakerId] = useState<string | null>(() => params.get('maker'));
  const [frId, setFrId] = useState<string | null>(() => params.get('franchise'));
  const [q, setQ] = useState(() => params.get('q') ?? '');
  useEffect(() => {
    const qs = new URLSearchParams();
    if (makerId) qs.set('maker', makerId);
    if (frId) qs.set('franchise', frId);
    if (q) qs.set('q', q);
    const s = qs.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  }, [makerId, frId, q, pathname, router]);

  const all = useMemo(() => shopLines(db, uid), [db, uid]);
  const lines = useMemo(() => shopLines(db, uid, { makerId, franchiseId: frId, query: q }), [db, uid, makerId, frId, q]);
  // ชิปกรองแสดงเฉพาะค่าย/เรื่องที่มีไลน์จริง (ไม่งั้นกดแล้วว่าง)
  const makers = db.manufacturers.filter((m) => all.some((l) => l.maker_id === m.id));
  const franchises = db.franchises.filter((f) => all.some((l) => l.franchise_id === f.id));
  const admin = isAdminUser(db, uid);

  return (
    <div className="mx-auto max-w-[760px]">
      <BackBar title="ไลน์อัป" onBack={goBack} />
      {admin && !linesPublicEnabled(db) && (
        <div className="mb-3 rounded-xl border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-3 py-2 text-[12px] text-[#fbbf24]">👀 แอดมินเห็นคนเดียว — ลูกค้ายังไม่เห็นหน้านี้ (สวิตช์ปิดอยู่)</div>
      )}
      {!ready ? (
        <div className="py-16 text-center text-ink-faint">กำลังโหลด…</div>
      ) : all.length === 0 ? (
        <div className="rounded-card border border-subtle bg-surface-2 py-14 text-center text-[13.5px] text-ink-faint">ยังไม่มีไลน์อัป</div>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-subtle bg-surface-3 px-[13px] py-[10px]">
            <Icon name="search" size={17} className="text-ink-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อไลน์ / ค่าย" className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint" />
          </div>
          {makers.length > 1 && (
            <div className="mb-2.5 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
              <Chip active={!makerId} onClick={() => setMakerId(null)}>ทุกค่าย</Chip>
              {makers.map((m) => <Chip key={m.id} active={makerId === m.id} onClick={() => setMakerId(makerId === m.id ? null : m.id)}>{m.name}</Chip>)}
            </div>
          )}
          {franchises.length > 1 && (
            <div className="mb-2.5 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
              <Chip active={!frId} onClick={() => setFrId(null)}>ทุกเรื่อง</Chip>
              {franchises.map((f) => <Chip key={f.id} active={frId === f.id} onClick={() => setFrId(frId === f.id ? null : f.id)}>{f.name}</Chip>)}
            </div>
          )}
          <div className="mb-3 text-[12.5px] text-ink-faint">{lines.length} ไลน์</div>
          {lines.length === 0 ? (
            <div className="py-12 text-center text-ink-faint">ไม่พบไลน์ตามตัวกรอง</div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2 lg:gap-4">
              {lines.map((l, i) => <LineCoverCard key={l.id} db={db} line={l} admin={admin} isNew={isNewLine(l)} eager={i < 2} />)}
            </div>
          )}
          <LooseProducts db={db} uid={uid} makerId={makerId} frId={frId} query={q} />
        </>
      )}
    </div>
  );
}

/** สินค้าที่ขายอยู่แต่ "ไม่อยู่ในไลน์ไหนเลย" (เจ้าของ 2026-10-08: จัดให้เป็นระเบียบ หาง่าย) — ตามตัวกรองเดียวกับไลน์ ·
 *  โชว์เป็นการ์ดสินค้าปกติ สูงสุด 12 ตัว + ลิงก์ไปช็อปพร้อมตัวกรองเดิม */
function LooseProducts({ db, uid, makerId, frId, query }: { db: Database; uid: string; makerId: string | null; frId: string | null; query: string }) {
  const inLine = new Set<string>();
  for (const l of db.productLines) if (lineVisibleTo(db, uid, l)) for (const m of l.members) for (const p of memberProducts(db, m).all) inLine.add(p.id);
  const loose = filterProducts(db, { manufacturerId: makerId, franchiseId: frId, query }).filter((p) => !inLine.has(p.id));
  if (loose.length === 0) return null;
  const qs = new URLSearchParams();
  if (makerId) qs.set('maker', makerId);
  if (frId) qs.set('franchise', frId);
  if (query) qs.set('q', query);
  return (
    <div className="mt-7">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-[15px] font-extrabold">ตัวเดี่ยว · ไม่อยู่ในไลน์ <span className="text-[12px] font-normal text-ink-faint">{loose.length} รายการ</span></div>
        <Link href={`/shop${qs.toString() ? `?${qs}` : ''}`} className="text-[12.5px] font-semibold text-primary-soft">ดูในช็อป →</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {loose.slice(0, 12).map((p) => <ProductCard key={p.id} product={p} quickAdd />)}
      </div>
    </div>
  );
}
