/**
 * การรับของ / ใบปะหน้าพัสดุ (ryuma delivery spec 2026-07-19).
 * ลูกค้าเลือกวิธีรับของได้เมื่อ "จ่ายครบ + ของถึงไทยแล้ว (หรือเป็น in-stock)" — ทุกวิธีรอแอดมิน
 * Accept. ใบปะหน้า A4 = 8 ช่อง (2×4) รวมพรีออเดอร์+in-stock ในรอบเดียว; ลูกค้าเดียวกัน
 * ที่อยู่เดียวกัน = ช่องเดียว หลายบรรทัดสินค้า.
 */

import type { Database, PreorderTicket, DeliveryMethod } from '../entities';
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
  // ตัดสินด้วยยอดจริง ไม่ใช่ field status — ตั๋ว in-stock จาก checkout เกิดมา remaining 0/0 แต่
  // status ค้าง 'active' ตลอด (มีแต่ admin approve ส่วนต่าง/grant ที่เซ็ต 'paid_full') → เคยโชว์ "เปิดจอง"
  // ทั้งที่จ่ายครบ (audit 2026-07-23, เคส Taweesin)
  if (t.status === 'paid_full' || ticketPaidFull(t)) return 'paid_full';
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

/** ผู้รับของช่องใบปะหน้า — custom ใช้ 3 ช่องที่กรอก, ที่เหลืออ่านสดจากโปรไฟล์ผู้ใช้. */
export interface ShipTo { name: string; phone: string; address: string }
export const resolveShipTo = (db: Database, t: PreorderTicket): ShipTo => {
  if (t.delivery?.method === 'custom')
    return { name: t.delivery.name ?? '', phone: t.delivery.phone ?? '', address: t.delivery.address ?? '' };
  const u = db.users.find((x) => x.id === t.owner_id);
  return { name: u?.display_name ?? '—', phone: u?.phone ?? '', address: u?.shipping_address ?? '' };
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
export interface LabelSlot { key: string; to: ShipTo; tickets: PreorderTicket[]; lines: { label: string; qty: number }[] }
export const labelSlots = (db: Database, tickets: PreorderTicket[]): LabelSlot[] => {
  const map = new Map<string, LabelSlot>();
  for (const t of tickets) {
    const to = resolveShipTo(db, t);
    const key = `${t.owner_id}|${to.name}|${to.phone}|${to.address}`;
    const slot = map.get(key) ?? { key, to, tickets: [], lines: [] };
    slot.tickets.push(t);
    // productLabel ลงท้าย "- ค่าย" อยู่แล้ว (DNA) — รวมจำนวนถ้าสินค้า+แบบซ้ำกันในช่องเดียว
    const label = productLabel(db, t.product_id, t.variant_id);
    const line = slot.lines.find((l) => l.label === label);
    if (line) line.qty += t.qty; else slot.lines.push({ label, qty: t.qty });
    map.set(key, slot);
  }
  return [...map.values()];
};
