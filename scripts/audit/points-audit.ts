/** ตรวจระบบคะแนน+ยศรายเดือน 28 ข้อ — รัน: npm run audit:points (ryuma-points-spec) */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.TZ = 'Asia/Bangkok'; // ตัดเดือนตามเวลาไทยเสมอ ไม่ว่ารันบนเครื่องไหน
import { SEED_DATABASE } from '../../src/data/seed';
import { approveOrder, approveRemainingPayment, submitOrder, payMonthlyRewards, deleteTicket, setMonthlyConfig } from '../../src/data/mutations';
import { balanceOf, ticketIsFullPay, rawPointsForTicket, ticketEarnEligible, earnIdFor } from '../../src/domain/services/points';
import { monthlyConfig, monthlyStatus, monthlyBoard, monthlyPieces, ticketYm, countsForMonthly, DEFAULT_MONTHLY, currentYm } from '../../src/domain/services/monthly';
import type { Database, PreorderTicket, Order } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail ?? ''); } };

const base: Database = structuredClone(SEED_DATABASE);
base.settings.points_enabled = true;
const YM = currentYm();
const [yy, mm] = YM.split('-').map(Number);
const inMonth = (day: number) => new Date(yy, mm - 1, day, 12, 0, 0).toISOString(); // เที่ยงวัน (เวลาเครื่อง = ไทย)
let seq = 0;
/** ใบพรี (มีออเดอร์คู่, snapshot มัดจำ < ราคา) ที่ปิดยอดแล้ว หรือยังค้าง */
function preTicket(db: Database, userId: string, day: number, opts: { qty?: number; closed?: boolean; price?: number; deposit?: number } = {}): PreorderTicket {
  seq += 1;
  const price = opts.price ?? 1600, dep = opts.deposit ?? 300, qty = opts.qty ?? 1;
  const itemId = `oi-a${seq}`;
  const order: Order = { id: `o-a${seq}`, user_id: userId, total_deposit: dep * qty, slip_url: '', status: 'approved', created_at: inMonth(day), approved_at: inMonth(day),
    items: [{ id: itemId, order_id: `o-a${seq}`, product_id: db.products[0].id, qty, deposit_amount: dep * qty, unit_price: price, unit_deposit: dep }] } as Order;
  const t: PreorderTicket = { id: `t-${itemId}`, ticket_no: `AU-${seq}`, product_id: db.products[0].id, owner_id: userId, original_buyer_id: userId, qty,
    deposit_paid: dep * qty, remaining_amount: (price - dep) * qty, remaining_paid: opts.closed ? (price - dep) * qty : 0,
    status: opts.closed ? 'paid_full' : 'active', product_status: 'open', qr_code_url: '', created_at: inMonth(day), approved_at: inMonth(day) } as PreorderTicket;
  db.orders.push(order); db.tickets.push(t);
  return t;
}
const U = 'u-audit', U2 = 'u-audit2';
base.users.push({ id: U, display_name: 'Audit A', rank: 'bronze', created_at: inMonth(1) } as any, { id: U2, display_name: 'Audit B', rank: 'bronze', created_at: inMonth(1) } as any);

// ── A) ไม่สะสมต่อกัน: 20 ใบ → ควรได้ 600 ไม่ใช่ 950 ───────────────────────────
{
  let db = structuredClone(base);
  for (let i = 0; i < 20; i++) preTicket(db, U, 3);
  const st = monthlyStatus(db, U, YM);
  ok('A1 20 ใบ → Gold entitled 600 (ไม่ใช่ 950)', st.top?.label === 'Gold' && st.entitled === 600 && st.due === 600, st);
  const b0 = balanceOf(db, U);
  db = payMonthlyRewards('u-admin', YM)(db);
  ok('A2 จ่าย Gold = +600', balanceOf(db, U) - b0 === 600, balanceOf(db, U) - b0);
  const n = db.pointLedger.length;
  db = payMonthlyRewards('u-admin', YM)(db);
  ok('A3 จ่ายซ้ำ +0 แถวไม่เพิ่ม', db.pointLedger.length === n && balanceOf(db, U) - b0 === 600);
  ok('A4 board: due 0 paid 600 over 0', (() => { const r = monthlyBoard(db, YM).find((x) => x.userId === U)!; return r.due === 0 && r.paid === 600 && r.over === 0; })());
}

// ── B) จ่าย Bronze กลางเดือน แล้วขึ้น Gold → จ่ายเพิ่มแค่ส่วนต่าง ─────────────────
{
  let db = structuredClone(base);
  for (let i = 0; i < 5; i++) preTicket(db, U, 5);
  db = payMonthlyRewards('u-admin', YM)(db);
  ok('B1 Bronze จ่าย 100', balanceOf(db, U) === 100, balanceOf(db, U));
  for (let i = 0; i < 15; i++) preTicket(db, U, 20);
  const st = monthlyStatus(db, U, YM);
  ok('B2 ขึ้น Gold: paid 100 due 500', st.top?.label === 'Gold' && st.paid === 100 && st.due === 500, st);
  db = payMonthlyRewards('u-admin', YM)(db);
  ok('B3 รวมได้ 600 พอดี (2 แถว)', balanceOf(db, U) === 600 && db.pointLedger.filter((e) => e.kind === 'monthly_reward' && e.user_id === U).length === 2, balanceOf(db, U));
  db = payMonthlyRewards('u-admin', YM)(db);
  ok('B4 จ่ายซ้ำหลังครบ +0', balanceOf(db, U) === 600);
}

// ── C) จ่ายเกิน: จ่าย Gold แล้วตั๋วถูกลบจนเหลือ Silver ────────────────────────────
{
  let db = structuredClone(base);
  const ts = Array.from({ length: 20 }, () => preTicket(db, U, 8));
  db = payMonthlyRewards('u-admin', YM)(db);
  for (const t of ts.slice(0, 8)) db = deleteTicket(t.id)(db);
  const st = monthlyStatus(db, U, YM);
  ok('C1 เหลือ 12 ใบ = Silver, over 350, due 0', st.pieces === 12 && st.top?.label === 'Silver' && st.over === 350 && st.due === 0, st);
  const n = db.pointLedger.length;
  db = payMonthlyRewards('u-admin', YM)(db);
  ok('C2 ปุ่มจ่ายไม่เพิ่มแถวเมื่อ over', db.pointLedger.length === n);
}

// ── D) คูปองครอบส่วนต่างทั้งก้อน → ใบพรียังเป็นพรี (20 คะแนน) และนับรายเดือน ─────────
{
  let db = structuredClone(base);
  const t = preTicket(db, U, 10, { price: 1000, deposit: 300 });
  db.remainingPayments.push({ id: 'rp-audit', ticket_id: t.id, user_id: U, amount: 0, slip_url: '', status: 'pending', created_at: inMonth(10), coupon_discount: 700 } as any);
  db = approveRemainingPayment('rp-audit')(db);
  const t2 = db.tickets.find((x) => x.id === t.id)!;
  ok('D1 หลังคูปองครอบ: remaining 0 paid 0', t2.remaining_amount === 0 && t2.remaining_paid === 0, t2);
  ok('D2 ticketIsFullPay = false (ดู snapshot ออเดอร์)', ticketIsFullPay(db, t2) === false);
  ok('D3 ได้ 20 คะแนน (อัตราพรี) ไม่ใช่ 30', db.pointLedger.find((e) => e.id === earnIdFor(t.id))?.delta === 20, db.pointLedger.find((e) => e.id === earnIdFor(t.id)));
  ok('D4 นับเป็นใบพรีรายเดือน', countsForMonthly(db, monthlyConfig(db), t2) && monthlyPieces(db, U, YM) === 1);
}

// ── E) ตั๋วมอบ/legacy (ไม่มีออเดอร์คู่) fallback ───────────────────────────────────
{
  const db = structuredClone(base);
  const full: PreorderTicket = { id: 'legacy-full', ticket_no: 'L1', product_id: db.products[0].id, owner_id: U, original_buyer_id: U, qty: 1, deposit_paid: 2000, remaining_amount: 0, remaining_paid: 0, status: 'paid_full', product_status: 'open', qr_code_url: '', created_at: inMonth(2), approved_at: inMonth(2) } as PreorderTicket;
  const pre: PreorderTicket = { ...full, id: 'legacy-pre', ticket_no: 'L2', deposit_paid: 300, remaining_amount: 700, remaining_paid: 700 };
  db.tickets.push(full, pre);
  ok('E1 legacy จ่ายเต็ม → พร้อมส่ง (30)', ticketIsFullPay(db, full) && rawPointsForTicket(db, full) === 30);
  ok('E2 legacy มีส่วนต่าง → พรี (20) + นับรายเดือน', !ticketIsFullPay(db, pre) && rawPointsForTicket(db, pre) === 20 && countsForMonthly(db, monthlyConfig(db), pre));
  ok('E3 legacy จ่ายเต็ม ไม่นับเป็นใบพรี (โหมด pre)', !countsForMonthly(db, monthlyConfig(db), full));
}

// ── F) ตัดเดือนตามเวลาไทย ─────────────────────────────────────────────────────────
{
  const mk = (iso: string) => ({ approved_at: iso, created_at: iso } as PreorderTicket);
  ok('F1 30 ก.ย. 23:59 ไทย = 2026-09', ticketYm(mk('2026-09-30T16:59:59.000Z')) === '2026-09', ticketYm(mk('2026-09-30T16:59:59.000Z')));
  ok('F2 1 ต.ค. 00:00 ไทย = 2026-10', ticketYm(mk('2026-09-30T17:00:00.000Z')) === '2026-10', ticketYm(mk('2026-09-30T17:00:00.000Z')));
  ok('F3 ไม่มี approved_at ใช้ created_at', ticketYm({ created_at: '2026-08-15T05:00:00.000Z' } as PreorderTicket) === '2026-08');
  ok('F4 currentYm รูปแบบ YYYY-MM', /^\d{4}-\d{2}$/.test(currentYm()));
}

// ── G) ใบที่เซ้งต่อ: ยอดพรีอยู่กับคนสั่ง (original_buyer) ─────────────────────────
{
  const db = structuredClone(base);
  const t = preTicket(db, U, 4);
  t.owner_id = U2; // โอนใบให้ U2 (P2P)
  ok('G1 นับให้ original_buyer (U) ไม่ใช่ owner (U2)', monthlyPieces(db, U, YM) === 1 && monthlyPieces(db, U2, YM) === 0);
}

// ── H) กติกา: ยศซ้ำ/ไม่เรียง ─────────────────────────────────────────────────────
{
  let db = structuredClone(base);
  db = setMonthlyConfig({ enabled: true, count: 'pre', tiers: [
    { pieces: 10, label: 'S', emoji: '🥈', points: 250, perks: [] },
    { pieces: 5, label: 'B', emoji: '🥉', points: 100, perks: [] },
    { pieces: 5, label: 'B-dup', emoji: '💥', points: 999, perks: [] },
  ] })(db);
  const cfg = monthlyConfig(db);
  ok('H1 เรียงน้อย→มาก + ตัดจำนวนใบซ้ำ (เก็บตัวแรก)', cfg.tiers.map((t) => `${t.pieces}:${t.label}`).join(',') === '5:B,10:S', cfg.tiers);
  ok('H2 ค่าเริ่มต้นเมื่อไม่มี config', monthlyConfig(structuredClone(base)).tiers.map((t) => t.points).join(',') === DEFAULT_MONTHLY.tiers.map((t) => t.points).join(','));
}

// ── I) approveOrder กดซ้ำหลังเซฟล้ม: ตั๋วมีอยู่แล้ว ต้องยังมินต์คะแนน (in-stock) ───────
{
  let db = structuredClone(base);
  const stock = db.products.find((p) => p.is_stock && (p.stock_qty ?? 0) > 0)!;
  db = submitOrder(U, [{ productId: stock.id, qty: 1, price: stock.price_total, deposit: stock.price_total, isStock: true } as never], 'slip.jpg')(db);
  const ord = db.orders.find((o) => o.user_id === U && o.status === 'pending_approval')!;
  db = approveOrder(ord.id)(db);
  ok('I1 อนุมัติปกติได้ 30', balanceOf(db, U) === 30, balanceOf(db, U));
  // จำลอง "ตั๋วขึ้นแล้วแต่ออเดอร์ยัง pending + คะแนนยังไม่ขึ้น" (เซฟล้มกลางคัน) แล้วกดอนุมัติซ้ำ
  db = { ...db, orders: db.orders.map((o) => (o.id === ord.id ? { ...o, status: 'pending_approval' as const } : o)), pointLedger: [] };
  db = approveOrder(ord.id)(db);
  ok('I2 อนุมัติซ้ำเมื่อตั๋วมีอยู่แล้ว → ยังมินต์ 30 (ไม่ข้าม)', balanceOf(db, U) === 30 && db.tickets.filter((t) => t.owner_id === U).length === 1, { bal: balanceOf(db, U), tickets: db.tickets.filter((t) => t.owner_id === U).length });
}

// ── J) ใบพรีที่ยังค้าง ไม่ได้คะแนน แต่ "นับ" เป็นใบพรีเดือน ─────────────────────────
{
  const db = structuredClone(base);
  const t = preTicket(db, U, 6, { closed: false });
  ok('J1 ค้างส่วนต่าง → ยังไม่ eligible แต่ monthly นับ', !ticketEarnEligible(db, t).ok && monthlyPieces(db, U, YM) === 1);
  ok('J2 qty 3 นับ 3 ใบ', (() => { const d = structuredClone(base); preTicket(d, U, 6, { qty: 3 }); return monthlyPieces(d, U, YM) === 3; })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
