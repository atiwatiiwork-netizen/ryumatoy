/** ตรวจ "คะแนนที่ลูกค้าจะได้" ทุกเส้นทางจริงก่อนเปิดตัว (เจ้าของ 2026-09-23: "มีอะไรแปลกๆ ไหม รวมถึงเคสมอบใบพรีให้ ตัดจบข้างนอก")
 *  ใช้ mutation จริงทุกขั้น: สั่ง→อนุมัติ→จ่ายส่วนต่าง · รอบพิเศษ (มัดจำ / จ่ายเต็ม) · มอบตั๋ว (จ่ายครบตอนมอบ / มัดจำ) · ไล่เก็บจากส่วนเกิน
 *  · ตัดจบข้างนอก · แก้มัดจำ · ลบตั๋ว · หาของ · พร้อมส่ง · บัญชีแอดมิน — รัน: npm run audit:points */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import {
  approveOrder, submitRemainingPayment, approveRemainingPayment, openSpecialRound, grantSpecialTickets, grantFromSurplus,
  completeTicketOffline, editTicketDeposit, deleteTicket, launchPointsPreOnly, setBatchPoints, mintPointsForTickets,
} from '../../src/data/mutations';
import { balanceOf, earnIdFor, sweepCandidates, ticketsMissingEarn, rawPointsForTicket } from '../../src/domain/services/points';
import { launchBreakdown } from '../../src/domain/services/pointsReport';
import { grantedTicketIds, isSourcingTicket } from '../../src/domain/services/money';
import { offlineRpIdFor } from '../../src/domain/services/payments';
import type { Database, Order, PreorderTicket, Product } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail ?? ''); } };

let db: Database = structuredClone(SEED_DATABASE);
db.settings.points_enabled = false; // ประวัติก่อนเปิดตัว
const C1 = 'sc-normal', C2 = 'sc-special', C3 = 'sc-granted', C4 = 'sc-offline', ST = 'sc-staff', C5 = 'sc-sourcing';
for (const [id, name, admin] of [[C1, 'Normal'], [C2, 'Special'], [C3, 'Granted'], [C4, 'Offline'], [ST, 'Staff', true], [C5, 'Sourcing']] as const)
  db.users.push({ id, display_name: name, rank: 'bronze', created_at: '2026-01-01', ...(admin ? { is_admin: true } : {}) } as any);
const tpl = db.products.find((p) => !p.is_stock)!;
const mk = (id: string, extra: Partial<Product> = {}): Product => ({ ...structuredClone(tpl), id, series_name: id, is_stock: false, surplus_qty: 10, status: 'arrived', ...extra } as Product);
db.products.push(mk('P-normal'), mk('P-sp'), mk('P-full'), mk('P-surplus'), mk('P-src'), mk('P-stock', { is_stock: true, stock_qty: 5 }));

let seq = 0;
/** ออเดอร์รอตรวจ → อนุมัติจริง (approveOrder) → คืนตั๋วที่เกิด */
function buy(uid: string, productId: string, price: number, dep: number, batchId?: string): PreorderTicket {
  seq += 1;
  const oid = `sc-o${seq}`, iid = `sc-i${seq}`;
  const o: Order = { id: oid, user_id: uid, total_deposit: dep, slip_url: 'x', status: 'pending_approval', created_at: new Date().toISOString(),
    items: [{ id: iid, order_id: oid, product_id: productId, qty: 1, deposit_amount: dep, unit_price: price, unit_deposit: dep, ...(batchId ? { batch_id: batchId } : {}) }] } as Order;
  db = { ...db, orders: [o, ...db.orders] };
  db = approveOrder(oid)(db);
  return db.tickets.find((t) => t.id === `t-${iid}`)!;
}
/** จ่ายส่วนต่างครบผ่านแอป (ส่งสลิป → อนุมัติ) */
function payOff(t: PreorderTicket) {
  const due = t.remaining_amount - t.remaining_paid;
  db = submitRemainingPayment(t.id, t.owner_id, due, 'slip')(db);
  const rp = db.remainingPayments.find((r) => r.ticket_id === t.id && r.status === 'pending')!;
  db = approveRemainingPayment(rp.id)(db);
}
const T = (id: string) => db.tickets.find((t) => t.id === id)!;

// ── ประวัติก่อนเปิดตัว ──────────────────────────────────────────────────────
const t1 = buy(C1, 'P-normal', 1600, 300); payOff(t1);                                   // ใบพรีปกติ ปิดผ่านแอป → 20
db = openSpecialRound('P-sp', { qty: 5, price: 2000, fullPay: false, deposit: 500, addSurplus: true })(db);
const B1 = db.batches.find((b) => b.product_id === 'P-sp')!.id;                          // รอบพิเศษ (ค่าเริ่มต้น 40)
const t2 = buy(C2, 'P-sp', 2000, 500, B1); payOff(t2);                                   // รอบพิเศษ สั่งในแอป → 40
db = openSpecialRound('P-full', { qty: 3, price: 1500, fullPay: true, addSurplus: true })(db);
const B2 = db.batches.find((b) => b.product_id === 'P-full')!.id;
const t3 = buy(C2, 'P-full', 1500, 1500, B2);                                             // รอบพิเศษจ่ายเต็ม → ปิดตั้งแต่เกิด → 40
db = grantSpecialTickets(C3, [{ batchId: B1, qty: 1, depEach: 2000, priceEach: 2000 }], undefined, 'g-prepaid')(db);
const t4 = db.tickets.find((t) => t.id === `tg-g-prepaid-${B1}`)!;                       // มอบแบบจ่ายครบตอนมอบ → 40
db = grantFromSurplus('P-surplus', C3, { qty: 1, priceEach: 1800, depEach: 500, label: 'ไล่เก็บใบพรี', grantId: 'g-legacy' })(db);
const B3 = db.batches.find((b) => b.product_id === 'P-surplus')!.id;
const t5 = db.tickets.find((t) => t.id === `tg-g-legacy-${B3}`)!;
payOff(t5);                                                                               // ไล่เก็บใบพรีเก่า มัดจำ แล้วจ่ายส่วนต่าง → ตามรอบ
const t6 = buy(C4, 'P-normal', 1600, 300);
db = completeTicketOffline(t6.id, { collectRemaining: true })(db);                        // ตัดจบข้างนอก → 20
const t7 = buy(ST, 'P-normal', 1600, 300); payOff(t7);                                    // บัญชีแอดมิน → 0
const t8 = buy(C1, 'P-stock', 1900, 1900);                                               // พร้อมส่ง → 0 (อัตรา 0 ตอนเปิดตัว)
db.sourcingRequests.push({ id: 'sr-sc', user_id: C5, product_id: 'P-src', status: 'started', created_at: '2026-08-01' } as any);
const t9 = buy(C5, 'P-src', 1000, 1000);                                                  // หาของ → 0

ok('Z0 ตั๋วครบ 9 ใบ + ปิดยอดตามที่ตั้งใจ', [t1, t2, t3, t4, t5, t6, t7, t8, t9].every(Boolean) && [t1, t2, t3, t4, t5, t6, t7, t8, t9].every((t) => T(t.id).remaining_paid >= T(t.id).remaining_amount),
  [t1, t2, t3, t4, t5, t6, t7, t8, t9].map((t) => t && `${t.id}:${T(t.id)?.remaining_amount - T(t.id)?.remaining_paid}`));
ok('Z1 ก่อนเปิดตัว: ยังไม่มีใครได้แต้ม (ระบบปิด)', db.pointLedger.filter((e) => e.kind === 'earn_ticket').length === 0);
ok('Z2 ตัดจบข้างนอก: บันทึกรับเงินนอกระบบ + ตั๋วจบงาน', db.remainingPayments.some((r) => r.id === offlineRpIdFor(t6.id) && r.status === 'approved') && T(t6.id).status === 'shipped');
ok('Z3 แหล่งที่มา: t4/t5 = ตั๋วมอบ · t9 = หาของ · ใบอื่นมาจากออเดอร์', grantedTicketIds(db).has(t4.id) && grantedTicketIds(db).has(t5.id) && isSourcingTicket(db, T(t9.id)) && !grantedTicketIds(db).has(t1.id));

// ── พรีวิวก่อนกด (สูตรเดียวกับปุ่ม) ─────────────────────────────────────────────
const zero: Database = { ...db, settings: { ...db.settings, points_per_piece_instock: 0 } };
const bd = launchBreakdown(zero);
const cat = (k: string) => bd.cats.find((c) => c.key === k)!;
// seed มีตั๋วเดโม่ของ u-me 1 ใบ (OP-2026-04-0012) = ตั๋วมอบเก่า "ไม่มีรอบ" ปิดแล้ว → +20 (อัตราใบพรีปกติ) — นับรวมด้วย
ok('Z4 แยกที่มา: ปกติ 2 ใบ (t1,t6)=40 · รอบพิเศษสั่งในแอป 2 ใบ (t2,t3)=80 · ตั๋วมอบ 3 ใบ (t4 40 + t5 40 + ตั๋วเก่าไม่มีรอบ 20)=100', cat('normal').tickets === 2 && cat('normal').points === 40 && cat('special').tickets === 2 && cat('special').points === 80 && cat('granted').tickets === 3 && cat('granted').points === 100, bd.cats);
ok('Z5 ตัดจบข้างนอก 1 ใบ (+20) · ตั๋วมอบจ่ายครบตอนมอบ 1 ใบ (+40)', bd.offlineClosed.tickets === 1 && bd.offlineClosed.points === 20 && bd.grantedPrepaid.tickets === 1 && bd.grantedPrepaid.points === 40, { off: bd.offlineClosed, pre: bd.grantedPrepaid });
ok('Z6 ไม่ได้แต้มพร้อมเหตุผล: พร้อมส่ง 1 · หาของ 1 · บัญชีแอดมิน 1', ['instock', 'ตั๋วหาของ (ไม่ให้เฟสนี้)', 'บัญชีแอดมิน/ทีมงาน'].every((k) => bd.skipped.find((s) => s.key === k)?.tickets === 1), bd.skipped);
const r1 = bd.rounds.find((r) => r.batchId === B1)!, r3 = bd.rounds.find((r) => r.batchId === B3)!;
ok('Z7 รายรอบ: รอบพิเศษ (สั่ง 1 · มอบ 1) = 80 · รอบไล่เก็บ (มอบ 1) = 40 · ค่าเริ่มต้น 40', r1?.bought === 1 && r1.granted === 1 && r1.points === 80 && r3?.granted === 1 && r3.points === 40 && !r3.explicit && r3.label === 'ไล่เก็บใบพรี', { r1, r3 });
ok('Z8 ยอดรวมพรีวิว 220 แต้ม · 5 คน (รวมเดโม่ u-me)', bd.total.points === 220 && bd.total.customers === 5 && bd.total.tickets === 7, bd.total);

// เจ้าของเลือกให้รอบไล่เก็บใบพรีเก่า = +20 ก่อนกด
db = setBatchPoints(B3, 20)(db);
const bd2 = launchBreakdown({ ...db, settings: { ...db.settings, points_per_piece_instock: 0 } });
ok('Z9 ตั้งรอบไล่เก็บเป็น +20 → ตั๋วมอบรวม 80 · ยอดรวม 200', bd2.cats.find((c) => c.key === 'granted')!.points === 80 && bd2.total.points === 200, bd2.total);

// ── กดเปิดตัว ──────────────────────────────────────────────────────────────
db = launchPointsPreOnly('u-admin')(db);
const bal = (u: string) => balanceOf(db, u);
ok('Z10 หลังเปิดตัว: ปกติ 20 · รอบพิเศษ 40+40 · มอบ 40 (รอบพิเศษ) + 20 (รอบไล่เก็บ) · ตัดจบข้างนอก 20 · แอดมิน/หาของ 0',
  bal(C1) === 20 && bal(C2) === 80 && bal(C3) === 60 && bal(C4) === 20 && bal(ST) === 0 && bal(C5) === 0,
  { C1: bal(C1), C2: bal(C2), C3: bal(C3), C4: bal(C4), ST: bal(ST), C5: bal(C5) });
ok('Z11 พรีวิว = ผลจริงทุกคน (ไม่มีตกหล่น/ไม่มีเกิน)', ticketsMissingEarn(db).length === 0 && sweepCandidates(db).length === 0);

// ── หลังเปิดตัว: เส้นทางใหม่ต้องได้แต้มทันที/อัตโนมัติ ─────────────────────────────
db = grantSpecialTickets(C3, [{ batchId: B1, qty: 1, depEach: 2000, priceEach: 2000 }], undefined, 'g-after')(db);
const t10 = T(`tg-g-after-${B1}`);
ok('Z12 มอบตั๋วจ่ายครบหลังเปิดตัว → ยังไม่มีแถว (ไม่ได้มินต์ตอนมอบ) แต่ระบบเติมอัตโนมัติ (sweep) ได้ 40', !db.pointLedger.some((e) => e.id === earnIdFor(t10.id)) && sweepCandidates(db).some((t) => t.id === t10.id) && rawPointsForTicket(db, t10) === 40);
db = mintPointsForTickets(sweepCandidates(db).map((t) => t.id), 'u-admin')(db); // สิ่งที่ AdminShell ทำเองหลัง 5 วิ
ok('Z13 หลังเติมอัตโนมัติ: C3 = 100', bal(C3) === 100, bal(C3));
const t11 = buy(C4, 'P-normal', 1600, 300);
db = completeTicketOffline(t11.id, { collectRemaining: true })(db);
ok('Z14 ตัดจบข้างนอกหลังเปิดตัว → +20 ทันที', bal(C4) === 40, bal(C4));
const t12 = buy(C1, 'P-normal', 1600, 300);
const before12 = db;
db = completeTicketOffline(t12.id)(db);
ok('Z15 ตัดจบข้างนอกแบบไม่ยืนยันรับเงิน (ยังค้าง) → ไม่ปิด ไม่ได้แต้ม', db === before12 && bal(C1) === 20);
db = editTicketDeposit(t12.id, 1600)(db);
ok('Z16 แก้มัดจำจนครบ (รับเงินนอกระบบ) → +20 ทันที', bal(C1) === 40, bal(C1));
db = deleteTicket(t4.id)(db);
ok('Z17 ลบตั๋วมอบที่ได้แต้มแล้ว → ดึงคืน 40', bal(C3) === 60, bal(C3));
const t13 = buy(C2, 'P-sp', 2000, 500, B1);
db = setBatchPoints(B1, 20)(db);
payOff(t13);
ok('Z18 เปลี่ยนรอบเป็น +20 ก่อนลูกค้าปิดใบ → ใบนั้นได้ 20 · ใบที่ปิดไปแล้วคงเดิม', bal(C2) === 100, bal(C2));

// ── ตั๋วในรอบ "หาของ" ที่เรื่องหาของถูกลบ → ต้องไม่กลายเป็นรอบพิเศษ +40 ────────────────────
{
  const d: Database = structuredClone(db);
  d.batches.push({ id: 'b-src-orphan', product_id: 'P-src', label: 'หาของ', price_total: 1000, deposit_amount: 1000, stock_qty: 1, status: 'open', created_at: '2026-08-01' } as any);
  const tx = { id: 'tx-src', ticket_no: 'SRC-1', product_id: 'P-src', owner_id: C1, original_buyer_id: C1, qty: 1, batch_id: 'b-src-orphan', deposit_paid: 1000, remaining_amount: 0, remaining_paid: 0, status: 'paid_full', product_status: 'arrived', qr_code_url: '', created_at: '2026-08-02' } as any;
  d.tickets.push(tx);
  ok('Z20 ตั๋วรอบ "หาของ" ไม่มีเรื่องหาของแล้ว → ไม่ได้แต้ม (ไม่ใช่รอบพิเศษ)', !isSourcingTicket(d, tx) && !ticketsMissingEarn(d).some((t) => t.id === 'tx-src') && sweepCandidates(d).every((t) => t.id !== 'tx-src'));
}
// ── ตัวอย่างเลขตั๋วในพรีวิว (ให้แอดมินเปิดดูว่าเข้ากลุ่มถูก) ─────────────────────────────
ok('Z21 พรีวิวมีตัวอย่าง: ตัดจบข้างนอก (t6) · มอบจ่ายครบ (t4) · พร้อมส่งที่ไม่ได้แต้ม (t8)',
  bd.samples.offline.some((s) => s.startsWith(t6.ticket_no)) && bd.samples.prepaid.some((s) => s.startsWith(t4.ticket_no)) && bd.samples.instock.some((s) => s.startsWith(t8.ticket_no)), bd.samples);
ok('Z22 รอบจ่ายเต็มถูกติดป้าย fullPay ในพรีวิว', bd.rounds.find((r) => r.batchId === B2)?.fullPay === true && bd.rounds.find((r) => r.batchId === B1)?.fullPay === false);

// ── ตั๋ว 1 ใบหลายชิ้น (ลูกค้าสั่ง 2 ตัวในรายการเดียว = ตั๋วใบเดียว qty 2) → คิดต่อชิ้น + พรีวิวต้องโชว์ให้เห็น ──
{
  let d: Database = structuredClone(db);
  d = { ...d, settings: { ...d.settings, points_enabled: false } };
  const o = { id: 'sc-oq', user_id: C1, total_deposit: 600, slip_url: 'x', status: 'pending_approval', created_at: new Date().toISOString(),
    items: [{ id: 'sc-iq', order_id: 'sc-oq', product_id: 'P-normal', qty: 2, deposit_amount: 600, unit_price: 1600, unit_deposit: 300 }] } as Order;
  d = approveOrder('sc-oq')({ ...d, orders: [o, ...d.orders] });
  const tq = d.tickets.find((t) => t.id === 't-sc-iq')!;
  d = submitRemainingPayment(tq.id, C1, tq.remaining_amount - tq.remaining_paid, 'slip')(d);
  d = approveRemainingPayment(d.remainingPayments.find((r) => r.ticket_id === tq.id && r.status === 'pending')!.id)(d);
  const b = launchBreakdown({ ...d, settings: { ...d.settings, points_per_piece_instock: 0 } });
  ok('Z23 ตั๋ว 1 ใบ 2 ชิ้น → ได้ 40 (ต่อชิ้น) · พรีวิวโชว์ 1 ใบ 2 ชิ้น ส่วนเพิ่ม +20 + ตัวอย่างมี ×2',
    tq.qty === 2 && rawPointsForTicket(d, tq) === 40 && b.multiPiece.tickets === 1 && b.multiPiece.pieces === 2 && b.multiPiece.extra === 20
      && b.cats.find((c) => c.key === 'normal')!.pieces === 2 && !!b.samples.multi[0]?.includes('×2'), { multi: b.multiPiece, s: b.samples.multi });
}

// ── ตั๋วมอบเก่า "ไม่มีรอบ" จ่ายเต็มตั้งแต่มอบ → สูตรตีเป็นพร้อมส่ง (0) · ต้องแยกบรรทัดให้แอดมินเห็น ไม่ปนกับของพร้อมส่งที่ซื้อในแอป ──
{
  const d: Database = structuredClone(db);
  d.tickets.push({ id: 'tg-old-full', ticket_no: 'OLD-FULL-1', product_id: 'P-full', owner_id: C4, original_buyer_id: C4, qty: 1, deposit_paid: 1500, remaining_amount: 0, remaining_paid: 0, status: 'paid_full', product_status: 'arrived', qr_code_url: '', created_at: '2026-07-28' } as any);
  const b = launchBreakdown({ ...d, settings: { ...d.settings, points_per_piece_instock: 0 } });
  ok('Z24 ตั๋วมอบเก่าไม่มีรอบ จ่ายเต็มตั้งแต่มอบ → 0 แต้ม แต่แยกบรรทัด + มีตัวอย่าง (ไม่ปนพร้อมส่ง)',
    b.skipped.find((s) => s.key === 'granted-full')?.tickets === 1 && !!b.samples.grantedFull[0]?.startsWith('OLD-FULL-1') && !b.samples.instock.some((s) => s.startsWith('OLD-FULL-1')),
    { sk: b.skipped, s: b.samples.grantedFull });
}

// ── ตัวจับคู่ตั๋ว↔ออเดอร์แบบใหม่ ต้องได้ผลเหมือนแบบเดิมทุกกรณี (เร็วขึ้นเท่านั้น) ─────────────
function grantedOld(d: Database): Set<string> {
  const covered = new Set<string>();
  for (const o of d.orders) {
    if (o.status !== 'approved') continue;
    const oTime = new Date(o.approved_at ?? o.created_at).getTime();
    for (const it of o.items) {
      if (!(it.qty > 0)) continue;
      const cands = d.tickets.filter((x) => !covered.has(x.id) && x.owner_id === o.user_id && x.product_id === it.product_id
        && (x.batch_id ?? null) === (it.batch_id ?? null) && (x.variant_id ?? null) === (it.variant_id ?? null));
      if (cands.length === 0) continue;
      const score = (x: PreorderTicket) => ((x.deposit_paid ?? 0) === (it.unit_deposit ?? 0) * x.qty ? 0 : 1e12) + Math.abs(new Date(x.approved_at ?? x.created_at).getTime() - oTime);
      covered.add(cands.sort((a, b) => score(a) - score(b))[0].id);
    }
  }
  return new Set(d.tickets.filter((t) => !covered.has(t.id) && !isSourcingTicket(d, t)).map((t) => t.id));
}
{
  // ข้อมูลสุ่มปนกัน: ตั๋วซ้ำเจ้าของ/สินค้าเดียวกัน, batch '' vs ไม่มี, variant, ตั๋วมอบ
  let r = 7; const rnd = (n: number) => { r = (r * 1103515245 + 12345) % 2147483648; return r % n; };
  const d: Database = structuredClone(SEED_DATABASE);
  const us = ['a', 'b', 'c'], ps = ['p1', 'p2'], bs = [undefined, 'b1', ''] as (string | undefined)[], vs = [undefined, 'v1'];
  for (let i = 0; i < 300; i++) {
    const u = us[rnd(3)], p = ps[rnd(2)], b = bs[rnd(3)], v = vs[rnd(2)], dep = [300, 500][rnd(2)];
    d.tickets.push({ id: `x${i}`, owner_id: u, product_id: p, batch_id: b, variant_id: v, qty: 1 + rnd(2), deposit_paid: dep, remaining_amount: 0, remaining_paid: 0, created_at: new Date(2026, 0, 1 + rnd(200)).toISOString() } as any);
    if (rnd(3) > 0) d.orders.push({ id: `xo${i}`, user_id: u, status: 'approved', created_at: new Date(2026, 0, 1 + rnd(200)).toISOString(),
      items: [{ id: `xi${i}`, order_id: `xo${i}`, product_id: p, batch_id: b, variant_id: v, qty: 1, deposit_amount: dep, unit_deposit: [300, 500][rnd(2)] }] } as any);
  }
  const a = grantedOld(d), bNew = grantedTicketIds(d);
  ok('Z19 ตัวจับคู่แบบใหม่ = แบบเดิมทุกใบ (300 ตั๋วสุ่ม)', a.size === bNew.size && [...a].every((x) => bNew.has(x)), { old: a.size, new: bNew.size });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
