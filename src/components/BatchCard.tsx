'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ProductBatch } from '@/domain/entities';
import { useDatabase } from '@/state/DataProvider';
import { baht } from '@/lib/theme';
import { metaLine } from '@/domain/services/catalog';
import { batchAvailable, batchGoneState, myPendingHold } from '@/domain/services/reservations';
import { useLiveStock } from '@/lib/useLiveStock';
import { useCurrentUserId } from '@/state/AuthProvider';
import { ProductThumb, cx } from './ui';

/** A special pre-order round (สต๊อกใบพรี) shown on the shop — same figure, its own lot/price.
 *  Availability is RESERVATION-AWARE (batchAvailable): someone sitting in the 15-min payment/slip
 *  stage already holds their unit, so a round pulled to 0 shows สินค้าหมด before any slip is approved.
 *  Scarcity labels (owner spec): every buyable state blinks "สินค้าเหลือน้อย" (rounds are limited by
 *  nature); exactly 1 left → "เหลือ 1 ชิ้นสุดท้าย"; 0 → สินค้าหมด, greyed + unclickable. */
export function BatchCard({ batch, liveAvail }: { batch: ProductBatch; liveAvail?: number }) {
  const db = useDatabase();
  const router = useRouter();
  const { checking, ensure } = useLiveStock();
  const meId = useCurrentUserId();
  const product = db.products.find((p) => p.id === batch.product_id);
  if (!product) return null;
  // ⚠ สูตร local เชื่อไม่ได้ฝั่งลูกค้า (audit 2026-07-30): RLS ให้เห็นเฉพาะตั๋วตัวเอง → "ขายไปแล้ว"
  // นับไม่ครบ → รอบที่หมดแล้วโชว์ว่ายังมีของ. liveAvail = เลขจาก ryuma_available (ข้าม RLS) เมื่อถามได้
  // บวก hold ของตัวเองคืน (server หักไปแล้ว) แล้วเอาค่าที่ "น้อยกว่า" — server ชนะฝั่งหมดเสมอ
  const mine = myPendingHold(db, meId, product.id, batch.id);
  const localAvail = batchAvailable(db, batch);
  const avail = liveAvail != null ? Math.min(localAvail, liveAvail + mine) : localAvail;
  const soldOut = avail <= 0;
  const lastOne = avail === 1;
  const fullPay = batch.deposit_amount >= batch.price_total;
  // ป้ายบอกว่าหมดแบบไหน: 'temp' = มีคนถือ hold/สลิปรอตรวจ (อาจหลุดกลับมา) · 'gone' = ตั๋วออกครบจริง
  // ⚠ ทั้งสองแบบ "กดเข้าไม่ได้" เหมือนกัน (เจ้าของ 2026-07-30) — ป้ายมีไว้บอกว่ารอได้ไหมเท่านั้น
  // ป้าย temp/gone อ่านจาก local (เห็น hold ครบเพราะ sr_read เปิดให้ทุกคน) — แต่ถ้า server บอกหมด
  // ทั้งที่ local ยังไม่รู้ (ตั๋วคนอื่นที่มองไม่เห็น) ให้ถือเป็น 'gone' เพราะตั๋วออกจริงแล้ว ไม่ได้แค่ถูกจอง
  const gone = soldOut ? (batchGoneState(db, batch) ?? 'gone') : null;
  const href = `/shop/${product.id}?batch=${batch.id}`;

  const inner = (
    <div className={cx('block overflow-hidden rounded-card border bg-surface-2', soldOut ? 'border-subtle opacity-60' : 'border-accent-soft')}>
      <div className="relative">
        <ProductThumb isStock={false} radius="rounded-none" src={product.images[0]} showRibbon={false} />
        <span className="absolute right-2 top-2 rounded-md bg-cta px-2 py-0.5 text-[10px] font-bold text-white">{batch.label || 'รอบพิเศษ'}</span>
        {soldOut && (
          <div className="absolute inset-0 grid place-items-center bg-black/55">
            <span className={cx('rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-bold', gone === 'temp' ? 'animate-blink text-[#fbbf24]' : 'text-white')}>
              {gone === 'temp' ? '⏳ หมดชั่วคราว · รอหลุด' : 'สินค้าหมด'}
            </span>
          </div>
        )}
        {/* กำลังถามของกับ server ตอนกด — กันกดรัว + บอกว่าไม่ได้ค้าง */}
        {checking && !soldOut && (
          <div className="absolute inset-0 grid place-items-center bg-black/45">
            <span className="animate-pulse rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-bold text-white">กำลังเช็คของ…</span>
          </div>
        )}
      </div>
      <div className="px-[11px] pb-3 pt-2.5">
        <div className="mb-[3px] font-mono text-[10px] text-ink-faint">{metaLine(db, product)}</div>
        <div className="line-clamp-2 min-h-[34px] text-[13px] font-semibold leading-tight">{product.series_name}</div>
        {soldOut ? (
          // ปิดราคา/มัดจำเมื่อรอบขายหมด — เหลือแค่ป้ายสถานะ (ไม่โชว์ตัวเลขให้สับสน)
          gone === 'temp'
            ? <div className="mt-1.5 animate-blink text-[12.5px] font-extrabold text-[#fbbf24]">⏳ หมดชั่วคราว — รอสลิปตรวจ อาจมีของหลุด</div>
            : <div className="mt-1.5 text-[13px] font-extrabold text-ink-faint">ปิดรอบ · สินค้าหมด</div>
        ) : (
          <>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-[15px] font-extrabold text-primary-soft">{baht(batch.price_total)}</span>
              {lastOne ? <span className="animate-pulse text-[11px] font-extrabold text-[#f87171]">เหลือ 1 ชิ้นสุดท้าย</span>
                : <span className="animate-pulse text-[11px] font-bold text-[#fbbf24]">สินค้าเหลือน้อย</span>}
            </div>
            {/* full-pay batch = ready-to-ship; deposit batch = still a pre-order round */}
            <div className="mt-0.5 text-[10.5px] font-semibold text-ink-muted2">
              {fullPay ? 'พร้อมส่ง · จ่ายเต็ม' : `พรีรอบพิเศษ · มัดจำ ${baht(batch.deposit_amount)}`}
            </div>
            {/* ปิดกระดานแล้วกำลังเดินทางมาไทย → ป้ายกระพริบ (รอบพิเศษยังจองได้ระหว่างของมา) */}
            {product.status === 'shipping' && (
              <div className="mt-1 animate-blink text-[10.5px] font-extrabold text-[#60a5fa]">🚚 กำลังเดินทางมาไทย</div>
            )}
          </>
        )}
      </div>
    </div>
  );

  // ของหมด (ทั้ง temp และ gone) = กดเข้าไม่ได้เลย — ลูกค้าจะได้ไม่งงว่าตกลงเหลือหรือไม่เหลือ
  if (soldOut) return inner;
  // ยังมีของ: กดแล้วถาม server ก่อนพาเข้า (เครื่องที่เปิดกริดค้างไว้อาจถือเลขเก่า)
  return (
    <Link href={href} onClick={(e) => { e.preventDefault(); void ensure(product.id, batch.id, myPendingHold(db, meId, product.id, batch.id)).then((ok) => { if (ok) router.push(href); }); }}>
      {inner}
    </Link>
  );
}
