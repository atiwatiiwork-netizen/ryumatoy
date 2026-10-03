import type { Database, PreorderTicket, TicketTransfer, User } from '../entities';
import { depositFor } from './pricing';
import { isSourcingTicket } from './money';
import { TRANSFER_DONE, ticketRoot, ticketPayer, orderTicketId } from './tickets';
import { isAdminUser } from './admins';

/** สวิตช์เปิดตลาดฝั่งลูกค้า (app_config 'market_public') — ไม่มีแถว = ปิด (เจ้าของ 2026-09-23: "รอทุกอย่างพร้อมก่อน")
 *  ⚠ ด่านจริงอยู่ฝั่ง server (ryuma_market_open ใน v72) ตัวนี้แค่ซ่อน/โชว์หน้าจอ */
export const MARKET_PUBLIC_KEY = 'market_public';
export function marketPublicEnabled(db: Database): boolean {
  const row = db.appConfig.find((c) => c.key === MARKET_PUBLIC_KEY);
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}
/** ใครเห็นตลาด: เปิดแล้ว = ทุกคน · ยังปิด = แอดมินเท่านั้น (ลองเล่นก่อน) */
export const marketVisibleTo = (db: Database, userId: string) => marketPublicEnabled(db) || isAdminUser(db, userId);

/** สวิตช์ "เปลี่ยนใบพรี" (โอนตรงด้วยเลขกระเป๋า · v73 · app_config 'market_direct') แยกจากกระดาน —
 *  เจ้าของ 2026-10-02: "อย่าเพิ่งเปิดให้ลูกค้าเห็น ทำพรีวิวให้เล่นก่อน" · ด่านจริง = ryuma_direct_open (server) */
export const MARKET_DIRECT_KEY = 'market_direct';
export function directEnabled(db: Database): boolean {
  const row = db.appConfig.find((c) => c.key === MARKET_DIRECT_KEY);
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}
/** ใครเห็นปุ่ม "เปลี่ยนใบพรี" + เลขกระเป๋า: เปิดแล้ว = ทุกคน · ยังปิด = แอดมิน (ลอง 2 บัญชี) */
export const directVisibleTo = (db: Database, userId: string) => directEnabled(db) || isAdminUser(db, userId);
/** เห็นหน้าดีล/ซื้อขายของฉัน ถ้าเปิดอย่างใดอย่างหนึ่ง (ดีลตรงใช้หน้า /market/[id] เดียวกับกระดาน) */
export const anyMarketVisibleTo = (db: Database, userId: string) => marketVisibleTo(db, userId) || directVisibleTo(db, userId);
/** ดีลนี้เป็น "เปลี่ยนใบพรี" (โอนตรง) ไม่ใช่กระดาน */
export const isDirect = (tr: Pick<TicketTransfer, 'kind'>) => tr.kind === 'direct';

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
  offerHours: 24,       // v73 เปลี่ยนใบพรี — ผู้รับมี 24 ชม. โอน+แนบสลิป (ไม่มีใครรอแย่ง จึงไม่ใช่ 15 นาที)
  lookupPerDay: 20,     // v73 — ค้นเลขกระเป๋าได้วันละ 20 ครั้ง (กันไล่เดา 4 หลัก)
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
  // ดีลตรง (v73): ข้อเสนอหมดเวลา = จบเลย ไม่กลับขึ้นกระดาน
  if (isDirect(tr) && tr.status === 'reserved' && ms(tr.hold_until) + MARKET.holdGraceMin * 60_000 <= t) return 'expired';
  if (tr.status === 'reserved' && ms(tr.hold_until) + MARKET.holdGraceMin * 60_000 <= t) return ms(tr.expires_at) <= t ? 'expired' : 'listed';
  if (tr.status === 'listed' && ms(tr.expires_at) <= t) return 'expired';
  return tr.status;
}

/** ป้ายสถานะที่อ่านรู้เรื่องทั้งสองแบบ — ดีลตรงไม่มี "ลงขาย/จอง" มีแต่ "ข้อเสนอ/รอผู้รับโอน" */
export function dealStatusLabel(tr: TicketTransfer, st: TicketTransfer['status'] = effectiveStatus(tr)): string {
  if (!isDirect(tr)) return TRANSFER_STATUS_LABEL[st];
  // v75: ผู้รับโอนแล้วแต่ดีลปิดไปก่อน — ร้านเก็บสลิปไว้ รอเคลียร์คืนเงิน (audit รอบ B R1-01)
  if ((st === 'cancelled' || st === 'expired') && tr.review_reason === 'late_slip') return 'โอนแล้ว · รอร้านเคลียร์คืนเงิน';
  if ((st === 'cancelled' || st === 'expired') && tr.review_reason === 'late_slip_done') return 'เคลียร์คืนเงินแล้ว';
  if (st === 'reserved') return (tr.asking_price ?? 0) > 0 ? 'รอผู้รับโอนเงิน' : 'รอผู้รับกดรับ';
  if (st === 'paid') return (tr.asking_price ?? 0) > 0 ? 'รอคนส่งเช็คเงิน' : 'รอคนส่งยืนยัน';
  if (st === 'expired') return 'ข้อเสนอหมดเวลา';
  if (st === 'cancelled') return tr.cancel_reason === 'buyer_declined' ? 'ผู้รับไม่รับ' : tr.cancel_reason === 'seller' ? 'ถอนข้อเสนอแล้ว' : 'ยกเลิกแล้ว';
  return TRANSFER_STATUS_LABEL[st];
}

/** สลิป "เติมมัดจำก่อนเปลี่ยนใบ/ลงขาย" ที่รอแอดมินตรวจ (เจ้าของ 2026-10-02: ส่งแอดมิน "แยกหัวข้อว่าเป็นการเติมมัดจำ") */
export function topupQueue(db: Database) {
  return db.remainingPayments
    .filter((r) => r.status === 'pending' && r.purpose === 'topup')
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
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

/** ตั๋วนี้ "เปลี่ยนมือจริงแล้ว" (ไฟนอลแล้ว / ถูกแตกขาย / เป็นตั๋วลูก) — แก้มัดจำไม่ได้: มัดจำผูกกับออเดอร์ของคนสั่ง
 *  แก้บนตั๋วเงินจะไม่ลงบัญชีใคร (audit รอบ A R3-16) · ตรงกับ ryuma_ticket_transferred (SQL v74) */
export function ticketTransferred(db: Database, t: PreorderTicket): boolean {
  return !!t.split_from
    || db.transfers.some((tr) => TRANSFER_DONE.has(tr.status) && (tr.ticket_id === t.id || tr.child_ticket_id === t.id))
    || db.tickets.some((x) => x.split_from === t.id);
}

/** มัดจำมาตรฐาน "ปัจจุบัน" ของสินค้า/รอบ (สูตรก่อน v76) — ใช้เฉพาะเป็นค่าสำรองของรายการที่ยังไม่มี std_deposit */
function currentStdDeposit(db: Database, t: PreorderTicket): number {
  const p = db.products.find((x) => x.id === t.product_id);
  if (t.batch_id) return db.batches.find((b) => b.id === t.batch_id)?.deposit_amount ?? 0;
  if (p?.is_stock) return depositFor(db.settings, p.wcf_type); // deposit_amount ของ SKU ที่ convert แล้ว = ราคาเต็ม ใช้ไม่ได้
  if (t.variant_id) return db.variants.find((v) => v.id === t.variant_id)?.deposit_amount ?? p?.deposit_amount ?? 0;
  return p?.deposit_amount ?? 0;
}

/** รายการในออเดอร์ที่ออกตั๋วใบนี้ (ตั๋วลูกใช้ของตั๋วแม่ต้นสาย) — สูตรเดียวกับ ryuma_market_std_deposit (v76):
 *  1) id ตั๋ว = 't-' + id รายการ · 2) ตั๋วรุ่นเก่า: รายการของคนจ่าย สินค้า/แบบ/รอบเดียวกัน มัดจำต่อชิ้นตรงกับตั๋ว (±1 บาท)
 *  ไม่เจอ = ตั๋วแอดมินมอบ/ไล่เก็บ/หาของ หรือออเดอร์ของคนอื่นที่เครื่องนี้มองไม่เห็น (ใบที่ซื้อต่อมา — คนแรกเติมไปแล้ว) */
export function sourceOrderItemOf(db: Database, t: PreorderTicket) {
  const r = t.split_from ? (ticketRoot(db, t) ?? t) : t;
  const approved = db.orders.filter((o) => o.status === 'approved');
  for (const o of approved) {
    const it = o.items.find((i) => orderTicketId(i.id) === r.id);
    if (it) return it;
  }
  const payer = ticketPayer(r);
  const unitDep = r.qty > 0 ? (r.deposit_paid ?? 0) / r.qty : 0;
  const tTime = new Date(r.created_at).getTime();
  let best: { it: (typeof approved)[number]['items'][number]; d: number } | null = null;
  for (const o of approved) {
    if (o.user_id !== payer) continue;
    for (const i of o.items) {
      if ((i.qty ?? 0) <= 0 || i.product_id !== r.product_id || (i.variant_id ?? null) !== (r.variant_id ?? null) || (i.batch_id ?? null) !== (r.batch_id ?? null)) continue;
      const iDep = i.unit_deposit ?? (i.deposit_amount ?? 0) / Math.max(1, i.qty);
      if (Math.abs(iDep - unitDep) > 1) continue;
      const d = Math.abs(new Date(o.approved_at ?? o.created_at).getTime() - tTime);
      if (!best || d < best.d) best = { it: i, d };
    }
  }
  return best?.it;
}

/**
 * "มัดจำปกติ" ต่อชิ้น (ข้อ 9) = มัดจำของรายการ "ตอนซื้อ" ก่อนส่วนลดยศ — Gold มัดจำครึ่ง / Diamond มัดจำ 0
 * ต้องเติมให้ถึงตัวนี้ก่อนเปลี่ยนใบ/ลงขาย (audit รอบ C R1-22: เดิมใช้มัดจำสินค้าปัจจุบัน → ร้านขึ้นมัดจำทีหลัง ใบมัดจำเต็มก็โดนสั่งเติม)
 * ตั๋วที่ไม่มีออเดอร์รองรับ (แอดมินมอบ/ไล่เก็บ/หาของ) = ไม่ได้ลดมัดจำด้วยยศ → 0 ไม่ต้องเติม (R2B-05 · เจ้าของ 2026-10-02)
 * ไม่เกินราคาเต็มต่อชิ้นของตั๋ว · ต้องตรงกับ ryuma_market_std_deposit (SQL v76)
 */
export function standardDepositPerUnit(db: Database, t: PreorderTicket): number {
  const it = sourceOrderItemOf(db, t);
  if (!it) return 0;
  const base = it.std_deposit ?? currentStdDeposit(db, t); // ก่อนรัน v76 รายการยังไม่มี std_deposit
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

/** ยอดเติมมัดจำเท่ากับ (หรือเกิน) ยอดค้างทั้งหมด = ต้องจ่ายส่วนต่างปิดใบตามปกติแทน (audit รอบ C R1-44) */
export function topupIsFullPayment(db: Database, t: PreorderTicket): boolean {
  const gap = depositGap(db, t);
  return gap > 0 && gap >= Math.max(0, (t.remaining_amount ?? 0) - (t.remaining_paid ?? 0));
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

// ── ดีลของฉัน / หน้าจอ ───────────────────────────────────────────────────────
export type DealRole = 'seller' | 'buyer' | 'none';
export const dealRole = (tr: TicketTransfer, uid: string): DealRole =>
  tr.from_user_id === uid ? 'seller' : tr.to_user_id === uid ? 'buyer' : 'none';

/** เวลาที่เหลือให้คนขายยืนยันรับเงิน (ms) — ติดลบ = เกิน 12 ชม. แล้ว (ข้อ 12/15) · ยังไม่จ่าย = NaN */
export const sellerSlaLeft = (tr: TicketTransfer, now: Date = new Date()) =>
  tr.paid_at ? ms(tr.paid_at) + MARKET.sellerSlaH * 3_600_000 - now.getTime() : NaN;

const DEAL_ACTIVE = ['paid', 'reviewing', 'seller_ok', 'pending_admin'];
const DEAL_DONE = ['done', 'approved', 'cancelled', 'expired'];

/** ดีลของฉันแยกกลุ่ม (/market/mine): ต้องทำ · กำลังดำเนินการ · ลงขายอยู่ · ประวัติ */
export function myDeals(db: Database, uid: string, now: Date = new Date()) {
  const mine = db.transfers
    .filter((tr) => tr.from_user_id === uid || tr.to_user_id === uid)
    .sort((a, b) => ms(b.updated_at ?? b.listed_at) - ms(a.updated_at ?? a.listed_at));
  const st = (tr: TicketTransfer) => effectiveStatus(tr, now);
  const isTodo = (tr: TicketTransfer) => {
    const role = dealRole(tr, uid);
    return (role === 'seller' && (st(tr) === 'paid' || (st(tr) === 'reviewing' && tr.review_reason === 'seller_silent')))
      || (role === 'buyer' && st(tr) === 'reserved');
  };
  const todo = mine.filter(isTodo);
  return {
    todo,
    active: mine.filter((tr) => !isTodo(tr) && DEAL_ACTIVE.includes(st(tr))),
    selling: mine.filter((tr) => !isTodo(tr) && dealRole(tr, uid) === 'seller' && ['listed', 'reserved'].includes(st(tr))),
    // ผู้ซื้อ: ซ่อนการจองกระดานที่หมดเวลา (ไม่มีอะไรเกิด) แต่ดีลที่โอนเงินไปแล้วต้องเห็นเสมอ (v75 late slip)
    history: mine.filter((tr) => DEAL_DONE.includes(st(tr)) && !(dealRole(tr, uid) === 'buyer' && st(tr) === 'expired' && !tr.paid_at)),
  };
}

/** ตัวเลขที่คนขายเห็นก่อนกดลงประกาศ (หน้าลงขาย) — ชิ้นที่ขายคิดแบบเดียวกับตอนไฟนอล (splitShare) */
export function listingPreview(t: PreorderTicket, qty: number, price: number) {
  const s = qty >= t.qty ? { deposit_paid: t.deposit_paid, remaining_amount: t.remaining_amount, remaining_paid: t.remaining_paid } : splitShare(t, qty).child;
  const paid = s.deposit_paid + s.remaining_paid;
  const due = Math.max(0, s.remaining_amount - s.remaining_paid);
  return { paid, due, total: s.deposit_paid + s.remaining_amount, buyerTotal: price + due, profit: price - paid };
}

/** ใบนี้ได้มาจากตลาด (ดีลที่ปิดแล้ว ผู้ซื้อ = คนนี้) — ป้าย "🔁 ได้มาจากตลาด" ในกระเป๋า */
export const boughtFromMarket = (db: Database, t: PreorderTicket, uid: string) =>
  db.transfers.find((tr) => TRANSFER_DONE.has(tr.status) && tr.to_user_id === uid && (tr.child_ticket_id || tr.ticket_id) === t.id);

/** ร้านยังขายตัวนี้อยู่ไหม — ไม่ = ป้าย "หมดในร้าน" + การ์ดโฮโลบนกระดาน (ของที่คนตามหา) */
export function soldOutInShop(db: Database, productId: string): boolean {
  const p = db.products.find((x) => x.id === productId);
  if (!p) return true;
  if (p.status === 'open' && !p.is_stock) return false;
  if (p.is_stock && (p.stock_qty ?? 0) > 0) return false;
  return !db.batches.some((b) => b.product_id === productId && b.status === 'open' && b.published !== false && b.stock_qty > 0);
}

/** คิวงานแอดมิน (หน้า /admin/market + badge เมนู + การ์ด /admin/today)
 *  ready = คนขายยืนยันแล้ว รอไฟนอล · reviewing = รอแอดมินตัดสิน · overdue = โอนแล้วแต่คนขายเงียบเกิน 12 ชม. */
export function marketQueue(db: Database, now: Date = new Date()) {
  const live = db.transfers.map((tr) => ({ tr, st: effectiveStatus(tr, now) }));
  const ready = live.filter((x) => x.st === 'seller_ok' || x.st === 'pending_admin').map((x) => x.tr);
  const reviewing = live.filter((x) => x.st === 'reviewing').map((x) => x.tr);
  const overdue = live.filter((x) => x.st === 'paid' && sellerSlaLeft(x.tr, now) <= 0).map((x) => x.tr);
  const waiting = live.filter((x) => x.st === 'paid' && sellerSlaLeft(x.tr, now) > 0).map((x) => x.tr);
  // v73: ข้อเสนอเปลี่ยนใบที่รอผู้รับ (ดูเฉยๆ ไม่ใช่งานแอดมิน) + สลิปเติมมัดจำรอตรวจ (งานแอดมิน แยกหัวข้อ)
  const offers = live.filter((x) => x.st === 'reserved' && isDirect(x.tr)).map((x) => x.tr);
  const topups = topupQueue(db);
  // v75: ผู้รับโอนเงินแล้วแต่ดีลปิดไปก่อน (คนส่งถอน/หมดเวลา/ตั๋วเปลี่ยน) — ต้องเคลียร์คืนเงิน (งานแอดมิน · audit รอบ B R1-01)
  const lateSlips = db.transfers.filter((tr) => tr.review_reason === 'late_slip');
  return { ready, reviewing, overdue, waiting, offers, topups, lateSlips, jobs: ready.length + reviewing.length + overdue.length + topups.length + lateSlips.length };
}
