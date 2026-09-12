/** ตรวจระบบคะแนน + รอบเดือน (Phase 1) — รัน: npm run audit:points (ryuma-points-spec / ryuma-points-redeem-spec) */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.TZ = 'Asia/Bangkok'; // ตัดเดือนตามเวลาไทยเสมอ ไม่ว่ารันบนเครื่องไหน
import { SEED_DATABASE } from '../../src/data/seed';
import { approveOrder, approveRemainingPayment, submitOrder, closeMonth, deleteTicket, backfillPoints, adjustPoints, submitRemainingPayment, setMonthlyConfig } from '../../src/data/mutations';
import { balanceOf, lifetimeOf, ticketIsFullPay, rawPointsForTicket, ticketEarnEligible, earnIdFor, ticketsMissingEarn } from '../../src/domain/services/points';
import { monthlyConfig, monthlyStatus, monthlyBoard, monthlyPieces, ticketYm, countsForMonthly, DEFAULT_MONTHLY, currentYm, prevYm, closedMonths, monthsToClose, computeMonthSnapshot, monthlyBonusForTicket, pendingBonusDiscount, mbonusId, latestRankOf } from '../../src/domain/services/monthly';
import type { Database, PreorderTicket, Order } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail ?? ''); } };

const base: Database = structuredClone(SEED_DATABASE);
base.settings.points_enabled = true;
const YM = prevYm(currentYm());            // เดือนก่อน = เดือนที่จะ "ปิด"
const [yy, mm] = YM.split('-').map(Number);
const at = (day: number, hour = 12) => new Date(yy, mm - 1, day, hour, 0, 0).toISOString();
let seq = 0;
/** ใบพรี (มีออเดอร์คู่, snapshot มัดจำ < ราคา) อนุมัติวันที่ day */
function preTicket(db: Database, userId: string, day: number, opts: { qty?: number; closed?: boolean; price?: number; deposit?: number; hour?: number } = {}): PreorderTicket {
  seq += 1;
  const price = opts.price ?? 1600, dep = opts.deposit ?? 300, qty = opts.qty ?? 1;
  const itemId = `oi-a${seq}`;
  const when = at(day, opts.hour ?? 12);
  const order: Order = { id: `o-a${seq}`, user_id: userId, total_deposit: dep * qty, slip_url: '', status: 'approved', created_at: when, approved_at: when,
    items: [{ id: itemId, order_id: `o-a${seq}`, product_id: db.products[0].id, qty, deposit_amount: dep * qty, unit_price: price, unit_deposit: dep }] } as Order;
  const t: PreorderTicket = { id: `t-${itemId}`, ticket_no: `AU-${String(seq).padStart(3, '0')}`, product_id: db.products[0].id, owner_id: userId, original_buyer_id: userId, qty,
    deposit_paid: dep * qty, remaining_amount: (price - dep) * qty, remaining_paid: opts.closed ? (price - dep) * qty : 0,
    status: opts.closed ? 'paid_full' : 'active', product_status: 'arrived', qr_code_url: '', created_at: when, approved_at: when } as PreorderTicket;
  db.orders.push(order); db.tickets.push(t);
  return t;
}
const U = 'u-audit', U2 = 'u-audit2';
base.users.push({ id: U, display_name: 'Audit A', rank: 'bronze', created_at: at(1) } as any, { id: U2, display_name: 'Audit B', rank: 'bronze', created_at: at(1) } as any);
const enableMonthly = (db: Database) => setMonthlyConfig({ ...DEFAULT_MONTHLY, enabled: true, start_ym: YM })(db);
/** ปิดใบ (จ่ายส่วนต่างเต็ม) ผ่านทางปกติ: ส่งสลิป → อนุมัติ */
const closeTicket = (db: Database, t: PreorderTicket, uid: string) => {
  let d = submitRemainingPayment(t.id, uid, 0, `https://x/${t.id}.jpg`)(db);
  const rp = d.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  d = approveRemainingPayment(rp.id)(d);
  return { db: d, rp };
};

// ── A) ปิดเดือน: Silver 10 ลูกค้ามี 14 → 10 ใบแรกตามลำดับอนุมัติได้รางวัล ─────────
{
  let db = enableMonthly(structuredClone(base));
  const tix: PreorderTicket[] = [];
  for (let i = 0; i < 14; i++) tix.push(preTicket(db, U, 1 + i)); // อนุมัติวันที่ 1..14 ตามลำดับ
  const st = monthlyStatus(db, U, YM);
  ok('A1 14 ใบ = Silver, ใบที่ได้รางวัล = 10 ใบแรก', st.top?.label === 'Silver' && st.rewardTicketIds.length === 10 && st.rewardTicketIds.join() === tix.slice(0, 10).map((t) => t.id).join(), st.rewardTicketIds);
  ok('A2 ยังไม่ปิดเดือน → ยังไม่มีโบนัสผูกใบ', monthlyBonusForTicket(db, tix[0]) === null);
  ok('A3 monthsToClose = [เดือนก่อน]', monthsToClose(db).join() === YM, monthsToClose(db));
  db = closeMonth('u-admin', YM)(db);
  const snap = closedMonths(db)[YM];
  ok('A4 snapshot: Silver share 25, 10 ใบ', !!snap && snap.users[U]?.tier.label === 'Silver' && snap.users[U].share === 25 && snap.users[U].tickets.length === 10, snap?.users[U]);
  ok('A5 ปิดแล้ว monthsToClose ว่าง', monthsToClose(db).length === 0);
  ok('A6 ใบที่ 1 มีโบนัส 25 (ยังไม่ใช้) · ใบที่ 11 ไม่มี', monthlyBonusForTicket(db, tix[0])?.amount === 25 && monthlyBonusForTicket(db, tix[0])?.applied === false && monthlyBonusForTicket(db, tix[10]) === null);
  // ปิดใบที่ 1 → ส่วนลด 25 อัตโนมัติ
  const due = tix[0].remaining_amount;
  const r1 = closeTicket(db, tix[0], U);
  db = r1.db;
  const t1 = db.tickets.find((x) => x.id === tix[0].id)!;
  ok('A7 ส่งสลิป: ยอดโอน = ค้าง − 25', r1.rp.amount === due - 25, r1.rp.amount);
  ok('A8 อนุมัติ: หนี้ถูกลด 25 + ปิดใบ + ได้ 20 คะแนน + สมุดมีคู่ +25/−25', t1.status === 'paid_full' && t1.remaining_amount === due - 25 && db.pointLedger.some((e) => e.id === earnIdFor(t1.id) && e.delta === 20) && db.pointLedger.some((e) => e.id === mbonusId(YM, t1.id) && e.delta === 25) && db.pointLedger.some((e) => e.id === `pl-mbonus-use-${YM}-${t1.id}` && e.delta === -25), t1);
  ok('A9 ยอดคงเหลือ = 20 (โบนัสเป็นส่วนลด ไม่ใช่แต้ม)', balanceOf(db, U) === 20, balanceOf(db, U));
  ok('A10 โบนัสใบที่ 1 ถูกใช้แล้ว (applied) · pendingBonusDiscount = 0', monthlyBonusForTicket(db, t1)?.applied === true && pendingBonusDiscount(db, t1) === 0);
  // ปิดใบที่ 11 → ไม่มีส่วนลด
  const due11 = tix[10].remaining_amount;
  const r11 = closeTicket(db, tix[10], U);
  db = r11.db;
  ok('A11 ใบที่ 11 ไม่มีส่วนลด: ยอดโอน = ค้างเต็ม', r11.rp.amount === due11 && balanceOf(db, U) === 40);
  // ปิดเดือนซ้ำ → no-op
  const n = db.pointLedger.length;
  db = closeMonth('u-admin', YM)(db);
  ok('A12 ปิดเดือนซ้ำ = no-op', closedMonths(db)[YM] === snap && db.pointLedger.length === n);
  ok('A13 latestRankOf = Silver เดือนก่อน', latestRankOf(db, U)?.ym === YM && latestRankOf(db, U)?.snap.tier.label === 'Silver');
  const board = monthlyBoard(db, YM).find((r) => r.userId === U)!;
  ok('A14 กระดาน: ใช้แล้ว 1 รอปิดใบ 9', board.used === 1 && board.pending === 9 && board.rewardCount === 10, board);
}

// ── B) ใบที่ปิดไปก่อนวันปิดเดือน → ได้เป็นแต้ม · เปลี่ยนกติกาหลังปิดไม่กระทบ ────────
{
  let db = enableMonthly(structuredClone(base));
  for (let i = 0; i < 5; i++) preTicket(db, U, 2 + i, { closed: i < 2 }); // 2 ใบแรกปิดไปแล้ว
  const b0 = balanceOf(db, U);
  db = closeMonth('u-admin', YM)(db);
  ok('B1 Bronze 5 ใบ: 2 ใบที่ปิดก่อน → +20 แต้ม ×2 = 40', balanceOf(db, U) - b0 === 40, balanceOf(db, U) - b0);
  ok('B2 ใบที่ปิดก่อนถูกนับว่า applied (ไม่ลดซ้ำ)', db.tickets.filter((t) => t.owner_id === U && t.status === 'paid_full').every((t) => monthlyBonusForTicket(db, t)?.applied));
  db = setMonthlyConfig({ ...monthlyConfig(db), tiers: [{ pieces: 5, label: 'Bronze', emoji: '🥉', points: 1000, perks: [] }] })(db);
  const t3 = db.tickets.find((t) => t.owner_id === U && t.status === 'active')!;
  ok('B3 เปลี่ยนคะแนนยศหลังปิดเดือน → ส่วนลดใบเดิมยัง 20 (snapshot ล็อก)', pendingBonusDiscount(db, t3) === 20, pendingBonusDiscount(db, t3));
}

// ── C) ใบถูกโอน (owner ≠ original_buyer) → ไม่ได้ส่วนลด · คนรับไม่ได้ยศ ─────────────
{
  let db = enableMonthly(structuredClone(base));
  const tix: PreorderTicket[] = [];
  for (let i = 0; i < 5; i++) tix.push(preTicket(db, U, 3 + i));
  db = closeMonth('u-admin', YM)(db);
  db.tickets = db.tickets.map((t) => (t.id === tix[0].id ? { ...t, owner_id: U2 } : t)); // เซ้งใบแรกให้ U2
  const moved = db.tickets.find((t) => t.id === tix[0].id)!;
  ok('C1 ใบที่เซ้งแล้ว ไม่มีโบนัส', monthlyBonusForTicket(db, moved) === null && pendingBonusDiscount(db, moved) === 0);
  const r = closeTicket(db, moved, U2);
  ok('C2 ผู้รับปิดใบ: จ่ายเต็ม ไม่ได้ลด แต่ได้ 20 คะแนนปิดใบ', r.rp.amount === moved.remaining_amount && balanceOf(r.db, U2) === 20 && balanceOf(r.db, U) === 0);
  ok('C3 กระดานนับ "ถูกโอน" 1', monthlyBoard(r.db, YM).find((x) => x.userId === U)?.transferred === 1);
}

// ── D) ลำดับอนุมัติ: เวลาเท่ากันตัดด้วยเลขตั๋ว · qty 2 กิน 2 ที่ ──────────────────
{
  let db = enableMonthly(structuredClone(base));
  const a = preTicket(db, U, 5, { hour: 9 });
  const b = preTicket(db, U, 5, { hour: 9 });
  const c = preTicket(db, U, 5, { hour: 9, qty: 2 });
  preTicket(db, U, 6); preTicket(db, U, 7); preTicket(db, U, 8);
  db = closeMonth('u-admin', YM)(db);
  const ids = closedMonths(db)[YM].users[U].tickets;
  ok('D1 Bronze 5 ชิ้น: a, b, c(qty2) = 4 ชิ้น + ใบถัดไป = 4 ใบ', ids.length === 4 && ids[0] === a.id && ids[1] === b.id && ids[2] === c.id, ids);
  ok('D2 ใบ qty 2 ได้ส่วนลด 20×2 = 40', monthlyBonusForTicket(db, db.tickets.find((t) => t.id === c.id)!)?.amount === 40);
}

// ── E) ตัวตัดสิน "ใบพรี vs จ่ายเต็ม" ตาม snapshot ออเดอร์ (คูปองครอบส่วนต่าง / legacy) ─────
{
  let db = structuredClone(base);
  const t = preTicket(db, U, 10, { price: 1000, deposit: 300 });
  db.remainingPayments.push({ id: 'rp-audit', ticket_id: t.id, user_id: U, amount: 0, slip_url: '', status: 'pending', created_at: at(10), coupon_discount: 700 } as any);
  db = approveRemainingPayment('rp-audit')(db);
  const t2 = db.tickets.find((x) => x.id === t.id)!;
  ok('E1 คูปองครอบส่วนต่าง: remaining 0/0 แต่ยังเป็นใบพรี (20) และนับรายเดือน', t2.remaining_amount === 0 && !ticketIsFullPay(db, t2) && db.pointLedger.find((e) => e.id === earnIdFor(t.id))?.delta === 20 && countsForMonthly(db, monthlyConfig(db), t2));
  const full: PreorderTicket = { id: 'legacy-full', ticket_no: 'L1', product_id: db.products[0].id, owner_id: U, original_buyer_id: U, qty: 1, deposit_paid: 2000, remaining_amount: 0, remaining_paid: 0, status: 'paid_full', product_status: 'open', qr_code_url: '', created_at: at(2), approved_at: at(2) } as PreorderTicket;
  const pre: PreorderTicket = { ...full, id: 'legacy-pre', ticket_no: 'L2', deposit_paid: 300, remaining_amount: 700, remaining_paid: 700 };
  db.tickets.push(full, pre);
  ok('E2 legacy จ่ายเต็ม → พร้อมส่ง (30) ไม่นับพรี · legacy มีส่วนต่าง → พรี (20) นับ', ticketIsFullPay(db, full) && rawPointsForTicket(db, full) === 30 && !countsForMonthly(db, monthlyConfig(db), full) && !ticketIsFullPay(db, pre) && rawPointsForTicket(db, pre) === 20 && countsForMonthly(db, monthlyConfig(db), pre));
}

// ── F) ตัดเดือนตามเวลาไทย ─────────────────────────────────────────────────────────
{
  const mk = (iso: string) => ({ approved_at: iso, created_at: iso } as PreorderTicket);
  ok('F1 30 ก.ย. 23:59 ไทย = 2026-09', ticketYm(mk('2026-09-30T16:59:59.000Z')) === '2026-09');
  ok('F2 1 ต.ค. 00:00 ไทย = 2026-10', ticketYm(mk('2026-09-30T17:00:00.000Z')) === '2026-10');
  ok('F3 ไม่มี approved_at ใช้ created_at', ticketYm({ created_at: '2026-08-15T05:00:00.000Z' } as PreorderTicket) === '2026-08');
  ok('F4 ยังไม่เปิดรอบเดือน → ไม่มีเดือนให้ปิด', monthsToClose(structuredClone(base)).length === 0);
  ok('F5 start_ym = เดือนนี้ → เดือนก่อนไม่ถูกปิดย้อนหลัง', monthsToClose(setMonthlyConfig({ ...DEFAULT_MONTHLY, enabled: true, start_ym: currentYm() })(structuredClone(base))).length === 0);
}

// ── G) ยอดพรีอยู่กับคนสั่ง (original_buyer) · กติกาซ้ำ/ไม่เรียง ────────────────────
{
  const db = structuredClone(base);
  const t = preTicket(db, U, 4);
  t.owner_id = U2;
  ok('G1 นับให้ original_buyer (U) ไม่ใช่ owner (U2)', monthlyPieces(db, U, YM) === 1 && monthlyPieces(db, U2, YM) === 0);
  const d2 = setMonthlyConfig({ enabled: true, count: 'pre', tiers: [
    { pieces: 10, label: 'S', emoji: '🥈', points: 250, perks: [] }, { pieces: 5, label: 'B', emoji: '🥉', points: 100, perks: [] }, { pieces: 5, label: 'B-dup', emoji: '💥', points: 999, perks: [] },
  ] })(structuredClone(base));
  ok('G2 เรียงน้อย→มาก + ตัดจำนวนใบซ้ำ', monthlyConfig(d2).tiers.map((x) => `${x.pieces}:${x.label}`).join(',') === '5:B,10:S');
  ok('G3 computeMonthSnapshot เก็บเฉพาะคนที่ถึงยศ', Object.keys(computeMonthSnapshot(db, YM, 'u-admin').users).length === 0);
}

// ── H) คะแนนปิดใบ/พร้อมส่ง: กันซ้ำ · ลบตั๋ว · backfill · adjust ────────────────────
{
  let db = structuredClone(base);
  const stock = db.products.find((p) => p.is_stock && (p.stock_qty ?? 0) > 1)!;
  db = submitOrder(U, [{ productId: stock.id, qty: 2, price: stock.price_total, deposit: stock.price_total, isStock: true } as never], 'slip.jpg')(db);
  const ord = db.orders.find((o) => o.user_id === U && o.status === 'pending_approval')!;
  db = approveOrder(ord.id)(db);
  ok('H1 in-stock qty 2 → 60', balanceOf(db, U) === 60);
  db = approveOrder(ord.id)(db);
  ok('H2 อนุมัติซ้ำ +0', balanceOf(db, U) === 60);
  db = { ...db, orders: db.orders.map((o) => (o.id === ord.id ? { ...o, status: 'pending_approval' as const } : o)), pointLedger: [] };
  db = approveOrder(ord.id)(db);
  ok('H3 อนุมัติซ้ำเมื่อตั๋วมีอยู่แล้ว → ยังมินต์ 60 (ไม่ข้าม)', balanceOf(db, U) === 60);
  const t = preTicket(db, U, 12);
  const r = closeTicket(db, t, U);
  db = r.db;
  ok('H4 ปิดใบพรี → +20', balanceOf(db, U) === 80);
  db = deleteTicket(t.id)(db);
  ok('H5 ลบตั๋ว → ดึงคืน 20 · ลบซ้ำ +0', balanceOf(db, U) === 60 && balanceOf(deleteTicket(t.id)(db), U) === 60);
  db.settings.points_enabled = false;
  const t2 = preTicket(db, U, 13);
  db = closeTicket(db, t2, U).db;
  ok('H6 ระบบปิด → ปิดใบไม่ได้คะแนน แต่โผล่ในรายการย้อนหลัง', balanceOf(db, U) === 60 && ticketsMissingEarn(db).some((x) => x.id === t2.id));
  db = backfillPoints('u-admin')(db);
  const n = db.pointLedger.length;
  db = backfillPoints('u-admin')(db);
  ok('H7 backfill ให้ 20 · ซ้ำ +0', balanceOf(db, U) === 80 && db.pointLedger.length === n);
  const bal = balanceOf(db, U);
  db = adjustPoints('u-admin', U, -(bal + 1), 'over')(db);
  ok('H8 หักเกินคงเหลือถูกบล็อก · lifetime ไม่รวม adjust', balanceOf(db, U) === bal && lifetimeOf(adjustPoints('u-admin', U, 5, 'x')(db), U) === lifetimeOf(db, U));
  ok('H9 ตั๋วค้าง ไม่ eligible', !ticketEarnEligible(db, preTicket(db, U, 14)).ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
