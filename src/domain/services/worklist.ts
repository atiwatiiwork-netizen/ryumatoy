import type { Database, PreorderTicket, PaymentPlan } from '../entities';
import { awaitingChoice, deliveryRequests, parcelQueue, handoffQueue, ticketPaidFull } from './delivery';
import { ticketDue } from './money';
import { warehouseQueue } from './warehouse';
import { canConvertToInStock, stockRemaining } from './catalog';
import { orphanUsedGrants } from './coupons';
import { unmatchedApprovedItems } from './tickets';

/**
 * "งานค้างของฉันวันนี้" — รวมงานที่ต้องลงมือ จากทุกโมดูล มาไว้ที่เดียว (2026-07-25).
 * เดิมกระจายอยู่ 5 หน้า (สลิป/จัดส่ง/สต๊อกใบพรี/หาของ/สมาชิก) แอดมินต้องเปิดไล่ทีละหน้าถึงจะรู้ว่าค้างอะไร.
 * ทุกงานมี: ความเร่งด่วน · ชื่อ · จำนวน · ลิงก์ไปหน้าที่ทำงานนั้นได้จริง.
 */

export type Urgency = 'now' | 'today' | 'soon';
export interface WorkItem {
  key: string;
  urgency: Urgency;
  icon: string;      // emoji
  title: string;
  detail: string;
  count: number;
  href: string;
  money?: number;    // ยอดเงินที่เกี่ยวข้อง (ถ้ามี)
}

const todayStr = () => new Date().toISOString().slice(0, 10);

/** นัดชำระที่ถึงกำหนดวันนี้/เลยกำหนด (ยังไม่ปิด). */
export function plansDue(db: Database, at = todayStr()): PaymentPlan[] {
  return db.paymentPlans
    .filter((p) => p.status === 'open' && p.due_date <= at)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
}
/** นัดชำระที่ยังไม่ถึงกำหนด (ไว้ดูล่วงหน้า). */
export function plansUpcoming(db: Database, at = todayStr()): PaymentPlan[] {
  return db.paymentPlans.filter((p) => p.status === 'open' && p.due_date > at).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
}

/** ตั๋วที่ "ของถึงไทยแล้ว แต่ลูกค้ายังไม่จ่ายส่วนต่าง" — เงินที่ทวงได้เลย. */
export function collectableTickets(db: Database): PreorderTicket[] {
  return db.tickets.filter((t) => ticketDue(t) > 0 && ['arrived', 'delivered'].includes(t.product_status) && t.status !== 'shipped');
}

export function worklist(db: Database): WorkItem[] {
  const out: WorkItem[] = [];
  const add = (w: WorkItem) => { if (w.count > 0) out.push(w); };

  // ── เงิน: ต้องตรวจ/ต้องทวง ──
  const slips = db.orders.filter((o) => o.status === 'pending_approval');
  add({ key: 'slips', urgency: 'now', icon: '🧾', title: 'สลิปมัดจำรอตรวจ', detail: 'ลูกค้าโอนแล้ว รอออกตั๋ว', count: slips.length, href: '/admin/orders', money: slips.reduce((s, o) => s + (o.total_deposit ?? 0), 0) });

  const rps = db.remainingPayments.filter((r) => r.status === 'pending');
  add({ key: 'rp', urgency: 'now', icon: '💸', title: 'สลิปส่วนต่างรอตรวจ', detail: 'ตรวจแล้วตั๋วจะพร้อมจัดส่ง', count: rps.length, href: '/admin/orders', money: rps.reduce((s, r) => s + (r.amount ?? 0), 0) });

  const due = plansDue(db);
  add({ key: 'plans', urgency: 'today', icon: '📅', title: 'นัดชำระถึงกำหนด', detail: 'ลูกค้านัดจ่ายวันนี้/เลยกำหนด — กดเตือนได้', count: due.length, href: '/admin/today', money: due.reduce((s, p) => s + p.amount, 0) });

  const collect = collectableTickets(db);
  add({ key: 'collect', urgency: 'today', icon: '📣', title: 'ทวงส่วนต่างได้แล้ว', detail: 'ของถึงไทยแล้วแต่ยังค้างจ่าย', count: collect.length, href: '/admin/analytics', money: collect.reduce((s, t) => s + ticketDue(t), 0) });

  // ── จัดส่ง ──
  add({ key: 'dchoice', urgency: 'today', icon: '📦', title: 'รอลูกค้าเลือกวิธีรับของ', detail: 'จ่ายครบแล้ว — เตือนหรือส่งตามที่อยู่ได้เลย', count: awaitingChoice(db).length, href: '/admin/shipping' });
  add({ key: 'dreq', urgency: 'now', icon: '📥', title: 'คำขอรับของรอรับเรื่อง', detail: 'กดรับเรื่องเพื่อเข้าคิวแพ็ค', count: deliveryRequests(db).length, href: '/admin/shipping' });
  add({ key: 'parcel', urgency: 'now', icon: '🚚', title: 'รอใส่เลขพัสดุ', detail: 'แพ็คเสร็จ กรอกเลข = แจ้งลูกค้าอัตโนมัติ', count: parcelQueue(db).length, href: '/admin/shipping' });
  add({ key: 'handoff', urgency: 'today', icon: '🤝', title: 'รถเข้ารับ / มารับเอง', detail: 'ของออกจากมือแล้วกดปิดงาน', count: handoffQueue(db).length, href: '/admin/shipping' });

  // ── ล็อต/สต๊อก ──
  const wh = warehouseQueue(db);
  add({ key: 'warehouse', urgency: 'today', icon: '🏭', title: 'ยืนยันเข้าโกดังจีน', detail: 'จับคู่ SF แล้วเริ่มนับ ETA', count: wh.reduce((s, g) => s + g.tickets.length, 0), href: '/admin/stock' });

  const convertible = db.products.filter((p) => canConvertToInStock(db, p));
  add({ key: 'convert', urgency: 'soon', icon: '🛒', title: 'พรีจบแล้ว มีของเหลือ', detail: 'ตั้งราคาขายเป็นสินค้าพร้อมส่ง', count: convertible.reduce((s, p) => s + stockRemaining(db, p), 0), href: '/admin/instock' });

  const drafts = db.batches.filter((b) => b.status === 'open' && b.published === false);
  add({ key: 'draft', urgency: 'soon', icon: '📝', title: 'รอบพิเศษยังเป็นร่าง', detail: 'ยังไม่ขึ้นหน้าร้าน — กดเปิดขายเมื่อพร้อม', count: drafts.length, href: '/admin/stock' });

  // ── สมาชิก / หาของ / กิจกรรม ──
  add({ key: 'members', urgency: 'now', icon: '👤', title: 'สมาชิกใหม่รออนุมัติ', detail: 'อนุมัติแล้วลูกค้าเริ่มสั่งได้', count: db.users.filter((u) => u.approved === false && !u.is_admin).length, href: '/admin/members' });
  add({ key: 'ranks', urgency: 'soon', icon: '🏅', title: 'คำขอเลื่อนขั้นรอตรวจ', detail: '', count: db.rankRequests.filter((r) => r.status === 'pending').length, href: '/admin/ranks' });
  add({ key: 'sourcing', urgency: 'now', icon: '🔎', title: 'งานหาของรอดำเนินการ', detail: 'เสนอราคา / เริ่มงานหลังลูกค้าจ่ายมัดจำ', count: db.sourcingRequests.filter((r) => ['requested', 'paid'].includes(r.status)).length, href: '/admin/sourcing' });
  add({ key: 'mission', urgency: 'soon', icon: '🎯', title: 'ภารกิจรอตรวจ', detail: '', count: db.missionSubmissions.filter((m) => m.status === 'pending').length, href: '/admin/events' });

  const order: Record<Urgency, number> = { now: 0, today: 1, soon: 2 };
  return out.sort((a, b) => order[a.urgency] - order[b.urgency] || b.count - a.count);
}

/* ── ตรวจสุขภาพข้อมูล (เครื่องมือกวาดของเสีย) ─────────────────────────── */

export type IssueFix = 'release_hold' | 'reclaim_coupons' | 'repair_tickets' | 'none';
export interface DataIssue {
  key: string;
  severity: 'high' | 'mid' | 'low';
  title: string;
  why: string;                 // ทำไมต้องแก้ (ภาษาคน)
  rows: { id: string; label: string; sub?: string }[];
  fix: IssueFix;
}

export function dataIssues(db: Database): DataIssue[] {
  const out: DataIssue[] = [];
  const U = (id: string) => db.users.find((u) => u.id === id)?.display_name ?? id.slice(0, 8);
  const P = (id: string) => db.products.find((p) => p.id === id)?.series_name ?? '—';

  // 1) hold สต๊อกค้างแบบไม่มีออเดอร์ (ขวางของขายไม่ได้)
  const stuckHolds = db.stockReservations.filter((r) => r.status === 'paid' && !db.orders.some((o) => o.id === r.order_id));
  if (stuckHolds.length) out.push({
    key: 'holds', severity: 'high', fix: 'release_hold',
    title: 'ของถูกกันไว้แต่ไม่มีออเดอร์',
    why: 'ลูกค้ากดจ่ายแล้วออเดอร์ไม่เกิด (โดน gate/เน็ตหลุด) — ของถูกล็อกขายไม่ได้จนกว่าจะปล่อย',
    rows: stuckHolds.map((r) => ({ id: r.id, label: `${P(r.product_id ?? '')} ×${r.qty}`, sub: `${U(r.user_id ?? '')} · ${r.created_at ? new Date(r.created_at).toLocaleDateString('th-TH') : '—'}` })),
  });

  // 2) ออเดอร์อนุมัติแล้วแต่ตั๋วหาย
  const lost = unmatchedApprovedItems(db);
  if (lost.length) out.push({
    key: 'tickets', severity: 'high', fix: 'repair_tickets',
    title: 'ออเดอร์อนุมัติแล้วแต่ตั๋วไม่ออก',
    why: 'เซฟไม่สมบูรณ์ — ลูกค้าจ่ายเงินแล้วแต่ไม่มีตั๋วในกระเป๋า',
    rows: lost.map((x, i) => ({ id: String(i), label: P(x.item.product_id), sub: U(x.order.user_id) })),
  });

  // 3) คูปองถูกใช้แต่ออเดอร์/สลิปไม่สมบูรณ์
  const orphanUsers = [...new Set(db.couponGrants.filter((g) => g.status === 'used').map((g) => g.user_id))]
    .filter((uid) => orphanUsedGrants(db, uid).length > 0);
  if (orphanUsers.length) out.push({
    key: 'coupons', severity: 'mid', fix: 'reclaim_coupons',
    title: 'คูปองถูกใช้แต่รายการไม่สมบูรณ์',
    why: 'คูปองหายไปจากลูกค้าโดยไม่ได้ส่วนลด — คืนให้ได้เลย',
    rows: orphanUsers.map((uid) => ({ id: uid, label: U(uid), sub: `${orphanUsedGrants(db, uid).length} ใบ` })),
  });

  // 4) มีเลขพัสดุแต่ตั๋วไม่จบ
  const halfShipped = db.tickets.filter((t) => t.parcel_no && t.status !== 'shipped');
  if (halfShipped.length) out.push({
    key: 'halfship', severity: 'mid', fix: 'none',
    title: 'มีเลขพัสดุแต่สถานะตั๋วไม่จบ',
    why: 'เซฟครึ่งเดียว — กรอกเลขพัสดุซ้ำในแท็บจัดส่งเพื่อปิดงาน',
    rows: halfShipped.map((t) => ({ id: t.id, label: t.ticket_no, sub: `${P(t.product_id)} · ${U(t.owner_id)}` })),
  });

  // 5) รับเรื่องจัดส่งแล้วแต่ยอดยังไม่ครบ
  const acceptedUnpaid = db.tickets.filter((t) => t.delivery?.accepted_at && !ticketPaidFull(t) && t.status !== 'shipped');
  if (acceptedUnpaid.length) out.push({
    key: 'unpaidship', severity: 'high', fix: 'none',
    title: 'รับเรื่องจัดส่งแล้วแต่ยังค้างเงิน',
    why: 'ห้ามส่งก่อนเก็บครบ — เก็บเงินหรือแก้ยอดให้ถูกก่อน',
    rows: acceptedUnpaid.map((t) => ({ id: t.id, label: t.ticket_no, sub: `${U(t.owner_id)} · ค้าง ${ticketDue(t).toLocaleString()}฿` })),
  });

  // 6) ตั๋ว/ออเดอร์ชี้ของที่ไม่มีแล้ว
  const orphanTickets = db.tickets.filter((t) => !db.products.some((p) => p.id === t.product_id));
  if (orphanTickets.length) out.push({
    key: 'orphan', severity: 'high', fix: 'none',
    title: 'ตั๋วอ้างอิงสินค้าที่ถูกลบ',
    why: 'ลูกค้าเปิดตั๋วแล้วไม่เห็นข้อมูลสินค้า — ต้องสร้างสินค้ากลับหรือลบตั๋วทิ้ง',
    rows: orphanTickets.map((t) => ({ id: t.id, label: t.ticket_no, sub: U(t.owner_id) })),
  });

  // 7) ออเดอร์ไม่มีรายการสินค้า
  const emptyOrders = db.orders.filter((o) => ['pending_approval', 'approved'].includes(o.status) && o.items.length === 0);
  if (emptyOrders.length) out.push({
    key: 'emptyorder', severity: 'mid', fix: 'none',
    title: 'ออเดอร์ไม่มีรายการสินค้า',
    why: 'ข้อมูลขาดจากการเซฟ — อนุมัติไม่ได้ ให้ปฏิเสธแล้วให้ลูกค้าสั่งใหม่',
    rows: emptyOrders.map((o) => ({ id: o.id, label: `#${o.id.slice(-6)}`, sub: U(o.user_id) })),
  });

  const rank = { high: 0, mid: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
