import type { Database, PreorderTicket, TicketTransfer, User } from '../entities';
import { depositFor } from './pricing';
import { isSourcingTicket } from './money';
import { TRANSFER_DONE } from './tickets';

/**
 * ตลาดใบพรี (P2P) — กติกาที่เจ้าของเคาะแล้วทั้ง 30 ข้อ (2026-09-23 · memory ryuma-p2p-spec) อยู่ที่นี่ที่เดียว.
 *
 * ⚠ ด่านจริงอยู่ฝั่งฐานข้อมูล (RPC `ryuma_market_*` ใน migration_market_v71.sql) — ไฟล์นี้มีไว้ให้หน้าจอ
 *   "บอกเหตุผลก่อนกด" และให้ชุดทดสอบ `npm run audit:market` ตรวจตัวเลข. แก้กติกาที่นี่ต้องแก้ SQL ให้ตรงเสมอ.
 *
 * เส้นเงิน: ผู้ซื้อโอน "ราคาขาย" ตรงถึงคนขาย (ไม่ผ่านร้าน) · ส่วนต่างที่ค้างร้านย้ายไปเป็นหนี้ของผู้ซื้อ
 * · ตั๋วใบเดิมแค่ย้าย owner_id (original_buyer_id คงเดิม) → ยอดเงินร้านไม่ขยับสักบาท
 */
export const MARKET = {
  holdMin: 15,          // ข้อ 14 — จองแล้วต้องโอน+แนบสลิปภายใน 15 นาที (ที่ลูกค้าเห็น)
  holdGraceMin: 10,     // ผ่อนผันหลังบ้าน: โอนทันแต่แนบสลิปช้า ยังไม่โดนตัดสิทธิ์ (SQL ใช้ตัวเลขเดียวกัน)
  sellerSlaH: 12,       // ข้อ 15 — คนขายต้องยืนยันรับเงินใน 12 ชม. (เกิน → เข้าตรวจสอบ · ข้อ 12)
  sellerRemindH: [2, 8],
  listingDays: 14,      // ข้อ 17 — ประกาศหมดอายุ (ต่ออายุได้)
  maxActive: 5,         // ข้อ 4 — ประกาศค้างพร้อมกันต่อคน
  resellDays: 3,        // ข้อ 5 — ซื้อจากตลาดแล้วต้องถือ 3 วันก่อนขายต่อ
} as const;

/** ข้อ 1A: ขายได้หลังปิดรอบเท่านั้น — ช่วงเปิดจองร้านยังขายตัวเดียวกันอยู่ */
export const SELLABLE_PRODUCT_STATUSES: PreorderTicket['product_status'][] = ['production', 'shipping', 'arrived'];

/** สถานะที่ยัง "ถือตั๋วไว้" (ล็อก: จ่ายส่วนต่าง/เลือกวิธีรับของ/แก้มัดจำ/ลบตั๋วไม่ได้) */
const ACTIVE = new Set<TicketTransfer['status']>(['listed', 'reserved', 'paid', 'reviewing', 'seller_ok', 'pending_admin']);

export const TRANSFER_STATUS_LABEL: Record<TicketTransfer['status'], string> = {
  listed: 'ลงขายอยู่',
  reserved: 'มีคนจอง',
  paid: 'รอคนขายเช็คเงิน',
  reviewing: 'ร้านกำลังตรวจสอบ',
  seller_ok: 'รอร้านโอนสิทธิ์',
  pending_admin: 'รอร้านโอนสิทธิ์',
  done: 'เปลี่ยนมือแล้ว',
  approved: 'เปลี่ยนมือแล้ว',
  cancelled: 'ยกเลิกแล้ว',
  expired: 'หมดอายุ',
};

const ms = (iso?: string) => (iso ? new Date(iso).getTime() : NaN);

/** สถานะจริง ณ ตอนนี้ — ฝั่ง server ไม่มีตัวตั้งเวลา จึงหมดอายุแบบ "ขี้เกียจ": จองเกินเวลา = กลับเป็น listed,
 *  ประกาศเกินอายุ = expired (RPC ทุกตัวใช้กติกาเดียวกันตอนถูกเรียก) */
export function effectiveStatus(tr: TicketTransfer, now: Date = new Date()): TicketTransfer['status'] {
  const t = now.getTime();
  if (tr.status === 'reserved' && ms(tr.hold_until) + MARKET.holdGraceMin * 60_000 <= t) return ms(tr.expires_at) <= t ? 'expired' : 'listed';
  if (tr.status === 'listed' && ms(tr.expires_at) <= t) return 'expired';
  return tr.status;
}

export const isActiveTransfer = (tr: TicketTransfer, now: Date = new Date()) => ACTIVE.has(effectiveStatus(tr, now));

/** ประกาศที่ยังค้างของตั๋วใบนี้ (มีได้ใบเดียว) */
export function activeListingOf(db: Database, ticketId: string, now: Date = new Date()): TicketTransfer | undefined {
  return db.transfers.find((tr) => tr.ticket_id === ticketId && isActiveTransfer(tr, now));
}

/** ตั๋วถูกล็อกเพราะลงขายอยู่ — ทุก mutation ที่แตะเงิน/การรับของของตั๋วต้องเช็คตัวนี้ (ด่านต้องอยู่ใน mutation) */
export const marketLocked = (db: Database, ticketId: string, now: Date = new Date()) => !!activeListingOf(db, ticketId, now);

/** ตั๋วนี้เคยผ่านตลาด (ขาย/ถูกแตกขาย/เป็นตั๋วลูก) — ลบทิ้งไม่ได้ ไม่งั้นหลักฐานว่าใครขายให้ใครหาย */
export function hasMarketHistory(db: Database, t: PreorderTicket): boolean {
  return !!t.split_from
    || db.transfers.some((tr) => tr.ticket_id === t.id || tr.child_ticket_id === t.id)
    || db.tickets.some((x) => x.split_from === t.id);
}

/**
 * "มัดจำปกติ" ต่อชิ้น (ข้อ 9) = มัดจำของรอบนั้น "ก่อนส่วนลดยศ" — Gold มัดจำครึ่ง / Diamond มัดจำ 0
 * ต้องเติมให้ถึงตัวนี้ก่อนลงขาย. ลำดับ: รอบพิเศษ → (SKU ที่ถูก convert เป็นพร้อมส่งแล้ว = ขั้นมัดจำมาตรฐานร้าน)
 * → แบบย่อย → สินค้า · ไม่เกินราคาเต็มต่อชิ้นของตั๋ว (รอบจ่ายเต็มจึงเท่ากับราคาเต็ม)
 */
export function standardDepositPerUnit(db: Database, t: PreorderTicket): number {
  const p = db.products.find((x) => x.id === t.product_id);
  let base = 0;
  if (t.batch_id) base = db.batches.find((b) => b.id === t.batch_id)?.deposit_amount ?? 0;
  else if (p?.is_stock) base = depositFor(db.settings, p.wcf_type); // deposit_amount ของ SKU ที่ convert แล้ว = ราคาเต็ม ใช้ไม่ได้
  else if (t.variant_id) base = db.variants.find((v) => v.id === t.variant_id)?.deposit_amount ?? p?.deposit_amount ?? 0;
  else base = p?.deposit_amount ?? 0;
  const unitTotal = t.qty > 0 ? (t.deposit_paid + t.remaining_amount) / t.qty : 0;
  return Math.max(0, Math.min(base, unitTotal));
}

/** ต้องเติมอีกเท่าไหร่ให้ "ทั้งใบ" ถึงมัดจำปกติ (ข้อ 9) — เงินที่เติมเข้าร้านเป็นสลิปส่วนต่าง purpose='topup'
 *  คิดทั้งใบ ไม่ใช่เฉพาะชิ้นที่ขาย: ตอนแตกขาย เงินที่จ่ายแล้วถูกแบ่งตามสัดส่วน เติมครึ่งเดียวชิ้นที่ขายก็ยังไม่ครบ */
export function depositGap(db: Database, t: PreorderTicket): number {
  const need = standardDepositPerUnit(db, t) * t.qty;
  const paid = (t.deposit_paid ?? 0) + (t.remaining_paid ?? 0);
  return Math.max(0, Math.ceil(need - paid));
}

/** ตั๋วลูก qty ชิ้นที่แตกออกจากตั๋ว t (ข้อ 3B) — แบ่งเงินตามสัดส่วน, แม่ได้ส่วนที่เหลือเป๊ะ (ยอดรวมไม่ขยับ)
 *  ⚠ สูตรเดียวกับ ryuma_market_finalize (SQL round = ปัดครึ่งขึ้น เหมือน Math.round กับเลขบวก) */
export function splitShare(t: Pick<PreorderTicket, 'qty' | 'deposit_paid' | 'remaining_amount' | 'remaining_paid'>, qty: number) {
  // (x × qty) ÷ ชิ้นทั้งหมด — ห้ามคูณด้วย qty/t.qty (เศษทศนิยมของ 1/3 ทำให้ปัดคนละทางกับ SQL)
  const part = (x: number) => Math.round((x * qty) / t.qty);
  const cDep = part(t.deposit_paid);
  const cRem = part(t.remaining_amount);
  let cPaid = Math.min(part(t.remaining_paid), cRem);
  const pRem = t.remaining_amount - cRem;
  let pPaid = t.remaining_paid - cPaid;
  if (pPaid > pRem) { const d = pPaid - pRem; pPaid -= d; cPaid += d; } // แม่จ่ายเกินหนี้ตัวเอง → โยกไปลูก
  return {
    child: { qty, deposit_paid: cDep, remaining_amount: cRem, remaining_paid: cPaid },
    parent: { qty: t.qty - qty, deposit_paid: t.deposit_paid - cDep, remaining_amount: pRem, remaining_paid: pPaid },
  };
}

/** เลขตั๋วหลังเปลี่ยนมือ (ข้อ 24A): เลขเดิม + -T<n> ถัดจากที่เคยออกของเลขฐานเดียวกัน (โอนครั้งที่ 2 = -T2)
 *  ฝั่ง server คำนวณเองตอนไฟนอล (เห็นตั๋วทุกใบ) — ตัวนี้ใช้พรีวิว/โหมด seed */
export function nextTransferNo(ticketNos: string[], ticketNo: string): string {
  const base = ticketNo.replace(/-T\d+$/, '');
  let n = 0;
  for (const no of ticketNos) {
    if (!no.startsWith(base + '-T')) continue;
    const k = parseInt(no.slice(base.length + 2), 10);
    if (Number.isFinite(k) && k > n) n = k;
  }
  return `${base}-T${n + 1}`;
}

/** ชื่อคนขายบนกระดาน (ข้อ 20A ปิดชื่อ): RYU-0012 → R•••12 */
export function sellerMask(u?: Pick<User, 'id' | 'member_code'>): string {
  const code = u?.member_code || u?.id || '';
  const tail = code.replace(/\D/g, '').slice(-2) || code.slice(-2);
  return `R•••${tail}`;
}

/** ตั๋วที่ซื้อจากตลาด ขายต่อได้เมื่อไหร่ (ข้อ 5: ถือครบ 3 วัน) — null = ขายได้เลย */
export function resellAllowedAt(db: Database, t: PreorderTicket, userId: string): Date | null {
  const last = db.transfers
    .filter((tr) => TRANSFER_DONE.has(tr.status) && tr.to_user_id === userId && (tr.child_ticket_id || tr.ticket_id) === t.id)
    .sort((a, b) => ms(b.approved_at) - ms(a.approved_at))[0];
  if (!last?.approved_at) return null;
  return new Date(ms(last.approved_at) + MARKET.resellDays * 86_400_000);
}

/**
 * ลงขายใบนี้ได้ไหม — คืนเหตุผลภาษาไทย (null = ได้). ด่านจริงอยู่ใน ryuma_market_list (SQL ตัวเดียวกัน)
 * ข้อ 1 สถานะ · 2 แหล่ง · 3 จำนวนชิ้น · 4 เพดานประกาศ · 5 ถือ 3 วัน · 9 เติมมัดจำ
 */
export function sellBlockReason(db: Database, t: PreorderTicket, userId: string, qty: number = t.qty, now: Date = new Date()): string | null {
  if (t.owner_id !== userId) return 'ไม่ใช่ใบของคุณ';
  if (t.status === 'shipped') return 'ส่งของแล้ว';
  if (t.status === 'pending_approval' || t.status === 'transferred') return 'ใบนี้ยังไม่พร้อมขาย';
  if (t.delivery) return 'เลือกวิธีรับของแล้ว';
  if (t.product_status === 'open') return 'ยังเปิดจองอยู่ — ขายได้หลังปิดรอบ';
  if (!SELLABLE_PRODUCT_STATUSES.includes(t.product_status)) return 'ของถึงมือแล้ว ขายในตลาดไม่ได้';
  // ข้อ 2: เฉพาะใบพรี — กติกาเดียวกับ ryuma_market_block_reason (ไม่ใช้ ticketSourceOf ทั้งก้อน: ตัวชี้ "ตั๋วมอบ"
  //   ต้องเห็นออเดอร์ทุกใบ ซึ่งฝั่ง SQL/เซสชันลูกค้าเห็นไม่เท่ากัน → ตัดสินเฉพาะ 2 เคสที่ไม่ใช่ใบพรีจริง)
  const p = db.products.find((x) => x.id === t.product_id);
  if (p?.is_stock && !t.batch_id && (t.remaining_amount ?? 0) === 0 && !t.split_from) return 'ของพร้อมส่งไม่ใช่ใบพรี';
  if (isSourcingTicket(db, t)) return 'ตั๋วงานหาของขายในตลาดไม่ได้';
  if (!(qty >= 1 && qty <= t.qty && Number.isInteger(qty))) return 'จำนวนชิ้นไม่ถูกต้อง';
  if (db.remainingPayments.some((r) => r.ticket_id === t.id && r.status === 'pending')) return 'มีสลิปส่วนต่างรอตรวจ';
  if (activeListingOf(db, t.id, now)) return 'ลงขายอยู่แล้ว';
  const active = db.transfers.filter((tr) => tr.from_user_id === userId && isActiveTransfer(tr, now)).length;
  if (active >= MARKET.maxActive) return `ลงประกาศพร้อมกันได้สูงสุด ${MARKET.maxActive} ใบ`;
  const resell = resellAllowedAt(db, t, userId);
  if (resell && resell.getTime() > now.getTime()) return `ซื้อจากตลาดมา ต้องถือครบ ${MARKET.resellDays} วัน (ขายได้ ${resell.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })})`;
  const gap = depositGap(db, t);
  if (gap > 0) return `ต้องเติมมัดจำอีก ฿${gap.toLocaleString('en-US')} ก่อนลงขาย`;
  return null;
}
