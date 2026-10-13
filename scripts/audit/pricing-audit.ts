/* สูตรราคา + ค่าส่งเพิ่มตามช่วงต้นทุน (v87) + กฎ "มีคนพรีแล้วห้ามแตะ" (เจ้าของ 2026-10-13) — ฐานปลอม ไม่แตะ Supabase
 *   npx --yes tsx scripts/audit/pricing-audit.ts
 *   F) priceFromYuan: 288–328 เท่าเดิม · ตั้งแต่ 329 +40 · ตั้งแต่ 500 +80 (ไม่บวกซ้อน) · ปิดขั้นด้วย 0 ได้
 *   P) repriceOpenPreorders/updateSettings: แตะเฉพาะพรีเปิดรับที่ยังไม่มีคนพรี — ตั๋วกระดานหลัก/ตั๋วรอบพิเศษ/ออเดอร์รอตรวจ/hold ค้าง = กันไว้
 *      ปิดรอบแล้ว (status ≠ open) · พร้อมส่ง · ไม่มีหยวน = ไม่แตะ · ออเดอร์ที่ถูกปฏิเสธ/hold หมดอายุ ไม่นับเป็นคนพรี
 *   U) หน้าแอดมินกับ mutation ใช้ตัวจำแนกเดียวกัน (repriceTargets.changed == สินค้าที่ mutation เปลี่ยนจริง)
 */
import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, Product, PreorderTicket } from '../../src/domain/entities';
import { priceFromYuan, shippingSurcharge, hasPreorderBookings, repriceTargets } from '../../src/domain/services/pricing';
import { repriceOpenPreorders, updateSettings } from '../../src/data/mutations';

let p = 0, f = 0;
const ok = (n: string, c: boolean, detail?: unknown) => { if (c) p++; else { f++; console.log('FAIL', n, detail === undefined ? '' : JSON.stringify(detail)); } };

const S = { ...SEED_DATABASE.settings }; // 288→1550 · 5฿/¥ · ขั้น 329→+40 · 500→+80
const linear = (y: number) => 1550 + (y - 288) * 5;

// ── F) สูตร ─────────────────────────────────────────────────────────────────────
ok('F1 288¥ เท่าเดิม 1550', priceFromYuan(S, 288) === 1550);
ok('F2 328¥ เท่าเดิม 1750', priceFromYuan(S, 328) === 1750);
ok('F3 329¥ +40', priceFromYuan(S, 329) === linear(329) + 40);
ok('F4 400¥ +40 = 2150', priceFromYuan(S, 400) === 2150);
ok('F5 499¥ +40', priceFromYuan(S, 499) === linear(499) + 40);
ok('F6 500¥ +80 = 2690', priceFromYuan(S, 500) === 2690);
ok('F7 800¥ +80 (ไม่บวกซ้อน)', priceFromYuan(S, 800) === linear(800) + 80 && shippingSurcharge(S, 800) === 80);
ok('F8 ต่ำกว่าฐานมากๆ ไม่ติดลบ', priceFromYuan(S, -500) === 0);
ok('F9 ปิดขั้นด้วย 0 → สูตรเดิมล้วน', priceFromYuan({ ...S, surcharge_from_yuan_1: 0, surcharge_from_yuan_2: 0 }, 600) === linear(600));
ok('F10 ปิดเฉพาะขั้น 2 → ขั้น 1 คุมต่อ', priceFromYuan({ ...S, surcharge_from_yuan_2: 0 }, 600) === linear(600) + 40);
ok('F11 ค่าติดลบถูกตัดเป็น 0', shippingSurcharge({ ...S, surcharge_baht_1: -5 }, 400) === 0);

// ── P) กฎห้ามแตะ ─────────────────────────────────────────────────────────────────
const prod = (id: string, extra: Partial<Product> = {}): Product => ({
  id, series_name: id, franchise_id: 'f', manufacturer_id: 'm', wcf_type: 'wcf', cost_yuan: 400, type: 'figure' as Product['type'], description: '', images: [], eta_note: '',
  price_total: 2110, deposit_amount: 300, is_stock: false, has_variants: false, status: 'open', created_at: '2026-10-01', ...extra,
});
const tk = (id: string, product: string, extra: Partial<PreorderTicket> = {}): PreorderTicket => ({
  id, ticket_no: id.toUpperCase(), product_id: product, owner_id: 'u1', original_buyer_id: 'u1', qty: 1, deposit_paid: 300,
  remaining_amount: 1810, remaining_paid: 0, status: 'active', product_status: 'open', qr_code_url: '', created_at: '2026-10-01', ...extra,
});
const base = (): Database => {
  const db = structuredClone(SEED_DATABASE) as Database;
  db.settings = { ...S };
  db.products = [
    prod('free'),                                            // เปิดรับ ไม่มีใคร → เปลี่ยน
    prod('mainTicket'),                                      // ตั๋วกระดานหลัก → กัน
    prod('batchTicket'),                                     // ตั๋วรอบพิเศษ → กัน
    prod('pendingOrder'),                                    // ออเดอร์รอตรวจ → กัน
    prod('hold'),                                            // hold ค้าง → กัน
    prod('rejectedOrder'),                                   // ออเดอร์ถูกปฏิเสธ = ไม่ใช่คนพรี → เปลี่ยน
    prod('expiredHold'),                                     // hold หมดอายุ → เปลี่ยน
    prod('closedRound', { status: 'production' }),          // ปิดรอบแล้ว → ไม่แตะ
    prod('instock', { is_stock: true, stock_qty: 3 }),      // พร้อมส่ง → ไม่แตะ
    prod('noYuan', { cost_yuan: undefined, price_total: 999 }), // ไม่มีหยวน → ราคาเดิม (มัดจำตามชนิด)
    prod('cheap', { cost_yuan: 300, price_total: 1610 }),    // ต่ำกว่าขั้น 1 → ราคาเท่าเดิมอยู่แล้ว ไม่อยู่ในรายการ
  ];
  db.batches = [{ id: 'b1', product_id: 'batchTicket', label: 'รอบ 2', price_total: 2110, deposit_amount: 300, stock_qty: 2, status: 'open', created_at: '2026-10-01' }];
  db.tickets = [tk('t1', 'mainTicket'), tk('t2', 'batchTicket', { batch_id: 'b1' })];
  db.orders = [
    { id: 'o1', user_id: 'u1', status: 'pending_approval', total_deposit: 300, slip_url: '', created_at: '2026-10-01', items: [{ id: 'i1', order_id: 'o1', product_id: 'pendingOrder', qty: 1, deposit_amount: 300 }] },
    { id: 'o2', user_id: 'u1', status: 'rejected', total_deposit: 300, slip_url: '', created_at: '2026-10-01', items: [{ id: 'i2', order_id: 'o2', product_id: 'rejectedOrder', qty: 1, deposit_amount: 300 }] },
  ];
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  const past = new Date(Date.now() - 10 * 60_000).toISOString();
  db.stockReservations = [
    { id: 'r1', product_id: 'hold', user_id: 'u2', qty: 1, status: 'active', reserved_until: future },
    { id: 'r2', product_id: 'expiredHold', user_id: 'u2', qty: 1, status: 'active', reserved_until: past },
  ];
  db.variants = []; db.transfers = [] as never; db.remainingPayments = []; db.activityLogs = []; db.paymentPlans = [];
  return db;
};
const priceOf = (db: Database, id: string) => db.products.find((x) => x.id === id)!.price_total;
const depOf = (db: Database, id: string) => db.products.find((x) => x.id === id)!.deposit_amount;

{
  const db = base();
  ok('P0 hasPreorderBookings: ตั๋ว/ออเดอร์รอตรวจ/hold = มี · ปฏิเสธ/หมดอายุ/ว่าง = ไม่มี',
    hasPreorderBookings(db, 'mainTicket') && hasPreorderBookings(db, 'batchTicket') && hasPreorderBookings(db, 'pendingOrder') && hasPreorderBookings(db, 'hold')
    && !hasPreorderBookings(db, 'rejectedOrder') && !hasPreorderBookings(db, 'expiredHold') && !hasPreorderBookings(db, 'free'));

  const after = repriceOpenPreorders()(db);
  ok('P1 ว่าง → ราคาใหม่ 2150', priceOf(after, 'free') === 2150);
  ok('P2 ตั๋วกระดานหลัก → ไม่แตะ', priceOf(after, 'mainTicket') === 2110);
  ok('P3 ตั๋วรอบพิเศษ → ไม่แตะ', priceOf(after, 'batchTicket') === 2110);
  ok('P4 ออเดอร์รอตรวจ → ไม่แตะ', priceOf(after, 'pendingOrder') === 2110);
  ok('P5 hold ค้าง → ไม่แตะ', priceOf(after, 'hold') === 2110);
  ok('P6 ออเดอร์ถูกปฏิเสธ → เปลี่ยนได้', priceOf(after, 'rejectedOrder') === 2150);
  ok('P7 hold หมดอายุ → เปลี่ยนได้', priceOf(after, 'expiredHold') === 2150);
  ok('P8 ปิดรอบแล้ว → ไม่แตะ', priceOf(after, 'closedRound') === 2110);
  ok('P9 พร้อมส่ง → ไม่แตะ', priceOf(after, 'instock') === 2110);
  ok('P10 ไม่มีหยวน → ราคาเดิม', priceOf(after, 'noYuan') === 999);
  ok('P11 ต่ำกว่าขั้น 1 → เท่าเดิม', priceOf(after, 'cheap') === 1610);
  ok('P12 มัดจำไม่ถูกแตะทุกตัว', after.products.every((x) => depOf(after, x.id) === 300));
  ok('P13 ตั๋ว/ออเดอร์ไม่ถูกแตะ', JSON.stringify(after.tickets) === JSON.stringify(db.tickets) && JSON.stringify(after.orders) === JSON.stringify(db.orders));

  // บันทึกสูตรใหม่ (เปลี่ยนก้อนขั้น 1 เป็น +60) → ปรับเฉพาะชุดเดียวกัน
  const saved = updateSettings({ surcharge_baht_1: 60 })(db);
  ok('P14 บันทึกสูตร: ว่าง → 2170 · มีคน → 2110', priceOf(saved, 'free') === 2170 && priceOf(saved, 'mainTicket') === 2110 && priceOf(saved, 'hold') === 2110);
  ok('P15 บันทึกค่าที่ไม่ใช่สูตร (บัญชี) → ไม่ reprice', priceOf(updateSettings({ bank_name: 'x' })(db), 'free') === 2110);
  ok('P16 มัดจำเกินราคา → ถูกตัดเท่าราคา (F12 เดิม)', depOf(repriceOpenPreorders()({ ...db, products: [prod('tiny', { cost_yuan: 288, wcf_type: 'mega_wcf', price_total: 1, deposit_amount: 1 })], settings: { ...S, baht_base: 100 } }), 'tiny') === 100);

  // ── U) หน้าแอดมิน = mutation ──
  const t = repriceTargets(db, db.settings);
  const changedIds = t.changed.map((c) => c.product.id).sort();
  const realChanged = after.products.filter((x) => x.price_total !== priceOf(db, x.id) || x.deposit_amount !== depOf(db, x.id)).map((x) => x.id).sort();
  ok('U1 รายการ "จะเปลี่ยน" ตรงกับที่ mutation เปลี่ยนจริง', JSON.stringify(changedIds) === JSON.stringify(realChanged), { changedIds, realChanged });
  ok('U2 จะเปลี่ยน = free/rejectedOrder/expiredHold', JSON.stringify(changedIds) === JSON.stringify(['expiredHold', 'free', 'rejectedOrder']));
  ok('U3 กันไว้ 4 รายการ (ตั๋วหลัก/ตั๋วรอบ/ออเดอร์รอตรวจ/hold)', t.protectedCount === 4, t.protectedCount);
  ok('U4 ราคาใหม่ในรายการตรงสูตร', t.changed.every((c) => c.next.price_total === 2150));
}

console.log(`\npricing-audit: ${p} passed, ${f} failed`);
if (f) process.exit(1);
