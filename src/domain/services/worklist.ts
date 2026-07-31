import type { Database, PreorderTicket, PaymentPlan } from '../entities';
import { awaitingChoice, deliveryRequests, parcelQueue, handoffQueue, ticketPaidFull } from './delivery';
import { ticketDue } from './money';
import { warehouseQueue } from './warehouse';
import { canConvertToInStock, stockRemaining } from './catalog';
import { orphanUsedGrants } from './coupons';
import { unmatchedApprovedItems } from './tickets';
import { needsClose, payOverdue } from './auctions';

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

/** วันที่ "ตามเวลาไทย" (ปฏิทินที่ร้านใช้จริง) — ห้ามใช้ toISOString ที่เป็น UTC:
 *  ก่อน 7 โมงเช้าบ้านเรา UTC ยังเป็นเมื่อวาน → นัดที่ครบกำหนดวันนี้จะไม่ขึ้นคิวจนถึง 7 โมง (audit v56) */
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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

/** ตั๋วที่ "ของถึงไทยแล้ว แต่ลูกค้ายังไม่จ่ายส่วนต่าง" — เงินที่ทวงได้เลย.
 *  ตัดตั๋วที่ลูกค้าส่งสลิปมาแล้วรอเราตรวจออก: นั่นเป็นงานของการ์ด "สลิปส่วนต่างรอตรวจ"
 *  ถ้านับซ้ำ ยอดบนหน้าจะเบิ้ล และแอดมินจะไปทวงคนที่จ่ายมาแล้ว (audit v56) */
export function collectableTickets(db: Database): PreorderTicket[] {
  const awaitingReview = new Set(db.remainingPayments.filter((r) => r.status === 'pending').map((r) => r.ticket_id));
  return db.tickets.filter((t) => ticketDue(t) > 0 && ['arrived', 'delivered'].includes(t.product_status)
    && t.status !== 'shipped' && !awaitingReview.has(t.id));
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

  // count = จำนวน "งาน" (กี่ SKU ที่ต้องกดตั้งราคา) ไม่ใช่จำนวนชิ้น — ไม่งั้นเหลือ 40 ชิ้นของ SKU เดียว
  // จะโชว์ "40 งาน" แล้วเด้งขึ้นหัวตารางแซงงานด่วนจริง (audit v56)
  const convertible = db.products.filter((p) => canConvertToInStock(db, p));
  const pieces = convertible.reduce((s, p) => s + stockRemaining(db, p), 0);
  add({ key: 'convert', urgency: 'soon', icon: '🛒', title: 'พรีจบแล้ว มีของเหลือ', detail: `ตั้งราคาขายเป็นสินค้าพร้อมส่ง (รวม ${pieces} ชิ้น)`, count: convertible.length, href: '/admin/instock' });

  const drafts = db.batches.filter((b) => b.status === 'open' && b.published === false);
  add({ key: 'draft', urgency: 'soon', icon: '📝', title: 'รอบพิเศษยังเป็นร่าง', detail: 'ยังไม่ขึ้นหน้าร้าน — กดเปิดขายเมื่อพร้อม', count: drafts.length, href: '/admin/stock' });

  // ── ประมูล (v60/v61) — ไม่มี scheduler: ถ้าไม่มีคนกด ห้องจะค้างและผู้ชนะไม่ได้รับแจ้ง ──
  const nowD = new Date();
  const toClose = db.auctions.filter((a) => needsClose(a, nowD));
  add({ key: 'auc_close', urgency: 'now', icon: '🔨', title: 'ประมูลหมดเวลา รอสรุปผล', detail: 'กดปิด + สรุปผลเพื่อประกาศผู้ชนะ', count: toClose.length, href: '/admin/auctions', money: toClose.reduce((s, a) => s + a.current_price, 0) });

  const unpaidWins = db.auctions.filter((a) => a.status === 'ended' && payOverdue(a, nowD));
  add({ key: 'auc_unpaid', urgency: 'now', icon: '⏳', title: 'ผู้ชนะประมูลเลยกำหนดจ่าย', detail: 'ทวง หรือยกสิทธิ์ให้อันดับ 2 ตามกติกา', count: unpaidWins.length, href: '/admin/auctions', money: unpaidWins.reduce((s, a) => s + (a.winning_amount ?? 0), 0) });

  const entries = db.auctionEntries.filter((e) => e.status === 'pending');
  add({ key: 'auc_entry', urgency: 'today', icon: '🎟️', title: 'ค่าเข้าสนามประมูลรอตรวจ', detail: 'อนุมัติแล้วลูกค้าบิดได้ทันที', count: entries.length, href: '/admin/auctions', money: entries.reduce((s, e) => s + e.amount, 0) });

  const cancelReqs = db.auctionBids.filter((b) => b.status === 'active' && !!b.cancel_requested_at);
  add({ key: 'auc_cancel', urgency: 'today', icon: '↩️', title: 'คำขอยกเลิกบิด', detail: 'ลูกค้าบิดผิด — ตรวจแล้วกดยกเลิกให้', count: cancelReqs.length, href: '/admin/auctions' });

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
  // ⚠ ต้องเทียบจาก orders.reservation_ids เท่านั้น — คอลัมน์ stock_reservations.order_id
  //   **ไม่เคยถูกเขียนเลย** (RPC ryuma_reserve/pay ไม่รับ order id) เดิมเช็ค `o.id === r.order_id`
  //   จึงเป็นจริงกับ hold ทุกใบ → ออเดอร์ที่รอตรวจสลิป "ทุกใบ" ถูกป้ายว่าเป็นข้อมูลเสีย
  //   พร้อมปุ่ม "ปล่อยของ" → กดแล้วของหลุดขายซ้ำ ลูกค้าที่โอนมาแล้วไม่ได้ของ (audit money #1)
  // + ต้องค้างเกิน 6 ชม.ก่อน ถึงจะเรียกว่าค้างจริง (ออเดอร์ที่เพิ่งเข้ายังรอเราตรวจอยู่ ปกติดี)
  const HOLD_STALE_MS = 6 * 60 * 60 * 1000;
  // นับเฉพาะออเดอร์ที่ "ยังไม่จบ" — ออเดอร์ที่อนุมัติ/ปฏิเสธไปแล้วควรปล่อย hold คืนตั้งแต่ตอนนั้น
  // ถ้า RPC ปล่อยของ time out ไป hold จะค้างถาวรและกันของขายไม่ได้ ต้องมองเห็นในหน้าสุขภาพข้อมูล
  // (ถ้านับออเดอร์ทุกสถานะ hold ที่ค้างจริงจะถูกซ่อนตลอดกาล — audit regression #5)
  const linked = new Set(db.orders.filter((o) => o.status === 'pending_approval').flatMap((o) => o.reservation_ids ?? []));
  const stuckHolds = db.stockReservations.filter((r) => r.status === 'paid'
    && !linked.has(r.id)
    && (!r.created_at || Date.now() - new Date(r.created_at).getTime() > HOLD_STALE_MS));
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
