/**
 * เทสต์ระบบไลน์ (พรียกไลน์ · v81 · 2026-10-07) — ตัวจำแนกป้ายสถานะ + การมองเห็น + การเขียนแถว
 * เจ้าของสั่ง "ตีตรวจหา Bugs ทุกขั้นตอน" และ "เปลี่ยนสถานะในฐานข้อมูล ป้ายต้องอัปเดตตาม"
 *   → เทสต์ใช้ mutation จริงของร้าน (ปิดรอบ/เปลี่ยนสถานะ/แปลงเป็นสต๊อก/เปิดรอบพิเศษ) แล้วดูว่าป้ายเปลี่ยนเอง
 * รัน: npm run audit:lines
 */
process.env.TZ = 'Asia/Bangkok';
// โหมดมี backend: isAdminUser ใช้กฎจริง (ไม่งั้นโหมด seed ทุกคนเป็นแอดมิน = เทสต์การมองเห็นไม่ได้)
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'k';

import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, LineMember, PreorderTicket, Product, ProductLine, StockReservation } from '../../src/domain/entities';
import {
  lineMemberState, lineVisibleTo, lineOpenToCustomers, memberOpenForPreorder, linesPublicEnabled, shopLines, linesOfProduct, liveTargetsForLine, sourcingPrefill,
  cleanLineRow, cleanMember, layoutPins, lineSetPlan, lineChecklist, autoPinSpread, PIN_AUTO_Y, pinLabelWidth, memberProducts, lineToneCounts, lineStates, productsInVisibleLines, PIN_STEM_SHORT, PIN_STEM_TALL, PIN_STEMS, homeLines, isNewLine, type LineCtx, type PinPlacement,
} from '../../src/domain/services/lines';
import { isStockTwin, preorderOpenForOrder, openBoards, findDuplicateProducts } from '../../src/domain/services/catalog';
import {
  setProductStatus, convertToInStock, reopenBatch, upsertProductLine, patchProductLine, patchLineMember, removeProductLine, setLinesPublic, restockInStock, submitOrder, createProductsIntoLine, approveOrder, rejectOrder, deleteTicket, createBoard, setBoardProducts, updateBoard, removeProduct,
} from '../../src/data/mutations';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const now = Date.now();
const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString();

const MK = 'mk-ks', MK2 = 'mk-other', FR = 'f-hx';
const P = (id: string, over: Partial<Product> = {}): Product => ({
  id, franchise_id: FR, manufacturer_id: MK, series_name: id, character_name: id, type: 'wcf', description: '', images: [`img-${id}`],
  eta_note: '', price_total: 2000, deposit_amount: 1000, is_stock: false, has_variants: false, status: 'open', created_at: '2026-10-01', ...over,
} as Product);
const T = (id: string, productId: string, owner: string, over: Partial<PreorderTicket> = {}): PreorderTicket => ({
  id, ticket_no: id, product_id: productId, owner_id: owner, original_buyer_id: owner, qty: 1, deposit_paid: 1000, remaining_amount: 1000,
  remaining_paid: 0, status: 'active', product_status: 'open', qr_code_url: '', created_at: iso(-86_400_000), ...over,
} as PreorderTicket);
const M = (id: string, product_ids: string[], over: Partial<LineMember> = {}): LineMember => ({ id, name: id, product_ids, ...over });
const L = (members: LineMember[], over: Partial<ProductLine> = {}): ProductLine => ({
  id: 'L1', maker_id: MK, franchise_id: FR, name: 'กองโจรเงามายา', cover_url: 'cover.jpg', note: null, members, active: true, created_at: '2026-10-07T00:00:00.000Z', ...over,
});
const base = (over: Partial<Database> = {}): Database => ({
  ...structuredClone(SEED_DATABASE),
  users: [
    { id: 'uA', display_name: 'A', facebook_id: '', rank: 'bronze', total_spent: 0, preferred_lang: 'th', approved: true } as Database['users'][number],
    { id: 'uB', display_name: 'B', facebook_id: '', rank: 'bronze', total_spent: 0, preferred_lang: 'th', approved: true } as Database['users'][number],
    { id: 'uAdm', display_name: 'Admin', facebook_id: '', rank: 'bronze', total_spent: 0, preferred_lang: 'th', is_admin: true } as Database['users'][number],
  ],
  manufacturers: [{ id: MK, name: 'KS', category_id: 'cat-wcf' }, { id: MK2, name: 'Other', category_id: 'cat-wcf' }],
  franchises: [{ id: FR, name: 'HunterxHunter', abbr: 'hx' }],
  products: [], variants: [], batches: [], boards: [], tickets: [], stockReservations: [], stockAdditions: [], auctions: [], orders: [],
  appConfig: [], productLines: [],
  ...over,
});
const st = (db: Database, members: LineMember[], memberId: string, ctx: Partial<LineCtx> = {}) => {
  const line = L(members);
  const m = line.members.find((x) => x.id === memberId)!;
  return lineMemberState(db, line, m, { uid: 'uA', ...ctx });
};
const hold = (over: Partial<StockReservation>): StockReservation => ({
  id: 'r1', user_id: 'uB', product_id: 'x', qty: 1, status: 'active', reserved_until: iso(10 * 60_000), created_at: iso(-60_000), ...over,
} as StockReservation);

(async () => {
  // ── 1. ลำดับการเช็ค (กับดักที่รู้อยู่แล้ว) ───────────────────────────────────────────────
  {
    const db = base({ products: [P('open'), P('conv', { is_stock: true, status: 'open', stock_qty: 2 })] });
    ok('K1 พรีเปิดรับ → เปิดพรี (ฟ้า) ปุ่มพรีเลย → หน้าสินค้า', (() => { const s = st(db, [M('a', ['open'])], 'a'); return s.kind === 'preorder' && s.tone === 'blue' && s.cta?.href === '/shop/open' && s.label === 'Pre-Order'; })());
    const conv = st(db, [M('a', ['conv'])], 'a');
    ok('K2 กับดัก: พรีที่แปลงเป็นสต๊อก (status open + is_stock) → พร้อมส่ง ไม่ใช่ "พรีเลย"', conv.kind === 'stock' && conv.cta?.label === 'ซื้อเลย', conv);
    const both = st(db, [M('a', ['open', 'conv'])], 'a');
    ok('K3 ผูกทั้งใบพรีเปิด + ของพร้อมส่ง → ของพร้อมส่งมาก่อน', both.kind === 'stock' && both.product?.id === 'conv', both);
  }
  {
    const db = base({
      products: [P('ob', { board_id: 'b-open' }), P('cb', { board_id: 'b-closed' })],
      boards: [{ id: 'b-open', maker_id: MK, title: 'x', status: 'open', created_at: '' }, { id: 'b-closed', maker_id: MK, title: 'y', status: 'closed', created_at: '' }],
    });
    ok('K4 อยู่ในกระดานที่ยังเปิด → เปิดพรี', st(db, [M('a', ['ob'])], 'a').kind === 'preorder');
    const cb = st(db, [M('a', ['cb'])], 'a');
    ok('K5 กระดานปิดแล้ว (status ยัง open) → ปิดพรีแล้ว · รอสั่งผลิต (ไม่ใช่เปิดพรี)', cb.kind === 'closed' && cb.detail.includes('รอสั่งผลิต'), cb);
  }
  {
    const db = base({ products: [P('prod', { status: 'production' }), P('ship', { status: 'shipping' }), P('arr', { status: 'arrived' }), P('del', { status: 'delivered' }), P('cl', { status: 'closed' })] });
    const prod = st(db, [M('a', ['prod'])], 'a');
    ok('K6 ผลิต → ปิดพรีแล้ว (ม่วง) · กำลังผลิต · ปุ่มดูรายละเอียด', prod.kind === 'closed' && prod.tone === 'purple' && prod.detail.includes('กำลังผลิต') && prod.cta?.href === '/shop/prod', prod);
    ok('K7 เดินทาง → ปิดพรีแล้ว · กำลังเดินทาง', st(db, [M('a', ['ship'])], 'a').detail.includes('เดินทาง'));
    ok('K8 ผูกทั้งผลิต+เดินทาง → เลือกตัวที่ใกล้ถึงมือกว่า (เดินทาง)', st(db, [M('a', ['prod', 'ship'])], 'a').product?.id === 'ship');
    for (const id of ['arr', 'del', 'cl']) {
      const s = st(db, [M('a', [id])], 'a');
      ok(`K9 ${id} (ของออกแล้ว ไม่มีสต๊อก) → หาของ (ส้ม) ปุ่มหาของให้ → /sourcing พร้อม line/m/src`, s.kind === 'out' && s.tone === 'amber' && s.cta?.href === `/sourcing?line=L1&m=a&src=${id}`, s);
    }
    const mixed = st(db, [M('a', ['arr', 'prod'])], 'a');
    ok('K10 ผูกของออกแล้ว + รอบใหม่ที่กำลังผลิต → ปิดพรีแล้ว (มีโอกาสได้ของกว่า "หาของ")', mixed.kind === 'closed', mixed);
  }

  // ── 2. ของในมือ / ของคู่ / สต๊อกจริงจาก server ─────────────────────────────────────────────
  {
    const twin = P('twin', { is_stock: true, stock_qty: 3, series_name: 'Chrollo (มือ1)', character_name: 'Chrollo' });
    const pre = P('pre', { status: 'arrived', character_name: 'Chrollo' });
    const other = P('otherMk', { is_stock: true, stock_qty: 3, manufacturer_id: MK2, character_name: 'Chrollo' });
    const db = base({ products: [pre, twin, other] });
    const s = st(db, [M('a', ['pre'])], 'a');
    ok('S1 ผูกแค่ใบพรี (ถึงไทยแล้ว) แต่มีของพร้อมส่งชื่อเดียวกันค่ายเดียวกัน → พร้อมส่ง (ตามไปเจอของคู่)', s.kind === 'stock' && s.product?.id === 'twin', s);
    ok('S2 ของคู่ต้องค่ายเดียวกัน (ค่ายอื่นชื่อเหมือนกันไม่นับ)', !memberProducts(db, M('a', ['pre'])).all.some((p) => p.id === 'otherMk'));
    ok('S3 กฎของคู่ = กฎเดียวกับการรวมสต๊อก (isStockTwin)', isStockTwin(twin, pre) && !isStockTwin(other, pre) && !isStockTwin(pre, twin));
    const db0 = base({ products: [pre, { ...twin, stock_qty: 0 }] });
    ok('S4 ของคู่หมด → หาของ', st(db0, [M('a', ['pre'])], 'a').kind === 'out');
    const live0 = st(db, [M('a', ['pre'])], 'a', { live: (pid) => (pid === 'twin' ? 0 : undefined) });
    ok('S5 server บอกหมด (ตั๋วคนอื่นที่ลูกค้ามองไม่เห็น) แม้ local ยังเห็นของ → ไม่โชว์พร้อมส่ง → หาของ', live0.kind === 'out', live0);
    const live9 = st(base({ products: [pre, { ...twin, stock_qty: 1 }] }), [M('a', ['pre'])], 'a', { live: () => 9 });
    ok('S6 server บอกเหลือเยอะกว่า local → ใช้ค่าน้อยกว่า (ยังพร้อมส่ง)', live9.kind === 'stock');
  }
  {
    const p = P('stk', { is_stock: true, stock_qty: 1 });
    const db = base({ products: [p], stockReservations: [hold({ product_id: 'stk', user_id: 'uB' })] });
    const s = st(db, [M('a', ['stk'])], 'a');
    ok('S7 ของชิ้นสุดท้ายมีคนกำลังจ่าย (hold ยังไม่หมดเวลา) → หมดชั่วคราว ปุ่มดูสินค้า (ไม่ใช่หาของ)', s.kind === 'soldout_temp' && s.cta?.href === '/shop/stk', s);
    const expired = base({ products: [p], stockReservations: [hold({ product_id: 'stk', reserved_until: iso(-60_000) })] });
    ok('S8 hold หมดเวลาแล้ว → ของกลับมา พร้อมส่ง', st(expired, [M('a', ['stk'])], 'a').kind === 'stock');
    const sold = base({ products: [p], tickets: [T('t1', 'stk', 'uB', { remaining_amount: 0, deposit_paid: 2000 })] });
    ok('S9 ขายหมดจริง (ตั๋วออกครบ) → หาของ', st(sold, [M('a', ['stk'])], 'a').kind === 'out');
  }
  {
    const db = base({ products: [P('auc', { is_stock: true, stock_qty: 1 })], auctions: [{ id: 'a1', product_id: 'auc', status: 'live' } as Database['auctions'][number]] });
    const s = st(db, [M('a', ['auc'])], 'a');
    ok('S10 ติดห้องประมูล → ป้ายประมูล ไม่มีปุ่มซื้อ (หน้าร้านซ่อน) และไม่ตกไป "หาของ"', s.kind === 'auction' && !s.cta, s);
  }

  // ── 3. รอบพิเศษ ───────────────────────────────────────────────────────────────────────────
  {
    let db = base({ products: [P('sp', { status: 'production' })] });
    db = reopenBatch('sp', { price: 2500, deposit: 1000, qty: 2, label: 'รอบ 2' })(db);
    const b = db.batches[0];
    const dep = st(db, [M('a', ['sp'])], 'a');
    ok('B1 รอบพิเศษแบบมัดจำเปิดอยู่ → เปิดพรี (ฟ้า) ลิงก์ ?batch=', dep.kind === 'special' && dep.tone === 'blue' && dep.cta?.href === `/shop/sp?batch=${b.id}`, dep);
    let full = base({ products: [P('sp', { status: 'arrived' })] });
    full = reopenBatch('sp', { price: 2500, deposit: 2500, qty: 1 })(full);
    const f = st(full, [M('a', ['sp'])], 'a');
    ok('B2 รอบจ่ายเต็ม (ของในมือ) → พร้อมส่ง (เขียว)', f.kind === 'special' && f.tone === 'green' && f.label === 'พร้อมส่ง', f);
    const draft = { ...db, batches: db.batches.map((x) => ({ ...x, published: false })) };
    ok('B3 รอบพิเศษที่ยังเป็นร่าง (published=false) ไม่นับ → ปิดพรีแล้ว', st(draft, [M('a', ['sp'])], 'a').kind === 'closed');
    const soldOut = { ...db, tickets: [T('t1', 'sp', 'uB', { batch_id: b.id, qty: 2 })] };
    ok('B4 รอบพิเศษขายหมดแล้ว → ปิดพรีแล้ว (ไม่ค้างเปิดพรี)', st(soldOut, [M('a', ['sp'])], 'a').kind === 'closed');
    const held = { ...db, tickets: [T('t1', 'sp', 'uB', { batch_id: b.id, qty: 1 })], stockReservations: [hold({ product_id: 'sp', batch_id: b.id })] };
    const h = st(held, [M('a', ['sp'])], 'a');
    ok('B5 รอบพิเศษชิ้นสุดท้ายมีคนกำลังจ่าย → หมดชั่วคราว ลิงก์ ?batch=', h.kind === 'soldout_temp' && h.cta?.href === `/shop/sp?batch=${b.id}`, h);
    ok('B6 server บอกรอบหมด → ไม่โชว์เปิดพรีรอบพิเศษ', st(db, [M('a', ['sp'])], 'a', { live: (_p, bid) => (bid ? 0 : undefined) }).kind === 'closed');
  }

  // ── 4. "เปลี่ยนสถานะในฐานข้อมูล → ป้ายเปลี่ยนตาม" (คำสั่งเจ้าของ) ด้วย mutation จริง ──────────────
  {
    const members = [M('a', ['x'])];
    let db = base({ products: [P('x', { surplus_qty: 0 })], tickets: [T('t1', 'x', 'uA')] });
    const seq: string[] = [];
    seq.push(st(db, members, 'a').kind);
    db = setProductStatus('x', 'production')(db); seq.push(st(db, members, 'a').detail);
    db = setProductStatus('x', 'shipping')(db); seq.push(st(db, members, 'a').detail);
    db = setProductStatus('x', 'arrived')(db); seq.push(st(db, members, 'a', { uid: 'uB' }).kind); seq.push(st(db, members, 'a').kind);
    ok('F1 เปิดพรี → ผลิต → เดินทาง → ถึงไทย: ป้ายเปลี่ยนเองทุกขั้น · ถึงไทยแล้ว คนอื่น = หาของ · เจ้าของตั๋ว = ปิดพรีแล้ว (ดูตั๋ว)',
      seq[0] === 'preorder' && seq[1].includes('กำลังผลิต') && seq[2].includes('เดินทาง') && seq[3] === 'out' && seq[4] === 'closed', seq);
    // ถึงไทยแล้วมีของเหลือ → แปลงเป็นสต๊อก (ไม่มีของคู่ = SKU เดิมพลิกเป็นพร้อมส่ง)
    let db2 = base({ products: [P('y', { status: 'arrived', surplus_qty: 2 })] });
    ok('F2 ก่อนแปลง: ของออกแล้ว ยังไม่เปิดขายของเหลือ → หาของ', st(db2, [M('a', ['y'])], 'a').kind === 'out');
    db2 = convertToInStock('y', 2600)(db2);
    const y = st(db2, [M('a', ['y'])], 'a');
    ok('F3 แปลงพรีเป็นสต๊อก (SKU เดิม) → พร้อมส่ง ราคาใหม่', y.kind === 'stock' && y.detail.includes('2,600'), y);
    // มีของคู่อยู่แล้ว → convert รวมของเข้า SKU คู่ (ใบพรีที่ผูกไม่ได้กลายเป็นสต๊อก)
    let db3 = base({ products: [P('z', { status: 'arrived', surplus_qty: 2, character_name: 'Feitan' }), P('zStock', { is_stock: true, stock_qty: 0, character_name: 'Feitan' })] });
    ok('F4 ก่อนรวม: ของคู่ 0 ชิ้น → หาของ', st(db3, [M('a', ['z'])], 'a').kind === 'out');
    db3 = convertToInStock('z', 2600)(db3);
    const z = st(db3, [M('a', ['z'])], 'a');
    ok('F5 แปลงแล้วของถูกรวมเข้า SKU คู่ → ไลน์ตามไปเจอ พร้อมส่ง (ไม่ค้างหาของ)', z.kind === 'stock' && z.product?.id === 'zStock', z);
    // เติมสต๊อกของพร้อมส่ง
    let db4 = base({ products: [P('w', { is_stock: true, stock_qty: 0 })] });
    ok('F6 ของพร้อมส่งหมด → หาของ', st(db4, [M('a', ['w'])], 'a').kind === 'out');
    db4 = restockInStock('w', 3)(db4);
    ok('F7 เติมสต๊อก → กลับเป็นพร้อมส่งทันที', st(db4, [M('a', ['w'])], 'a').kind === 'stock');
  }

  // ── 5. ของฉัน (ตั๋ว) — หน้าพรีวิวแอดมินมีตั๋วทั้งร้าน ต้องกรอง owner เสมอ ──────────────────────────
  {
    const db = base({ products: [P('prod', { status: 'production' })], tickets: [T('t1', 'prod', 'uB')] });
    const mineA = st(db, [M('a', ['prod'])], 'a', { uid: 'uA' });
    const mineB = st(db, [M('a', ['prod'])], 'a', { uid: 'uB' });
    ok('O1 ตั๋วของ uB ไม่ทำให้ uA เห็นว่า "พรีแล้ว" (กรอง owner_id)', !mineA.mine && mineA.pinLabel === 'ปิดพรีแล้ว' && mineA.cta?.label === 'ดูรายละเอียด', mineA);
    ok('O2 เจ้าของตั๋วเห็น "พรีแล้ว ✓" + ปุ่มดูตั๋ว', mineB.mine && mineB.pinLabel === 'พรีแล้ว ✓' && mineB.cta?.href === '/wallet', mineB);
    const tr = base({ products: [P('prod', { status: 'production' })], tickets: [T('t1', 'prod', 'uB', { status: 'transferred' })] });
    ok('O3 ตั๋วสถานะ transferred ไม่นับว่าเป็นของฉัน', !st(tr, [M('a', ['prod'])], 'a', { uid: 'uB' }).mine);
    ok('O4 uid ว่าง (ยังไม่ล็อกอิน) → ไม่มีของฉัน', !st(db, [M('a', ['prod'])], 'a', { uid: '' }).mine);
    // เจ้าของ 2026-10-08: พรีไปแล้วต้องขึ้น "พรีแล้ว" แม้กระดานยังเปิดอยู่ · รวมออเดอร์ที่สลิปรอตรวจ (ยังไม่มีตั๋ว)
    const openMine = st(base({ products: [P('open')], tickets: [T('t1', 'open', 'uA')] }), [M('a', ['open'])], 'a', { uid: 'uA' });
    ok('O5 กระดานยังเปิด + มีตั๋วแล้ว → ป้าย "พรีแล้ว ✓" (คำย่อ "พรีแล้ว") แต่ยังเป็น kind preorder (สั่งเพิ่มได้)', openMine.mine && openMine.pinLabel === 'พรีแล้ว ✓' && openMine.pinShort === 'พรีแล้ว' && openMine.kind === 'preorder', openMine);
    const pendingOrder = base({ products: [P('open')], orders: [{ id: 'o1', user_id: 'uA', total_deposit: 1000, slip_url: 's', status: 'pending_approval', created_at: iso(-1000), items: [{ id: 'oi1', order_id: 'o1', product_id: 'open', qty: 1, deposit_amount: 1000 } as never] } as never] });
    ok('O6 ส่งสลิปแล้วรอตรวจ (ยังไม่มีตั๋ว) → นับว่าพรีแล้ว (กันสั่งซ้ำ) · คนอื่นไม่เกี่ยว', st(pendingOrder, [M('a', ['open'])], 'a', { uid: 'uA' }).mine && !st(pendingOrder, [M('a', ['open'])], 'a', { uid: 'uB' }).mine);
    const boughtStock = st(base({ products: [P('stk', { is_stock: true, stock_qty: 3 })], tickets: [T('t1', 'stk', 'uA', { remaining_amount: 0, deposit_paid: 2000 })] }), [M('a', ['stk'])], 'a', { uid: 'uA' });
    ok('O7 ของพร้อมส่งที่ซื้อแล้ว → ป้าย "ซื้อแล้ว ✓"', boughtStock.mine && boughtStock.pinLabel === 'ซื้อแล้ว ✓' && boughtStock.kind === 'stock', boughtStock);
  }

  // ── 6. ตัวที่ยังไม่มีสินค้าในระบบ (Add เอง) / id ที่ถูกลบ ─────────────────────────────────────────
  {
    const db = base({ products: [] });
    const gone = st(db, [M('a', ['deleted-product'], { manual_state: 'sourcing' })], 'a');
    ok('N1 สินค้าที่ผูกถูกลบไปแล้ว → ข้าม แล้วใช้สถานะที่แอดมินตั้ง (หาของ)', gone.kind === 'manual_sourcing' && gone.cta?.href === '/sourcing?line=L1&m=a', gone);
    const hidden = st(db, [M('a', ['deleted-product'])], 'a');
    ok('N2 ไม่มีสินค้า + ไม่ได้ตั้งสถานะ → ลูกค้าไม่เห็น (visible=false)', hidden.kind === 'hidden' && !hidden.visible, hidden);
    const mp = st(db, [M('a', [], { manual_state: 'preorder' })], 'a', { lineOa: '@ryumatoy' });
    ok('N3 Add เอง "พรีออเดอร์" → เปิดพรี (ฟ้า) ปุ่มทักร้าน LINE', mp.kind === 'manual_preorder' && mp.tone === 'blue' && mp.cta?.external === true && mp.cta.href.includes('line.me'), mp);
    const ms = st(db, [M('a', [], { manual_state: 'stock' })], 'a');
    ok('N4 Add เอง "มีสต๊อก" ไม่มี LINE OA → ป้ายมีของ ไม่มีปุ่ม (ไม่ลิงก์เสีย)', ms.kind === 'manual_stock' && ms.tone === 'green' && !ms.cta, ms);
    const linked = st(base({ products: [P('real', { status: 'production' })] }), [M('a', ['real'], { manual_state: 'sourcing' })], 'a');
    ok('N5 ผูกสินค้าจริงแล้ว → สถานะมือถูกเมิน คำนวณจากสินค้า', linked.kind === 'closed', linked);
  }

  // ── 7. การมองเห็น (สวิตช์ใหญ่ + ร่าง) ────────────────────────────────────────────────────────────
  {
    const line = L([M('a', ['open'])]);
    const draft = L([M('a', ['open'])], { id: 'L2', active: false });
    let db = base({ products: [P('open')], productLines: [line, draft] });
    ok('V1 ค่าเริ่มต้น: สวิตช์ปิด', !linesPublicEnabled(db));
    ok('V2 สวิตช์ปิด: ลูกค้าไม่เห็น · แอดมินเห็นทั้งไลน์จริงและร่าง', !lineVisibleTo(db, 'uA', line) && lineVisibleTo(db, 'uAdm', line) && lineVisibleTo(db, 'uAdm', draft));
    ok('V3 สวิตช์ปิด: หน้าร้านของลูกค้าไม่มีไลน์ · แอดมินเห็น 2', shopLines(db, 'uA').length === 0 && shopLines(db, 'uAdm').length === 2);
    db = setLinesPublic(true)(db);
    ok('V4 เปิดสวิตช์: ลูกค้าเห็นเฉพาะไลน์ active (ร่างยังซ่อน)', linesPublicEnabled(db) && lineVisibleTo(db, 'uA', line) && !lineVisibleTo(db, 'uA', draft) && shopLines(db, 'uA').map((l) => l.id).join() === 'L1');
    db = setLinesPublic(false)(db);
    ok('V5 ปิดสวิตช์กลับ → ลูกค้าไม่เห็นอีก (แถวเดียว ไม่ซ้ำ)', !lineVisibleTo(db, 'uA', line) && db.appConfig.filter((c) => c.key === 'lines_public').length === 1);
    db = setLinesPublic(true)(db);
    const noCover = L([M('a', ['open'])], { id: 'L3', cover_url: null });
    const allHidden = L([M('a', [])], { id: 'L4' });
    db = { ...db, productLines: [line, noCover, allHidden] };
    ok('V6 ลูกค้าไม่เห็นไลน์ที่ไม่มีรูปปก / ไม่มีตัวที่ลูกค้าเห็นได้ · แอดมินเห็นครบ', shopLines(db, 'uA').map((l) => l.id).join() === 'L1' && shopLines(db, 'uAdm').length === 3);
    const L5 = L([M('a', ['open'])], { id: 'L5', maker_id: MK2, name: 'ไลน์โฮคาเงะ', franchise_id: 'f-nr' });
    db = { ...db, productLines: [line, L5] };
    ok('V7 กรองตามค่าย/เรื่อง/คำค้น', shopLines(db, 'uA', { makerId: MK2 }).map((l) => l.id).join() === 'L5'
      && shopLines(db, 'uA', { franchiseId: FR }).map((l) => l.id).join() === 'L1' && shopLines(db, 'uA', { query: 'โฮคาเงะ' }).map((l) => l.id).join() === 'L5'
      && shopLines(db, 'uA', { query: 'other' }).map((l) => l.id).join() === 'L5');
  }
  {
    const pre = P('pre', { status: 'arrived', character_name: 'Machi' });
    const twin = P('twin', { is_stock: true, stock_qty: 1, character_name: 'Machi' });
    const line = L([M('a', ['pre'])]);
    let db = base({ products: [pre, twin, P('lonely')], productLines: [line] });
    ok('V8 ลูกค้า + สวิตช์ปิด: หน้าสินค้าไม่มีปุ่ม "ดูทั้งไลน์"', linesOfProduct(db, 'uA', 'pre').length === 0);
    db = setLinesPublic(true)(db);
    ok('V9 เปิดแล้ว: ผูกตรง + ของคู่ (SKU พร้อมส่ง) เจอไลน์ · สินค้าที่ไม่อยู่ในไลน์ไม่เจอ',
      linesOfProduct(db, 'uA', 'pre').length === 1 && linesOfProduct(db, 'uA', 'twin').length === 1 && linesOfProduct(db, 'uA', 'lonely').length === 0);
  }

  // ── 8. หาของ: เติมฟอร์มจากลิงก์ ─────────────────────────────────────────────────────────────────
  {
    const pre = P('pre', { status: 'arrived', images: ['p1', 'p2', 'p3', 'p4'], franchise_id: 'f-op' });
    const line = L([M('a', []), M('b', ['pre']), M('c', [], { image_url: 'mine.jpg', manual_state: 'sourcing' })], { franchise_id: null });
    let db = base({ products: [pre, P('stranger', { images: ['s1'] })], productLines: [line] });
    db = setLinesPublic(true)(db);
    const fb = sourcingPrefill(db, 'uA', { line: 'L1', m: 'b', src: 'pre' });
    ok('Q1 จากไลน์: ค่ายจากไลน์ · เรื่องตกไปที่สินค้า · ชื่อตัว · รูปสินค้า ≤3 · อ้าง SKU · โน้ต "ตัวที่ 1" = เลขที่ลูกค้าเห็น (a ไม่มีสถานะ ไม่นับ)',
      !!fb && fb.makerId === MK && fb.frId === 'f-op' && fb.cname === 'b' && fb.images.join() === 'p1,p2,p3' && fb.srcId === 'pre' && fb.note === 'จากไลน์ กองโจรเงามายา · ตัวที่ 1', fb);
    const fc = sourcingPrefill(db, 'uA', { line: 'L1', m: 'c' });
    ok('Q2 ตัว Add เองมีรูป → ใช้รูปของตัวนั้น ไม่มี SKU · ตัวที่ 2 ตามที่ลูกค้าเห็น', !!fc && fc.images.join() === 'mine.jpg' && fc.srcId === undefined && !!fc.note?.endsWith('ตัวที่ 2'), fc);
    const fa = sourcingPrefill(db, 'uA', { line: 'L1', m: 'a' });
    ok('Q3 ไม่มีรูปเลย → ใช้รูปปกไลน์ (ต้องมีรูปอย่างน้อย 1)', !!fa && fa.images.join() === 'cover.jpg', fa);
    const mismatch = sourcingPrefill(db, 'uA', { line: 'L1', m: 'b', src: 'stranger' });
    ok('Q4 src ไม่ใช่สินค้าของตัวนั้น (ลิงก์ปน) → ไม่ใช้ ใช้สินค้าที่ผูกแทน', mismatch?.srcId === 'pre' && mismatch.images[0] === 'p1', mismatch);
    const hiddenDb = setLinesPublic(false)(db);
    const fallback = sourcingPrefill(hiddenDb, 'uA', { line: 'L1', m: 'b', src: 'pre' });
    ok('Q5 ไลน์ที่ลูกค้ามองไม่เห็น → ไม่ใช้ข้อมูลไลน์ ใช้แค่สินค้า (ไม่หลุดชื่อไลน์ในโน้ต)', !!fallback && fallback.note === undefined && fallback.srcId === 'pre', fallback);
    ok('Q6 ไม่มีอะไรตรง → null (ฟอร์มว่างตามปกติ)', sourcingPrefill(db, 'uA', { line: 'nope', m: 'x' }) === null && sourcingPrefill(db, 'uA', {}) === null);
  }

  // ── 9. เขียนแถว (null สำหรับช่องที่ล้าง) + mutation ───────────────────────────────────────────
  {
    const row = cleanLineRow({ ...L([M('a', ['x', 'x', ''], { pin_x: 120, pin_y: -5 }), M('b', [], { pin_x: 40 } as Partial<LineMember>)]), cover_url: undefined, franchise_id: '', note: undefined, name: 'กองโจร ' });
    ok('W1 ล้างรูปปก/เรื่อง/โน้ต → null (ไม่ใช่ undefined ที่หายตอน JSON แล้วค่าเก่าค้างใน DB)', row.cover_url === null && row.franchise_id === null && row.note === null && JSON.stringify(row).includes('"cover_url":null'));
    ok('W2 ชื่อไม่ถูก trim (พิมพ์เว้นวรรคได้)', row.name === 'กองโจร ');
    ok('W3 พิกัดถูกบีบเข้ากรอบ 0–100 · product_ids ไม่ซ้ำ ไม่มีค่าว่าง', row.members[0].pin_x === 100 && row.members[0].pin_y === 0 && row.members[0].product_ids.join() === 'x');
    ok('W4 พิกัดไม่ครบคู่ → ทิ้งทั้งคู่ (ไม่วางป้ายครึ่งๆ)', row.members[1].pin_x === undefined && row.members[1].pin_y === undefined);
    ok('W5 manual_state แปลกปลอม → ทิ้ง', cleanMember({ id: 'q', name: 'q', product_ids: [], manual_state: 'bogus' as never }).manual_state === undefined);
    let db = base();
    db = upsertProductLine(L([M('a', [])], { cover_url: 'c.jpg' }))(db);
    ok('W6 upsert ใส่ updated_at + เก็บแถวสะอาด', !!db.productLines[0].updated_at && db.productLines[0].cover_url === 'c.jpg');
    db = patchProductLine('L1', (l) => ({ ...l, cover_url: undefined }))(db);
    ok('W7 ลบรูปปกผ่าน patch → null', db.productLines[0].cover_url === null);
    const before = db;
    ok('W8 patch ไลน์ที่ไม่มีอยู่ / สมาชิกที่ไม่มี → ไม่แตะอะไรเลย (db ตัวเดิม)', patchProductLine('nope', (l) => l)(db) === before && patchLineMember('L1', 'nope', (m) => ({ ...m, name: 'z' }))(db).productLines[0].members[0].name === 'a');
    db = patchLineMember('L1', 'a', (m) => ({ ...m, pin_x: 33.333333, pin_y: 66.666666 }))(db);
    ok('W9 วางป้าย → ปัดทศนิยม 2 ตำแหน่ง', db.productLines[0].members[0].pin_x === 33.33 && db.productLines[0].members[0].pin_y === 66.67);
    db = removeProductLine('L1')(db);
    ok('W10 ลบไลน์', db.productLines.length === 0);
  }

  // ── 10. จัดวางป้าย ───────────────────────────────────────────────────────────────────────────
  {
    const pins = layoutPins([{ id: 'a', x: 30, y: 50 }, { id: 'b', x: 40, y: 50 }, { id: 'c', x: 45, y: 50 }, { id: 'd', x: 90, y: 50 }, { id: 'e', x: 5, y: 10 }]);
    const by = Object.fromEntries(pins.map((p) => [p.id, p]));
    ok('P1 ป้ายติดกัน 3 อัน (ฝั่งเดียวกัน) → 3 ชั้น สั้น/ยาว/ยาวสุด ไม่ทับกันเลย', by.a.stem === PIN_STEM_SHORT && by.b.stem === PIN_STEM_TALL && by.c.stem === PIN_STEMS[2], pins);
    // เคสจริง 2026-10-08: 5 หัวติดกันกลางรูป ชื่อเต็ม "Xxx Black Suite" (รูป 580px) → ต้องไม่มีคู่ไหนทับกันในชั้นเดียวกัน
    const five = layoutPins(['Feitan', 'Machi', 'Kuroro', 'Pakunoda', 'Shalnark'].map((n, i) => ({ id: n, x: 12 + i * 19, y: 42, w: pinLabelWidth(`${n} Black Suite`) })), 380, 580);
    const clash = five.some((a) => five.some((b) => a.id < b.id && a.stem === b.stem && Math.abs(a.x - b.x) / 100 * 580 < (pinLabelWidth(`${a.id} Black Suite`) + pinLabelWidth(`${b.id} Black Suite`)) / 2));
    ok('P1b 5 ป้ายชื่อยาวติดกัน → กระจาย 3 ชั้น ไม่มีคู่ไหนทับกัน', !clash, five);
    const flatRoom = layoutPins([{ id: 'a', x: 30, y: 30, w: 80 }, { id: 'b', x: 36, y: 30, w: 80 }, { id: 'c', x: 42, y: 30, w: 80 }], 300, 400);
    ok('P1c ชั้นที่ 3 ใช้ได้เฉพาะเมื่อมีที่พอเหนือหัว (รูปเตี้ย 30% ของ 300px = 90px → ไม่พอ 62+34) → ไม่เกินชั้น 2', flatRoom.every((p) => p.stem <= PIN_STEM_TALL), flatRoom);
    // Snap (เจ้าของ 2026-10-08): หัวสูงไล่เลี่ยกัน (ต่างไม่เกิน 36px) → ป้ายอยู่แถวเดียวกัน = เส้นของคนที่หัวต่ำกว่ายาวขึ้นเท่าส่วนต่าง
    const SH = 400, SW = 1000;
    const snap = layoutPins([{ id: 'a', x: 10, y: 40, w: 60 }, { id: 'b', x: 40, y: 45, w: 60 }, { id: 'c', x: 70, y: 70, w: 60 }], SH, SW);
    const sb = Object.fromEntries(snap.map((p) => [p.id, p]));
    const top = (p: PinPlacement) => (p.y / 100) * SH - p.stem; // ตำแหน่งขอบล่างป้าย (px) ฝั่งบน
    ok('P9 Snap: หัว 40% กับ 45% (ต่าง 20px) → ป้ายระดับเดียวกัน · หัว 70% ห่างเกิน → แถวของตัวเอง',
      Math.abs(top(sb.a) - top(sb.b)) < 1 && sb.a.stem === PIN_STEM_SHORT && sb.b.stem === PIN_STEM_SHORT + 20 && sb.c.stem === PIN_STEM_SHORT, snap);
    const noH = layoutPins([{ id: 'a', x: 10, y: 40 }, { id: 'b', x: 40, y: 45 }]);
    ok('P10 ไม่รู้ขนาดรูป → ไม่ snap (เส้นปกติ)', noH.every((p) => p.stem === PIN_STEM_SHORT));
    // เจ้าของ 2026-10-08 "ระดับไม่เท่ากัน": มือถือ 343px · 5 ป้าย "เปิดพรี" (68px) แถวเดียวไม่พอ → ย่อป้าย 16% แล้วพอดีแถวเดียว ไม่สลับชั้น
    // ขนาดจริงที่วัดในเบราว์เซอร์ (รูป 341×227 · หัว y ไม่เท่ากัน) และจอเล็กกว่านั้นอีกหน่อย (320px)
    const realY = [46, 41, 39, 41, 40];
    for (const [W, H] of [[343, 229], [341, 227]] as const) {
      const phone = layoutPins([11, 29.5, 50, 68.5, 87].map((x, i) => ({ id: `m${i}`, x, y: realY[i], w: pinLabelWidth('เปิดพรี') })), H, W);
      ok(`P11 มือถือ ${W}px: 5 ป้าย 'เปิดพรี' แถวเดียวไม่พอ → ย่อป้ายแล้วจัดแถวเดียว ทุกป้ายชั้น 0`, phone.every((p) => p.dense && p.tier === 0), phone.map((p) => `${p.id}:t${p.tier}${p.dense ? 'D' : ''}dx${p.dx}`));
    }
    // จอเล็กมาก (iPhone SE 320px → รูป 304px): ย่อแล้วก็ยังไม่พอ → สลับชั้นเป็นระเบียบ 0/1/0/1/0 ขนาดปกติ (ไม่ย่อครึ่งๆ กลางๆ)
    const se = layoutPins([11, 29.5, 50, 68.5, 87].map((x, i) => ({ id: `m${i}`, x, y: realY[i], w: pinLabelWidth('เปิดพรี') })), 203, 304);
    ok('P11b จอ 304px: ย่อแล้วขยับซ้ายขวาเล็กน้อย → ยังแถวเดียว (dx ไม่เป็น 0 บางอัน · หางยังอยู่ในป้าย)', se.every((p) => p.dense && p.tier === 0) && se.some((p) => p.dx !== 0) && se.every((p) => Math.abs(p.dx) <= pinLabelWidth('เปิดพรี') * 0.8 / 2 - 10), se.map((p) => `${p.id}:t${p.tier}${p.dense ? 'D' : ''}dx${p.dx}`));
    // ป้ายจริงตอนนี้ = 'Pre-Order' (96px): มือถือ 343 → 5 ป้ายรวม 480 แม้ย่อ (384) ก็เกิน 335 → สลับชั้น (คนละแถวแต่ระดับคงที่) · จอ 580 → แถวเดียว
    const po343 = layoutPins([11, 29.5, 50, 68.5, 87].map((x, i) => ({ id: `m${i}`, x, y: realY[i], w: pinLabelWidth('Pre-Order') })), 229, 343);
    const po580 = layoutPins([11, 29.5, 50, 68.5, 87].map((x, i) => ({ id: `m${i}`, x, y: realY[i], w: pinLabelWidth('Pre-Order') })), 387, 580);
    ok('P11c Pre-Order ×5 ไม่มีคำย่อ: มือถือ 343 → สลับชั้น 0/1/0/1/0 · จอ 580 แถวเดียว', po343.map((p) => p.tier).join() === '0,1,0,1,0' && po580.every((p) => p.tier === 0 && !p.dense), { po343: po343.map((p) => p.tier), po580: po580.map((p) => p.tier) });
    // เจ้าของ 2026-10-08 "เหมือนเดิม" → มีคำย่อ (PRE): มือถือ 343 ใช้คำย่อ แถวเดียว ขนาดปกติ · จอ 580 ยังคำเต็ม
    const sh343 = layoutPins([11, 29.5, 50, 68.5, 87].map((x, i) => ({ id: `m${i}`, x, y: realY[i], w: pinLabelWidth('Pre-Order'), ws: pinLabelWidth('PRE') })), 229, 343);
    const sh580 = layoutPins([11, 29.5, 50, 68.5, 87].map((x, i) => ({ id: `m${i}`, x, y: realY[i], w: pinLabelWidth('Pre-Order'), ws: pinLabelWidth('PRE') })), 387, 580);
    ok('P11d Pre-Order ×5 มีคำย่อ PRE: มือถือ 343 → แถวเดียว คำย่อ ขนาดปกติ · จอ 580 → คำเต็ม', sh343.every((p) => p.tier === 0 && p.short === true && !p.dense) && sh580.every((p) => p.tier === 0 && !p.short), { sh343: sh343.map((p) => `t${p.tier}${p.short ? 'S' : ''}`), sh580: sh580.map((p) => `t${p.tier}${p.short ? 'S' : ''}`) });
    const wide = layoutPins([11, 29.5, 50, 68.5, 87].map((x, i) => ({ id: `m${i}`, x, y: 42, w: pinLabelWidth('เปิดพรี') })), 380, 580);
    ok('P12 จอกว้างพอ → ไม่ย่อ (ป้ายขนาดปกติ แถวเดียว)', wide.every((p) => !p.dense && p.tier === 0), wide);
    const tight = layoutPins([10, 22, 34, 46, 58].map((x, i) => ({ id: `m${i}`, x, y: 42, w: pinLabelWidth('Pakunoda Black Suite') })), 229, 343);
    ok('P13 ย่อแล้วยังไม่พอ (ชื่อยาว 5 อันในครึ่งรูป) → กลับไปสลับชั้นแบบเดิม ไม่ย่อ', tight.every((p) => !p.dense) && tight.some((p) => p.tier > 0), tight);
    ok('P2 ห่างกัน → เส้นสั้นปกติ · ชิดขอบขวา/ซ้ายไม่ล้นรูป · ใกล้ขอบบนกลับหัวลงล่าง', by.d.stem === PIN_STEM_SHORT && by.d.align === 'right' && by.e.align === 'left' && by.e.below === true && by.a.below === false);
    ok('P3 ≤6 ป้าย = โหมดเต็ม · 7 ป้าย = โหมดย่อ (เลขอย่างเดียว)', !pins[0].compact && layoutPins(Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, x: i * 14, y: 50 }))).every((p) => p.compact));
    const flat = layoutPins([{ id: 'q', x: 50, y: 40 }], 120);  // รูปเตี้ย 120px: 40% = 48px ไม่พอเส้นยาว+ป้าย
    const tall = layoutPins([{ id: 'q', x: 50, y: 40 }], 600);
    ok('P4 รูปเตี้ย: จุดที่ 40% ไม่มีที่พอข้างบน → ป้ายลงล่าง (ไม่ถูกตัดหัว) · รูปสูงไม่ต้องกลับ', flat[0].below && !tall[0].below, { flat, tall });
    // เคสจริงจากเทสต์ในเบราว์เซอร์ 2026-10-07: "Luffy Gear 5" (ชิดซ้าย) กับ "Zoro" ห่างกัน ~20% บนรูปกว้าง 520px → ทับกัน
    const W = 520, H = 300;
    const real = layoutPins([{ id: '1', x: 8, y: 45, w: pinLabelWidth('Luffy Gear 5') }, { id: '2', x: 28, y: 45, w: pinLabelWidth('Zoro') }, { id: '3', x: 68, y: 45, w: pinLabelWidth('Pakunoda') }], H, W);
    const rb = Object.fromEntries(real.map((p) => [p.id, p]));
    ok('P5 ป้ายชื่อยาวที่ทับกัน (คิดเป็นพิกเซล) → ยังแถวเดียว: ป้าย 1 ชิดขอบซ้ายถูกดันขวา · ป้าย 2 ถูกดันต่อ · ป้าย 3 ห่างพอ dx=0', real.every((p) => p.tier === 0) && rb['1'].dx > 0 && rb['2'].dx > 0 && rb['3'].dx === 0, real.map((p) => `${p.id}:dx${p.dx}`));
    const edgeR = layoutPins([{ id: 'r', x: 95, y: 50, w: 120 }], H, W)[0]; const edgeL = layoutPins([{ id: 'l', x: 5, y: 50, w: 120 }], H, W)[0];
    ok('P6 ป้ายล้นขอบรูป → ถูกดันเข้าใน (ขวา dx<0 · ซ้าย dx>0) หางยังอยู่ในป้าย', edgeR.dx < 0 && edgeR.dx >= -50 && edgeL.dx > 0 && edgeL.dx <= 50, { edgeR, edgeL });
    const apart = layoutPins([{ id: 'a', x: 20, y: 50, w: pinLabelWidth('Feitan') }, { id: 'b', x: 45, y: 50, w: pinLabelWidth('Machi') }], H, 1000);
    ok('P7 รูปกว้าง (เดสก์ท็อป) ชื่อสั้นห่าง 25% → ไม่ชน เส้นสั้น ไม่ต้องขยับ', apart.every((p) => p.stem === PIN_STEM_SHORT && p.dx === 0), apart);
    ok('P8 ความกว้างป้ายไทยไม่นับสระบน/ล่าง/วรรณยุกต์ · "เปิดพรี" ≥ 70px ที่วัดจริง', pinLabelWidth('ปิดพรีแล้ว') < pinLabelWidth('abcdefghij') && pinLabelWidth('ปิดพรีแล้ว') === 38 + 7 * 6.4 && pinLabelWidth('เปิดพรี') >= 70); // 10 ตัวอักษร − สระอิ/อี/ไม้โท 3 ตัว = 7 ที่กินที่
  }

  // ── 11. ของที่ต้องถามเลขจริงจาก server + ตัวนับ ─────────────────────────────────────────────────
  {
    let db = base({ products: [P('pre', { status: 'production', character_name: 'K' }), P('twin', { is_stock: true, stock_qty: 1, character_name: 'K' }), P('open')] });
    db = reopenBatch('pre', { price: 1, deposit: 1, qty: 1 })(db);
    db = { ...db, batches: [...db.batches, { ...db.batches[0], id: 'draftB', published: false }] };
    const line = L([M('a', ['pre']), M('b', ['pre', 'twin'])]);
    const targets = liveTargetsForLine(db, line).map((t) => `${t.productId}|${t.batchId ?? ''}`).sort();
    ok('L1 ถามเฉพาะของจำกัดจำนวน (ของในมือ + รอบพิเศษที่เปิดขาย) ไม่ซ้ำ · ไม่ถามรอบร่าง', targets.join() === [`pre|${db.batches[0].id}`, 'twin|'].sort().join(), targets);
    const states = lineStates(db, L([M('a', ['open']), M('b', ['twin']), M('c', [], { manual_state: 'sourcing' }), M('d', [])]), { uid: 'uA' });
    const c = lineToneCounts(states);
    ok('L2 ตัวนับตามสี นับเฉพาะตัวที่ลูกค้าเห็น', c.blue === 1 && c.green === 1 && c.amber === 1 && c.purple === 0 && states[3].state.visible === false, c);
    ok('L3 เลขลำดับ = ตำแหน่งใน members (1,2,3…)', states.map((s) => s.no).join() === '1,2,3,4');
    // ยุบไลน์ในช็อป (เจ้าของ 2026-10-08): ตัวที่อยู่ในไลน์ที่ลูกค้าเห็น (ผูกตรง + ของคู่) หายจากกริด ทั้งหมด · สวิตช์ปิด = ไม่ยุบ
    const col = L([M('a', ['pre'])]);
    let cdb = base({ products: [P('pre', { status: 'production', character_name: 'K' }), P('twin', { is_stock: true, stock_qty: 1, character_name: 'K' }), P('open')], productLines: [col] });
    ok('L4 สวิตช์ปิด: ลูกค้าไม่ยุบอะไร · แอดมินยุบ (เห็นไลน์อยู่แล้ว)', productsInVisibleLines(cdb, 'uA').size === 0 && [...productsInVisibleLines(cdb, 'uAdm')].sort().join() === 'pre,twin');
    cdb = setLinesPublic(true)(cdb);
    ok('L5 สวิตช์เปิด: ลูกค้ายุบ pre+ของคู่ twin · open ไม่อยู่ในไลน์ยังอยู่', [...productsInVisibleLines(cdb, 'uA')].sort().join() === 'pre,twin' && !productsInVisibleLines(cdb, 'uA').has('open'));
  }

  // ── 12. แก้ตามผลตรวจของ reviewer 2 ชุด (2026-10-07) ──────────────────────────────────────────
  {
    // R1: ลบรูปปก/ไม่มีตัวที่เห็นได้ → ลูกค้าเข้าไม่ได้ทุกทาง (เดิมกันแค่แถบช็อป · ชิปหน้าสินค้า/ลิงก์ตรงหลุด)
    const noCover = L([M('a', ['pre'])], { cover_url: null });
    let db = setLinesPublic(true)(base({ products: [P('pre', { status: 'production' })], productLines: [noCover] }));
    ok('R1 ไลน์ active แต่ไม่มีรูปหมู่ → ลูกค้าไม่เห็นทุกทาง (หน้า/ชิปหน้าสินค้า/เติมฟอร์ม) · แอดมินยังเห็น',
      !lineVisibleTo(db, 'uA', noCover) && !lineOpenToCustomers(db, noCover) && linesOfProduct(db, 'uA', 'pre').length === 0
      && sourcingPrefill(db, 'uA', { line: 'L1', m: 'a' }) === null && lineVisibleTo(db, 'uAdm', noCover));
    const allHidden = L([M('a', ['gone-product'])]);
    db = { ...db, productLines: [allHidden] };
    ok('R2 ไลน์ที่ทุกตัวยังไม่ตั้งสถานะ (ลูกค้าไม่เห็นสักตัว) → ลูกค้าเข้าหน้าไลน์ไม่ได้', !lineVisibleTo(db, 'uA', allHidden));
    // R3: ผูก SKU พร้อมส่งไว้ แต่ตัวที่ขายจริงเป็น SKU พร้อมส่งชื่อซ้ำ (ฟอร์มทีละตัวไม่รวมสต๊อก)
    const s1 = P('s1', { is_stock: true, stock_qty: 0, character_name: 'Chrollo' });
    const s2 = P('s2', { is_stock: true, stock_qty: 2, character_name: 'Chrollo' });
    const st3 = st(base({ products: [s1, s2] }), [M('a', ['s1'])], 'a');
    ok('R3 ผูก SKU พร้อมส่งที่หมดแล้ว แต่มี SKU พร้อมส่งชื่อเดียวกันขายอยู่ → พร้อมส่ง (ไม่ใช่หาของ)', st3.kind === 'stock' && st3.product?.id === 's2', st3);
    // R4: ตัวนับ "เปิดพรี" บนการ์ดไม่ขึ้นกับสต๊อก
    const pre = P('pre', { character_name: 'Machi' });
    const twin = P('twin', { is_stock: true, stock_qty: 1, character_name: 'Machi' });
    const db4 = base({ products: [pre, twin] });
    ok('R4 ตัวที่เปิดพรีอยู่ + มีของคู่พร้อมส่ง: ป้ายขึ้นพร้อมส่ง แต่การ์ดนับเป็น "เปิดพรี" ได้ (ไม่ผูกกับสต๊อก local)',
      st(db4, [M('a', ['pre'])], 'a').kind === 'stock' && memberOpenForPreorder(db4, M('a', ['pre']))
      && memberOpenForPreorder(db4, M('b', [], { manual_state: 'preorder' })) && !memberOpenForPreorder(db4, M('c', [], { manual_state: 'stock' })));
    // R5: ไม่ถามเลขสดของที่ติดประมูล (ไม่มีวันขึ้นป้ายซื้อได้)
    const auc = base({ products: [P('auc', { is_stock: true, stock_qty: 1 }), P('ok', { is_stock: true, stock_qty: 1 })], auctions: [{ id: 'a1', product_id: 'auc', status: 'live' } as Database['auctions'][number]] });
    ok('R5 รายการถามเลขสดข้ามของที่ติดประมูล', liveTargetsForLine(auc, L([M('a', ['auc']), M('b', ['ok'])])).map((t) => t.productId).join() === 'ok');
    // R6: ไลน์ไม่ระบุเรื่อง + ตัว Add เอง (ไม่มีสินค้า) → ไม่รู้เรื่อง (ฟอร์มต้องให้ลูกค้าเลือกเอง ไม่ปล่อยค่าเริ่มต้น)
    const noFr = L([M('a', [], { manual_state: 'sourcing' })], { franchise_id: null });
    const db6 = setLinesPublic(true)(base({ productLines: [noFr] }));
    const pf6 = sourcingPrefill(db6, 'uA', { line: 'L1', m: 'a' });
    ok('R6 เรื่องไม่รู้ → frId ว่าง (หน้าฟอร์มตั้งเป็น "อื่นๆ" ให้เลือกเอง) · ค่ายมาจากไลน์', !!pf6 && pf6.frId === undefined && pf6.makerId === MK, pf6);
  }
  // ── 13. ด่านสั่งซื้อพรีในกระดานที่ปิดแล้ว (reviewer ชุดข้อมูล · บั๊กเดิมของร้านที่ไลน์พาไปเจอ) ──────────────
  {
    const boards = [{ id: 'b-open', maker_id: MK, title: 'x', status: 'open', created_at: '' }, { id: 'b-closed', maker_id: MK, title: 'y', status: 'closed', created_at: '' }] as Database['boards'];
    const open = P('ob', { board_id: 'b-open' });
    const closed = P('cb', { board_id: 'b-closed' });
    const db = base({ products: [open, closed], boards });
    ok('G1 preorderOpenForOrder: กระดานเปิด = สั่งได้ · กระดานปิดแล้ว (status ยัง open) = สั่งไม่ได้ · ของพร้อมส่ง = ไม่ใช่พรี',
      preorderOpenForOrder(db, open) && !preorderOpenForOrder(db, closed) && !preorderOpenForOrder(db, P('x', { is_stock: true })) && !preorderOpenForOrder(db, P('y', { status: 'production' })));
    const line = (p: Product) => [{ productId: p.id, qty: 1, depositEach: p.deposit_amount, priceEach: p.price_total }];
    const okOrder = submitOrder('uA', line(open), 'slip.jpg')(db);
    const badOrder = submitOrder('uA', line(closed), 'slip.jpg')(db);
    ok('G2 submitOrder: พรีในกระดานที่เปิดอยู่ = ออเดอร์เกิด · กระดานที่ปิดแล้ว = ปัดตก (db เดิม ไม่มีออเดอร์)',
      okOrder.orders.length === db.orders.length + 1 && badOrder === db && badOrder.orders.length === db.orders.length, { ok: okOrder.orders.length, bad: badOrder.orders.length });
    const s = st(db, [M('a', ['cb'])], 'a');
    ok('G3 ไลน์: ตัวที่อยู่ในกระดานที่ปิดแล้ว = ปิดพรีแล้ว · รอสั่งผลิต (ไม่ใช่เปิดพรี)', s.kind === 'closed' && s.detail.includes('รอสั่งผลิต'), s);
  }

  // ── 14. หน้าแรก: 3 ไลน์ล่าสุด (เจ้าของ 2026-10-08) + แท็บปิดพรี ───────────────────────────────────────
  {
    const mk = (id: string, daysAgo: number, over: Partial<ProductLine> = {}) =>
      L([M('m', [], { manual_state: 'sourcing' })], { id, created_at: new Date(now - daysAgo * 86_400_000).toISOString(), ...over });
    let db = base({ productLines: [mk('old', 40), mk('new', 1), mk('mid', 10), mk('draft', 0, { active: false }), mk('mid2', 20)] });
    ok('H1 สวิตช์ปิด: หน้าแรกลูกค้าไม่มีไลน์ · แอดมินเห็น (แต่ก็แค่ 3 ตามเพดานหน้าแรก)', homeLines(db, 'uA').length === 0 && homeLines(db, 'uAdm').length === 3);
    db = setLinesPublic(true)(db);
    ok('H2 เปิดแล้ว: ลูกค้าได้ 3 ไลน์ล่าสุด (ใหม่สุดก่อน · ร่างไม่นับ)', homeLines(db, 'uA').map((l) => l.id).join() === 'new,mid,mid2');
    ok('H3 ป้าย "ใหม่" = สร้างใน 7 วัน', isNewLine(mk('x', 1), now) && !isNewLine(mk('y', 8), now));
    const boards = base({ boards: [
      { id: 'b1', maker_id: MK, title: 'a', poster_url: 'p.jpg', status: 'open', created_at: '' },
      { id: 'b2', maker_id: MK, title: 'b', status: 'open', created_at: '' },
      { id: 'b3', maker_id: MK, title: 'c', poster_url: 'p.jpg', status: 'closed', created_at: '' },
    ] as Database['boards'] });
    ok('H4 openBoards: เฉพาะกระดานเปิดที่มีโปสเตอร์ (แท็บ "ปิดพรี" + แถบหน้าแรกใช้ชุดเดียวกัน)', openBoards(boards).map((b) => b.id).join() === 'b1');
  }

  // ── 15. ลงสินค้าพรีใหม่ "จากในไลน์" (เจ้าของ 2026-10-08: ทำไลน์ + แอดสินค้าเข้าระบบในขั้นเดียว) ───────────────
  {
    const NP = (id: string, over: Partial<Product> = {}) => P(id, { character_name: `C-${id}`, series_name: `C-${id} - Vol.1`, type: 'other', ...over });
    const line = L([M('custom', [], { manual_state: 'sourcing', pin_x: 40, pin_y: 30, image_url: 'm.jpg' }), M('b', ['pb'])]);
    const db = setLinesPublic(true)(base({ products: [P('pb')], productLines: [line] }));
    const r1 = createProductsIntoLine('L1', [{ product: NP('n1') }, { product: NP('n2'), memberId: 'custom' }])(db);
    const l1 = r1.productLines[0];
    ok('I1 ตัวใหม่: สินค้าเข้าระบบ (หน้าสุด) + ต่อท้ายเป็นตัวในไลน์ ชื่อ = ชื่อตัวละคร · product_ids = [id]',
      r1.products[0].id === 'n1' && r1.products.some((p) => p.id === 'n2') && l1.members.length === 3 && l1.members[2].name === 'C-n1' && l1.members[2].product_ids.join() === 'n1', l1.members);
    const cm = l1.members[0];
    ok('I2 ผูกกับตัวที่ Add ไว้: ป้าย/รูปอยู่ที่เดิม · manual_state ถูกล้าง (ไม่มีคีย์ค้าง) · product_ids = [n2]',
      cm.pin_x === 40 && cm.pin_y === 30 && cm.image_url === 'm.jpg' && !('manual_state' in cm) && cm.product_ids.join() === 'n2', cm);
    const s2 = lineMemberState(r1, l1, cm, { uid: 'uA' });
    ok('I3 ตัวที่ผูกแล้วอ่านสถานะจากสินค้า: เปิดพรี → ป้าย Pre-Order (ไม่ใช่ "หาของ" ที่ตั้งเองไว้)', s2.kind === 'preorder' && s2.pinLabel === 'Pre-Order' && s2.visible, s2);
    const inLines = productsInVisibleLines(r1, 'uA');
    ok('I4 updated_at ถูกตั้ง · ไลน์ยังเปิดให้ลูกค้า · สินค้าใหม่ถูกยุบเข้าไลน์ในช็อป', !!l1.updated_at && lineOpenToCustomers(r1, l1) && inLines.has('n1') && inLines.has('n2'));
    const r2 = createProductsIntoLine('L1', [{ product: NP('n3'), memberId: 'ghost' }])(db);
    ok('I5 memberId ที่ไม่มีแล้ว → เพิ่มเป็นตัวใหม่ (สินค้าไม่หลุดจากไลน์)',
      r2.productLines[0].members.length === 3 && r2.productLines[0].members[2].product_ids.join() === 'n3' && r2.products[0].id === 'n3');
    ok('I6 ไม่เจอไลน์ = db เดิมเป๊ะ (ไม่ปล่อยสินค้าเกิดลอยๆ นอกไลน์)', createProductsIntoLine('nope', [{ product: NP('n4') }])(db) === db);
    const r4 = createProductsIntoLine('L1', [{ product: NP('pb', { price_total: 1 }) }, { product: NP('n5') }, { product: NP('n5', { price_total: 1 }) }])(db);
    ok('I7 id ซ้ำ (กับในระบบ / ในชุดเดียวกัน) ถูกข้าม: ของเก่าไม่ถูกทับ · n5 เข้าครั้งเดียว · ไม่มีตัวซ้ำ',
      r4.products.find((p) => p.id === 'pb')!.price_total === 2000 && r4.products.filter((p) => p.id === 'n5').length === 1 && r4.products.find((p) => p.id === 'n5')!.price_total === 2000
      && r4.productLines[0].members.filter((m) => m.product_ids.includes('n5')).length === 1 && r4.productLines[0].members.length === 3, r4.productLines[0].members);
    const noFr = base({ productLines: [L([], { franchise_id: null })] });
    ok('I8 ไลน์ยังไม่ระบุเรื่อง → ตั้งเป็นเรื่องของสินค้าตัวแรก', createProductsIntoLine('L1', [{ product: NP('n6', { franchise_id: 'f-other' }) }])(noFr).productLines[0].franchise_id === 'f-other');
    ok('I9 ไลน์ที่มีเรื่องอยู่แล้ว → เรื่องเดิมคงอยู่', createProductsIntoLine('L1', [{ product: NP('n7', { franchise_id: 'f-other' }) }])(db).productLines[0].franchise_id === FR);
    const row = cleanLineRow(l1);
    ok('I10 แถวที่เขียนลง DB: ตัวใหม่มีแค่ id/name/product_ids · ตัวที่ผูกไม่มี manual_state ค้าง',
      Object.keys(row.members[2]).sort().join() === 'id,name,product_ids' && !('manual_state' in row.members[0]), row.members);
    ok('I11 entries ว่าง = db เดิม', createProductsIntoLine('L1', [])(db) === db);
    ok('I12 ติ๊กจากในระบบเห็นว่าผูกแล้ว: memberProducts ของตัวใหม่ = สินค้าที่เพิ่งลง', memberProducts(r1, l1.members[2]).linked.map((p) => p.id).join() === 'n1');
    // ชุดเดียวกันหลายตัว ผูกตัว Add ไว้ 2 ตัว + ตัวใหม่ 1 → ลำดับเดิมไม่สลับ ตัวใหม่ต่อท้าย
    const two = setLinesPublic(true)(base({ productLines: [L([M('x', [], { manual_state: 'preorder', pin_x: 10, pin_y: 10 }), M('y', [], { manual_state: 'sourcing' })])] }));
    const r5 = createProductsIntoLine('L1', [{ product: NP('a1'), memberId: 'y' }, { product: NP('a2') }, { product: NP('a3'), memberId: 'x' }])(two);
    const ms = r5.productLines[0].members;
    ok('I13 หลายตัวในชุดเดียว: ลำดับตัวเดิมคงที่ (x,y) · ตัวใหม่ต่อท้าย · ผูกถูกตัว', ms.map((m) => `${m.id}:${m.product_ids.join('+')}`).join() === 'x:a3,y:a1' + `,${ms[2].id}:a2` && ms[2].name === 'C-a2', ms);
    const dark = setLinesPublic(true)(base({ productLines: [L([M('z', [])])] })); // ตัวเดียว ยังไม่ตั้งสถานะ = ลูกค้าไม่เห็นตัว → ไลน์ยังไม่นับว่าเปิด
    const lit = createProductsIntoLine('L1', [{ product: NP('b1'), memberId: 'z' }])(dark);
    // หลายแบบ (variants) จากในไลน์ (เจ้าของ 2026-10-12): ราคาต่อแบบ · มัดจำของสินค้าใช้ทุกแบบ · แบบชื่อว่างถูกทิ้ง
    const rv = createProductsIntoLine('L1', [{ product: NP('v1', { has_variants: true, price_total: 1500, deposit_amount: 300 }), variants: [{ name: 'แดง', price_total: 1500, image_url: 'r.jpg' }, { name: 'น้ำเงิน', price_total: 1700 }, { name: ' ', price_total: 1 }] }])(db);
    const vs = rv.variants.filter((v) => v.product_id === 'v1');
    ok('I15 variants: สร้าง 2 แบบ (ชื่อว่างทิ้ง) · ราคาต่อแบบ · มัดจำ = ของสินค้า · รูปแบบติดมา',
      vs.length === 2 && vs.every((v) => v.deposit_amount === 300) && vs.map((v) => v.price_total).sort().join() === '1500,1700' && vs.find((v) => v.name === 'แดง')?.image_url === 'r.jpg' && rv.productLines[0].members.some((m) => m.product_ids.includes('v1')), vs);
    ok('I16 ไม่มี variants → ตาราง variants ไม่ถูกแตะ (อ้างอิงเดิม)', r1.variants === db.variants);
    ok('I14 ไลน์ที่ยังไม่มีตัวที่มองเห็น → หลังลงสินค้า "เปิดให้ลูกค้า" ทันที (push ต้องตัดสินจากสภาพหลังเซฟ ไม่ใช่ตอนวาดหน้า)',
      !lineOpenToCustomers(dark, dark.productLines[0]) && lineOpenToCustomers(lit, lit.productLines[0]));
  }

  // ── 16. พรีทั้งเซต / x/y ตัว (เจ้าของ 2026-10-16 รอบ 1) ───────────────────────────────────────────
  {
    const db = setLinesPublic(true)(base({
      products: [P('a'), P('b'), P('c', { has_variants: true }), P('d', { status: 'production' })],
      tickets: [T('t1', 'a', 'uA')],
    }));
    const line = L([M('ma', ['a']), M('mb', ['b']), M('mc', ['c']), M('md', ['d']), M('me', [], { manual_state: 'sourcing' })]);
    const shown = lineStates(db, line, { uid: 'uA' }).filter((s) => s.state.visible);
    const plan = lineSetPlan(shown, (pid) => pid === 'b');
    ok('U1 นับ: ตัวที่ Add เอง (e) ไม่นับ → พรีแล้ว 1/4 · ยังขาด 3 · b อยู่ในตะกร้า (inCart) · c มีแบบ = ต้องกดที่แถว · d ปิดพรีแล้ว ไม่ต้องบอกให้กด',
      plan.mine === 1 && plan.total === 4 && plan.missing.length === 3 && plan.addable.length === 0 && plan.inCart === 1 && plan.rowOnly.join() === 'mc' && plan.missingDeposit === 2000, plan);
    const plan2 = lineSetPlan(shown, () => false);
    ok('U2 ตะกร้าว่าง: ใส่ได้ 1 (b) · มัดจำรวม = ของ b', plan2.addable.map((a) => a.product.id).join() === 'b' && plan2.deposit === 1000, plan2);
    const none = lineSetPlan(lineStates(db, line, { uid: 'uB' }).filter((s) => s.state.visible), () => false);
    ok('U3 คนที่ยังไม่พรีเลย: mine 0 · ใส่ได้ a+b · มัดจำ 2000', none.mine === 0 && none.addable.map((a) => a.product.id).join() === 'a,b' && none.deposit === 2000, none);
    const full = lineSetPlan(lineStates(setLinesPublic(true)(base({ products: [P('a'), P('b')], tickets: [T('t1', 'a', 'uA'), T('t2', 'b', 'uA')] })), L([M('ma', ['a']), M('mb', ['b'])]), { uid: 'uA' }), () => false);
    const half = lineSetPlan(lineStates(db, line, { uid: 'uB' }).filter((s) => s.state.visible), () => false, (p) => p.deposit_amount / 2);
    ok('U5 มัดจำตามยศ: ปุ่ม (a+b) และการ์ด (a+b+c ที่ยังพรีกระดานหลักได้ · d ปิดแล้วไม่นับ) ใช้ depositOf ที่ส่งมา', half.deposit === 1000 && half.missingDeposit === 1500, half);
    const manualOnly = lineSetPlan(lineStates(setLinesPublic(true)(base({ products: [P('a'), P('b')], tickets: [T('t1', 'a', 'uA'), T('t2', 'b', 'uA')] })), L([M('ma', ['a']), M('mb', ['b']), M('mx', [], { manual_state: 'sourcing' })]), { uid: 'uA' }), () => false);
    ok('U6 มีตัว Add เอง (ไม่มีสินค้า) ในไลน์ → ยังครบเซตได้ (2/2) ไม่ติดตัวที่ติดตามไม่ได้', manualOnly.total === 2 && manualOnly.mine === 2 && manualOnly.missing.length === 0, manualOnly);
    ok('U4 ครบเซต: mine = total · ไม่มีอะไรให้ใส่', full.mine === 2 && full.total === 2 && full.missing.length === 0 && full.addable.length === 0);
  }

  // ── 17. แอดมินรอบ 1 (เจ้าของ 2026-10-16): กันลงซ้ำ · เช็กลิสต์เปิดไลน์ · วางป้ายอัตโนมัติ ─────────────────
  {
    const db = base({ products: [
      P('r1', { character_name: 'Ringo', series_name: 'Ringo - 7 SwordMaster' }),
      P('r-stock', { character_name: 'Ringo', series_name: 'Ringo - 7 SwordMaster', is_stock: true }),
      P('r-other', { character_name: 'Ringo', manufacturer_id: MK2 }),
      P('legacy', { character_name: undefined, series_name: 'Kuriare - 7 SwordMaster' }),
    ] });
    const ids = (q: { name: string; is_stock?: boolean; mk?: string }, ex?: string) => findDuplicateProducts(db, { manufacturer_id: q.mk ?? MK, name: q.name, is_stock: !!q.is_stock }, ex).map((p) => p.id).join();
    ok('D1 ค่ายเดียวกัน + ชื่อเดียวกัน + พรีทั้งคู่ = ซ้ำ · ไม่สนตัวพิมพ์/ช่องว่าง', ids({ name: 'Ringo' }) === 'r1' && ids({ name: '  rINGO ' }) === 'r1' && ids({ name: 'Ringo  ' }) === 'r1');
    ok('D2 พรีกับพร้อมส่งชื่อเดียวกัน = ของคู่ ไม่ซ้ำ · พร้อมส่งเทียบกับพร้อมส่ง', ids({ name: 'Ringo', is_stock: true }) === 'r-stock');
    ok('D3 ค่ายอื่นชื่อเดียวกันไม่ซ้ำ · ตัดตัวเองออกตอนแก้ · ชื่อว่าง = ไม่มีอะไรซ้ำ', ids({ name: 'Ringo', mk: MK2 }) === 'r-other' && ids({ name: 'Ringo' }, 'r1') === '' && ids({ name: '   ' }) === '');
    ok('D4 สินค้าเก่าไม่มี character_name → เทียบส่วนหน้าของ "ตัวละคร - ซีรีย์"', ids({ name: 'kuriare' }) === 'legacy');
    ok('D5 ค่ายว่าง = ไม่เทียบ (กันจับมั่วตอนฟอร์มยังไม่เลือกค่าย)', findDuplicateProducts(db, { manufacturer_id: '', name: 'Ringo', is_stock: false }).length === 0);
  }
  {
    const pdb = base({ products: [P('a'), P('b')] });
    const chk = (members: LineMember[], over: Partial<ProductLine> = {}, d: Database = pdb) => lineChecklist(d, L(members, over));
    const noCover = chk([M('a', ['a'])], { cover_url: null });
    ok('C1 ไม่มีรูปหมู่ → ยังเปิดไม่ได้ · ข้อแรกที่ติด = รูปหมู่', !noCover.ready && noCover.firstProblem === 'cover', noCover);
    const noName = chk([M('a', ['a'])], { name: '  ' });
    ok('C2 ชื่อไลน์ว่าง → ติดข้อชื่อก่อน', !noName.ready && noName.firstProblem === 'info');
    const hidden = chk([M('x', []), M('y', [])]);
    ok('C3 มีตัวแต่ลูกค้าไม่เห็นสักตัว (ไม่ผูกสินค้า ไม่ตั้งสถานะ) → ติดข้อตัวในไลน์ · hiddenN = 2', !hidden.ready && hidden.firstProblem === 'members' && hidden.hiddenN === 2 && hidden.visible.length === 0, hidden);
    const pins = chk([M('a', ['a'], { pin_x: 10, pin_y: 20 }), M('b', ['b']), M('z', [])]);
    ok('C4 ครบข้อบังคับแต่ป้ายไม่ครบ → เปิดได้ (ready) · ป้ายนับเฉพาะตัวที่ลูกค้าเห็น 1/2 · ตัวไม่มีสถานะไม่นับ',
      pins.ready && !pins.items.find((i) => i.key === 'pins')!.ok && pins.pinned === 1 && pins.visible.length === 2 && pins.pinsMissing.map((m) => m.id).join() === 'b' && pins.hiddenN === 1, pins);
    const full = chk([M('a', ['a'], { pin_x: 10, pin_y: 20 }), M('b', ['b'], { pin_x: 60, pin_y: 20 })]);
    ok('C5 ครบทุกข้อ → okCount = 4/4 · สวิตช์ระบบปิด = ยังไม่ live', full.ready && full.okCount === 4 && full.items.length === 4 && !full.live, full);
    const on = chk([M('a', ['a'])], {}, setLinesPublic(true)(pdb));
    const draft = chk([M('a', ['a'])], { active: false }, setLinesPublic(true)(pdb));
    ok('C6 live = กติกาเดียวกับ lineOpenToCustomers (ระบบเปิด + เปิดไลน์ + รูป + มีตัวที่เห็น) · ไลน์ร่าง = ไม่ live แต่ ready', on.live && !draft.live && draft.ready);
  }
  {
    const a3 = autoPinSpread(3);
    ok('A1 วางป้ายอัตโนมัติ 3 ตัว: x กระจายเท่ากัน 16.67 / 50 / 83.33 · y = ค่าเริ่ม', a3.map((p) => p.x).join() === '16.67,50,83.33' && a3.every((p) => p.y === PIN_AUTO_Y), a3);
    ok('A2 0 ตัว = [] · 1 ตัว = กลางรูป · y นอกกรอบถูกหนีบ 0–100', autoPinSpread(0).length === 0 && autoPinSpread(1)[0].x === 50 && autoPinSpread(2, 140)[0].y === 100 && autoPinSpread(2, -5)[0].y === 0);
    const six = autoPinSpread(6);
    ok('A3 6 ตัว: เรียงซ้ายไปขวา ไม่ชนขอบ (x อยู่ใน 0–100 และเพิ่มขึ้นเรื่อยๆ)', six.every((p, i) => p.x > 0 && p.x < 100 && (i === 0 || p.x > six[i - 1].x)), six);
  }

  // ── 18. รีวิวฝั่งลูกค้า 2026-10-16: ลำดับทางเลือก · อีกทาง · ยุบช็อปตามตัวกรอง · คำขอหาของที่ส่งแล้ว ─────────
  {
    let db = base({ products: [P('pre')] });
    db = reopenBatch('pre', { price: 2500, deposit: 1000, qty: 2, label: 'รอบ 2' })(db);
    const b = db.batches[0];
    const both = st(db, [M('a', ['pre'])], 'a');
    ok('W1 กระดานหลักเปิด + รอบพิเศษเปิด → ปุ่มหลัก = กระดานหลัก (ตรงกับหน้าสินค้า) · อีกทาง = รอบพิเศษ ?batch=',
      both.kind === 'preorder' && both.cta?.href === '/shop/pre' && both.alt?.href === `/shop/pre?batch=${b.id}` && !!both.alt?.label.includes('รอบ 2'), both);
    const twin = st(base({ products: [P('pre'), P('stk', { is_stock: true, stock_qty: 3, character_name: 'pre', series_name: 'pre' })] }), [M('a', ['pre'])], 'a');
    ok('W2 มีพร้อมส่ง (ของคู่) + เปิดพรีใหม่ → ปุ่มหลักพร้อมส่ง · อีกทาง = Pre-Order ของตัวพรี (ไม่หายเพราะถูกยุบจากช็อป)',
      twin.kind === 'stock' && twin.product?.id === 'stk' && twin.alt?.href === '/shop/pre' && !!twin.alt?.label.includes('Pre-Order'), twin);
    ok('W3 มีทางเดียว → ไม่มีอีกทาง', !st(base({ products: [P('pre')] }), [M('a', ['pre'])], 'a').alt);

    const lnull = L([M('m', ['pre'])], { id: 'Lnull', franchise_id: null });
    const lfr = L([M('m2', ['pre2'])], { id: 'Lfr' });
    const sdb = setLinesPublic(true)(base({ products: [P('pre'), P('pre2')], productLines: [lnull, lfr] }));
    ok('W4 ยุบช็อปตามตัวกรองเรื่อง: ไลน์ที่ไม่ระบุเรื่องไม่มีการ์ดโผล่ → สมาชิกไม่ถูกยุบ (ยังเห็นในกริด) · ไลน์ของเรื่องนั้นยังยุบ',
      [...productsInVisibleLines(sdb, 'uA', { franchiseId: FR })].join() === 'pre2' && [...productsInVisibleLines(sdb, 'uA')].sort().join() === 'pre,pre2');
    ok('W5 กรองค่ายอื่น → ไม่ยุบอะไรของค่ายนี้', productsInVisibleLines(sdb, 'uA', { makerId: MK2 }).size === 0);

    const out = base({ products: [P('old', { status: 'arrived' })] });
    const ask = (status: string, uid = 'uA') => ({ ...out, sourcingRequests: [{ id: 'sr1', user_id: uid, maker_name: 'KS', franchise_name: 'HxH', character_name: 'old', qty: 1, images: ['x'], source_product_id: 'old', status, created_at: iso(-1000) }] } as Database);
    const s1 = st(ask('requested'), [M('a', ['old'])], 'a');
    ok('W6 ส่งคำขอหาของตัวนี้ไว้แล้ว → "ส่งคำขอหาของแล้ว" + ปุ่มดูคำขอ (กันส่งซ้ำ)', s1.kind === 'out' && s1.cta?.href === '/sourcing' && s1.detail.includes('ส่งคำขอหาของแล้ว'), s1);
    ok('W7 คำขอหมดอายุ / ของคนอื่น → กลับเป็น "หาของให้" ตามปกติ',
      st(ask('expired'), [M('a', ['old'])], 'a').cta?.label === 'หาของให้' && st(ask('requested', 'uB'), [M('a', ['old'])], 'a').cta?.label === 'หาของให้');
  }

  // ── 19. เส้นทางลูกค้าจริง (เจ้าของ 2026-10-16 "ตรวจฝั่งลูกค้าอีกที ทั้งพื้นฐานและกรณีต่างๆ") ─────────────────
  //   สินค้าตัวเดียวเดินครบวงจรด้วย mutation จริงของร้าน แล้วดูหน้าไลน์จาก 3 มุม: เจ้าของตั๋ว (uA) · คนอื่น (uB) · คนยังไม่ล็อกอิน ('')
  {
    const line = L([M('a', ['pre']), M('b', ['pre2'])]);
    let db = setLinesPublic(true)(base({ products: [P('pre'), P('pre2')], productLines: [line] }));
    const view = (d: Database, uid: string) => lineMemberState(d, d.productLines[0], d.productLines[0].members[0], { uid });
    const plan = (d: Database, uid: string) => lineSetPlan(lineStates(d, d.productLines[0], { uid }).filter((x) => x.state.visible), () => false);
    const cartLine = [{ productId: 'pre', qty: 1, depositEach: 1000, priceEach: 2000 }];

    // เปิดพรี: ทุกคนเห็น Pre-Order + ปุ่มพรีเลย · ปุ่มพรีทั้งเซต 2 ตัว
    ok('J1 เปิดพรี: ทุกคนเห็น Pre-Order + พรีเลย · ยังไม่พรีใคร = พรีทั้งเซต 2 ตัว',
      view(db, 'uA').kind === 'preorder' && view(db, 'uA').cta?.label === 'พรีเลย' && view(db, '').kind === 'preorder' && plan(db, 'uA').addable.length === 2);

    // ส่งสลิปแล้ว (รอแอดมินตรวจ) → uA เห็น "พรีแล้ว ✓" ทันที (กันสั่งซ้ำ) · uB ยังเห็นปกติ
    const sent = submitOrder('uA', cartLine, 'slip.jpg')(db);
    const orderId = sent.orders.find((o) => o.user_id === 'uA')?.id;
    ok('J2 ส่งสลิปรอตรวจ: เจ้าของเห็นพรีแล้ว ✓ · ชุด 1/2 · ปุ่มเหลือ 1 ตัว · คนอื่นไม่เห็นป้ายของเรา',
      !!orderId && view(sent, 'uA').mine && view(sent, 'uA').pinLabel === 'พรีแล้ว ✓' && plan(sent, 'uA').mine === 1 && plan(sent, 'uA').addable.length === 1 && !view(sent, 'uB').mine && view(sent, 'uB').pinLabel === 'Pre-Order', view(sent, 'uA'));

    // แอดมินปฏิเสธสลิป → กลับเป็นยังไม่พรี (ไม่ค้าง "พรีแล้ว" หลอกลูกค้า)
    const rejected = rejectOrder(orderId!)(sent);
    ok('J3 สลิปถูกปฏิเสธ → ป้ายกลับเป็น Pre-Order · ชุด 0/2 · ปุ่มพรีทั้งเซต 2 ตัวกลับมา', !view(rejected, 'uA').mine && plan(rejected, 'uA').mine === 0 && plan(rejected, 'uA').addable.length === 2);

    // แอดมินอนุมัติ → มีตั๋ว → ยังเป็น "พรีแล้ว ✓"
    const approved = approveOrder(orderId!)(sent);
    const tk = approved.tickets.find((x) => x.owner_id === 'uA' && x.product_id === 'pre');
    ok('J4 อนุมัติแล้ว → มีตั๋ว · ยังพรีแล้ว ✓ (ไม่หายตอนเปลี่ยนจากออเดอร์เป็นตั๋ว)', !!tk && view(approved, 'uA').mine && view(approved, 'uA').pinLabel === 'พรีแล้ว ✓');

    // ตั๋วเปลี่ยนมือให้ uB → uA ไม่ใช่เจ้าของแล้ว · uB เป็นเจ้าของ
    const moved = { ...approved, tickets: approved.tickets.map((x) => (x.id === tk!.id ? { ...x, owner_id: 'uB' } : x)) };
    ok('J5 ตั๋วเปลี่ยนมือ → คนให้ไม่เห็นพรีแล้ว · คนรับเห็นพรีแล้ว ✓', !view(moved, 'uA').mine && view(moved, 'uB').mine);
    const xfer = { ...approved, tickets: approved.tickets.map((x) => (x.id === tk!.id ? { ...x, status: 'transferred' as const } : x)) };
    ok('J6 ตั๋วสถานะโอนออกแล้ว (transferred) → ไม่นับเป็นของเรา', !view(xfer, 'uA').mine);
    const gone = deleteTicket(tk!.id)(approved);
    ok('J7 แอดมินลบตั๋ว → ไม่นับเป็นของเรา', !view(gone, 'uA').mine || gone.tickets.some((x) => x.id === tk!.id), gone.tickets.length);

    // ปิดกระดาน (ปิดรับพรี) → ทุกคนเห็นปิดพรีแล้ว · ไม่มีปุ่มพรีเลย · ชุดไม่เสนอให้ใส่ · สั่งไม่ได้จริง
    let board = createBoard(MK, 'ปิดรอบ')(approved);
    const bid = board.boards[0].id;
    board = setBoardProducts(bid, ['pre'])(board);
    board = updateBoard(bid, { status: 'closed', poster_url: 'p.jpg' })(board);
    const closedA = view(board, 'uA'), closedB = view(board, 'uB');
    ok('J8 ปิดรับพรี: เจ้าของ = พรีแล้ว ✓ + ปุ่มดูตั๋ว · คนอื่น = ปิดพรีแล้ว + ดูรายละเอียด (ไม่ใช่พรีเลย)',
      closedA.kind === 'closed' && closedA.pinLabel === 'พรีแล้ว ✓' && closedA.cta?.href === '/wallet' && closedB.kind === 'closed' && closedB.cta?.label === 'ดูรายละเอียด', { closedA, closedB });
    ok('J9 ปิดรับพรี: ชุดของคนอื่นไม่เสนอตัวนั้น · สั่งตรงก็ไม่ผ่าน (submitOrder ปัดตก)',
      plan(board, 'uB').addable.every((a) => a.product.id !== 'pre') && submitOrder('uB', cartLine, 'slip.jpg')(board) === board);

    // ผลิต → เดินทาง → ถึงไทย
    const prod = setProductStatus('pre', 'production')(approved);
    const ship = setProductStatus('pre', 'shipping')(prod);
    ok('J10 ผลิต/เดินทาง: ปิดพรีแล้ว · บอกขั้นตอนตรง · เจ้าของยังพรีแล้ว ✓', view(prod, 'uB').detail.includes('ผลิต') && view(ship, 'uB').detail.includes('เดินทาง') && view(ship, 'uA').pinLabel === 'พรีแล้ว ✓');
    const arrived = setProductStatus('pre', 'arrived')(ship);
    const arrA = view(arrived, 'uA'), arrB = view(arrived, 'uB');
    ok('J11 ของถึงไทย: คนอื่น = หาของ (ร้านไม่มีของ) · เจ้าของตั๋ว ต้องไม่ถูกชวน "หาของให้" ของของตัวเอง → พรีแล้ว ✓ + ดูตั๋ว',
      arrB.kind === 'out' && arrB.cta?.label === 'หาของให้' && arrA.pinLabel === 'พรีแล้ว ✓' && arrA.cta?.href === '/wallet' && arrA.cta?.label !== 'หาของให้', { arrA, arrB });

    // ของเหลือแปลงเป็นพร้อมส่ง → ทุกคนเห็นพร้อมส่ง ซื้อได้
    const conv = convertToInStock('pre', 2500)({ ...arrived, products: arrived.products.map((p) => (p.id === 'pre' ? { ...p, surplus_qty: 3 } : p)) });
    const convB = view(conv, 'uB');
    ok('J12 แปลงเป็นพร้อมส่ง → คนอื่นเห็นพร้อมส่ง + ซื้อเลย', convB.kind === 'stock' && convB.cta?.label === 'ซื้อเลย', convB);

    // สินค้าถูกลบออกจากระบบ → ตัวนั้นไม่พังหน้า (ไม่มีสินค้า + ไม่ได้ตั้งสถานะ = ลูกค้าไม่เห็นตัวนั้น) · ตัวอื่นยังปกติ
    const removed = removeProduct('pre')(db);
    ok('J13 สินค้าที่ผูกถูกลบ → ตัวนั้นซ่อน (ไม่พัง) · ไลน์ยังเปิดได้เพราะตัวอื่นยังเห็น', !view(removed, 'uB').visible && lineOpenToCustomers(removed, removed.productLines[0]));
    const allGone = removeProduct('pre2')(removed);
    // รอบพิเศษมีด่าน (ต้องเคยพรี) → คนใหม่ไม่เห็น "พรีเลย" กระพริบที่พาไปหน้าล็อก
    let sp = base({ products: [P('sp', { status: 'production' }), P('other')], tickets: [T('tB', 'other', 'uB')] });
    sp = reopenBatch('sp', { price: 2500, deposit: 1000, qty: 3, label: 'รอบ 2' })(sp);
    const spNew = st(sp, [M('a', ['sp'])], 'a', { uid: 'uA' }), spOld = st(sp, [M('a', ['sp'])], 'a', { uid: 'uB' });
    ok('J15 รอบพิเศษ: คนที่ยังไม่เคยพรี = "ดูเงื่อนไข" + บอกเงื่อนไขในแถว · คนที่เคยพรี = พรีเลย',
      spNew.kind === 'special' && spNew.cta?.label === 'ดูเงื่อนไข' && !!spNew.note?.includes('เคยพรี') && !spNew.detail.includes('เคยพรี') && spOld.cta?.label === 'พรีเลย' && !spOld.note, { spNew, spOld });
    const gateOff = { ...sp, appConfig: [{ key: 'special_gate', value: { enabled: false } }] } as Database;
    ok('J16 ปิดด่านรอบพิเศษ (ช่วงโปร) → ทุกคนเห็นพรีเลย · การ์ด/พรีวิว (uid ว่าง) ไม่ล็อก',
      st(gateOff, [M('a', ['sp'])], 'a', { uid: 'uA' }).cta?.label === 'พรีเลย' && st(sp, [M('a', ['sp'])], 'a', { uid: '' }).cta?.label === 'พรีเลย');
    ok('J14 ทุกตัวไม่มีสินค้าแล้ว → ไลน์ปิดตัวเองจากลูกค้า (ไม่ใช่หน้าว่างๆ) · ลิงก์ตรงจะเจอ "ไม่พบหน้านี้"', !lineOpenToCustomers(allGone, allGone.productLines[0]) && !lineVisibleTo(allGone, 'uB', allGone.productLines[0]));
  }

  // ── 20. รีวิวลูกค้ารอบ 2 (2026-10-16): พรี/ซื้อ ตามตั๋วจริง · hold ของตัวเอง · โควตารอบพิเศษ · ตัว Add เองที่ขอหาของแล้ว ─────
  {
    // พรีไว้แล้ว + มีของพร้อมส่งเข้ามา → ยังเป็น "พรีแล้ว ✓" (ไม่ใช่ "ซื้อแล้ว ✓")
    const preThenStock = st(base({ products: [P('pre'), P('stk', { is_stock: true, stock_qty: 3, character_name: 'pre', series_name: 'pre' })], tickets: [T('t1', 'pre', 'uA')] }), [M('a', ['pre'])], 'a', { uid: 'uA' });
    ok('X1 พรีไว้ + มีพร้อมส่งเข้ามา → ป้าย "พรีแล้ว ✓" ตามตั๋วจริง (ปุ่มหลักยังเป็นพร้อมส่งให้คนที่อยากได้เพิ่ม)', preThenStock.kind === 'stock' && preThenStock.pinLabel === 'พรีแล้ว ✓', preThenStock);
    // ซื้อพร้อมส่งแล้ว ของหมด → "ซื้อแล้ว ✓" สีเทา ไม่ใช่ "ปิดพรีแล้ว" ม่วง
    const soldOutMine = st(base({ products: [P('stk', { is_stock: true, stock_qty: 1 })], tickets: [T('t1', 'stk', 'uA', { remaining_amount: 0, deposit_paid: 2000 })] }), [M('a', ['stk'])], 'a', { uid: 'uA' });
    ok('X2 ซื้อพร้อมส่งชิ้นสุดท้ายไปแล้ว (ของหมด) → ซื้อแล้ว ✓ · สีเทา · ดูตั๋ว (ไม่ใช่ปิดพรี/หาของ)', soldOutMine.pinLabel === 'ซื้อแล้ว ✓' && soldOutMine.tone === 'gray' && soldOutMine.label === 'ซื้อแล้ว' && soldOutMine.cta?.href === '/wallet', soldOutMine);
    // ใบพรีที่ SKU ถูกแปลงเป็นพร้อมส่งทีหลัง (ยังมียอดค้าง) = ยังเป็น "พรี"
    const converted = st(base({ products: [P('c', { is_stock: true, stock_qty: 0 })], tickets: [T('t1', 'c', 'uA', { remaining_amount: 1000 })] }), [M('a', ['c'])], 'a', { uid: 'uA' });
    ok('X3 ใบพรีของ SKU ที่แปลงเป็นพร้อมส่งทีหลัง (มียอดค้าง) → ยัง "พรีแล้ว ✓"', converted.pinLabel === 'พรีแล้ว ✓', converted);

    // คนดูเองจ่ายชิ้นสุดท้าย (hold + ออเดอร์รอตรวจ) → ไม่ใช่ "มีคนกำลังจ่ายเงิน" · บอกว่าส่งสลิปแล้วรอตรวจ
    const hold = (uid: string): StockReservation => ({ id: 'h-' + uid, product_id: 'stk', user_id: uid, qty: 1, status: 'paid', reserved_until: iso(600_000), created_at: iso(-1000) } as StockReservation);
    const order = { id: 'o1', user_id: 'uA', total_deposit: 2000, slip_url: 's', status: 'pending_approval', created_at: iso(-1000), items: [{ id: 'oi1', order_id: 'o1', product_id: 'stk', qty: 1, deposit_amount: 2000 }] } as never;
    const myHold = base({ products: [P('stk', { is_stock: true, stock_qty: 1 })], stockReservations: [hold('uA')], orders: [order] });
    const me = st(myHold, [M('a', ['stk'])], 'a', { uid: 'uA' }), other = st(myHold, [M('a', ['stk'])], 'a', { uid: 'uB' });
    ok('X4 ตัวเองเป็นคนจ่ายชิ้นสุดท้าย → ซื้อแล้ว ✓ · "ส่งสลิปแล้ว · รอร้านตรวจ" (ไม่ใช่ "มีคนกำลังจ่าย") · คนอื่นเห็นหมดชั่วคราว',
      me.kind !== 'soldout_temp' && me.pinLabel === 'ซื้อแล้ว ✓' && me.detail.includes('รอร้านตรวจ') && other.kind === 'soldout_temp', { me, other });
    // คนอื่นซื้อหมด (server บอก 0) แต่ยังมีคน hold → หมดชั่วคราว ไม่ตกไป "หาของ"
    const othersHold = base({ products: [P('stk', { is_stock: true, stock_qty: 3 })], stockReservations: [hold('uB')] });
    const live0 = st(othersHold, [M('a', ['stk'])], 'a', { uid: 'uA', live: () => 0 });
    ok('X5 server บอกหมด + มีคนอื่น hold อยู่ → หมดชั่วคราว (ตรงกับหน้าสินค้า) ไม่ใช่ "หาของให้"', live0.kind === 'soldout_temp', live0);

    // รอบพิเศษครบโควตาต่อคน → ไม่ชวนพรีเลย · บอกในบรรทัดเงื่อนไข
    let sp = base({ products: [P('sp', { status: 'production' })] });
    sp = reopenBatch('sp', { price: 2500, deposit: 1000, qty: 9, label: 'รอบ 2' })(sp);
    const bid = sp.batches[0].id;
    const full = { ...sp, tickets: [T('q1', 'sp', 'uA', { batch_id: bid }), T('q2', 'sp', 'uA', { batch_id: bid })] } as Database;
    const q = st(full, [M('a', ['sp'])], 'a', { uid: 'uA' });
    ok('X6 รอบพิเศษครบโควตาต่อคนแล้ว → ปุ่ม "ดูรายละเอียด" (ไม่กระพริบ) + บรรทัด "ครบโควตา" · คนอื่นยังพรีได้',
      q.kind === 'special' && q.cta?.label === 'ดูรายละเอียด' && !!q.note?.includes('ครบโควตา') && st(full, [M('a', ['sp'])], 'a', { uid: 'uB' }).cta?.label !== 'ดูรายละเอียด', q);

    // ตัว Add เอง (หาของ) ส่งคำขอชื่อนี้กับค่ายนี้ไปแล้ว → "ส่งคำขอหาของแล้ว"
    const req = (status: string, name = 'Pakunoda', maker = MK) => ({ id: 'sr', user_id: 'uA', maker_id: maker, maker_name: 'KS', franchise_name: 'HxH', character_name: name, qty: 1, images: ['x'], status, created_at: iso(-1000) });
    const man = (r: object[]) => st({ ...base(), sourcingRequests: r } as Database, [M('pak', [], { name: 'Pakunoda', manual_state: 'sourcing' })], 'pak', { uid: 'uA' });
    ok('X7 ตัว Add เอง: ขอหาของชื่อนี้ไปแล้ว → ส่งคำขอแล้ว/ดูคำขอ · ชื่ออื่น/ค่ายอื่น/หมดอายุ → หาของให้ตามเดิม',
      man([req('requested')]).cta?.href === '/sourcing' && man([req('requested', ' pakunoda ')]).cta?.href === '/sourcing'
      && man([req('requested', 'Other')]).cta?.label === 'หาของให้' && man([req('requested', 'Pakunoda', MK2)]).cta?.label === 'หาของให้' && man([req('expired')]).cta?.label === 'หาของให้');

    // ประมูล = เทา ไม่นับเป็น "ปิดพรีแล้ว"
    const auc = { ...base({ products: [P('au', { is_stock: true, stock_qty: 1 })] }), auctions: [{ id: 'a1', product_id: 'au', status: 'live', ends_at: iso(3_600_000), current_price: 1000, bid_count: 0, extend_count: 0 }] } as unknown as Database;
    const as = st(auc, [M('a', ['au'])], 'a');
    ok('X8 ติดประมูล → สีเทา (ไม่ถูกนับในชิป "ปิดพรีแล้ว")', as.kind === 'auction' && as.tone === 'gray', as);

    // จุดในการ์ด x/y มาจากชุดเดียวกับตัวเลข
    const tracked = lineSetPlan(lineStates(setLinesPublic(true)(base({ products: [P('a'), P('b')], tickets: [T('t1', 'a', 'uA')] })), L([M('ma', ['a']), M('mb', ['b']), M('mx', [], { manual_state: 'sourcing' })]), { uid: 'uA' }), () => false);
    ok('X9 จุดในการ์ด = ตัวที่นับ (ตัว Add เองไม่มีจุด) · 1/2', tracked.tracked.length === 2 && tracked.tracked.filter((x) => x.mine).length === 1 && tracked.total === 2, tracked.tracked);
  }

  console.log(`\nlines-audit: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
