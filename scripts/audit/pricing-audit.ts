/* สูตรราคา + ค่าส่งเพิ่มตามช่วงต้นทุน (v87/v88) + กฎ "มีคนพรีแล้วห้ามแตะ" (เจ้าของ 2026-10-13) — ฐานปลอม ไม่แตะ Supabase
 *   npx --yes tsx scripts/audit/pricing-audit.ts
 *   F) priceFromYuan: 288–348 เท่าเดิม · ตั้งแต่ 349 +40 · ตั้งแต่ 500 +80 (ไม่บวกซ้อน) · ปิดขั้นด้วย 0 ได้
 *   P) updateSettings (บันทึกสูตร): ขยับเฉพาะพรีเปิดรับที่ยังไม่มีคนพรี และราคา/มัดจำ "ตามสูตรเก่า" อยู่
 *      กันไว้: ตั๋วกระดานหลัก/ตั๋วรอบพิเศษ/ออเดอร์รอตรวจ/hold ค้าง · ปิดรอบ · พร้อมส่ง · หลายแบบ · ราคา/มัดจำตั้งเอง
 *      ออเดอร์ที่ถูกปฏิเสธ/hold หมดอายุ ไม่นับเป็นคนพรี
 *   U) หน้าแอดมิน (พรีวิวจากค่าในฟอร์ม) กับ mutation ใช้ตัวจำแนกเดียวกัน (repriceTargets.changed == สินค้าที่บันทึกแล้วเปลี่ยนจริง)
 */
import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, Product, PreorderTicket } from '../../src/domain/entities';
import { priceFromYuan, shippingSurcharge, hasPreorderBookings, repriceTargets } from '../../src/domain/services/pricing';
import { updateSettings } from '../../src/data/mutations';

let p = 0, f = 0;
const ok = (n: string, c: boolean, detail?: unknown) => { if (c) p++; else { f++; console.log('FAIL', n, detail === undefined ? '' : JSON.stringify(detail)); } };

const S = { ...SEED_DATABASE.settings }; // 288→1550 · 5฿/¥ · ขั้น 349→+40 · 500→+80
const linear = (y: number) => 1550 + (y - 288) * 5;

// ── F) สูตร ─────────────────────────────────────────────────────────────────────
ok('F1 288¥ เท่าเดิม 1550', priceFromYuan(S, 288) === 1550);
ok('F2a 328¥ เท่าเดิม 1750', priceFromYuan(S, 328) === 1750);
ok('F2b 348¥ เท่าเดิม 1850', priceFromYuan(S, 348) === 1850);
ok('F3 349¥ +40 = 1895', priceFromYuan(S, 349) === linear(349) + 40 && priceFromYuan(S, 349) === 1895);
ok('F4 400¥ +40 = 2150', priceFromYuan(S, 400) === 2150);
ok('F5 499¥ +40', priceFromYuan(S, 499) === linear(499) + 40);
ok('F6 500¥ +80 = 2690', priceFromYuan(S, 500) === 2690);
ok('F7 800¥ +80 (ไม่บวกซ้อน)', priceFromYuan(S, 800) === linear(800) + 80 && shippingSurcharge(S, 800) === 80);
ok('F8 ต่ำกว่าฐานมากๆ ไม่ติดลบ', priceFromYuan(S, -500) === 0);
ok('F9 ปิดขั้นด้วย 0 → สูตรเดิมล้วน', priceFromYuan({ ...S, surcharge_from_yuan_1: 0, surcharge_from_yuan_2: 0 }, 600) === linear(600));
ok('F10 ปิดเฉพาะขั้น 2 → ขั้น 1 คุมต่อ', priceFromYuan({ ...S, surcharge_from_yuan_2: 0 }, 600) === linear(600) + 40);
ok('F11 ค่าติดลบถูกตัดเป็น 0', shippingSurcharge({ ...S, surcharge_baht_1: -5 }, 400) === 0);
ok('F12 production (ฐาน 1,640): 348→1940 · 349→1985 · 500→2780', (() => { const P = { ...S, baht_base: 1640 }; return priceFromYuan(P, 348) === 1940 && priceFromYuan(P, 349) === 1985 && priceFromYuan(P, 500) === 2780; })());

// ── P) กฎห้ามแตะ ─────────────────────────────────────────────────────────────────
const FORMULA = priceFromYuan(S, 400); // 2150 = ราคาตามสูตรปัจจุบันของ 400¥
const prod = (id: string, extra: Partial<Product> = {}): Product => ({
  id, series_name: id, franchise_id: 'f', manufacturer_id: 'm', wcf_type: 'wcf', cost_yuan: 400, type: 'figure' as Product['type'], description: '', images: [], eta_note: '',
  price_total: FORMULA, deposit_amount: 300, is_stock: false, has_variants: false, status: 'open', created_at: '2026-10-01', ...extra,
});
const tk = (id: string, product: string, extra: Partial<PreorderTicket> = {}): PreorderTicket => ({
  id, ticket_no: id.toUpperCase(), product_id: product, owner_id: 'u1', original_buyer_id: 'u1', qty: 1, deposit_paid: 300,
  remaining_amount: 1810, remaining_paid: 0, status: 'active', product_status: 'open', qr_code_url: '', created_at: '2026-10-01', ...extra,
});
const base = (): Database => {
  const db = structuredClone(SEED_DATABASE) as Database;
  db.settings = { ...S };
  db.products = [
    prod('free'),                                            // เปิดรับ ไม่มีใคร ตามสูตร → ขยับ
    prod('mainTicket'),                                      // ตั๋วกระดานหลัก → กัน
    prod('batchTicket'),                                     // ตั๋วรอบพิเศษ → กัน
    prod('pendingOrder'),                                    // ออเดอร์รอตรวจ → กัน
    prod('hold'),                                            // hold ค้าง → กัน
    prod('rejectedOrder'),                                   // ออเดอร์ถูกปฏิเสธ = ไม่ใช่คนพรี → ขยับ
    prod('expiredHold'),                                     // hold หมดอายุ → ขยับ
    prod('closedRound', { status: 'production' }),          // ปิดรอบแล้ว → ไม่แตะ
    prod('instock', { is_stock: true, stock_qty: 3 }),      // พร้อมส่ง → ไม่แตะ
    prod('noYuan', { cost_yuan: undefined, price_total: 999 }), // ไม่มีหยวน → ราคาเดิม
    prod('cheap', { cost_yuan: 300, price_total: priceFromYuan(S, 300) }), // ต่ำกว่าขั้น 1 → ขยับเฉพาะถ้าฐานเปลี่ยน
    prod('customPrice', { price_total: 2500 }),              // ราคาตั้งเอง → ไม่แตะ
    prod('customDep', { deposit_amount: 1000 }),             // มัดจำตั้งเอง → ราคาขยับ มัดจำคง
    prod('variant', { has_variants: true }),                 // หลายแบบ → ไม่แตะ
  ];
  db.batches = [{ id: 'b1', product_id: 'batchTicket', label: 'รอบ 2', price_total: FORMULA, deposit_amount: 300, stock_qty: 2, status: 'open', created_at: '2026-10-01' }];
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
const changedIds = (before: Database, after: Database) => after.products.filter((x) => x.price_total !== priceOf(before, x.id) || x.deposit_amount !== depOf(before, x.id)).map((x) => x.id).sort();

{
  const db = base();
  ok('P0 hasPreorderBookings: ตั๋ว/ออเดอร์รอตรวจ/hold = มี · ปฏิเสธ/หมดอายุ/ว่าง = ไม่มี',
    hasPreorderBookings(db, 'mainTicket') && hasPreorderBookings(db, 'batchTicket') && hasPreorderBookings(db, 'pendingOrder') && hasPreorderBookings(db, 'hold')
    && !hasPreorderBookings(db, 'rejectedOrder') && !hasPreorderBookings(db, 'expiredHold') && !hasPreorderBookings(db, 'free'));

  // บันทึกสูตร: ขั้น 1 จาก +40 เป็น +60
  const after = updateSettings({ surcharge_baht_1: 60 })(db);
  ok('P1 ว่าง ตามสูตร → 2170', priceOf(after, 'free') === 2170);
  ok('P2 ตั๋วกระดานหลัก → ไม่แตะ', priceOf(after, 'mainTicket') === FORMULA);
  ok('P3 ตั๋วรอบพิเศษ → ไม่แตะ', priceOf(after, 'batchTicket') === FORMULA);
  ok('P4 ออเดอร์รอตรวจ → ไม่แตะ', priceOf(after, 'pendingOrder') === FORMULA);
  ok('P5 hold ค้าง → ไม่แตะ', priceOf(after, 'hold') === FORMULA);
  ok('P6 ออเดอร์ถูกปฏิเสธ → ขยับ', priceOf(after, 'rejectedOrder') === 2170);
  ok('P7 hold หมดอายุ → ขยับ', priceOf(after, 'expiredHold') === 2170);
  ok('P8 ปิดรอบแล้ว → ไม่แตะ', priceOf(after, 'closedRound') === FORMULA);
  ok('P9 พร้อมส่ง → ไม่แตะ', priceOf(after, 'instock') === FORMULA);
  ok('P10 ไม่มีหยวน → ราคาเดิม', priceOf(after, 'noYuan') === 999);
  ok('P11 ต่ำกว่าขั้น 1 → เท่าเดิม', priceOf(after, 'cheap') === priceFromYuan(S, 300));
  ok('P12 ราคาตั้งเอง → ไม่แตะ', priceOf(after, 'customPrice') === 2500);
  ok('P13 มัดจำตั้งเอง: ราคาขยับ มัดจำคง 1,000', priceOf(after, 'customDep') === 2170 && depOf(after, 'customDep') === 1000);
  ok('P14 หลายแบบ → ไม่แตะ', priceOf(after, 'variant') === FORMULA);
  ok('P15 แก้สูตรราคา: มัดจำไม่ถูกแตะทุกตัว', after.products.every((x) => depOf(after, x.id) === depOf(db, x.id)));
  ok('P16 ตั๋ว/ออเดอร์ไม่ถูกแตะ', JSON.stringify(after.tickets) === JSON.stringify(db.tickets) && JSON.stringify(after.orders) === JSON.stringify(db.orders));
  ok('P17 บันทึกค่าที่ไม่ใช่สูตร (บัญชี) → ไม่ขยับ', JSON.stringify(updateSettings({ bank_name: 'x' })(db).products) === JSON.stringify(db.products));
  ok('P18 บันทึกค่าเดิมซ้ำ → ไม่ขยับ', JSON.stringify(updateSettings({ ...S })(db).products) === JSON.stringify(db.products));

  // ฐานบาทเปลี่ยน → ของต่ำกว่าขั้นที่ตามสูตรก็ขยับ
  const rebased = updateSettings({ baht_base: 1640 })(db);
  ok('P19 ฐาน 1550→1640: ตามสูตรขยับ +90 · ตั้งเอง/มีคนพรีไม่แตะ',
    priceOf(rebased, 'free') === FORMULA + 90 && priceOf(rebased, 'cheap') === priceFromYuan(S, 300) + 90
    && priceOf(rebased, 'customPrice') === 2500 && priceOf(rebased, 'mainTicket') === FORMULA);

  // แก้เรทมัดจำ 300→400: มัดจำที่ตามเรทขยับ · ตั้งเอง/มีคนพรีไม่แตะ · ราคาไม่ขยับ
  const depSaved = updateSettings({ deposit_wcf: 400 })(db);
  ok('P20 แก้เรทมัดจำ: ว่าง → 400 · ตั้งเอง 1,000 คง · มีคน 300 คง',
    depOf(depSaved, 'free') === 400 && depOf(depSaved, 'customDep') === 1000 && depOf(depSaved, 'mainTicket') === 300 && depOf(depSaved, 'hold') === 300);
  ok('P21 แก้เรทมัดจำ: ราคาไม่ขยับ', depSaved.products.every((x) => priceOf(depSaved, x.id) === priceOf(db, x.id)));

  // มัดจำไม่เกินราคา (F12)
  const tiny = { ...db, settings: { ...S, baht_base: 100, deposit_mega: 500 }, products: [prod('tiny', { cost_yuan: 288, wcf_type: 'mega_wcf', price_total: 100, deposit_amount: 100 })] };
  ok('P22 แก้เรทมัดจำ Mega → มัดจำถูกตัดเท่าราคา', depOf(updateSettings({ deposit_mega: 600 })(tiny), 'tiny') === 100);

  // ── U) พรีวิวหน้าแอดมิน = ที่บันทึกแล้วเปลี่ยนจริง ──
  const cases: Partial<Database['settings']>[] = [{ surcharge_baht_1: 60 }, { baht_base: 1640 }, { deposit_wcf: 400 }, { surcharge_from_yuan_1: 300, surcharge_baht_2: 100 }];
  for (const patch of cases) {
    const t = repriceTargets(db, db.settings, { ...db.settings, ...patch });
    const real = changedIds(db, updateSettings(patch)(db));
    ok(`U ${JSON.stringify(patch)}: พรีวิว = จริง`, JSON.stringify(t.changed.map((c) => c.product.id).sort()) === JSON.stringify(real), { preview: t.changed.map((c) => c.product.id), real });
  }
  const t = repriceTargets(db, db.settings, { ...db.settings, surcharge_baht_1: 60 });
  ok('U กันไว้ 4 รายการ (ตั๋วหลัก/ตั๋วรอบ/ออเดอร์รอตรวจ/hold)', t.protectedCount === 4, t.protectedCount);
  ok('U ไม่มีอะไรเปลี่ยนถ้าสูตรเท่าเดิม', repriceTargets(db, db.settings, db.settings).changed.length === 0);
}

console.log(`\npricing-audit: ${p} passed, ${f} failed`);
if (f) process.exit(1);
