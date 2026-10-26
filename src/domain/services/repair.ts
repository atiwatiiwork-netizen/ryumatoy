import type { Database, PreorderTicket, RepairClaim, RepairStatus, Carrier } from '../entities';

/**
 * 🔧 เรื่องซ่อม (เจ้าของ 2026-10-26): ลูกค้าได้รับของแล้วชำรุด → ยื่นเรื่องให้แอดมิน
 *
 * flow:  filed (ลูกค้ายื่น รูป+รายละเอียด)
 *     → address_sent (แอดมินส่งที่อยู่ช่าง — มีค่าตั้งต้นใน repair_config)
 *     → sent_to_tech (ลูกค้าส่งของแล้ว แจ้งเลขพัสดุ → จดว่าส่งให้ช่างวันไหน)
 *     → returned (ช่างซ่อมเสร็จ ส่งคืน — แอดมินแจ้งเลขพัสดุในระบบ)
 *     → done (ลูกค้ากดได้รับของ · หรือแอดมินปิดเรื่อง)
 *     · rejected (แอดมินไม่รับเรื่อง พร้อมเหตุผล — จาก filed/address_sent)
 *
 * กฎเคลม "ไม่เกิน 15 วันหลังได้รับของ": ระบบมีแค่ "วันที่ส่งของ" (ticket.shipped_out_at) ไม่มีวันรับจริง
 *   → กำหนด = shipped_out_at + days (15) + transit_days (3 เผื่อขนส่ง · รับเอง/รถเข้ารับ = 0)
 *   ตัวเลขอยู่ใน app_config 'repair_config' แก้ได้จากหน้าแอดมิน · ฝั่ง DB (trigger v89) คำนวณซ้ำด้วยสูตรเดียวกัน
 * ตัวจำแนกเดียว = repairWindow() — ห้ามเขียนเงื่อนไขซ้ำในหน้า (DNA เดียวกับ collect.ts / ticketSource.ts)
 */
export const REPAIR_CONFIG_KEY = 'repair_config';
// ลูกค้า → แอดมิน ใช้ LINE (notifyAdminLine) เท่านั้น: push หาแอดมินจากเครื่องลูกค้าส่งไม่ถึง (RLS ซ่อนเครื่องแอดมิน — audit #4 ของหาของ)
export const REPAIR_PUSH_ADDRESS = 'repair_address'; // แอดมินส่งที่อยู่ช่าง → เจ้าของเรื่อง
export const REPAIR_PUSH_RETURN = 'repair_return';   // แอดมินแจ้งเลขส่งกลับ → เจ้าของเรื่อง
export const REPAIR_PUSH_REJECT = 'repair_reject';   // แอดมินไม่รับเรื่อง → เจ้าของเรื่อง
export const MAX_REPAIR_IMAGES = 4;

export interface RepairConfig { days: number; transit_days: number; address: string }
export const DEFAULT_REPAIR_CONFIG: RepairConfig = { days: 15, transit_days: 3, address: '' };

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);

/** ระบบเปิดใช้แล้วหรือยัง = migration v89 รันแล้ว — ดูจาก "ตรา" v=89 ที่มีแต่ SQL ใส่ให้ (แอดมินเซฟที่อยู่จากหน้าเว็บก่อนรัน SQL
 *  สร้าง key ได้แต่ไม่มีตรา) · ก่อนรัน ลูกค้าต้องไม่เห็นปุ่ม ไม่งั้นกดยื่นแล้วเซฟพัง "ตารางไม่มี" (deploy ไปก่อนรัน SQL เป็นปกติของโปรเจกต์นี้) */
export const REPAIR_SCHEMA_V = 89;
export const repairLive = (db: Database) => db.appConfig.find((c) => c.key === REPAIR_CONFIG_KEY)?.value.v === REPAIR_SCHEMA_V;

export function repairConfig(db: Database): RepairConfig {
  const v = db.appConfig.find((c) => c.key === REPAIR_CONFIG_KEY)?.value ?? {};
  return {
    days: num(v.days, DEFAULT_REPAIR_CONFIG.days),
    transit_days: num(v.transit_days, DEFAULT_REPAIR_CONFIG.transit_days),
    address: typeof v.address === 'string' ? v.address : '',
  };
}

export const isOpenClaim = (c: RepairClaim) => c.status !== 'done' && c.status !== 'rejected';

/** เรื่องที่ยังไม่จบของตั๋วนี้ (มีได้ใบละ 1 เรื่อง) */
export const openRepairClaim = (db: Database, ticketId: string): RepairClaim | undefined =>
  db.repairClaims.find((c) => c.ticket_id === ticketId && isOpenClaim(c));

/** ทุกเรื่องของตั๋ว (ใหม่สุดก่อน) */
export const repairClaimsOf = (db: Database, ticketId: string): RepairClaim[] =>
  db.repairClaims.filter((c) => c.ticket_id === ticketId).sort((a, b) => (a.filed_at < b.filed_at ? 1 : -1));

/** วันเผื่อขนส่ง: รับเอง/รถเข้ารับ = ได้ของวันนั้น (0) · ส่งพัสดุ = transit_days */
export const repairTransitDays = (cfg: RepairConfig, t: PreorderTicket) =>
  t.delivery?.method === 'courier' || t.delivery?.method === 'pickup' ? 0 : cfg.transit_days;

const DAY = 86_400_000;
const BKK = 7 * 3_600_000; // เวลาไทย UTC+7 ไม่มี DST
/** จุดตัดการยื่น (exclusive) = เที่ยงคืนเวลาไทยหลังวันสุดท้าย — นับเป็น "วัน" ไม่ใช่ "ชั่วโมง" (ส่งของ 10:00 ไม่ได้แปลว่าหมดสิทธิ์ตอน 10:01 ของวันสุดท้าย)
 *  สูตรเดียวกับ trigger v89 · null = ไม่มีวันที่ส่งในระบบ (ตั๋วเก่าก่อนมีช่อง shipped_out_at) · เทียบด้วย now < cutoff */
export function repairDeadline(db: Database, t: PreorderTicket): Date | null {
  if (!t.shipped_out_at) return null;
  const ms = new Date(t.shipped_out_at).getTime();
  if (Number.isNaN(ms)) return null;
  const cfg = repairConfig(db);
  const bkk = new Date(ms + BKK);
  const dayStart = Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) - BKK; // 00:00 ไทยของวันที่ส่ง
  return new Date(dayStart + (cfg.days + repairTransitDays(cfg, t) + 1) * DAY);
}
/** วันสุดท้ายที่ยื่นได้ (สำหรับโชว์) = จุดตัด − 1 ms */
export const repairLastDay = (cutoffIso: string) => new Date(new Date(cutoffIso).getTime() - 1).toISOString();

export type RepairBlock = 'not_owner' | 'not_shipped' | 'no_date' | 'expired' | 'open_claim';
export interface RepairWindow {
  ok: boolean;
  reason?: RepairBlock;
  deadline?: string;   // ISO
  daysLeft?: number;   // เหลือกี่วัน (ปัดขึ้น) — ติดลบ = เกินแล้ว
  claim?: RepairClaim; // เรื่องที่ยังไม่จบ (reason open_claim)
}

export const REPAIR_BLOCK_TEXT: Record<RepairBlock, string> = {
  not_owner: 'ยื่นได้เฉพาะเจ้าของใบพรี',
  not_shipped: 'ยื่นได้หลังได้รับของแล้ว',
  no_date: 'ใบนี้ไม่มีวันที่ส่งในระบบ ทักแอดมิน',
  expired: 'เกินกำหนดยื่นเรื่องซ่อมแล้ว',
  open_claim: 'ใบนี้มีเรื่องซ่อมค้างอยู่',
};

/** ด่านเดียวของการยื่นเรื่อง — ใช้ทั้งปุ่มฝั่งลูกค้าและ mutation (ด่านต้องอยู่ใน mutation) */
export function repairWindow(db: Database, t: PreorderTicket, userId: string, now: Date = new Date()): RepairWindow {
  if (t.owner_id !== userId) return { ok: false, reason: 'not_owner' };
  if (t.status !== 'shipped') return { ok: false, reason: 'not_shipped' };
  const dl = repairDeadline(db, t);
  if (!dl) return { ok: false, reason: 'no_date' };
  const deadline = dl.toISOString();
  const daysLeft = Math.ceil((dl.getTime() - now.getTime()) / DAY); // นับวันปฏิทินที่เหลือ รวมวันนี้
  const open = openRepairClaim(db, t.id);
  if (open) return { ok: false, reason: 'open_claim', deadline, daysLeft, claim: open };
  if (now.getTime() >= dl.getTime()) return { ok: false, reason: 'expired', deadline, daysLeft };
  return { ok: true, deadline, daysLeft };
}

// ── สถานะ / ไทม์ไลน์ ──────────────────────────────────────────────────────
export const REPAIR_STATUS_LABEL: Record<RepairStatus, string> = {
  filed: 'ยื่นเรื่องแล้ว · รอแอดมินตรวจ',
  address_sent: 'ได้ที่อยู่ช่างแล้ว · ส่งของได้เลย',
  sent_to_tech: 'ส่งของให้ช่างแล้ว · กำลังซ่อม',
  returned: 'ช่างส่งคืนแล้ว · รอรับของ',
  done: 'เสร็จสิ้น',
  rejected: 'ไม่รับเรื่อง',
};
/** ป้ายสั้นฝั่งแอดมิน */
export const REPAIR_STATUS_SHORT: Record<RepairStatus, string> = {
  filed: 'รอตรวจ',
  address_sent: 'รอลูกค้าส่งของ',
  sent_to_tech: 'อยู่ที่ช่าง',
  returned: 'ส่งคืนแล้ว',
  done: 'เสร็จสิ้น',
  rejected: 'ไม่รับเรื่อง',
};
export const REPAIR_STEPS: { key: RepairStatus; label: string }[] = [
  { key: 'filed', label: 'ยื่นเรื่อง' },
  { key: 'address_sent', label: 'ได้ที่อยู่ช่าง' },
  { key: 'sent_to_tech', label: 'ส่งให้ช่าง' },
  { key: 'returned', label: 'ช่างส่งคืน' },
  { key: 'done', label: 'ได้รับของ' },
];
/** ลำดับขั้นบนไทม์ไลน์ (rejected = -1) */
export const repairStep = (s: RepairStatus) => REPAIR_STEPS.findIndex((x) => x.key === s);

/** ใครต้องทำต่อ */
export const repairNextActor = (s: RepairStatus): 'admin' | 'customer' | 'none' =>
  s === 'filed' || s === 'sent_to_tech' ? 'admin' : s === 'address_sent' || s === 'returned' ? 'customer' : 'none';

// ── คิวแอดมิน ──────────────────────────────────────────────────────────────
export interface RepairQueue {
  todo: RepairClaim[];     // แอดมินต้องทำ: filed (ส่งที่อยู่/ปฏิเสธ) + sent_to_tech (ของอยู่ที่ช่าง → แจ้งเลขส่งกลับ)
  waiting: RepairClaim[];  // รอลูกค้า: address_sent (รอส่งของ) + returned (รอกดได้รับ)
  closed: RepairClaim[];   // done + rejected
}
const byNewest = (a: RepairClaim, b: RepairClaim) => (a.filed_at < b.filed_at ? 1 : -1);
export function repairQueue(db: Database): RepairQueue {
  const all = [...db.repairClaims].sort(byNewest);
  return {
    todo: all.filter((c) => repairNextActor(c.status) === 'admin'),
    waiting: all.filter((c) => repairNextActor(c.status) === 'customer'),
    closed: all.filter((c) => !isOpenClaim(c)),
  };
}
export const repairAdminTodo = (db: Database) => db.repairClaims.filter((c) => repairNextActor(c.status) === 'admin').length;

/** เรื่องของลูกค้าคนหนึ่ง (ใหม่สุดก่อน) */
export const repairClaimsForUser = (db: Database, userId: string): RepairClaim[] =>
  db.repairClaims.filter((c) => c.user_id === userId).sort(byNewest);

// ── push / ข้อความ ──────────────────────────────────────────────────────────
type Payload = { title: string; body: string; url: string };
export const repairTicketUrl = (ticketNo: string) => `/wallet/${ticketNo}`;
export const repairAddressPayload = (label: string, ticketNo: string): Payload =>
  ({ title: '🔧 แอดมินส่งที่อยู่ช่างให้แล้ว', body: `${label} — เปิดดูที่อยู่แล้วส่งของได้เลย`, url: repairTicketUrl(ticketNo) });
export const repairReturnPayload = (label: string, carrier: string, tracking: string, ticketNo: string): Payload =>
  ({ title: '📦 ซ่อมเสร็จแล้ว กำลังส่งคืน', body: `${label} · ${carrier} ${tracking}`, url: repairTicketUrl(ticketNo) });
export const repairRejectPayload = (label: string, reason: string, ticketNo: string): Payload =>
  ({ title: '🔧 เรื่องซ่อม: ไม่รับเรื่อง', body: `${label} — ${reason}`, url: repairTicketUrl(ticketNo) });

export const CARRIER_NAME: Record<Carrier, string> = { ems: 'EMS', jt: 'J&T', flash: 'Flash', kerry: 'Kerry' };
export const CARRIERS: Carrier[] = ['jt', 'flash', 'kerry', 'ems'];
