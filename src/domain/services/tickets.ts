import type { Database } from '../entities';
import { franchiseOf } from './catalog';

/**
 * Ticket number generator — `{abbr}-{year}-{month}-{seq}` (PRD §8).
 * Sequence is per-franchise, per-month, padded to 4 digits.
 */
/** The `{ABBR}-{YYYY}-{MM}` prefix a ticket_no is built on (no trailing dash). One sequence per
 *  franchise per month. Used by BOTH the client fallback below AND the server RPC reserve path. */
export function ticketPrefix(franchiseAbbr: string, when = new Date()): string {
  return `${franchiseAbbr.toUpperCase()}-${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
}

/** Pad a sequence int into a ticket_no's 4-digit suffix. */
export function padTicketSeq(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * Gate รอบพิเศษ (เจ้าของ 2026-07-23): ลูกค้าต้อง "เคยพรี" ถึงซื้อรอบพิเศษได้ — กันคนไม่พรีมาเอาแต่ของพิเศษ.
 * นับเป็นใบพรี: ตั๋วทุกใบ ยกเว้นการซื้อ in-stock ล้วน (ไม่มี batch + สินค้า is_stock + ไม่มีส่วนต่าง).
 * ตั๋วรอบพิเศษ/หาของ/ที่แอดมินมอบ นับหมด (= ลูกค้าพรีตัวจริง ทั้งในระบบและไล่เก็บนอกระบบ);
 * ตั๋วพรีเก่าบน SKU ที่ถูก convert เป็น in-stock ทีหลังก็ยังนับ (มีส่วนต่างเป็นหลักฐานว่าเป็นพรี).
 */
export function hasPreorderTicket(db: Database, userId: string): boolean {
  return db.tickets.some((t) => {
    if (t.owner_id !== userId) return false;
    if (t.batch_id) return true; // รอบพิเศษ / หาของ / มอบตั๋วสต๊อกใบพรี
    const p = db.products.find((x) => x.id === t.product_id);
    return !(p?.is_stock && t.remaining_amount === 0); // ตัดเฉพาะซื้อพร้อมส่งล้วน
  });
}

/** สวิตช์เปิด/ปิด gate รอบพิเศษ (app_config key 'special_gate') — default เปิด. ปิด = ใครก็ซื้อได้ (ช่วงโปร). */
export function specialGateEnabled(db: Database): boolean {
  const row = db.appConfig.find((c) => c.key === 'special_gate');
  return (row?.value as { enabled?: boolean } | undefined)?.enabled !== false;
}

/** ตะกร้านี้ซื้อรอบพิเศษได้ไหม: gate ปิดอยู่ = ได้เสมอ · เคยมีใบพรีอยู่แล้ว หรือ ตะกร้าเดียวกันมีพรีปกติพ่วง = ได้. */
export function canBuySpecialWithLines(db: Database, userId: string, lines: { productId: string; batchId?: string }[]): boolean {
  if (!specialGateEnabled(db)) return true;
  if (hasPreorderTicket(db, userId)) return true;
  return lines.some((l) => !l.batchId && !(db.products.find((p) => p.id === l.productId)?.is_stock));
}

/** How many tickets each prefix will need, from a list of product ids (one ticket per id) — used by the
 *  UI handler to reserve exactly that many numbers per prefix from the server before issuing. */
export function ticketPrefixCounts(db: Database, productIds: string[], when = new Date()): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pid of productIds) {
    const product = db.products.find((p) => p.id === pid);
    if (!product) continue;
    const prefix = ticketPrefix(franchiseOf(db, product)?.abbr ?? 'xx', when);
    counts[prefix] = (counts[prefix] ?? 0) + 1;
  }
  return counts;
}

/** CLIENT fallback numbering (seed/preview, or when a server reserve wasn't available). In a customer
 *  session this UNDER-counts (RLS hides other customers' tickets) and can collide — production issuance
 *  reserves numbers from the server RPC instead (see reserveTicketNos / migration v47). */
export function nextTicketNo(db: Database, franchiseAbbr: string, when = new Date(), pending: { ticket_no: string }[] = []): string {
  const prefix = ticketPrefix(franchiseAbbr, when) + '-';
  // ⚠ ต้องนับจาก "เลขสูงสุดที่เคยออก + 1" ไม่ใช่ "จำนวนแถว + 1" — ลำดับที่มีรู (แอดมินลบตั๋วซ้ำทิ้ง
  //   หรือบล็อกที่จองจาก RPC ใช้ไม่หมด) ทำให้การนับแถวย้อนไปทับเลขที่มีคนถืออยู่แล้ว → ticket_no
  //   ชน UNIQUE ตอน insert → ทั้ง flush ล้มถาวรและ reloadIfIdle ถูกบล็อกทั้งแท็บ (audit 2026-08-08)
  //   สูตรเดียวกับ real_max ใน RPC reserve_ticket_nos (migration v47)
  // รวม pending ของรอบเดียวกันด้วย ไม่งั้นตั๋วสองใบใน approveOrder เดียวกันชนกันเอง
  let max = 0;
  for (const t of [...db.tickets, ...pending]) {
    if (!t.ticket_no.startsWith(prefix)) continue;
    const n = parseInt(t.ticket_no.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + padTicketSeq(max + 1);
}

/**
 * APPROVED-order items that have no matching ticket — the "จ่ายแล้วตั๋วหาย" detector.
 * A ticket matches an item on owner + product + variant + batch, and each ticket satisfies at most
 * one item (same greedy matching repairTickets uses). Non-atomic multi-table flushes (a mobile
 * customer backgrounding the app mid-save on a Diamond auto-approve) can persist the order but not
 * its tickets; this finds those splits. `userId` narrows to one customer (self-heal).
 */
export const HEAL_SETTLE_MS = 3 * 60_000;

/**
 * IDEMPOTENCY KEY ของตั๋วที่เกิดจากออเดอร์ (เคสตั๋วซ้ำ Mongkol 2026-08-07).
 * ตั๋ว 1 ใบ = order_item 1 รายการเสมอ (qty อยู่บนตั๋ว ไม่ได้แตกเป็นหลายใบ) จึงผูก id ตั๋วกับ id
 * ของรายการได้ตรงๆ — order_items.id ถูก snapshot ไว้ตั้งแต่ตอนลูกค้าส่งออเดอร์ และ adapter ใช้
 * upsert บน primary key ⇒ ไม่ว่าเครื่องไหนจะมินต์ก่อน/หลัง/ซ้ำกี่รอบ ก็ลงเป็น "แถวเดิม" เสมอ
 * ไม่ใช่ใบใหม่. นี่คือชั้นที่กันตั๋วซ้ำได้จริง ส่วนช่วงรอให้นิ่ง/ลำดับการเขียนตารางเป็นแค่การลดโอกาสชน.
 */
export function orderTicketId(itemId: string): string {
  return `t-${itemId}`;
}

/** รายการที่ถูกยกเลิก (แอดมินลบตั๋วของมันทิ้ง) — ทำเครื่องหมายด้วย qty 0 เพื่อไม่ให้ตัวซ่อมมินต์คืน */
export function isVoidedItem(item: { qty: number }): boolean {
  return !(item.qty > 0);
}

type TicketLike = { id: string; owner_id: string; product_id: string; variant_id?: string; batch_id?: string };
type ItemLike = Database['orders'][number]['items'][number];

/** ตั๋วใบนี้เป็นของรายการนี้ไหม (ตั๋วรุ่นเก่าที่ id ไม่ได้ผูกกับรายการ ต้องเดาจาก สินค้า/รุ่น/รอบ) */
export function ticketForItem<T extends TicketLike>(tickets: T[], ownerId: string, item: ItemLike): T | undefined {
  const key = (a?: string) => a ?? null;
  return tickets.find((t) => t.id === orderTicketId(item.id)) ??
    tickets.find((t) => t.owner_id === ownerId && t.product_id === item.product_id &&
      key(t.variant_id) === key(item.variant_id) && key(t.batch_id) === key(item.batch_id));
}

/**
 * จับคู่รายการในออเดอร์กับตั๋วที่มีอยู่ — **สองรอบ**: รอบแรกจับเฉพาะคู่ที่ id ผูกกันตรงๆ
 * (orderTicketId) รอบสองค่อยเดาให้รายการที่เหลือแบบเดิม. ห้ามรวมเป็นรอบเดียว ไม่งั้นรายการแรก
 * จะ "เดา" ไปหยิบตั๋วของรายการหลังที่ผูก id กันอยู่แล้ว = ตั๋วใบเดียวถูกนับสองรายการ
 * แล้วรายการที่ตั๋วหายจริงจะตรวจไม่เจอ. `used` กันตั๋วใบเดิมถูกนับข้ามออเดอร์.
 */
export function pairItemsWithTickets<T extends TicketLike>(
  tickets: T[], ownerId: string, items: ItemLike[], used: Set<string>,
): { item: ItemLike; ticket?: T }[] {
  const out = items.map((item) => ({ item, ticket: undefined as T | undefined }));
  for (const row of out) {
    const exact = tickets.find((t) => !used.has(t.id) && t.id === orderTicketId(row.item.id));
    if (exact) { row.ticket = exact; used.add(exact.id); }
  }
  const key = (a?: string) => a ?? null;
  for (const row of out) {
    if (row.ticket) continue;
    const guess = tickets.find((t) =>
      !used.has(t.id) && t.owner_id === ownerId && t.product_id === row.item.product_id &&
      key(t.variant_id) === key(row.item.variant_id) && key(t.batch_id) === key(row.item.batch_id));
    if (guess) { row.ticket = guess; used.add(guess.id); }
  }
  return out;
}

export function unmatchedApprovedItems(db: Database, userId?: string, settledMs: number = HEAL_SETTLE_MS): { order: Database['orders'][number]; item: Database['orders'][number]['items'][number] }[] {
  const used = new Set<string>();
  const now = Date.now();
  const out: { order: Database['orders'][number]; item: Database['orders'][number]['items'][number] }[] = [];
  for (const order of db.orders) {
    if (order.status !== 'approved') continue;
    if (userId && order.user_id !== userId) continue;
    // ⚠ ออเดอร์ที่เพิ่งอนุมัติ "ยังไม่นิ่ง" — ห้ามตัดสินว่าตั๋วหาย (เคสตั๋วซ้ำ Mongkol 2026-08-07)
    //   การเซฟไม่ atomic ข้ามตาราง → เครื่องอื่นที่ poll เจอตอนเซฟยังไม่จบเห็น "approved แต่ไม่มีตั๋ว"
    //   ซึ่งไม่ใช่ตั๋วหายจริง แค่ยังเดินทางมาไม่ถึง → self-heal มินต์ทับกลายเป็น 2 ใบ
    //   ตั๋วที่หายจริงจะยังหายอยู่หลังพ้นช่วงนี้เสมอ จึงไม่เสียความสามารถในการกู้
    //   นาฬิกาเครื่องเพี้ยนไปข้างหน้า → ค่าติดลบ → ถือว่ายังไม่นิ่ง = ไม่มินต์ (fail-safe ฝั่งไม่ซ้ำ)
    if (settledMs > 0) {
      const approvedAt = new Date(order.approved_at ?? order.created_at).getTime();
      if (!Number.isFinite(approvedAt) || now - approvedAt < settledMs) continue;
    }
    // แอดมินลบตั๋วของรายการไหน = ตั้งใจให้รายการนั้นไม่มีตั๋ว (qty 0) — ห้ามมินต์คืน
    const live = order.items.filter((i) => !isVoidedItem(i));
    for (const { item, ticket } of pairItemsWithTickets(db.tickets, order.user_id, live, used)) {
      if (!ticket) out.push({ order, item });
    }
  }
  return out;
}

/** % of the full price that has been paid (deposit + remaining paid). */
export function paidPercent(deposit_paid: number, remaining_amount: number, remaining_paid: number): number {
  const total = deposit_paid + remaining_amount;
  if (total <= 0) return 100;
  return Math.round(((deposit_paid + remaining_paid) / total) * 100);
}
