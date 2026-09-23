/** ตรวจ "ใช้แต้ม" สเต็ป 1 (v67) — รัน: npm run audit:points (ryuma-points-redeem-spec) */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import { submitRemainingPayment, approveRemainingPayment, rejectRemainingPayment, submitOrder, approveOrder, rejectOrder, adjustPoints } from '../../src/data/mutations';
import { balanceOf, clampRedeem, maxRedeemable, redeemPicks, redeemHoldId, refundId, earnIdFor, redeemEnabled, redeemFlag, REDEEM_KEY } from '../../src/domain/services/points';
import { setPointsRedeem } from '../../src/data/mutations';
import { openSpecialRound, publishBatch, removeBatch, setBatchPoints } from '../../src/data/mutations';
import { batchPoints, batchPointsSet, batchPointsKey, SPECIAL_ROUND_POINTS_DEFAULT, rawPointsForTicket, redeemKindFor, redeemRules, orderPointsIssue } from '../../src/domain/services/points';
import type { Database } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail ?? ''); } };

const base: Database = structuredClone(SEED_DATABASE);
base.settings.points_enabled = true;
base.appConfig = [{ key: REDEEM_KEY, value: { enabled: true } }, ...base.appConfig.filter((c) => c.key !== REDEEM_KEY)]; // สวิตช์ใช้แต้มเปิด (ทดสอบ G แยกต่างหาก)
const U = 'u-me';
const openTicket = (db: Database) => db.tickets.find((t) => t.owner_id === U && t.remaining_amount - t.remaining_paid > 0 && t.status === 'active')!;
const withBalance = (n: number) => adjustPoints('u-admin', U, n, 'seed')(structuredClone(base));

// ── R1-R2: ใช้แต้มลดส่วนต่าง → จอง → อนุมัติ → หนี้ลด + ได้ 20 ──────────────────
{
  let db = withBalance(200);
  const t = openTicket(db);
  const due = t.remaining_amount - t.remaining_paid;
  db = submitRemainingPayment(t.id, U, due - 150, 'slip', undefined, { points: 150 })(db);
  const rp = db.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  ok('R1 rp บันทึกแต้ม 150 + ยอดโอน = ค้าง−150', rp?.points_redeemed === 150 && rp.amount === due - 150, rp);
  ok('R1b แถวจอง pl-redeem-<rp> คงเหลือ 50', db.pointLedger.some((e) => e.id === redeemHoldId(rp.id) && e.delta === -150) && balanceOf(db, U) === 50, balanceOf(db, U));
  db = approveRemainingPayment(rp.id)(db);
  const t2 = db.tickets.find((x) => x.id === t.id)!;
  ok('R2 อนุมัติ: หนี้ถูกหัก 150 + จ่ายครบ (paid_full) + ได้ 20', t2.remaining_amount === t.remaining_amount - 150 && t2.remaining_paid === t2.remaining_amount && t2.status === 'paid_full' && db.pointLedger.some((e) => e.id === earnIdFor(t.id) && e.delta === 20), t2);
  ok('R2b คงเหลือ 50 + 20 = 70 (แต้มที่ใช้ไม่คืน)', balanceOf(db, U) === 70, balanceOf(db, U));
  const n = db.pointLedger.length;
  db = approveRemainingPayment(rp.id)(db);
  ok('R2c อนุมัติซ้ำ ไม่เพิ่มแถว', db.pointLedger.length === n);
}

// ── R3: ปฏิเสธสลิป → คืนแต้ม ────────────────────────────────────────────────
{
  let db = withBalance(300);
  const t = openTicket(db);
  const due = t.remaining_amount - t.remaining_paid;
  db = submitRemainingPayment(t.id, U, due - 100, 'slip', undefined, { points: 100 })(db);
  const rp = db.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  ok('R3a จองแล้วเหลือ 200', balanceOf(db, U) === 200);
  db = rejectRemainingPayment(rp.id)(db);
  ok('R3b ปฏิเสธ: แถวคืน pl-refund-<rp> + คงเหลือกลับ 300 + rp หาย + หนี้เท่าเดิม', db.pointLedger.some((e) => e.id === refundId(rp.id) && e.delta === 100) && balanceOf(db, U) === 300 && !db.remainingPayments.some((r) => r.id === rp.id) && db.tickets.find((x) => x.id === t.id)!.remaining_amount === t.remaining_amount, balanceOf(db, U));
  db = rejectRemainingPayment(rp.id)(db);
  ok('R3c ปฏิเสธซ้ำ ไม่คืนซ้ำ', balanceOf(db, U) === 300);
}

// ── R4-R5: สูตร clamp / เพดาน / ขั้นต่ำ / ระบบปิด ────────────────────────────
{
  const db = withBalance(1000);
  ok('R4a ต่ำกว่าขั้นต่ำ 50 → 0', clampRedeem(db, U, 'pre', 5000, 30) === 0);
  ok('R4b เกินเพดานพรี 200 → 200', clampRedeem(db, U, 'pre', 5000, 500) === 200);
  ok('R4c เกินเพดาน in-stock 400 → 400', clampRedeem(db, U, 'instock', 5000, 900) === 400);
  ok('R4d เกินยอดค้าง → เท่ายอดค้าง', clampRedeem(db, U, 'pre', 120, 200) === 120);
  ok('R4e เกินคงเหลือ → เท่าคงเหลือ', clampRedeem(withBalance(80), U, 'pre', 5000, 200) === 80);
  ok('R4f maxRedeemable ปัดลงขั้น 50 (คงเหลือ 130 → 100)', maxRedeemable(withBalance(130).settings, { balance: 130, kind: 'pre', payable: 5000 }) === 100);
  ok('R4g maxRedeemable ต่ำกว่าขั้นต่ำ (คงเหลือ 40) → 0', maxRedeemable(db.settings, { balance: 40, kind: 'pre', payable: 5000 }) === 0);
  ok('R4h ปุ่มเลือก 50..200', redeemPicks(200).join(',') === '50,100,150,200');
  const off = withBalance(1000); off.settings.points_enabled = false;
  ok('R5 ระบบปิด → ใช้ไม่ได้ (0) และ rp ไม่มีแต้ม', (() => { const t = openTicket(off); const d = submitRemainingPayment(t.id, U, 1, 'slip', undefined, { points: 100 })(off); const rp = d.remainingPayments.find((r) => r.ticket_id === t.id)!; return clampRedeem(off, U, 'pre', 5000, 100) === 0 && !rp.points_redeemed && balanceOf(d, U) === 1000; })());
}

// ── R6-R8: พร้อมส่ง: ใช้แต้มตอน checkout → อนุมัติหักจากตั๋ว / ปฏิเสธคืน ──────
{
  let db = withBalance(500);
  const stock = db.products.find((p) => p.is_stock && (p.stock_qty ?? 0) > 0)!;
  const line = { productId: stock.id, qty: 1, depositEach: stock.price_total, priceEach: stock.price_total } as never;
  db = submitOrder(U, [line], 'slip', undefined, false, undefined, undefined, 400)(db);
  const ord = db.orders.find((o) => o.user_id === U && o.status === 'pending_approval')!;
  ok('R6a ออเดอร์: total_deposit = ราคา−400, points_redeemed 400, จองแล้วเหลือ 100', ord.total_deposit === stock.price_total - 400 && ord.points_redeemed === 400 && balanceOf(db, U) === 100, { td: ord.total_deposit, price: stock.price_total, bal: balanceOf(db, U) });
  db = approveOrder(ord.id)(db);
  const tk = db.tickets.find((t) => t.owner_id === U && t.product_id === stock.id)!;
  ok('R6b อนุมัติ: ตั๋ว deposit_paid = ราคา−400 + ได้ 30', tk?.deposit_paid === stock.price_total - 400 && balanceOf(db, U) === 130, { dep: tk?.deposit_paid, bal: balanceOf(db, U) });

  // R7: ตะกร้าพรีล้วน → ใช้แต้มไม่ได้ (0)
  let db2 = withBalance(500);
  const pre = db2.products.find((p) => !p.is_stock && p.status === 'open')!;
  db2 = submitOrder(U, [{ productId: pre.id, qty: 1, depositEach: pre.deposit_amount, priceEach: pre.price_total } as never], 'slip', undefined, false, undefined, undefined, 200)(db2);
  const ord2 = db2.orders.find((o) => o.user_id === U && o.status === 'pending_approval');
  ok('R7 ตะกร้าพรีล้วน: แต้มไม่ถูกใช้ คงเหลือเท่าเดิม', !!ord2 && !ord2.points_redeemed && balanceOf(db2, U) === 500, ord2);

  // R8: ปฏิเสธออเดอร์ที่ใช้แต้ม → คืน
  let db3 = withBalance(500);
  db3 = submitOrder(U, [line], 'slip', undefined, false, undefined, undefined, 200)(db3);
  const ord3 = db3.orders.find((o) => o.user_id === U && o.status === 'pending_approval')!;
  db3 = rejectOrder(ord3.id)(db3);
  ok('R8 ปฏิเสธออเดอร์: คืน 200 → คงเหลือ 500', balanceOf(db3, U) === 500 && db3.pointLedger.some((e) => e.id === refundId(ord3.id)), balanceOf(db3, U));
}

// ── R9: จ่ายหลายใบ group_id + hold ต่อใบ ────────────────────────────────────
{
  let db = withBalance(350);
  const tix = db.tickets.filter((t) => t.owner_id === U && t.remaining_amount - t.remaining_paid > 0 && t.status === 'active').slice(0, 2);
  const g = 'grp-test';
  for (const [i, t] of tix.entries()) db = submitRemainingPayment(t.id, U, 0, 'slip', undefined, { points: i === 0 ? 200 : 150, groupId: g })(db);
  const rps = db.remainingPayments.filter((r) => r.group_id === g);
  ok('R9 2 ใบในกลุ่มเดียว: หลด 200 + 150 = คงเหลือ 0, group_id ครบ', rps.length === 2 && balanceOf(db, U) === 0 && rps.every((r) => r.group_id === g), { n: rps.length, bal: balanceOf(db, U) });
}

// ── G: สวิตช์ "ใช้แต้มตัดยอด" แยกจากสวิตช์โชว์แต้ม (เจ้าของ 2026-09-12 ค่ำ: โชว์ก่อน ยังไม่เปิดลดจริง) ──
{
  const off: Database = { ...withBalance(500), appConfig: base.appConfig.filter((c) => c.key !== REDEEM_KEY) }; // ระบบเปิด แต่ยังไม่เปิดใช้แต้ม
  ok('G1 ระบบเปิด + ใช้แต้มปิด → clampRedeem 0 / redeemEnabled false', clampRedeem(off, U, 'pre', 5000, 200) === 0 && !redeemEnabled(off) && !redeemFlag(off));
  const t = openTicket(off);
  const due = t.remaining_amount - t.remaining_paid;
  const d2 = submitRemainingPayment(t.id, U, due, 'slip', undefined, { points: 200 })(off);
  const rp = d2.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  ok('G2 ส่งสลิปพร้อมขอใช้แต้ม → ถูกตัดเป็น 0 ไม่มีแถวจอง คงเหลือเท่าเดิม', (rp.points_redeemed ?? 0) === 0 && !d2.pointLedger.some((e) => e.id === redeemHoldId(rp.id)) && balanceOf(d2, U) === 500, rp);
  const flagOnly: Database = { ...withBalance(500), settings: { ...base.settings, points_enabled: false } };
  ok('G3 สวิตช์ใช้แต้มเปิด แต่ระบบคะแนนปิด → ยังใช้ไม่ได้', !redeemEnabled(flagOnly) && redeemFlag(flagOnly) && clampRedeem(flagOnly, U, 'instock', 5000, 100) === 0);
  const on = setPointsRedeem('u-admin', true)(off);
  ok('G4 เปิดสวิตช์ → ใช้ได้ + มี activity log', redeemEnabled(on) && clampRedeem(on, U, 'pre', 5000, 200) === 200 && on.activityLogs.some((l) => JSON.stringify(l).includes('points_redeem')));
  const off2 = setPointsRedeem('u-admin', false)(on);
  ok('G5 ปิดสวิตช์กลับ → 0 + เหลือ config แถวเดียว', clampRedeem(off2, U, 'pre', 5000, 200) === 0 && off2.appConfig.filter((c) => c.key === REDEEM_KEY).length === 1);
}

// ── S) รอบพิเศษ + เพดานใหม่ (เจ้าของ 2026-09-23): ได้ รอบปกติ 20 / รอบพิเศษ 40 (ตั้งต่อรอบ 20/40) · ใช้ ปกติ 200/ใบ · รอบพิเศษ/พร้อมส่ง 400/ใบ ──
{
  const P = 'p-sp-audit';
  let db: Database = structuredClone(base);
  db.products.push({ ...structuredClone(db.products.find((p) => !p.is_stock)!), id: P, series_name: 'Special Audit', is_stock: false, surplus_qty: 10 } as any);
  db = openSpecialRound(P, { qty: 3, price: 2000, fullPay: false, deposit: 500, addSurplus: false, points: 20 })(db);
  const b1 = db.batches.find((b) => b.product_id === P)!;
  ok('S1 เปิดรอบพร้อมเลือก +20 → เก็บต่อรอบ (app_config points_batch:<id>)', batchPointsSet(db, b1.id) === 20 && batchPoints(db, b1.id) === 20);
  ok('S2 ค่าที่ไม่ใช่ 20/40 ถูกปฏิเสธ', setBatchPoints(b1.id, 30)(db) === db);
  const noPick = { ...db, appConfig: db.appConfig.filter((c) => c.key !== batchPointsKey(b1.id)) };
  ok('S3 รอบที่ไม่ได้เลือก → ค่าเริ่มต้น 40', batchPointsSet(noPick, b1.id) === null && batchPoints(noPick, b1.id) === SPECIAL_ROUND_POINTS_DEFAULT && SPECIAL_ROUND_POINTS_DEFAULT === 40);
  // ตั๋วรอบพิเศษ: ได้ตามรอบ · เพดานใช้แต้ม 400
  const t = { id: 't-sp1', ticket_no: 'SP-1', product_id: P, owner_id: U, original_buyer_id: U, qty: 1, batch_id: b1.id, deposit_paid: 500, remaining_amount: 1500, remaining_paid: 0, status: 'active', product_status: 'arrived', qr_code_url: '', created_at: '2026-09-01' } as any;
  db.tickets.push(t);
  ok('S4 ตั๋วรอบพิเศษ (+20 ที่ตั้งไว้) → rawPoints 20 · ชนิดใช้แต้ม special · เพดาน 400', rawPointsForTicket(db, t) === 20 && redeemKindFor(db, t) === 'special' && redeemRules(db.settings, 'special').cap === 400);
  const normal = openTicket(db);
  ok('S5 ตั๋วรอบปกติ → ชนิด pre · เพดาน 200', redeemKindFor(db, normal) === 'pre' && redeemRules(db.settings, 'pre').cap === 200);
  // ใช้แต้มจริง (สวิตช์เปิดใน base): รอบพิเศษใช้ได้ 400 · ปกติถูกตัดที่ 200
  db = adjustPoints('u-admin', U, 1000, 'seed')(db);
  let d1 = submitRemainingPayment(t.id, U, 1100, 'slip', undefined, { points: 400 })(db);
  const rpS = d1.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  ok('S6 ปิดใบรอบพิเศษ ใช้ 400 ได้', rpS?.points_redeemed === 400, rpS);
  d1 = submitRemainingPayment(normal.id, U, 0, 'slip', undefined, { points: 400 })(db);
  const rpN = d1.remainingPayments.find((r) => r.ticket_id === normal.id && r.status === 'pending')!;
  ok('S7 ปิดใบรอบปกติ ขอ 400 → ถูกตัดเหลือ 200', rpN?.points_redeemed === 200, rpN);
  // publish ร่างพร้อมเลือกคะแนน · ลบรอบ = ลบค่าตั้ง
  let d2: Database = structuredClone(base);
  d2.products.push({ ...structuredClone(d2.products.find((p) => !p.is_stock)!), id: P, series_name: 'Special Audit', is_stock: false, surplus_qty: 10 } as any);
  d2 = openSpecialRound(P, { qty: 2, price: 1800, fullPay: true, addSurplus: false, published: false })(d2);
  const b2 = d2.batches.find((b) => b.product_id === P)!;
  d2 = publishBatch(b2.id, { price: 1800, qty: 2, points: 20 })(d2);
  ok('S8 เปิดขายรอบร่างพร้อมเลือก +20 → ตั้งค่าแล้ว + รอบ published', batchPointsSet(d2, b2.id) === 20 && d2.batches.find((b) => b.id === b2.id)?.published === true);
  d2 = removeBatch(b2.id)(d2);
  ok('S9 ลบรอบ (ไม่มีตั๋ว) → ค่าตั้งคะแนนถูกลบด้วย', !d2.appConfig.some((c) => c.key === batchPointsKey(b2.id)));
}

// ── T) ของพร้อมส่ง: เพดาน 400 "ต่อใบ" × จำนวนรายการ · แต้มห้ามไหลไปหักมัดจำพรี ──
{
  const stock = base.products.filter((p) => p.is_stock).slice(0, 2);
  ok('T0 seed มีของพร้อมส่ง ≥ 2 รายการ', stock.length >= 2);
  ok('T1 maxRedeemable พร้อมส่ง 2 ใบ = 800 (ถ้ายอด/คงเหลือพอ)', maxRedeemable(base.settings, { balance: 5000, kind: 'instock', payable: 5000, units: 2 }) === 800);
  ok('T2 clampRedeem พร้อมส่ง 2 ใบ ขอ 900 → 800', clampRedeem(withBalance(5000), U, 'instock', 5000, 900, 2) === 800);
  const fake: any = { id: 'o-fake', points_redeemed: 400, coupon_discount: 0, items: [{ product_id: base.products.find((p) => !p.is_stock)!.id, deposit_amount: 500, qty: 1 }] };
  const withHold = { ...withBalance(1000), pointLedger: [{ id: redeemHoldId('o-fake'), user_id: U, delta: -400, kind: 'redeem_order', created_at: '2026-09-01' } as any, ...withBalance(1000).pointLedger] };
  ok('T3 ออเดอร์พรีล้วนอ้างใช้แต้ม → orderPointsIssue เกินเพดาน (ไม่มีใบพร้อมส่ง)', !!orderPointsIssue(withHold, fake), orderPointsIssue(withHold, fake));
  const ok1: any = { id: 'o-fake', points_redeemed: 400, coupon_discount: 0, items: [{ product_id: stock[0].id, deposit_amount: 1500, qty: 1 }] };
  ok('T4 ของพร้อมส่ง 1 ใบ ยอด 1,500 ใช้ 400 → ปกติ', orderPointsIssue(withHold, ok1) === null, orderPointsIssue(withHold, ok1));
  ok('T5 ไม่มีแถวจอง → แต้มยังไม่ถูกจอง', orderPointsIssue(withBalance(1000), ok1) === 'แต้มยังไม่ถูกจอง');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
