/**
 * การรับของ / ใบปะหน้าพัสดุ (ryuma delivery spec 2026-07-19).
 * ลูกค้าเลือกวิธีรับของได้เมื่อ "จ่ายครบ + ของถึงไทยแล้ว (หรือเป็น in-stock)" — ทุกวิธีรอแอดมิน
 * Accept. ใบปะหน้า A4 = 8 ช่อง (2×4) รวมพรีออเดอร์+in-stock ในรอบเดียว; ลูกค้าเดียวกัน
 * ที่อยู่เดียวกัน = ช่องเดียว หลายบรรทัดสินค้า.
 */

import type { Database, PreorderTicket, DeliveryMethod, ActivityLog } from '../entities';
import { productLabel } from './catalog';

/** ผู้ส่ง — คงที่ทุกช่อง (spec ข้อ 2). */
export const SENDER_NAME = 'ริวมะ';
export const SENDER_PHONE = '0853475681';

export const DELIVERY_METHOD_LABEL: Record<DeliveryMethod, string> = {
  registered: 'ส่งตามที่อยู่ที่ลงทะเบียน',
  custom: 'ส่งที่อยู่ใหม่',
  courier: 'เรียกรถเข้ามารับเอง',
  pickup: 'เข้ามารับด้วยตัวเอง',
};

/** จ่ายครบหรือยัง (มัดจำเต็มราคา in-stock → remaining 0 = ครบตั้งแต่ซื้อ). */
export const ticketPaidFull = (t: PreorderTicket) => t.remaining_paid >= t.remaining_amount;

/**
 * ป้ายสถานะตั๋วฝั่งลูกค้า (ฐานระบบ flow การรับของ):
 * ส่ง/ปิดงานแล้ว → "เสร็จสิ้น" · ลูกค้า submit วิธีรับของแล้ว (จ่ายครบ) → "รอจัดส่ง" ·
 * จ่ายครบเฉยๆ → "จ่ายครบ" · นอกนั้นตามสถานะล็อต. คืนค่าเป็น key ของ STATUS ใน lib/theme.
 */
/** ตั๋ว "จบ/อยู่ปลายทาง" แล้ว (ถึงไทย/จ่ายครบ/เสร็จสิ้น) — ใช้แบ่งแท็บกระเป๋า (เรียบร้อย vs ใบพรี). */
export const ticketDone = (t: PreorderTicket): boolean =>
  t.status === 'shipped' || t.status === 'paid_full' || ticketPaidFull(t)
  || ['arrived', 'delivered', 'closed'].includes(t.product_status);

export const ticketBadgeKey = (t: PreorderTicket): string => {
  if (t.status === 'shipped') return 'shipped';
  if (t.delivery && ticketPaidFull(t)) return 'awaiting_ship';
  // ตัดสินด้วย "ยอดจริง" เท่านั้น — ห้ามเชื่อ field status (audit 2026-07-25 T3):
  // ตั๋ว in-stock จาก checkout เกิดมา remaining 0/0 แต่ status ค้าง 'active' (เคยโชว์ "เปิดจอง" ทั้งที่จ่ายครบ
  // — เคส Taweesin) · กลับกัน ถ้าแอดมินแก้มัดจำย้อนหลังจน status='paid_full' ค้างทั้งที่ยอดไม่ครบ
  // การเชื่อ field จะโกหกลูกค้าว่า "จ่ายครบ ✓" ทั้งที่ยังค้างเงิน
  if (ticketPaidFull(t)) return 'paid_full';
  return t.product_status;
};

/**
 * ตั๋วนี้ "พร้อมให้เลือกวิธีรับของ" หรือยัง: จ่ายครบ + ยังไม่จบงาน + ของอยู่ไทยแล้ว
 * (ถึงไทย/ส่งมอบ หรือเป็นสินค้า in-stock ที่พร้อมส่งตั้งแต่ซื้อ).
 */
export const deliveryReady = (db: Database, t: PreorderTicket): boolean => {
  if (t.status === 'shipped' || !ticketPaidFull(t)) return false;
  if (['arrived', 'delivered'].includes(t.product_status)) return true;
  const p = db.products.find((x) => x.id === t.product_id);
  return !!p?.is_stock;
};

/** ผู้รับของช่องใบปะหน้า — custom ใช้ช่องที่กรอกต่อตั๋ว, ที่เหลืออ่านสดจากโปรไฟล์ผู้ใช้.
 *  แพลตฟอร์มที่อยู่ 2026-09-12: ถ้ามี shipping_info (แยกช่อง) ใช้ "ชื่อผู้รับ/เบอร์ผู้รับ" จากนั้นก่อน —
 *  display_name คือชื่อเฟส ไม่ใช่ชื่อจ่าหน้าพัสดุ · ที่อยู่ยังอ่านจาก shipping_address (ประกอบแล้ว) เหมือนเดิม */
export interface ShipTo { name: string; phone: string; address: string }
export const resolveShipTo = (db: Database, t: PreorderTicket): ShipTo => {
  if (t.delivery?.method === 'custom')
    return { name: t.delivery.name ?? '', phone: t.delivery.phone ?? '', address: t.delivery.address ?? '' };
  const u = db.users.find((x) => x.id === t.owner_id);
  const info = u?.shipping_info;
  return {
    name: info?.name?.trim() || u?.display_name || '—',
    phone: info?.phone?.trim() || u?.phone || '',
    address: u?.shipping_address ?? '',
  };
};

/**
 * คิว "รอแจ้งเลขพัสดุ" (แอดมินใส่ tracking → จบงาน): พร้อมรับของ + ยังไม่มีเลขพัสดุ + เป็นแบบ
 * ส่งพัสดุ. ตั๋วเก่าที่ไม่ได้เลือก (delivery ว่าง) เข้าคิวเฉพาะพรีออเดอร์ที่ "ถึงไทย" ตาม flow เดิม —
 * in-stock ต้องเลือกวิธีรับของก่อนถึงจะโผล่ (กันตั๋ว in-stock เก่าที่ปิดงานนอกระบบไหลท่วมคิว).
 */
export const parcelQueue = (db: Database): PreorderTicket[] =>
  db.tickets.filter((t) => {
    // มี parcel_no แต่ status ยังไม่ shipped = เซฟครึ่งเดียว (split-flush) — คงไว้ในคิวให้แอดมินกรอกซ้ำ
    if (t.status === 'shipped' || !ticketPaidFull(t)) return false;
    if (!t.delivery) return t.product_status === 'arrived'; // flow เดิม (ตั๋วก่อน v52)
    return !!t.delivery.accepted_at && (t.delivery.method === 'registered' || t.delivery.method === 'custom');
  });

/**
 * จ่ายครบ + ของพร้อมส่ง แต่ลูกค้ายังไม่กดเลือกวิธีรับของ → ไม่เข้าคิวไหนเลย แอดมินมองไม่เห็น
 * (เคสจริง Taweesin 2026-07-23: ตั๋ว in-stock จ่ายครบแล้วหายเงียบ). พรีที่ "ถึงไทย" ไม่นับ —
 * ตั๋วพวกนั้นไหลเข้า parcelQueue ตาม flow เดิมอยู่แล้ว.
 */
export const awaitingChoice = (db: Database): PreorderTicket[] =>
  // 'delivered' legacy (ไม่มี delivery/parcel) = ส่งมอบตาม flow เก่าไปแล้ว — อย่าชวนแอดมินทวงลูกค้าซ้ำ
  db.tickets.filter((t) => !t.delivery && !t.parcel_no && !['arrived', 'delivered'].includes(t.product_status) && deliveryReady(db, t));

/** คำขอรับของที่รอแอดมิน Accept. */
export const deliveryRequests = (db: Database): PreorderTicket[] =>
  db.tickets.filter((t) => t.delivery && !t.delivery.accepted_at && t.status !== 'shipped');

/** งานรับเอง/รถเข้ารับ ที่ Accept แล้ว รอแอดมินปิดงานเอง (spec ข้อ 7.3). */
export const handoffQueue = (db: Database): PreorderTicket[] =>
  db.tickets.filter((t) =>
    t.delivery && !!t.delivery.accepted_at && !t.delivery.closed_at && t.status !== 'shipped'
    && (t.delivery.method === 'courier' || t.delivery.method === 'pickup'));

/**
 * จัดกลุ่มตั๋วเป็น "ช่อง" ของใบปะหน้า: ลูกค้าเดียวกัน + ที่อยู่เดียวกัน = ช่องเดียว (spec ข้อ 4.3 —
 * in-stock ส่งพร้อมพรีได้), ที่อยู่ custom ต่างกัน = แยกช่องให้เอง. บรรทัดสินค้า = ชื่อ - ค่าย ×จำนวน.
 */
export interface LabelSlot {
  key: string; to: ShipTo; tickets: PreorderTicket[]; lines: { label: string; qty: number }[];
  /** เวลาที่งานนี้ "เข้าคิว" = แอดมินกดรับเรื่อง (accepted_at) ครั้งแรกสุดในช่อง — ไม่มี = ตั๋วเก่าก่อน v52 (ไม่มีเวลา)
   *  เจ้าของ 2026-10-10: "เข้ามาหลายช่วง ไม่รู้ว่าอันไหนมาก่อนหลัง" → เรียงเก่าสุดก่อน + เลขคิว */
  since?: string;
  requestedAt?: string; // ลูกค้ากดขอรับของเมื่อไหร่ (เก่าสุดในช่อง)
  queueNo: number;      // ลำดับคิว 1.. (เก่าสุด = 1)
}
const minIso = (a?: string, b?: string) => (!a ? b : !b ? a : a < b ? a : b);
export const labelSlots = (db: Database, tickets: PreorderTicket[]): LabelSlot[] => {
  const map = new Map<string, LabelSlot>();
  for (const t of tickets) {
    const to = resolveShipTo(db, t);
    const key = `${t.owner_id}|${to.name}|${to.phone}|${to.address}`;
    const slot = map.get(key) ?? { key, to, tickets: [], lines: [], queueNo: 0 };
    slot.tickets.push(t);
    slot.since = minIso(slot.since, t.delivery?.accepted_at ?? t.delivery?.requested_at);
    slot.requestedAt = minIso(slot.requestedAt, t.delivery?.requested_at);
    // productLabel ลงท้าย "- ค่าย" อยู่แล้ว (DNA) — รวมจำนวนถ้าสินค้า+แบบซ้ำกันในช่องเดียว
    const label = productLabel(db, t.product_id, t.variant_id);
    const line = slot.lines.find((l) => l.label === label);
    if (line) line.qty += t.qty; else slot.lines.push({ label, qty: t.qty });
    map.set(key, slot);
  }
  // เก่าสุดก่อน (มาก่อนได้ก่อน) · ตั๋วเก่าที่ไม่มีเวลาไว้ท้ายสุด
  const out = [...map.values()].sort((a, b) => (!a.since ? 1 : !b.since ? -1 : a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  out.forEach((s, i) => { s.queueNo = i + 1; });
  return out;
};

/* ── สถานะ "พิมพ์ใบปะหน้าแล้วหรือยัง" (เจ้าของ 2026-10-11) ───────────────────────────────────
 * ปัญหา: ติ๊กพิมพ์ไปแล้ว มีรายการใหม่เข้ามา → งงว่าช่องไหนเคยกดสร้างรูปไปแล้ว.
 * จดไว้ใน activity_logs (ไม่ต้องรัน SQL · เห็นทุกเครื่อง · แอดมินอ่านได้คนเดียว — มีที่อยู่ลูกค้า)
 * แถวละ 1 ช่องต่อการพิมพ์ 1 ครั้ง: target_id = id ตั๋วในช่องคั่นด้วย "," · summary = ผู้รับ+ที่อยู่ที่ "พิมพ์ลงใบจริง"
 * (ใช้เทียบตรงตัวว่าที่อยู่เปลี่ยนหลังพิมพ์ไหม + เป็นหลักฐานว่าใบที่ติดกล่องจ่าหน้าไปที่ไหน)
 * ⚠ client โหลดประวัติแค่ 400 แถวล่าสุด — ใบที่ค้างคิวนานจนแถวพิมพ์หลุดหน้าต่าง จะกลับมาเป็น "ยังไม่พิมพ์" (พิมพ์ซ้ำได้ ไม่เสียหาย) */
export const LABEL_PRINT_ACTION = 'print_label';
export const labelPrintSummary = (to: ShipTo): string => `พิมพ์ใบปะหน้า → ${to.name} ${to.phone} · ${to.address || '—'}`;
export const labelPrintTarget = (slot: LabelSlot): { targetId: string; targetLabel: string } => ({
  targetId: slot.tickets.map((t) => t.id).join(','),
  targetLabel: slot.tickets.map((t) => t.ticket_no).join(' '),
});

/** new = ยังไม่เคยพิมพ์ · added = เคยพิมพ์แล้วแต่มีตั๋วใหม่มารวมช่อง (ใบเก่าขาดรายการ ต้องพิมพ์ใหม่ทั้งช่อง)
 *  readdressed = พิมพ์ครบแต่ที่อยู่/ชื่อ/เบอร์เปลี่ยนหลังพิมพ์ · printed = พิมพ์แล้วตรงกับปัจจุบัน */
export type SlotPrintKind = 'new' | 'added' | 'readdressed' | 'printed';
export interface SlotPrintState {
  kind: SlotPrintKind;
  at?: string;            // พิมพ์ล่าสุดเมื่อไหร่ (แถวใหม่สุดที่แตะช่องนี้)
  by?: string;            // ใครกด
  labels: number;         // ตั๋วในช่องนี้กระจายอยู่ในใบปะหน้ากี่ใบ (>1 = เคยพิมพ์แยกกัน)
  newTicketNos: string[]; // added: ตั๋วที่ยังไม่อยู่ในใบไหนเลย
}
export function slotPrintState(db: Database, slot: LabelSlot): SlotPrintState {
  const ids = new Set(slot.tickets.map((t) => t.id));
  // ใหม่สุดก่อนเสมอ — ไม่พึ่งลำดับใน array (โหลดจาก DB กับ logActivity prepend บังเอิญตรงกัน แต่ไม่รับประกัน)
  const rows = db.activityLogs
    .filter((l) => l.action === LABEL_PRINT_ACTION && !!l.target_id)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const latest = new Map<string, ActivityLog>(); // ตั๋ว → แถวพิมพ์ล่าสุดที่มีตั๋วนี้
  for (const l of rows) {
    for (const tid of l.target_id!.split(',')) if (ids.has(tid) && !latest.has(tid)) latest.set(tid, l); // id ที่ไม่อยู่ในช่องแล้ว = ข้าม
    if (latest.size === ids.size) break;
  }
  if (latest.size === 0) return { kind: 'new', labels: 0, newTicketNos: [] };
  const used = [...new Set(latest.values())];
  const newest = used.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  const base = { at: newest.created_at, by: newest.actor_name, labels: used.length };
  const missing = slot.tickets.filter((t) => !latest.has(t.id));
  if (missing.length) return { kind: 'added', ...base, newTicketNos: missing.map((t) => t.ticket_no) };
  const expect = labelPrintSummary(slot.to);
  if (used.some((l) => l.summary !== expect)) return { kind: 'readdressed', ...base, newTicketNos: [] };
  return { kind: 'printed', ...base, newTicketNos: [] };
}
