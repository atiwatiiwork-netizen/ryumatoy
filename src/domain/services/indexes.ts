import type { Database, OrderItem, PointLedgerEntry, PreorderTicket } from '../entities';

/**
 * ดัชนีค้นหาแบบแคช (audit ความเร็ว 2026-09-23: ร้าน ~2,500 ตั๋ว → ฟังก์ชันคะแนนที่วนทุกตั๋วช้า 35-100 ms ต่อครั้ง
 * และหน้า /admin/points คิดซ้ำ ~240-360 ms ทุกครั้งที่ข้อมูลเปลี่ยน — มือถือช้ากว่านี้ 3-5 เท่า)
 *
 * แคชผูกกับ "array" ไม่ใช่ db: mutation ทุกตัว spread db ใหม่ แต่ array ที่ไม่ถูกแก้ยังเป็นตัวเดิม → ดัชนีอยู่รอดข้าม mutation
 * ตรวจความยาวด้วย: โค้ดทดสอบที่ push เข้า array เดิมจะได้ดัชนีใหม่ (แอปจริงไม่แก้ array ในที่)
 * ค่าที่เก็บเป็น "ตัวอ้างอิงแถวเดิม" → แก้ฟิลด์ในแถวทีหลังก็ยังเห็นค่าใหม่
 */
type Slot<V> = { n: number; v: V };
function arrayIndex<T, V>(cache: WeakMap<readonly T[], Slot<V>>, arr: readonly T[], build: (a: readonly T[]) => V): V {
  const hit = cache.get(arr);
  if (hit && hit.n === arr.length) return hit.v;
  const v = build(arr);
  cache.set(arr, { n: arr.length, v });
  return v;
}

const ledgerCache = new WeakMap<readonly PointLedgerEntry[], Slot<Map<string, PointLedgerEntry>>>();
/** แถวสมุดคะแนนตาม id */
export const ledgerById = (db: Database) =>
  arrayIndex(ledgerCache, db.pointLedger, (a) => new Map(a.map((e) => [e.id, e])));

const totalsCache = new WeakMap<readonly PointLedgerEntry[], Slot<Map<string, { sum: number; life: number }>>>();
const LIFETIME_KINDS = new Set(['earn_ticket', 'reverse_ticket', 'earn_adjust', 'monthly_reward', 'coupon_reward']);
/** ยอดรวมต่อคน: sum = ทุกแถว (คงเหลือ) · life = เฉพาะแต้มที่ "ได้จริง" (ยอดสะสม) */
export const ledgerTotals = (db: Database) =>
  arrayIndex(totalsCache, db.pointLedger, (a) => {
    const m = new Map<string, { sum: number; life: number }>();
    for (const e of a) {
      const r = m.get(e.user_id) ?? { sum: 0, life: 0 };
      r.sum += e.delta;
      if (LIFETIME_KINDS.has(e.kind)) r.life += e.delta;
      m.set(e.user_id, r);
    }
    return m;
  });

const itemCache = new WeakMap<readonly Database['orders'][number][], Slot<Map<string, { item: OrderItem; orderId: string }>>>();
/** รายการในออเดอร์ตาม id (ตั๋วจากออเดอร์ id = 't-' + itemId) + ออเดอร์ที่มันอยู่ */
export const orderItemById = (db: Database) =>
  arrayIndex(itemCache, db.orders, (a) => {
    const m = new Map<string, { item: OrderItem; orderId: string }>();
    for (const o of a) for (const it of o.items) m.set(it.id, { item: it, orderId: o.id });
    return m;
  });

const auctionCache = new WeakMap<readonly Database['auctions'][number][], Slot<Set<string>>>();
/** ออเดอร์ที่เป็นตัวจ่ายค่าประมูล */
export const auctionPayOrderIds = (db: Database) =>
  arrayIndex(auctionCache, db.auctions, (a) => new Set(a.map((x) => x.pay_order_id).filter((x): x is string => !!x)));

const ticketCache = new WeakMap<readonly PreorderTicket[], Slot<Map<string, PreorderTicket>>>();
export const ticketById = (db: Database) =>
  arrayIndex(ticketCache, db.tickets, (a) => new Map(a.map((t) => [t.id, t])));

const userCache = new WeakMap<readonly Database['users'][number][], Slot<Map<string, Database['users'][number]>>>();
export const userById = (db: Database) =>
  arrayIndex(userCache, db.users, (a) => new Map(a.map((u) => [u.id, u])));

const sourcingCache = new WeakMap<readonly Database['sourcingRequests'][number][], Slot<Set<string>>>();
/** คู่ "สินค้า|ลูกค้า" ที่มีเรื่องหาของ — ตัวตัดสินตั๋วหาของ (isSourcingTicket) */
export const sourcingKeys = (db: Database) =>
  arrayIndex(sourcingCache, db.sourcingRequests, (a) => new Set(a.map((s) => `${s.product_id}|${s.user_id}`)));

const rpCache = new WeakMap<readonly Database['remainingPayments'][number][], Slot<Set<string>>>();
/** ตั๋วที่มีสลิปส่วนต่างอนุมัติแล้ว (ใช้ตัดสิน "จ่ายเต็มตั้งแต่เกิด" ของตั๋วที่ไม่มีออเดอร์) */
export const approvedRpTicketIds = (db: Database) =>
  arrayIndex(rpCache, db.remainingPayments, (a) => new Set(a.filter((r) => r.status === 'approved').map((r) => r.ticket_id)));

const rpAtCache = new WeakMap<readonly Database['remainingPayments'][number][], Slot<Map<string, string>>>();
/** เวลาอนุมัติสลิปส่วนต่างล่าสุดของแต่ละตั๋ว (ISO) — ใช้ประมาณ "ตั๋วปิดยอดเมื่อไหร่" */
export const lastApprovedRpAt = (db: Database) =>
  arrayIndex(rpAtCache, db.remainingPayments, (a) => {
    const m = new Map<string, string>();
    for (const r of a) {
      if (r.status !== 'approved' || !r.approved_at) continue;
      const cur = m.get(r.ticket_id);
      if (!cur || r.approved_at > cur) m.set(r.ticket_id, r.approved_at);
    }
    return m;
  });

const cfgCache = new WeakMap<readonly Database['appConfig'][number][], Slot<Map<string, Record<string, unknown>>>>();
/** app_config ตาม key (ค่าตั้งต่อรอบพิเศษเก็บเป็นแถวละรอบ → ถูกอ่านต่อตั๋ว) */
export const appConfigByKey = (db: Database) =>
  arrayIndex(cfgCache, db.appConfig, (a) => new Map(a.map((c) => [c.key, c.value])));
