/**
 * audit_money.mjs — เดินเส้นเงิน "ผู้ชนะประมูล → ตะกร้า → checkout → ออเดอร์ → ตั๋ว" ด้วยตัวเลขจริง
 * รันด้วย:  node audit_money.mjs
 * โหลดโค้ดจริง (TypeScript) ผ่าน jiti — ไม่ได้ลอกสูตรมาเขียนใหม่
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jiti = require('jiti')(process.cwd(), { interopDefault: true, esmResolve: true });

const M = jiti('./src/data/mutations.ts');
const { livePrice } = jiti('./src/domain/services/pricing.ts');
const { lineDepositForRank } = jiti('./src/domain/services/ranks.ts');
const { instockCouponsFor, couponDiscount, couponMatchesProduct } = jiti('./src/domain/services/coupons.ts');
const { availableFor } = jiti('./src/domain/services/reservations.ts');
const { SEED_DATABASE } = jiti('./src/data/seed.ts');

const clone = (o) => JSON.parse(JSON.stringify(o));
const line = (s) => console.log(s);
const B = (n) => `${n.toLocaleString()}฿`;

// ── ฐานข้อมูลจำลอง: ลูกค้า 1 คน + สินค้าพร้อมส่ง 1 ตัว + ห้องประมูลที่ปิดแล้ว ────────
function baseDb({ isStock = true, productStatus = 'arrived', stockQty = 1 } = {}) {
  const db = clone(SEED_DATABASE);
  db.users = [{ id: 'u1', display_name: 'ลูกค้า A', rank: 'gold', is_admin: false, member_code: 'M001', approved: true }];
  db.products = [{
    id: 'p1', series_name: 'Zoro WCF', type: 'wcf', manufacturer_id: 'mk1', franchise_id: 'fr1',
    images: [], price_total: 2500, deposit_amount: 500, status: productStatus,
    is_stock: isStock, stock_qty: stockQty, surplus_qty: 0, created_at: '2026-01-01',
  }];
  db.manufacturers = [{ id: 'mk1', name: 'Bandai', category_id: 'c1' }];
  db.franchises = [{ id: 'fr1', name: 'One Piece', abbr: 'op' }];
  db.variants = []; db.batches = []; db.tickets = []; db.orders = [];
  db.stockReservations = []; db.stockAdditions = []; db.couponGrants = []; db.coupons = [];
  db.auctionBids = []; db.auctionWatch = []; db.auctionEntries = [];
  db.auctions = [{
    id: 'auc1', product_id: 'p1', title: 'Zoro WCF', images: [], start_price: 1000,
    ends_at: '2026-08-01T12:00:00Z', original_ends_at: '2026-08-01T12:00:00Z',
    extend_min: 5, window_min: 30, cap_min: 60, status: 'ended',
    current_price: 3200, bid_count: 12, extend_count: 2,
    winner_user_id: 'u1', winning_amount: 3200,
    runner_up_user_id: 'u2', runner_up_amount: 3150,
    pay_due_at: '2026-08-02T12:00:00Z', created_at: '2026-07-30T00:00:00Z',
  }];
  return db;
}
const AUC_LINE = { productId: 'p1', auctionId: 'auc1', qty: 1, priceEach: 3200, depositEach: 3200 };

line('════════ 1) ราคา/มัดจำของบรรทัดประมูล ════════');
{
  const db = baseDb();
  const { price, deposit } = livePrice(db, AUC_LINE);
  const each = lineDepositForRank(db.settings, { deposit, price, isStock: true }, 'gold');
  line(`  livePrice → ราคา ${B(price)} / มัดจำ ${B(deposit)}`);
  line(`  เก็บจริง (ยศ gold, ส่วนลดมัดจำ ${db.settings.rank_gold_deposit_pct}%) = ${B(each)}  ${each === 3200 ? '✓ ยศไม่มีผล' : '✗ ยศลดให้!'}`);
}

line('\n════════ 2) คูปองใช้กับบรรทัดประมูลได้ไหม (กติกา: ห้าม) ════════');
{
  const db = baseDb();
  db.coupons = [{ id: 'cp1', label: 'ส่วนลด 200', value: 200, scope: 'instock', active: true, created_at: '2026-01-01' }];
  db.couponGrants = [{ id: 'g1', coupon_id: 'cp1', user_id: 'u1', status: 'active', created_at: '2026-01-01' }];
  const usable = instockCouponsFor(db, 'u1', ['p1']);
  line(`  คูปองที่ checkout เสนอให้ใช้กับตะกร้าที่มีแต่บรรทัดประมูล = ${usable.length} ใบ ${usable.length ? '✗ ไม่ควรมี' : '✓'}`);
  const after = M.submitOrder('u1', [AUC_LINE], 'slip.jpg', [], false, { grantId: 'g1', discount: 200 })(db);
  const o = after.orders[0];
  line(`  submitOrder → total_deposit = ${B(o.total_deposit)} (ยอดที่ชนะ ${B(3200)})  ${o.total_deposit === 3200 ? '✓' : `✗ ลดไป ${B(3200 - o.total_deposit)}`}`);
  line(`  coupon_discount ที่บันทึกลงออเดอร์ = ${o.coupon_discount ?? 0}`);
}

line('\n════════ 3) qty = 2 บนบรรทัดประมูล (ปุ่ม + ในตะกร้า / กด add ซ้ำ) ════════');
{
  const db = baseDb({ stockQty: 5 });
  const l2 = { ...AUC_LINE, qty: 2 };
  const { price, deposit } = livePrice(db, l2);
  const shown = lineDepositForRank(db.settings, { deposit, price, isStock: true }, 'gold') * l2.qty;
  line(`  หน้า checkout โชว์ยอดโอน = ${B(shown)} (ลูกค้าโอนจริงตามนี้)`);
  const after = M.submitOrder('u1', [l2], 'slip.jpg', [], false)(db);
  line(`  submitOrder → ออเดอร์ที่เกิด = ${after.orders.length} ใบ ${after.orders.length === 0 ? '✗ เงินหาย (ปัดตกเงียบ)' : '✓'}`);
  line(`  availableFor(p1) = ${availableFor(db, db.products[0])} → หน้า checkout ${2 > availableFor(db, db.products[0]) ? 'บล็อก' : 'ไม่บล็อก'}`);
}

line('\n════════ 4) ห้องผูกกับ "สินค้าพรีที่ถึงไทยแล้ว" (ไม่ใช่ is_stock) ════════');
{
  const db = baseDb({ isStock: false, productStatus: 'arrived' });
  const p = db.products[0];
  const deadAtCheckout = !p.is_stock && p.status !== 'open';           // สูตร deadLines ใน checkout/page.tsx
  line(`  checkout deadLines = ${deadAtCheckout} ${deadAtCheckout ? '✗ เด้งกลับตะกร้า "สินค้าหมดแล้ว"' : '✓'}`);
  const after = M.submitOrder('u1', [AUC_LINE], 'slip.jpg', [], false)(db);
  line(`  submitOrder (sellable guard) → ออเดอร์ = ${after.orders.length} ใบ ${after.orders.length === 0 ? '✗ จ่ายไม่ได้เลย' : '✓'}`);
}

line('\n════════ 5) เส้นเงินปกติ: submit → approve → ตั๋ว ════════');
{
  const db = baseDb();
  const a1 = M.submitOrder('u1', [AUC_LINE], 'slip.jpg', [], false)(db);
  const o = a1.orders[0];
  line(`  ออเดอร์ ${B(o.total_deposit)} · ห้อง → status='${a1.auctions[0].status}' pay_order_id=${a1.auctions[0].pay_order_id ? 'set' : 'ว่าง'}`);
  line(`  (⚠ แถว auctions ถูกแก้ใน "เซสชันลูกค้า" → adapter upsert ตาราง auctions → RLS มีแต่ policy admin)`);
  const a2 = M.approveOrder(o.id, { mintRewards: false })(a1);
  const t = a2.tickets[0];
  line(`  approveOrder → ตั๋ว ${t.ticket_no} มัดจำ ${B(t.deposit_paid)} ค้าง ${B(t.remaining_amount)} status=${t.status}`);
  line(`  ห้องหลังอนุมัติ = '${a2.auctions[0].status}'`);
  // จำลอง "แถว auctions ไม่ได้ขึ้น server" (RLS ปฏิเสธ) แล้วแอดมินโหลดใหม่
  const serverView = clone(a1);
  serverView.auctions = clone(db.auctions);            // ห้องยัง ended / pay_order_id ว่าง
  const a3 = M.approveOrder(o.id, { mintRewards: false })(serverView);
  line(`  ถ้าแถว auctions ไม่ขึ้น server → หลังอนุมัติห้อง = '${a3.auctions[0].status}' (ควรเป็น paid)`);
  // จ่ายซ้ำ
  const again = M.submitOrder('u1', [AUC_LINE], 'slip2.jpg', [], false)(serverView);
  line(`  ผู้ชนะกด "ชำระเงิน" ซ้ำบนข้อมูลชุดนั้น → ออเดอร์รวม ${again.orders.length} ใบ ${again.orders.length > 1 ? '✗ จ่ายซ้ำได้' : '✓'}`);
}

line('\n════════ 6) rejectOrder แล้วส่งสลิปใหม่ ════════');
{
  const db = baseDb();
  const a1 = M.submitOrder('u1', [AUC_LINE], 'slip.jpg', [], false)(db);
  const a2 = M.rejectOrder(a1.orders[0].id)(a1);
  const au = a2.auctions[0];
  line(`  หลัง reject: status='${au.status}' pay_order_id=${au.pay_order_id === null ? 'null' : String(au.pay_order_id)} pay_due_at=${au.pay_due_at}`);
  const a3 = M.submitOrder('u1', [AUC_LINE], 'slip3.jpg', [], false)(a2);
  line(`  ส่งสลิปใหม่ได้ไหม → ออเดอร์ = ${a3.orders.length} ใบ ${a3.orders.length === 2 ? '✓' : '✗'}`);
}

line('\n════════ 7) อันดับ 2 ที่บิดถูก void ไปแล้ว ════════');
{
  const db = baseDb();
  db.auctionBids = [
    { id: 'b1', auction_id: 'auc1', user_id: 'u1', amount: 3200, status: 'active', created_at: '2026-08-01T11:00:00Z' },
    { id: 'b2', auction_id: 'auc1', user_id: 'u2', amount: 3150, status: 'active', created_at: '2026-08-01T10:00:00Z' },
  ];
  const voided = M.voidAuctionBid('b2', 'ลูกค้าพิมพ์ผิด')(db);
  line(`  หลัง void บิดอันดับ 2: runner_up=${voided.auctions[0].runner_up_user_id} @ ${B(voided.auctions[0].runner_up_amount)}`);
  const awarded = M.awardRunnerUp('auc1')(voided);
  const au = awarded.auctions[0];
  line(`  กด "ยกให้อันดับ 2" → ผู้ชนะใหม่ = ${au.winner_user_id} @ ${B(au.winning_amount)} ${au.winner_user_id === 'u2' ? '✗ ยกให้บิดที่เป็นโมฆะ' : '✓'}`);
  line(`  current_price หลัง void = ${B(voided.auctions[0].current_price)} · bid_count = ${voided.auctions[0].bid_count}`);
}

line('\n════════ 8) เพดาน "ชนะค้างจ่าย 2 รายการ" หลังจ่ายเงินแล้ว ════════');
{
  const { openWins } = jiti('./src/domain/services/auctions.ts');
  const db = baseDb();
  const a1 = M.submitOrder('u1', [AUC_LINE], 'slip.jpg', [], false)(db);
  line(`  ระหว่างรอแอดมินตรวจสลิป: openWins = ${openWins(a1, 'u1').length} (สถานะ '${a1.auctions[0].status}')`);
  const server = clone(a1); server.auctions = clone(db.auctions);
  line(`  ถ้าแถวห้องไม่ขึ้น server: openWins = ${openWins(server, 'u1').length} → ค้างเต็มเพดานถาวร`);
}

line('\n════════ 9) ของในมือที่ไม่ได้ตั้งขายในร้าน (stock_qty = 0) ════════');
{
  const db = baseDb({ isStock: true, stockQty: 0 });
  const p = db.products[0];
  const avail = availableFor(db, p);
  const dead = 1 > avail;                                   // สูตร deadLines (in-stock) ใน checkout
  line(`  availableFor = ${avail} → deadLines = ${dead} ${dead ? '✗ เด้งกลับตะกร้า จ่ายไม่ได้' : '✓'}`);
  const after = M.submitOrder('u1', [AUC_LINE], 'slip.jpg', [], false)(db);
  line(`  submitOrder (กันขายเกิน) → ออเดอร์ = ${after.orders.length} ใบ ${after.orders.length === 0 ? '✗' : '✓'}`);
}
