import type { Database, PaymentPlan, PreorderTicket } from '../entities';
import { collectableTickets } from './worklist';
import { ticketDue } from './money';
import { marketLocked } from './market';
import { productLabel, lineImage } from './catalog';

/**
 * 📣 ตามของ (เจ้าของ 2026-10-10): "รวมรายการสินค้าที่มาถึงไทยแล้ว ลูกค้ายังไม่ชำระ"
 *
 * ตัวจำแนกเดียว = `collectableTickets()` ใน worklist.ts (ของถึงไทย/ส่งมอบ · ค้างส่วนต่าง · ยังไม่ส่ง · ไม่มีสลิปรอตรวจ)
 * ไฟล์นี้แค่ "จัดกลุ่ม" ให้หน้าตามของ — ห้ามเขียนเงื่อนไขสถานะซ้ำที่อื่น (DNA เดียวกับ ticketSource.ts)
 *
 * สิ่งที่หน้าต้องเห็นนอกจากรายการทวงได้:
 * - ใบที่ "ส่งสลิปแล้ว รอเราตรวจ" โชว์เป็นแถวจาง (ไม่นับเงิน/ไม่ทวง) — ไม่งั้นสินค้าที่มี 5 คนโชว์ 3 แล้วคิดว่าข้อมูลหาย
 * - ใบที่ "ติดประกาศขายในตลาด" (marketLocked) ลูกค้าจ่ายไม่ได้ → ห้ามทวง (ชิป + ตัดออกจาก push)
 * - ⚠ ส่งของไปแล้วแต่ยังค้าง (ไม่ควรมี) แยกเป็นแถบแดงบนสุด
 * - ไม่มีวันที่ "ถึงไทยเมื่อ" ในฐาน (ไม่มีคอลัมน์ arrived_at) — "เตือนล่าสุด" derive จาก activityLogs action remind_collect
 */
export const REMIND_ACTION = 'remind_collect';
export const COLLECT_PUSH_KEY = 'collect_remind';

export interface CollectTicket {
  ticket: PreorderTicket;
  due: number;
  label: string;          // ชื่อสินค้า (+ แบบ/รอบ)
  awaitingSlip: boolean;  // ลูกค้าส่งสลิปแล้ว รอตรวจ — ไม่ทวง
  locked: boolean;        // ติดประกาศขายในตลาด — จ่ายไม่ได้ ไม่ทวง
}
export interface CollectCustomer {
  userId: string;
  name: string;
  memberCode?: string;
  phone?: string;
  lineId?: string;
  tickets: CollectTicket[];
  due: number;            // เฉพาะใบที่ทวงได้
  chaseable: CollectTicket[]; // ใบที่ทวงได้ (ไม่รอสลิป ไม่ติดตลาด)
  plan?: PaymentPlan;     // มีนัดชำระค้างอยู่ (ยังเปิด) — อย่าทวงซ้ำ
  lastRemindedAt?: string;
  hasBell: boolean;       // มีเครื่องที่เปิดกระดิ่ง → push ถึง
}
export interface CollectProduct {
  productId: string;
  name: string;
  image?: string;
  due: number;
  customers: CollectCustomer[];
  ticketCount: number;    // ใบที่อยู่ในหน้านี้ (ทวงได้ + รอสลิป + ติดตลาด)
  awaitingSlip: number;
  /** ใบอื่นของสินค้าเดียวกันที่ "ไม่อยู่ในรายการทวง" — เจ้าของ 2026-10-10: "โลกิมี 7 ใบ ทำไมเหลือ 4" ต้องบอกว่าอีก 3 ไปอยู่ไหน */
  totalTickets: number;
  others: { paidFull: number; shipped: number; notArrived: number };
}
export interface CollectBoard {
  products: CollectProduct[];
  customers: CollectCustomer[]; // มุมมองรายคน (คนเดียวค้างหลาย SKU → ทักครั้งเดียว)
  totalDue: number;
  ticketCount: number;    // ใบที่ทวงได้
  customerCount: number;  // คนที่ทวงได้
  awaitingSlip: number;
  shippedUnpaid: PreorderTicket[];
}

const arrived = (t: PreorderTicket) => ['arrived', 'delivered'].includes(t.product_status);

/** ใบที่ของถึงแล้ว ค้างจ่าย แต่ลูกค้าส่งสลิปมาแล้วรอเราตรวจ — งานของการ์ด "สลิปส่วนต่างรอตรวจ" ไม่ใช่งานทวง */
export function awaitingSlipTickets(db: Database): PreorderTicket[] {
  const pending = new Set(db.remainingPayments.filter((r) => r.status === 'pending').map((r) => r.ticket_id));
  return db.tickets.filter((t) => ticketDue(t) > 0 && arrived(t) && t.status !== 'shipped' && pending.has(t.id));
}

/** ⚠ ส่งของออกไปแล้วแต่ยังค้างเงิน — ไม่ควรเกิด ต้องเห็นก่อนทุกอย่าง */
export function shippedUnpaidTickets(db: Database): PreorderTicket[] {
  return db.tickets.filter((t) => t.status === 'shipped' && ticketDue(t) > 0);
}

function ticketLabel(db: Database, t: PreorderTicket): string {
  const base = productLabel(db, t.product_id, t.variant_id);
  const b = t.batch_id ? db.batches.find((x) => x.id === t.batch_id) : undefined;
  return b?.label ? `${base} · ${b.label}` : base;
}

export function lastRemindedAt(db: Database, userId: string): string | undefined {
  let best: string | undefined;
  for (const l of db.activityLogs) {
    if (l.action !== REMIND_ACTION || l.target_id !== userId) continue;
    if (!best || l.created_at > best) best = l.created_at;
  }
  return best;
}

function buildCustomer(db: Database, userId: string, rows: CollectTicket[], now: Date): CollectCustomer {
  const u = db.users.find((x) => x.id === userId);
  const chaseable = rows.filter((r) => !r.awaitingSlip && !r.locked);
  return {
    userId,
    name: u?.display_name ?? '—',
    memberCode: u?.member_code,
    phone: u?.phone,
    lineId: u?.line_id,
    tickets: rows,
    chaseable,
    due: chaseable.reduce((s, r) => s + r.due, 0),
    plan: db.paymentPlans.find((p) => p.user_id === userId && p.status === 'open'),
    lastRemindedAt: lastRemindedAt(db, userId),
    hasBell: db.pushSubscriptions.some((s) => s.user_id === userId),
  };
}

export function collectBoard(db: Database, now: Date = new Date()): CollectBoard {
  const chase = collectableTickets(db);
  const waiting = awaitingSlipTickets(db);
  const waitingIds = new Set(waiting.map((t) => t.id));
  const all: CollectTicket[] = [...chase, ...waiting].map((t) => ({
    ticket: t,
    due: ticketDue(t),
    label: ticketLabel(db, t),
    awaitingSlip: waitingIds.has(t.id),
    locked: marketLocked(db, t.id, now),
  }));

  // ── รายสินค้า → รายคนในสินค้านั้น ──
  const byProduct = new Map<string, CollectTicket[]>();
  for (const r of all) byProduct.set(r.ticket.product_id, [...(byProduct.get(r.ticket.product_id) ?? []), r]);
  const products: CollectProduct[] = [...byProduct.entries()].map(([productId, rows]) => {
    const byUser = new Map<string, CollectTicket[]>();
    for (const r of rows) byUser.set(r.ticket.owner_id, [...(byUser.get(r.ticket.owner_id) ?? []), r]);
    const customers = [...byUser.entries()].map(([uid, rs]) => buildCustomer(db, uid, rs, now)).sort((a, b) => b.due - a.due || a.name.localeCompare(b.name, 'th'));
    const p = db.products.find((x) => x.id === productId);
    const inPage = new Set(rows.map((r) => r.ticket.id));
    const others = { paidFull: 0, shipped: 0, notArrived: 0 };
    let totalTickets = rows.length;
    for (const t of db.tickets) {
      if (t.product_id !== productId || inPage.has(t.id)) continue;
      totalTickets++;
      if (t.status === 'shipped') others.shipped++;          // ส่งพัสดุแล้ว (ค้างเงินด้วย = อยู่แถบแดงบนสุด)
      else if (ticketDue(t) <= 0) others.paidFull++;         // จ่ายครบแล้ว รอจัดส่ง
      else others.notArrived++;                              // ใบรอบอื่น ของยังไม่ถึงไทย (product_status ต่อใบยังเป็นผลิต/เดินทาง)
    }
    return {
      productId,
      name: p ? productLabel(db, productId) : productId,
      image: lineImage(db, productId),
      due: customers.reduce((s, c) => s + c.due, 0),
      customers,
      ticketCount: rows.length,
      awaitingSlip: rows.filter((r) => r.awaitingSlip).length,
      totalTickets,
      others,
    };
  }).sort((a, b) => b.due - a.due || b.ticketCount - a.ticketCount);

  // ── รายคน (ข้ามสินค้า) ──
  const byUser = new Map<string, CollectTicket[]>();
  for (const r of all) byUser.set(r.ticket.owner_id, [...(byUser.get(r.ticket.owner_id) ?? []), r]);
  const customers = [...byUser.entries()].map(([uid, rs]) => buildCustomer(db, uid, rs, now)).sort((a, b) => b.due - a.due || a.name.localeCompare(b.name, 'th'));

  const chaseCustomers = customers.filter((c) => c.chaseable.length > 0);
  return {
    products,
    customers,
    totalDue: chaseCustomers.reduce((s, c) => s + c.due, 0),
    ticketCount: chaseCustomers.reduce((s, c) => s + c.chaseable.length, 0),
    customerCount: chaseCustomers.length,
    awaitingSlip: waiting.length,
    shippedUnpaid: shippedUnpaidTickets(db),
  };
}

const fmtBaht = (n: number) => '฿' + Math.round(n).toLocaleString('en-US');

/** ข้อความ push ถึงลูกค้า 1 คน (บอกยอดได้ ห้ามบอกจำนวนสต๊อก — DNA push no-qty) */
export function collectPushPayload(c: CollectCustomer, chaseable: CollectTicket[] = c.chaseable): { title: string; body: string; url: string } {
  const names = [...new Set(chaseable.map((r) => r.label))];
  const list = names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} และอีก ${names.length - 2} รายการ`;
  const due = chaseable.reduce((s, r) => s + r.due, 0);
  return { title: '📦 ของถึงไทยแล้ว รอชำระส่วนต่าง', body: `${list} — ค้าง ${fmtBaht(due)} · ชำระแล้วเลือกวิธีรับของได้เลย`, url: '/wallet' };
}

/** ข้อความสำหรับก๊อปไปทักเอง (LINE/เฟส) — ลูกค้าที่ไม่ได้เปิดกระดิ่ง */
export function collectMessage(db: Database, c: CollectCustomer, chaseable: CollectTicket[] = c.chaseable, origin = 'https://ryumatoy.vercel.app'): string {
  const acc = db.paymentAccounts.find((a) => a.active);
  const lines = chaseable.map((r) => `• ${r.label} ×${r.ticket.qty} ค้างส่วนต่าง ${fmtBaht(r.due)} (ตั๋ว ${r.ticket.ticket_no})`);
  const due = chaseable.reduce((s, r) => s + r.due, 0);
  return [
    `สวัสดีครับคุณ ${c.name} 🙏 ของถึงไทยแล้วครับ`,
    ...lines,
    `รวมค้าง ${fmtBaht(due)}`,
    acc ? `โอนได้ที่ ${acc.name} ${acc.number}` : '',
    `แล้วแนบสลิปในแอปที่ ${origin}/wallet ได้เลยครับ`,
  ].filter(Boolean).join('\n');
}
