/**
 * เทสต์ระดับ SQL ของรอบ E (v78) — Postgres จริง (PGlite) รัน migration ครบทุกไฟล์
 * รัน: npm run audit:sql
 */
import type { PGlite } from '@electric-sql/pglite';
import { bootDb, asUser, rpc } from './pgdb';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const AUTH = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
  X: '00000000-0000-4000-8000-0000000000ad',
} as const;
type Who = keyof typeof AUTH;
type Res = Record<string, any> & { THROWN?: string };
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const call = (db: PGlite, who: Who, fn: string, args: unknown[] = []) =>
  asUser(db, AUTH[who], () => rpc<Res>(db, fn, args)).catch((e) => ({ THROWN: (e as Error).message } as Res));
const PAY = { account_name: 'Alice A', promptpay: '0812345678' };

async function boot() {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v78) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  const u = (id: string, name: string, auth: string, admin = false, mc = '') =>
    db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank, payout_info) values ($1,$2,$3,true,'addr',$4,$5,'bronze',$6)`, [id, name, auth, mc, admin, PAY]);
  await u('uA', 'Alice', AUTH.A, false, 'RYU-0011'); await u('uB', 'Bob', AUTH.B, false, 'RYU-0022');
  await u('uC', 'Carl', AUTH.C, false, 'RYU-0033'); await u('uX', 'Admin', AUTH.X, true, 'RYU-0001');
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status, is_stock) values
    ('P1','Series One',1690,300,'production',false), ('PS','Stock',2500,2500,'open',true), ('PH','Hunt',2000,500,'production',false)`);
  await db.query(`insert into product_batches (id, product_id, label, price_total, deposit_amount, stock_qty, status) values ('BH','PH','หาของ',2000,500,5,'open')`);
  await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ('o1','uA','approved',now(),3000)`);
  for (let i = 1; i <= 6; i++) {
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit, std_deposit) values ($1,'o1','P1',1,300,1690,300,300)`, [`oi${i}`]);
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at)
                    values ($1,$2,'P1','uA','uA',1,300,1390,0,'active','production',now())`, [`t-oi${i}`, `NR-2026-10-40${i}`]);
  }
  await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status) values
    ('t-stock','NR-S-1','PS','uA','uA',1,2500,0,0,'paid_full','open'),
    ('t-hunt','NR-H-1','PH','uA','uA',1,500,1500,0,'active','production')`);
  await db.query(`update preorder_tickets set batch_id = 'BH' where id = 't-hunt'`);
  await db.query(`insert into app_config (key, value) values ('market_direct', '{"enabled": true}'), ('market_public', '{"enabled": true}')`);
  await db.exec('set session_replication_role = origin;');
  return db;
}
const reason = async (db: PGlite, t: string) => (await q(db, `select ryuma_market_block_reason($1, 'uA', 1) as r`, [t]))[0].r;

(async () => {
  const db = await boot();
  ok('E1 ของพร้อมส่ง → เหตุผล instock ไม่ใช่ still_open (R2B-17)', (await reason(db, 't-stock')) === 'instock', await reason(db, 't-stock'));
  ok('E2 ตั๋วในรอบ "หาของ" ที่ไม่มีเรื่องหาของแล้ว → sourcing (R2B-19)', (await reason(db, 't-hunt')) === 'sourcing', await reason(db, 't-hunt'));

  // ยกให้ฟรี → ผู้รับกดรับ → คนส่งยกเลิกได้ (R1-58)
  const codeB = (await call(db, 'B', 'ryuma_wallet_code')).code as string;
  const f = await call(db, 'A', 'ryuma_market_offer', ['t-oi1', 1, 0, codeB, null, 'uB']);
  const acc = await call(db, 'B', 'ryuma_market_pay', [f.id, '']);
  const cn = await call(db, 'A', 'ryuma_market_cancel', [f.id]);
  const st = (await q(db, `select status, cancel_reason from ticket_transfers where id = $1`, [f.id]))[0];
  ok('E3 ยกให้ฟรีที่ผู้รับกดรับแล้ว คนส่งยกเลิกได้ก่อนยืนยัน', !!f.ok && !!acc.ok && !!cn.ok && st?.status === 'cancelled' && st?.cancel_reason === 'seller', { f, acc, cn, st });
  const pw = await call(db, 'A', 'ryuma_market_push_targets', [f.id, 'withdrawn']);
  ok('E4 push ถึงผู้รับ: "คนส่งยกเลิกการยกให้แล้ว" (ไม่บอกให้แนบสลิป)', /ยกเลิกการยกให้/.test(pw.body ?? ''), pw);
  const p2 = await call(db, 'A', 'ryuma_market_offer', ['t-oi2', 1, 500, codeB, PAY, 'uB']);
  await call(db, 'B', 'ryuma_market_pay', [p2.id, 'https://x/s.jpg']);
  const cn2 = await call(db, 'A', 'ryuma_market_cancel', [p2.id]);
  ok('E5 ดีลมีเงินที่ผู้รับโอนแล้ว คนส่งยังถอนเองไม่ได้', cn2.error === 'bad_status', cn2);

  // push ข้อความ seller_ok ของยกให้ฟรี (R1-33)
  const g = await call(db, 'A', 'ryuma_market_offer', ['t-oi3', 1, 0, codeB, null, 'uB']);
  await call(db, 'B', 'ryuma_market_pay', [g.id, '']);
  await call(db, 'A', 'ryuma_market_seller_confirm', [g.id]);
  const pok = await call(db, 'A', 'ryuma_market_push_targets', [g.id, 'seller_ok']);
  ok('E6 push ยืนยันของยกให้ = "คนส่งยืนยันยกให้แล้ว" (เดิม "คนขายยืนยันรับเงินแล้ว")', pok.title === '✅ คนส่งยืนยันยกให้แล้ว', pok);
  const fin = await call(db, 'X', 'ryuma_market_finalize', [g.id, null]);

  // กระดาน: "ขายสำเร็จ" ไม่นับเปลี่ยนใบ (R1-32)
  const l = await call(db, 'A', 'ryuma_market_list', ['t-oi4', 1, 700]);
  const feed = await call(db, 'C', 'ryuma_market_feed');
  const row = (feed.rows ?? []).find((r: any) => r.id === l.id);
  ok('E7 กระดานนับ "ขายสำเร็จ" เฉพาะขายบนกระดาน (เปลี่ยนใบ/ยกให้ไม่นับ)', !!fin.ok && !!row && Number(row.seller_sold) === 0, { fin, row });

  // ข้อเสนอที่หมดเวลา ไม่ถูกล้างชื่อผู้รับ (R1-36)
  const h = await call(db, 'A', 'ryuma_market_offer', ['t-oi5', 1, 300, codeB, PAY, 'uB']);
  await db.exec('set session_replication_role = replica;');
  await db.query(`update ticket_transfers set hold_until = now() - interval '2 days', expires_at = now() - interval '2 days' where id = $1`, [h.id]);
  await db.exec('set session_replication_role = origin;');
  const l2 = await call(db, 'A', 'ryuma_market_list', ['t-oi5', 1, 900]); // ตัวล้างแถวหมดอายุตั้ง to_user_id = null
  const hr = (await q(db, `select status, to_user_id from ticket_transfers where id = $1`, [h.id]))[0];
  ok('E8 ลงประกาศใหม่หลังข้อเสนอหมดเวลา → ข้อเสนอเดิมยังมีชื่อผู้รับ (ประวัติผู้รับไม่หาย)', !!l2.ok && hr?.status === 'expired' && hr?.to_user_id === 'uB', { l2, hr });

  console.log(`\nroundE-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
