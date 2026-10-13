/**
 * เทสต์ระดับ SQL ของ v88 (ปรับราคาพรีเดิมตามกฎค่าส่งรถ 2026-10-13) — Postgres จริง (PGlite)
 *   ร้านจำลองใช้ค่าตั้งของ production: 288¥ = 1,640฿ · 5฿/¥ · ขั้น 349→+40 · 500→+80
 *   R) กติกาเงินราคา: ตามสูตร → สูตรใหม่ · ตั้งเองก่อนกฎ → +40/80 · ตั้งเองหลังกฎ/ตรงสูตรใหม่แล้ว → ไม่แตะ · ลงช่วงขั้น 329 → −40
 *   K) ห้ามแตะ: มีตั๋ว · ออเดอร์รอตรวจ · hold ค้าง/ส่งสลิปแล้ว · ปิดรอบ · พร้อมส่ง · หลายแบบ · ไม่มีหยวน
 *   I) รันซ้ำไม่บวกซ้ำ · ตารางสำรองครบ · ย้อนกลับได้ · fingerprint cols=4 · API อ่านตารางสำรองไม่ได้
 * รัน: npm run audit:sql
 */
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { bootDb, splitSql, asUser } from './pgdb';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)); }
};
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;

const base = (y: number) => 1640 + (y - 288) * 5;
const BEFORE = '2026-10-01T10:00:00+07:00';
const WINDOW = '2026-10-13T13:15:00+07:00'; // ช่วงที่ขั้น 1 ยังเป็น 329
const AFTER = '2026-10-13T15:00:00+07:00';

// [id, cost, price, extra]
type P = { id: string; cost: number | null; price: number; deposit?: number; status?: string; is_stock?: boolean; has_variants?: boolean; created?: string };
const PRODUCTS: P[] = [
  { id: 'F400', cost: 400, price: base(400) },                  // ตามสูตร → +40
  { id: 'F500', cost: 500, price: base(500) },                  // ตามสูตร → +80
  { id: 'F348', cost: 348, price: base(348) },                  // ขั้นยังไม่ถึง → เท่าเดิม
  { id: 'F349', cost: 349, price: base(349) },                  // ขั้นแรกพอดี → +40
  { id: 'F800', cost: 800, price: base(800) },                  // ขั้น 2 → +80 (ไม่ซ้อน)
  { id: 'C450', cost: 450, price: 2500 },                       // ตั้งเองก่อนกฎ → 2,540
  { id: 'CNEW', cost: 450, price: 2600, created: AFTER },       // ตั้งเองหลังกฎ → ไม่แตะ
  { id: 'NEWF', cost: 400, price: base(400) + 40, created: AFTER }, // ลงหลังกฎ ราคาใหม่แล้ว → ไม่แตะ
  { id: 'WIN', cost: 340, price: base(340) + 40, created: WINDOW },  // ช่วงขั้น 329 ได้ +40 ไป → เอาออก
  { id: 'WINOLD', cost: 340, price: base(340) + 40 },           // ราคาตั้งเองก่อนกฎ ช่วงไม่บวก → ไม่แตะ
  { id: 'DEP', cost: 400, price: base(400), deposit: 1000 },    // มัดจำตั้งเอง → ราคาขึ้น มัดจำคง
  { id: 'TK', cost: 400, price: base(400) },                    // มีตั๋ว
  { id: 'TKB', cost: 400, price: base(400) },                   // มีตั๋วรอบพิเศษ
  { id: 'PO', cost: 400, price: base(400) },                    // ออเดอร์รอตรวจ
  { id: 'RO', cost: 400, price: base(400) },                    // ออเดอร์ถูกปฏิเสธ → ปรับได้
  { id: 'HOLD', cost: 400, price: base(400) },                  // hold ยังไม่หมดเวลา
  { id: 'HOLDX', cost: 400, price: base(400) },                 // hold หมดเวลาแล้ว → ปรับได้
  { id: 'PAID', cost: 400, price: base(400) },                  // ส่งสลิปแล้วรอตรวจ (reservation paid)
  { id: 'CLOSED', cost: 400, price: base(400), status: 'production' },
  { id: 'STOCK', cost: 400, price: base(400), is_stock: true },
  { id: 'VAR', cost: 400, price: base(400), has_variants: true },
  { id: 'NOY', cost: null, price: 2000 },
];
const EXPECT: Record<string, number> = {
  F400: base(400) + 40, F500: base(500) + 80, F348: base(348), F349: base(349) + 40, F800: base(800) + 80,
  C450: 2540, CNEW: 2600, NEWF: base(400) + 40, WIN: base(340), WINOLD: base(340) + 40, DEP: base(400) + 40,
  TK: base(400), TKB: base(400), PO: base(400), RO: base(400) + 40, HOLD: base(400), HOLDX: base(400) + 40, PAID: base(400),
  CLOSED: base(400), STOCK: base(400), VAR: base(400), NOY: 2000,
};
const CHANGED = Object.keys(EXPECT).filter((id) => EXPECT[id] !== PRODUCTS.find((p) => p.id === id)!.price).sort();

const V88 = splitSql(readFileSync('supabase/migration_surcharge_apply_v88.sql', 'utf8'));
async function runV88(db: PGlite) {
  for (const s of V88.slice(0, -1)) await db.exec(s);
  return (await q(db, V88[V88.length - 1]))[0];
}
const prices = async (db: PGlite) => Object.fromEntries((await q(db, 'select id, price_total::numeric p, deposit_amount::numeric d from products')).map((r) => [r.id, { p: Number(r.p), d: Number(r.d) }]));

async function main() {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v87+v88) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  await db.query(`insert into shop_settings (id, yuan_base, baht_base, baht_per_yuan) values ('default', 288, 1640, 5)
                  on conflict (id) do update set yuan_base = 288, baht_base = 1640, baht_per_yuan = 5`);
  await db.query(`insert into users (id, display_name) values ('u1', 'A') on conflict do nothing`);
  for (const p of PRODUCTS)
    await db.query(`insert into products (id, series_name, price_total, deposit_amount, status, is_stock, has_variants, cost_yuan, created_at) values ($1,$1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.id, p.price, p.deposit ?? 300, p.status ?? 'open', p.is_stock ?? false, p.has_variants ?? false, p.cost, p.created ?? BEFORE]);
  await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, qty) values ('t1','T-1','TK','u1',1)`);
  await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, qty, batch_id) values ('t2','T-2','TKB','u1',1,'b1')`);
  await db.query(`insert into orders (id, user_id, status) values ('o1','u1','pending_approval'), ('o2','u1','rejected')`);
  await db.query(`insert into order_items (id, order_id, product_id, qty) values ('i1','o1','PO',1), ('i2','o2','RO',1)`);
  await db.query(`insert into stock_reservations (id, product_id, qty, status, reserved_until) values
    ('r1','HOLD',1,'active', now() + interval '10 minutes'),
    ('r2','HOLDX',1,'active', now() - interval '10 minutes'),
    ('r3','PAID',1,'paid', now() - interval '1 hour')`);
  await db.exec('set session_replication_role = origin;');

  const fp = await runV88(db);
  const after = await prices(db);
  for (const id of Object.keys(EXPECT)) ok(`R/K ${id} → ${EXPECT[id]}`, after[id]?.p === EXPECT[id], after[id]);
  ok('R มัดจำตั้งเอง 1,000 คงเดิม', after.DEP.d === 1000);
  ok('R มัดจำตัวอื่นคง 300', PRODUCTS.filter((p) => p.id !== 'DEP').every((p) => after[p.id].d === 300), PRODUCTS.map((p) => [p.id, after[p.id].d]));

  const backup = await q(db, 'select product_id, old_price::numeric o, new_price::numeric n, rule from price_surcharge_v88 order by product_id');
  ok('I ตารางสำรอง = รายการที่เปลี่ยนจริงพอดี', JSON.stringify(backup.map((r) => r.product_id)) === JSON.stringify(CHANGED), backup.map((r) => r.product_id));
  ok('I fingerprint: cols = 4', Number(fp.cols) === 4, fp);
  ok('I fingerprint: changed = จำนวนที่เปลี่ยน', Number(fp.changed) === CHANGED.length, fp);
  ok('I fingerprint: kept_booked = TK/TKB/PO (≥349¥ มีคนพรี)', Number(fp.kept_booked) === 3, fp);
  ok('I fingerprint: list มีชื่อ+ราคาเก่า→ใหม่', typeof fp.list === 'string' && fp.list.includes('F400 · 400¥ · 2200 → 2240'), fp.list);
  console.log(fp.list);

  // รันซ้ำ: ไม่บวกซ้ำ
  const fp2 = await runV88(db);
  const again = await prices(db);
  ok('I รันซ้ำ: ราคาไม่เปลี่ยนอีก', JSON.stringify(again) === JSON.stringify(after));
  ok('I รันซ้ำ: changed เท่าเดิม', Number(fp2.changed) === CHANGED.length);

  // ลูกค้า/API อ่านตารางสำรองไม่ได้
  const leak = await asUser(db, null, async () => { await db.query('select * from price_surcharge_v88'); return 'readable'; }).catch((e) => (e as Error).message);
  ok('I anon อ่านตารางสำรองไม่ได้', leak !== 'readable', leak);

  // ย้อนกลับ (ตามคอมเมนต์หัวไฟล์)
  await db.exec(`update products p set price_total = b.old_price from price_surcharge_v88 b where p.id = b.product_id and p.price_total = b.new_price`);
  const back = await prices(db);
  ok('I ย้อนกลับได้ครบ', PRODUCTS.every((p) => back[p.id].p === p.price), PRODUCTS.filter((p) => back[p.id].p !== p.price).map((p) => p.id));

  console.log(`\nsurcharge88-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
