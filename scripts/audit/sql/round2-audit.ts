/**
 * เทสต์ระดับ SQL ของ v86 (รอบ 2 · audit 2026-10-12: รูรั่วที่กระทบร้านอยู่แล้ว) — Postgres จริง (PGlite)
 *   P) ออเดอร์ที่แอปสร้างจริง (submitOrder ตัวจริง) ทุกยศ/ทุกแบบสินค้า → ฐานข้อมูลรับ (ห้ามทำลูกค้าปกติสั่งไม่ได้)
 *   T) ลูกค้ายิงตรงตั้งราคา/มัดจำเอง → ถูกปรับขึ้นเป็นราคาร้าน (M02) · โครงสร้างผิด/ออเดอร์ปิดแล้ว/รอบไม่เปิด → ปฏิเสธ · หลังสร้างแก้ราคาไม่ได้
 *   A) อนุมัติออเดอร์ที่ยอดไม่ตรงกับมัดจำของรายการ (ต่ำ/สูง/ไม่มีรายการ) → ปฏิเสธ (แม้แอดมิน) · ตั๋ว/แต้มของออเดอร์ที่ไม่ผ่านออกไม่ได้
 *   S) คลังรูป: ลูกค้าเห็นรายชื่อไฟล์ของตัวเองเท่านั้น (M06)
 *   R) reserve_ticket_nos: คนไม่ล็อกอินเรียกไม่ได้ · ลูกค้าขอเกิน 50 ไม่ได้ (M13)
 *   L) ryuma_link_auth: ต้องล็อกอินเป็นบัญชีของเบอร์นั้น + PIN ถูก (M39)
 * รัน: npm run audit:sql
 */
import type { PGlite } from '@electric-sql/pglite';
import { bootDb, asUser, rpc } from './pgdb';
import { submitOrder } from '../../../src/data/mutations';
import { SEED_DATABASE } from '../../../src/data/seed';
import type { Database, User } from '../../../src/domain/entities';
import type { CartLine } from '../../../src/state/CartProvider';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)); }
};
const AUTH: Record<string, string> = {
  B: '00000000-0000-4000-8000-0000000086b0', S: '00000000-0000-4000-8000-0000000086b1', G: '00000000-0000-4000-8000-0000000086b2',
  D: '00000000-0000-4000-8000-0000000086b3', X: '00000000-0000-4000-8000-0000000086ad', L: '00000000-0000-4000-8000-0000000086cc',
};
const RANK: Record<string, string> = { B: 'bronze', S: 'silver', G: 'gold', D: 'diamond', X: 'bronze' };
type Who = keyof typeof AUTH;
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const run = (db: PGlite, who: Who | null, sql: string, params: unknown[] = []) =>
  asUser(db, who ? AUTH[who] : null, async () => { await db.query(sql, params); return 'ok'; }).catch((e) => (e as Error).message);
const call = (db: PGlite, who: Who | null, fn: string, args: unknown[] = []): Promise<Record<string, any>> =>
  asUser(db, who ? AUTH[who] : null, () => rpc<Record<string, any>>(db, fn, args)).catch((e) => ({ THROWN: (e as Error).message }) as Record<string, any>);

// ── ร้านจำลอง (ต้องตรงกันทั้ง PGlite และ Database ของแอป) ───────────────────────────────────────
const PRODUCTS = [
  { id: 'P1', series_name: 'Luffy', price_total: 4000, deposit_amount: 1000, status: 'open', is_stock: false },
  { id: 'P2', series_name: 'Zoro', price_total: 2500, deposit_amount: 2500, status: 'open', is_stock: true, stock_qty: 5 },      // พร้อมส่ง
  { id: 'P3', series_name: 'Sanji', price_total: 3000, deposit_amount: 999, status: 'open', is_stock: false },     // มัดจำคี่ (Gold 50% ปัด)
  { id: 'P4', series_name: 'Nami', price_total: 1800, deposit_amount: 500, status: 'arrived', is_stock: false },   // มีรอบพิเศษ
];
const VARIANTS = [{ id: 'V1', product_id: 'P1', name: 'Gold ver.', price_total: 4400, deposit_amount: 1200 }];
const BATCHES = [
  { id: 'B4', product_id: 'P4', label: 'รอบ 2', price_total: 1900, deposit_amount: 600, stock_qty: 10, status: 'open', published: true },
  { id: 'B4f', product_id: 'P4', label: 'จ่ายเต็ม', price_total: 1900, deposit_amount: 1900, stock_qty: 10, status: 'open', published: true },
];

function appDb(): Database {
  const base = structuredClone(SEED_DATABASE);
  const users = (['B', 'S', 'G', 'D', 'X'] as Who[]).map((w) => ({ ...base.users[0], id: `u${w}`, display_name: w, auth_id: AUTH[w], approved: true, is_admin: w === 'X', rank: RANK[w], phone: `08100000${w.charCodeAt(0)}` } as unknown as User));
  return {
    ...base, users, orders: [], tickets: [], remainingPayments: [], transfers: [], pointLedger: [], stockReservations: [], auctions: [], couponGrants: [], boards: [],
    products: PRODUCTS.map((p) => ({ ...base.products[0], ...p, franchise_id: undefined, manufacturer_id: undefined })) as unknown as Database['products'],
    variants: VARIANTS as unknown as Database['variants'],
    batches: BATCHES as unknown as Database['batches'],
    settings: { ...base.settings, rank_gold_deposit_pct: 50, points_enabled: false },
  } as Database;
}

async function boot() {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v86) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  for (const w of ['B', 'S', 'G', 'D', 'X'] as Who[])
    await db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank, phone) values ($1,$2,$3,true,'addr',$4,$5,$6,$7)`,
      [`u${w}`, w, AUTH[w], `RYU-86${w}`, w === 'X', RANK[w], `08100000${w.charCodeAt(0)}`]);
  await db.query(`insert into shop_settings (id, rank_gold_deposit_pct) values ('default', 50) on conflict (id) do update set rank_gold_deposit_pct = 50`);
  for (const p of PRODUCTS)
    await db.query(`insert into products (id, series_name, price_total, deposit_amount, status, is_stock) values ($1,$2,$3,$4,$5,$6)`, [p.id, p.series_name, p.price_total, p.deposit_amount, p.status, p.is_stock]);
  for (const v of VARIANTS)
    await db.query(`insert into product_variants (id, product_id, name, price_total, deposit_amount) values ($1,$2,$3,$4,$5)`, [v.id, v.product_id, v.name, v.price_total, v.deposit_amount]);
  for (const b of BATCHES)
    await db.query(`insert into product_batches (id, product_id, label, price_total, deposit_amount, stock_qty, status) values ($1,$2,$3,$4,$5,$6,$7)`, [b.id, b.product_id, b.label, b.price_total, b.deposit_amount, b.stock_qty, b.status]);
  // รอบที่ปิดแล้ว (ราคาเก่าถูกกว่า) — แอปไม่ให้สั่ง ห้ามใช้เป็นช่องราคาถูก
  await db.query(`insert into product_batches (id, product_id, label, price_total, deposit_amount, stock_qty, status) values ('B4old','P4','รอบ 1',900,200,0,'closed')`);
  // ประมูลที่ uB ชนะ: P2 (ของในมือ ราคาร้าน 2,500) ชนะที่ 1,100
  await db.query(`insert into auctions (id, product_id, title, ends_at, original_ends_at, status, winner_user_id, winning_amount) values ('au1','P2','Zoro auction',now(),now(),'ended','uB',1100)`);
  await db.exec('set session_replication_role = origin;');
  return db;
}

/** ส่งออเดอร์ที่แอปสร้าง (orders แล้ว order_items — ลำดับเดียวกับ adapter) ในฐานะลูกค้า */
async function pushOrder(db: PGlite, who: Who, order: Database['orders'][number]) {
  const o = await run(db, who, `insert into orders (id, user_id, total_deposit, slip_url, status, coupon_grant_id, coupon_discount, points_redeemed) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [order.id, order.user_id, order.total_deposit, order.slip_url, order.status, order.coupon_grant_id ?? null, order.coupon_discount ?? null, order.points_redeemed ?? null]);
  if (o !== 'ok') return o;
  for (const i of order.items) {
    const r = await run(db, who, `insert into order_items (id, order_id, product_id, variant_id, qty, deposit_amount, unit_price, unit_deposit, batch_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [i.id, i.order_id, i.product_id, i.variant_id ?? null, i.qty, i.deposit_amount, i.unit_price ?? null, i.unit_deposit ?? null, i.batch_id ?? null]);
    if (r !== 'ok') return r;
  }
  return 'ok';
}

(async () => {
  const db = await boot();

  // ── P) ออเดอร์จริงจากแอป → ต้องผ่านทุกแบบ ─────────────────────────────────────────────────
  const carts: { who: Who; lines: CartLine[]; label: string }[] = [
    { who: 'B', label: 'Bronze พรีปกติ ×2', lines: [{ productId: 'P1', qty: 2 } as CartLine] },
    { who: 'S', label: 'Silver แบบ (variant)', lines: [{ productId: 'P1', variantId: 'V1', qty: 1 } as CartLine] },
    { who: 'G', label: 'Gold มัดจำ 50% (มัดจำคี่ 999 → 500)', lines: [{ productId: 'P3', qty: 1 } as CartLine, { productId: 'P1', qty: 1 } as CartLine] },
    { who: 'D', label: 'Diamond มัดจำ 0 + ของพร้อมส่ง (จ่ายเต็ม)', lines: [{ productId: 'P1', qty: 1 } as CartLine, { productId: 'P2', qty: 1 } as CartLine] },
    { who: 'G', label: 'Gold รอบพิเศษ + รอบจ่ายเต็ม (ไม่ลดยศ)', lines: [{ productId: 'P1', qty: 1 } as CartLine, { productId: 'P4', batchId: 'B4', qty: 1 } as CartLine, { productId: 'P4', batchId: 'B4f', qty: 1 } as CartLine] },
  ];
  for (const c of carts) {
    const before = appDb();
    const after = submitOrder(`u${c.who}`, c.lines, 'https://x/slip.jpg')(before);
    const order = after.orders[0];
    if (!order) { ok(`P ${c.label}: แอปสร้างออเดอร์ได้`, false, 'submitOrder returned no order'); continue; }
    const res = await pushOrder(db, c.who, order);
    ok(`P ${c.label}: ออเดอร์จากแอปจริง → ฐานข้อมูลรับ (มัดจำ ${order.items.map((i) => i.unit_deposit).join('/')})`, res === 'ok', { res, items: order.items });
  }

  // ── T) ยิงตรงตั้งราคา/มัดจำเอง ────────────────────────────────────────────────────────────
  await run(db, 'B', `insert into orders (id, user_id, total_deposit, slip_url, status) values ('oT','uB',1000,'s','pending_approval')`);
  const tamper = async (label: string, cols: Record<string, unknown>) => {
    const row = { id: `oiT-${label}`, order_id: 'oT', product_id: 'P1', variant_id: null, qty: 1, deposit_amount: 1000, unit_price: 4000, unit_deposit: 1000, batch_id: null, ...cols };
    const keys = Object.keys(row);
    return run(db, 'B', `insert into order_items (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => (row as Record<string, unknown>)[k]));
  };
  const item = async (id: string) => (await q(db, `select unit_price, unit_deposit, deposit_amount from order_items where id = $1`, [id]))[0];
  const is = (r: Record<string, any> | undefined, up: number, ud: number, da: number) => !!r && Number(r.unit_price) === up && Number(r.unit_deposit) === ud && Number(r.deposit_amount) === da;
  const t1 = await tamper('price', { unit_price: 1000 });
  ok('T1 Bronze ตั้งราคา 1,000 ให้ของ 4,000 → ถูกปรับเป็นราคาร้าน 4,000', t1 === 'ok' && is(await item('oiT-price'), 4000, 1000, 1000), { t1, r: await item('oiT-price') });
  const t2 = await tamper('zero', { unit_price: 0, unit_deposit: 0, deposit_amount: 0 });
  ok('T2 แบบ 0 บาท (หน้าตาเหมือน Diamond) แต่เป็น Bronze → ถูกปรับเป็น 4,000 / มัดจำ 1,000', t2 === 'ok' && is(await item('oiT-zero'), 4000, 1000, 1000), await item('oiT-zero'));
  const t3 = await tamper('dep', { unit_deposit: 500, deposit_amount: 500 });
  ok('T3 Bronze จ่ายมัดจำครึ่งเดียว (แอบใช้สิทธิ์ Gold) → มัดจำถูกปรับเป็น 1,000', t3 === 'ok' && is(await item('oiT-dep'), 4000, 1000, 1000), await item('oiT-dep'));
  const t4 = await tamper('sum', { qty: 3, deposit_amount: 1000 });
  ok('T4 จำนวน 3 แต่มัดจำรวมเท่า 1 ชิ้น → มัดจำรวมถูกปรับเป็น 3,000', t4 === 'ok' && is(await item('oiT-sum'), 4000, 1000, 3000), await item('oiT-sum'));
  const t5 = await tamper('var', { product_id: 'P3', variant_id: 'V1', unit_price: 4400, unit_deposit: 1200, deposit_amount: 1200 });
  ok('T5 แบบของสินค้าอื่น → ปฏิเสธ', /ไม่ใช่ของสินค้านี้/.test(t5), t5);
  const t6 = await tamper('batch', { product_id: 'P1', batch_id: 'B4', unit_price: 1900, unit_deposit: 600, deposit_amount: 600 });
  ok('T6 รอบพิเศษของสินค้าอื่น → ปฏิเสธ', /ไม่ใช่ของสินค้านี้/.test(t6), t6);
  const t6b = await tamper('closed', { product_id: 'P4', batch_id: 'B4old', unit_price: 900, unit_deposit: 200, deposit_amount: 200 });
  ok('T6b รอบที่ปิดแล้ว (ราคาเก่าถูกกว่า) → ปฏิเสธ', /ปิดรับแล้ว/.test(t6b), t6b);
  const t7 = await tamper('over', { unit_price: 4500, unit_deposit: 1100, deposit_amount: 1100 });
  ok('T7 จ่ายมากกว่าราคาร้าน (ไม่เสียหาย) → เก็บตามที่ส่ง', t7 === 'ok' && is(await item('oiT-over'), 4500, 1100, 1100), await item('oiT-over'));
  const t7a = await tamper('auc', { product_id: 'P2', unit_price: 1100, unit_deposit: 1100, deposit_amount: 1100 });
  ok('T7a ผู้ชนะประมูลจ่ายตามยอดที่ชนะ 1 ชิ้น → เก็บราคาประมูล (ไม่ถูกปรับ)', t7a === 'ok' && is(await item('oiT-auc'), 1100, 1100, 1100), await item('oiT-auc'));
  const t7b = await tamper('auc2', { product_id: 'P2', qty: 3, unit_price: 1100, unit_deposit: 1100, deposit_amount: 3300 });
  ok('T7b ใช้ราคาประมูลซื้อหลายชิ้น → ถูกปรับเป็นราคาร้าน 2,500', t7b === 'ok' && is(await item('oiT-auc2'), 2500, 2500, 7500), await item('oiT-auc2'));
  const t8 = await run(db, 'B', `update order_items set unit_price = 100, unit_deposit = 0 where id = 'oiT-over'`);
  const after8 = (await q(db, `select unit_price, unit_deposit from order_items where id = 'oiT-over'`))[0];
  ok('T8 หลังสร้างแล้ว ลูกค้าแก้ราคา/มัดจำไม่ได้ (ค่าคงเดิม)', t8 === 'ok' && Number(after8.unit_price) === 4500 && Number(after8.unit_deposit) === 1100, { t8, after8 });
  const t9 = await asUser(db, AUTH.X, async () => {
    await db.query(`insert into orders (id, user_id, total_deposit, slip_url, status) values ('oAdm','uB',0,'s','pending_approval')`);
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit) values ('oiAdm','oAdm','P1',1,0,0,0)`);
    return 'ok';
  }).catch((e) => (e as Error).message);
  ok('T9 แอดมินสร้างรายการราคาพิเศษเองได้ (ด่านนี้คุมเฉพาะลูกค้า)', t9 === 'ok', t9);

  // ── A) อนุมัติ: ยอดออเดอร์ต้องตรงกับมัดจำของรายการ ──────────────────────────────────────────
  const approve = (id: string) => run(db, 'X', `update orders set status = 'approved', approved_at = now() where id = $1`, [id]);
  await db.exec('set session_replication_role = replica;');
  await db.query(`insert into orders (id, user_id, total_deposit, slip_url, status) values ('oLow','uB',0,'s','pending_approval'), ('oOk','uB',2000,'s','pending_approval'),
    ('oCp','uD',2100,'s','pending_approval'), ('oHigh','uB',5000,'s','pending_approval'), ('oNone','uB',1000,'s','pending_approval')`);
  await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit) values
    ('oiLow','oLow','P1',2,2000,4000,1000), ('oiOk','oOk','P1',2,2000,4000,1000), ('oiCp','oCp','P2',1,2500,2500,2500), ('oiHigh','oHigh','P1',1,1000,4000,1000)`);
  await db.query(`update orders set coupon_discount = 300, points_redeemed = 100 where id = 'oCp'`);
  await db.exec('set session_replication_role = origin;');
  const a1 = await approve('oLow');
  ok('A1 ยอดออเดอร์ 0 แต่รายการมัดจำ 2,000 → แอดมินกดอนุมัติไม่ผ่าน (บอกเหตุผล)', /ต่ำกว่ามัดจำของรายการ/.test(a1), a1);
  ok('A2 ยอดตรงกับรายการ → อนุมัติผ่าน', (await approve('oOk')) === 'ok');
  ok('A3 ของพร้อมส่ง 2,500 − คูปอง 300 − แต้ม 100 = 2,100 → อนุมัติผ่าน', (await approve('oCp')) === 'ok');
  const a4 = await run(db, 'X', `update orders set total_deposit = total_deposit where id = 'oOk'`);
  ok('A4 ออเดอร์ที่อนุมัติแล้ว แก้อย่างอื่นต่อได้ตามปกติ (ด่านทำงานเฉพาะตอนเปลี่ยนเป็นอนุมัติ)', a4 === 'ok', a4);
  const a5 = await approve('oHigh');
  ok('A5 ยอดออเดอร์มากกว่ารายการ (รายการบันทึกไม่ครบ) → อนุมัติไม่ได้', /มากกว่ามัดจำของรายการ/.test(a5), a5);
  const a6 = await approve('oNone');
  ok('A6 ออเดอร์ไม่มีรายการเลย → อนุมัติไม่ได้', /ไม่มีรายการสินค้า/.test(a6), a6);
  const a7 = await approve('oT');
  ok('A7 ออเดอร์ที่ลูกค้าแก้ราคา (รายการถูกปรับขึ้นแล้ว ยอดสลิปไม่ตรง) → อนุมัติไม่ได้', /ต่ำกว่ามัดจำของรายการ/.test(a7), a7);
  // แอดมินกดอนุมัติแล้วเซฟไม่ผ่าน: ตั๋ว/แต้มที่หน้าจอสร้างไว้ต้องไม่หลุดลงฐานข้อมูล (adapter เขียนทุกตารางต่อ)
  const tk = await run(db, 'X', `insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status)
      values ('t-oiLow','NR-LOW','P1','uB','uB',2,2000,6000,0,'active','open')`);
  ok('A8 ตั๋วของออเดอร์ที่ยังไม่อนุมัติ → แอดมินก็ออกไม่ได้', /ยังไม่ได้อนุมัติ/.test(tk), tk);
  const tkOk = await run(db, 'X', `insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status)
      values ('t-oiOk','NR-OK','P1','uB','uB',2,2000,6000,0,'active','open')`);
  ok('A9 ตั๋วของออเดอร์ที่อนุมัติแล้ว → ออกได้ตามปกติ', tkOk === 'ok', tkOk);
  const pl = await run(db, 'X', `insert into point_ledger (id, user_id, delta, kind, ref_type, ref_id, note, created_by) values ('pl-earn-t-oiLow','uB',20,'earn_ticket','ticket','t-oiLow','x','uX')`);
  ok('A10 แต้มปิดใบของตั๋วที่ไม่มีจริง → บันทึกไม่ได้', /ไม่พบตั๋วของแต้มนี้/.test(pl), pl);
  const plOk = await run(db, 'X', `insert into point_ledger (id, user_id, delta, kind, ref_type, ref_id, note, created_by) values ('pl-earn-t-oiOk','uB',20,'earn_ticket','ticket','t-oiOk','x','uX')`);
  ok('A11 แต้มปิดใบของตั๋วที่มีจริง → บันทึกได้', plOk === 'ok', plOk);
  // เพิ่มรายการเข้าออเดอร์ที่อนุมัติแล้ว แล้วออกตั๋วเอง (self-heal) → ปิดทั้งสองชั้น
  const addApproved = await run(db, 'B', `insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit) values ('oiSneak','oOk','P2',3,7500,2500,2500)`);
  ok('A12 ลูกค้าเพิ่มของเข้าออเดอร์ที่อนุมัติแล้ว → ปฏิเสธ (กันออกตั๋วพร้อมส่งเองโดยไม่มีสลิป)', /ออเดอร์นี้ปิดแล้ว/.test(addApproved), addApproved);

  // ── S) คลังรูป ───────────────────────────────────────────────────────────────────────────
  await db.exec('set session_replication_role = replica;');
  await db.query(`insert into storage.objects (bucket_id, name, owner) values ('logos','slip-b.jpg',$1), ('logos','slip-g.jpg',$2), ('logos','banner.jpg',$3)`, [AUTH.B, AUTH.G, AUTH.X]);
  await db.exec('set session_replication_role = origin;');
  const seeB = await asUser(db, AUTH.B, () => q(db, `select name from storage.objects where bucket_id = 'logos' order by name`));
  ok('S1 ลูกค้าเห็นรายชื่อไฟล์ของตัวเองเท่านั้น (ไม่เห็นสลิปคนอื่น)', seeB.length === 1 && seeB[0].name === 'slip-b.jpg', seeB);
  const seeX = await asUser(db, AUTH.X, () => q(db, `select name from storage.objects where bucket_id = 'logos'`));
  ok('S2 แอดมินเห็นทุกไฟล์', seeX.length === 3, seeX);
  const up = await run(db, 'G', `insert into storage.objects (bucket_id, name, owner) values ('logos','slip-g2.jpg',$1)`, [AUTH.G]);
  ok('S3 ลูกค้ายังอัปโหลดสลิปได้ตามปกติ', up === 'ok', up);

  // ── R) reserve_ticket_nos ───────────────────────────────────────────────────────────────
  const r1 = await call(db, null, 'reserve_ticket_nos', ['NR-2026-10', 5]);
  ok('R1 คนไม่ล็อกอินเรียกจองเลขตั๋วไม่ได้', /permission denied/.test(String(r1?.THROWN ?? '')), r1);
  const r2 = await call(db, 'B', 'reserve_ticket_nos', ['NR-2026-10', 3]);
  ok('R2 ลูกค้าจอง 3 เลข (self-heal) ได้ตามปกติ', typeof r2 === 'number' && r2 >= 1, r2);
  const r3 = await call(db, 'B', 'reserve_ticket_nos', ['NR-2026-10', 2000000000]);
  ok('R3 ลูกค้าขอทีละมหาศาล (ดันเลขตั๋วทั้งร้านพัง) → ปฏิเสธ', /มากเกินไป/.test(String((r3 as Record<string, unknown>)?.THROWN ?? '')), r3);
  let rr: Record<string, any> | number = 0;
  for (let i = 0; i < 6; i++) rr = await call(db, 'B', 'reserve_ticket_nos', ['NR-2026-10', 50]);
  ok('R3b ลูกค้ายิงวนทีละ 50 → ถูกหยุดเมื่อตัวนับนำหน้าตั๋วจริงเกิน 200', /มากเกินไป/.test(String((rr as Record<string, any>)?.THROWN ?? '')), rr);
  const r4 = await call(db, 'X', 'reserve_ticket_nos', ['NR-2026-10', 200]);
  ok('R4 แอดมินอนุมัติออเดอร์ใหญ่ จองทีละ 200 ได้', typeof r4 === 'number', r4);
  await db.exec('set session_replication_role = replica;');
  await db.query(`insert into users (id, display_name, auth_id, approved, member_code, rank) values ('uNew','New',$1,false,null,'bronze')`, [AUTH.L]);
  await db.exec('set session_replication_role = origin;');
  const r5 = await call(db, 'L', 'reserve_ticket_nos', ['NR-2026-11', 3]);
  ok('R5 บัญชีที่ยังไม่อนุมัติ จองเลขตั๋วไม่ได้', /ยังไม่ได้รับอนุมัติ/.test(String(r5?.THROWN ?? '')), r5);
  await db.exec('set session_replication_role = replica;');
  await db.query(`delete from users where id = 'uNew'`);
  await db.exec('set session_replication_role = origin;');

  // ── L) ryuma_link_auth ──────────────────────────────────────────────────────────────────
  await db.exec('set session_replication_role = replica;');
  await db.query(`insert into users (id, display_name, approved, member_code, rank, phone) values ('uLeg','Legacy',true,'RYU-86LG','bronze','0899998888')`);
  await db.query(`insert into user_secrets (user_id, pin_hash) values ('uLeg', crypt('123456', gen_salt('bf')))`);
  await db.query(`insert into auth.users (id, email) values ($1, '0899998888@ryuma.local'), ($2, 'attacker@ryuma.local')`, [AUTH.L, AUTH.S]);
  await db.exec('set session_replication_role = origin;');
  const l0 = await call(db, null, 'ryuma_link_auth', ['uLeg', AUTH.L, '123456']);
  ok('L1 คนไม่ล็อกอินเรียกผูกบัญชีไม่ได้', /permission denied/.test(String(l0?.THROWN ?? '')), l0);
  const l1 = await call(db, 'S', 'ryuma_link_auth', ['uLeg', AUTH.S, '123456']);
  ok('L2 คนอื่น (อีเมลไม่ใช่เบอร์นี้) ผูกบัญชีสมาชิกเก่าไม่ได้ แม้รู้ PIN', l1?.error === 'forbidden', l1);
  const l2 = await call(db, 'L', 'ryuma_link_auth', ['uLeg', AUTH.L, '000000']);
  ok('L3 เจ้าของเบอร์แต่ PIN ผิด → wrong_pin (นับครั้งผิด)', l2?.error === 'wrong_pin', l2);
  const l3 = await call(db, 'L', 'ryuma_link_auth', ['uLeg', AUTH.L, '123456']);
  const linked = (await q(db, `select auth_id from users where id = 'uLeg'`))[0];
  ok('L4 เจ้าของเบอร์ + PIN ถูก → ผูกได้ (login รุ่นเก่ายังใช้ได้)', l3?.ok === true && linked.auth_id === AUTH.L, { l3, linked });
  const l4 = await call(db, 'L', 'ryuma_link_auth', ['uLeg', AUTH.L]);
  ok('L5 รุ่นเก่า 2 ช่อง (ไม่มี PIN) ไม่มีแล้ว', /does not exist|function/.test(String(l4?.THROWN ?? '')), l4);

  // ── ตัวตรวจ ────────────────────────────────────────────────────────────────────────────
  const chk = await q(db, `select * from ryuma_schema_check()`);
  ok('C1 ryuma_schema_check = 32 แถว true ทั้งหมด (fingerprint ของ v86)', chk.length === 32 && chk.every((r) => r.ok === true), chk.filter((r) => !r.ok));

  console.log(`\nround2-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
