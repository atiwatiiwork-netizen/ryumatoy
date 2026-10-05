/**
 * เทสต์ระดับ SQL ของรอบ C (v76) — Postgres จริง (PGlite) รัน migration ครบทุกไฟล์
 * บัญชีรับเงิน (ตารางลับ / สิทธิ์อ่าน / ล็อกตอนลงประกาศ / ยกให้ฟรี) + เติมมัดจำ (std_deposit ตอนซื้อ) + สลิปที่อนุมัติแล้วลบไม่ได้
 * รัน: npm run audit:sql
 */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { bootDb, asUser, rpc, splitSql } from './pgdb';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const AUTH = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
  G: '00000000-0000-4000-8000-00000000000e',
  X: '00000000-0000-4000-8000-0000000000ad',
} as const;
type Who = keyof typeof AUTH;
type Res = Record<string, any> & { THROWN?: string };
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const call = (db: PGlite, who: Who, fn: string, args: unknown[] = []) =>
  asUser(db, AUTH[who], () => rpc<Res>(db, fn, args)).catch((e) => ({ THROWN: (e as Error).message } as Res));
const run = (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  asUser(db, AUTH[who], async () => ({ ok: true, rows: (await db.query<Record<string, any>>(sql, params)).rows } as Res)).catch((e) => ({ THROWN: (e as Error).message } as Res));
const std = async (db: PGlite, id: string) => Number((await q(db, 'select ryuma_market_std_deposit($1) as v', [id]))[0].v);
const PAY = { account_name: 'Alice A', promptpay: '0812345678' };
const DIR = 'supabase'; // รันจากรากโปรเจกต์ (เหมือน roundA/roundB)

async function boot() {
  const { db, errors } = await bootDb(DIR);
  ok('boot: migration ทุกไฟล์ (รวม v76) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  const u = (id: string, name: string, auth: string, rank: string, admin = false, mc = '') =>
    db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank) values ($1,$2,$3,true,'addr',$4,$5,$6)`, [id, name, auth, mc, admin, rank]);
  await u('uA', 'Alice', AUTH.A, 'bronze', false, 'RYU-0011'); await u('uB', 'Bob', AUTH.B, 'bronze', false, 'RYU-0022');
  await u('uC', 'Carl', AUTH.C, 'bronze', false, 'RYU-0033'); await u('uG', 'Gina', AUTH.G, 'gold', false, 'RYU-0044');
  await u('uX', 'Admin', AUTH.X, 'bronze', true, 'RYU-0001');
  await u('uH', 'Hana', null as unknown as string, 'gold', false, 'RYU-0055'); // จ่ายมัดจำเต็มตอนยัง bronze แล้วเพิ่งขึ้น gold (review รอบ C ข้อ 2)
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status, is_stock) values ('P2','Converted',2500,2500,'arrived',true)`); // SKU ที่ convert เป็นพร้อมส่งแล้ว (ข้อ 1)
  await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ('oH','uH','approved',now(),300), ('oS','uG','approved',now(),150)`);
  await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit) values ('oiH','oH','P1',1,300,1690,300), ('oiS','oS','P2',1,150,2500,150)`);
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status) values ('P1','Series One',1690,300,'production')`);
  // A (bronze) มัดจำเต็ม 300 · G (gold) มัดจำครึ่ง 150 — ก่อน v76 ยังไม่มี std_deposit (null)
  await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ('oA','uA','approved',now(),3000), ('oG','uG','approved',now(),300)`);
  for (let i = 1; i <= 6; i++) {
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit) values ($1,'oA','P1',1,300,1690,300)`, [`oi${i}`]);
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at)
                    values ($1,$2,'P1','uA','uA',1,300,1390,0,'active','production',now())`, [`t-oi${i}`, `NR-2026-10-10${i}`]);
  }
  await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit) values ('oiG1','oG','P1',1,150,1690,150), ('oiG2','oG','P1',1,150,1690,150)`);
  await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at, created_at)
                  values ('t-oiG1','NR-2026-10-201','P1','uG','uG',1,150,1540,0,'active','production',now(),now()),
                         ('legacy-g','NR-2026-10-202','P1','uG','uG',1,150,1540,0,'active','production',now(),now()),
                         ('tg-gift-1','NR-2026-10-203','P1','uG','uG',1,0,1690,0,'active','production',now(),now())`);
  await db.query(`insert into app_config (key, value) values ('market_direct', '{"enabled": true}'), ('market_public', '{"enabled": true}')`);
  await db.query(`update order_items set std_deposit = null`); // จำลองข้อมูลก่อน v76
  await db.query(`update products set deposit_amount = 400 where id = 'P1'`); // ร้านขึ้นมัดจำหลังลูกค้าซื้อ (R1-22)
  await db.exec('set session_replication_role = origin;');
  // รัน v76 ซ้ำ = เติม std_deposit ให้รายการเก่า (migration รันซ้ำได้)
  for (const s of splitSql(readFileSync(`${DIR}/migration_roundC_v76.sql`, 'utf8'))) await db.exec(s);
  return db;
}

(async () => {
  const db = await boot();

  // ── เติมมัดจำ: std_deposit ตอนซื้อ (R1-22 / R2B-05) ─────────────────────────────────────
  {
    const items = Object.fromEntries((await q(db, `select id, std_deposit from order_items`)).map((r) => [r.id, Number(r.std_deposit)]));
    ok('C1 รายการเก่าของคน bronze: std = มัดจำที่จ่าย 300 (ไม่ใช่ 400 ที่ขึ้นทีหลัง)', items.oi1 === 300, items);
    ok('C2 รายการเก่าที่จ่ายครึ่ง (Gold 50%): std = มัดจำฐานตอนซื้อ 300 (= 150 ÷ 50%) ไม่ใช่ 400 ที่ขึ้นทีหลัง', items.oiG1 === 300, items);
    ok('C2b จ่ายมัดจำเต็มตอนยัง bronze แล้วเพิ่งขึ้น gold → std = ที่จ่าย 300 (ไม่ดูยศวันนี้)', items.oiH === 300, items);
    ok('C2c SKU ที่ convert เป็นพร้อมส่ง: std = ขั้นมัดจำร้าน 300 ไม่ใช่ราคาเต็ม 2,500', items.oiS === 300, items);
    ok('C3 ตั๋ว bronze มัดจำเต็ม หลังร้านขึ้นมัดจำ → ไม่ต้องเติม (std 300)', (await std(db, 't-oi1')) === 300);
    const br = await call(db, 'A', 'ryuma_market_offer', ['t-oi1', 1, 500, '0000', PAY, 'uB']);
    ok('C4 ตั๋ว bronze ไม่ติด topup_needed', br.error !== 'topup_needed', br);
    ok('C5 ตั๋ว gold (มัดจำครึ่ง) ต้องเติม: std 300', (await std(db, 't-oiG1')) === 300);
    const gr = (await q(db, `select ryuma_market_block_reason('t-oiG1','uG',1) as r`))[0].r; // ฟังก์ชันภายใน (เรียกตรงในฐานะเจ้าของ DB)
    ok('C6 ตั๋ว gold → topup_needed', gr === 'topup_needed', gr);
    ok('C7 ตั๋วรุ่นเก่า (id ไม่ผูกรายการ) จับคู่รายการด้วยมัดจำต่อชิ้น → std 300', (await std(db, 'legacy-g')) === 300);
    ok('C8 ตั๋วแอดมินมอบ (ไม่มีออเดอร์) → std 0 ไม่ต้องเติม (R2B-05)', (await std(db, 'tg-gift-1')) === 0);
    await db.exec('set session_replication_role = replica;');
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, split_from, created_at)
                    values ('tc-child','NR-2026-10-201-T1','P1','uB','uG',1,150,1540,0,'active','production','t-oiG1',now())`);
    await db.exec('set session_replication_role = origin;');
    ok('C9 ตั๋วลูกใช้รายการของตั๋วแม่ต้นสาย → std 300', (await std(db, 'tc-child')) === 300);

    // รายการใหม่: เซิร์ฟเวอร์คำนวณเอง ลูกค้าตั้งเองไม่ได้ / แก้ทีหลังไม่ได้
    await run(db, 'A', `insert into orders (id, user_id, status, total_deposit) values ('oNew','uA','pending_approval',400)`);
    const ins = await run(db, 'A', `insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit, std_deposit) values ('oiNew','oNew','P1',1,400,1690,400,1)`);
    const v = (await q(db, `select std_deposit from order_items where id = 'oiNew'`))[0]?.std_deposit;
    ok('C10 ลูกค้าส่ง std_deposit = 1 มาเอง → เซิร์ฟเวอร์ตั้งเป็น 400', !!ins.ok && Number(v) === 400, { ins, v });
    await run(db, 'A', `update order_items set std_deposit = 5 where id = 'oiNew'`);
    const v2 = (await q(db, `select std_deposit from order_items where id = 'oiNew'`))[0]?.std_deposit;
    ok('C11 แก้ std_deposit ทีหลังไม่ได้', Number(v2) === 400, v2);
    // เจ้าของแก้ค่าที่ผิดจาก SQL Editor ได้ เมื่อตั้ง ryuma.trusted (ข้อ 1)
    await db.exec(`select set_config('ryuma.trusted', 'on', false); update order_items set std_deposit = 250 where id = 'oiNew'; select set_config('ryuma.trusted', 'off', false);`);
    ok('C12 ตั้ง ryuma.trusted แล้วแก้ค่าได้', Number((await q(db, `select std_deposit from order_items where id = 'oiNew'`))[0]?.std_deposit) === 250);
    // แถวที่ยังไม่มีค่า: ลูกค้าส่งค่ามาเองไม่ได้ เซิร์ฟเวอร์คำนวณ (ข้อ 6)
    await db.exec(`set session_replication_role = replica; update order_items set std_deposit = null where id = 'oiNew'; set session_replication_role = origin;`);
    await run(db, 'A', `update order_items set std_deposit = 1 where id = 'oiNew'`);
    ok('C13 แถวที่ยังไม่มีค่า + ลูกค้าส่ง 1 → เซิร์ฟเวอร์คำนวณเป็น 400', Number((await q(db, `select std_deposit from order_items where id = 'oiNew'`))[0]?.std_deposit) === 400);
  }

  // ── บัญชีรับเงิน: ตารางลับ + สิทธิ์อ่าน (R1-10 / R1-49 / R1-58) ───────────────────────────
  const codeB = (await call(db, 'B', 'ryuma_wallet_code')).code as string;
  {
    const o = await call(db, 'A', 'ryuma_market_offer', ['t-oi2', 1, 500, codeB, PAY, 'uB']);
    ok('P1 ส่งข้อเสนอมีราคา สำเร็จ', !!o.ok, o);
    const col = (await q(db, `select payout_snap from ticket_transfers where id = $1`, [o.id]))[0]?.payout_snap;
    const vault = (await q(db, `select payout from ticket_transfer_payouts where transfer_id = $1`, [o.id]))[0]?.payout;
    ok('P2 บัญชีไม่อยู่ในตารางดีล (อยู่ในตารางลับ)', col === null && vault?.promptpay === '0812345678', { col, vault });
    const rd = await run(db, 'B', `select * from ticket_transfer_payouts`);
    ok('P3 ลูกค้าอ่านตารางลับตรงๆ ไม่ได้', !!rd.THROWN || (rd.rows ?? []).length === 0, rd);
    const pB = await call(db, 'B', 'ryuma_market_payout', [o.id]);
    const pC = await call(db, 'C', 'ryuma_market_payout', [o.id]);
    const pA = await call(db, 'A', 'ryuma_market_payout', [o.id]);
    const pX = await call(db, 'X', 'ryuma_market_payout', [o.id]);
    ok('P4 ผู้รับอ่านได้ระหว่างข้อเสนอ · คนนอกไม่ได้', pB.promptpay === '0812345678' && pC.error === 'not_found', { pB, pC });
    ok('P5 คนส่งดูบัญชีของดีลตัวเองได้ (R1-49) · แอดมินดูได้', pA.promptpay === '0812345678' && pX.promptpay === '0812345678', { pA, pX });
    const cn = await call(db, 'A', 'ryuma_market_cancel', [o.id]);
    ok('P6 ถอนโดยไม่ใส่เหตุผลไม่ได้ (v79 reason_required)', cn.error === 'reason_required', cn);
    await call(db, 'X', 'ryuma_market_admin_cancel', [o.id, 'test']);
    const pB2 = await call(db, 'B', 'ryuma_market_payout', [o.id]);
    ok('P7 ดีลถูกยกเลิกแล้ว ผู้รับอ่านบัญชีไม่ได้อีก (R1-10)', pB2.error === 'not_found', pB2);

    const f = await call(db, 'A', 'ryuma_market_offer', ['t-oi3', 1, 0, codeB, null, 'uB']);
    ok('P8 ยกให้ฟรีไม่ต้องมีบัญชีรับเงิน (R1-58)', !!f.ok, f);
    const pf = await call(db, 'B', 'ryuma_market_payout', [f.id]);
    ok('P9 ดีลฟรีไม่มีบัญชีในตารางลับ (payout = none)', !!pf.ok && pf.none === true, pf);
    const np = await call(db, 'A', 'ryuma_market_offer', ['t-oi4', 1, 300, codeB, null, 'uB']);
    ok('P10 ดีลมีราคาแต่ไม่มีบัญชี → no_payout', np.error === 'no_payout', np);
    const leak = await run(db, 'B', `select payout_snap from ticket_transfers where to_user_id = 'uB'`);
    ok('P11 ผู้รับ select ตารางดีลตรงๆ ไม่เห็นบัญชี', !!leak.ok && (leak.rows ?? []).every((r: any) => r.payout_snap === null), leak);
  }

  // ── กระดาน: ล็อกบัญชีตอนลงประกาศ + ผู้ซื้อเห็นเฉพาะช่วงจอง (R1-07 / R1-08) ───────────────────
  {
    await asUser(db, AUTH.X, () => db.query(`update users set payout_info = '{"account_name":"Alice","promptpay":"0899999999"}' where id = 'uA'`));
    // ส่งบัญชีที่เลือกในหน้าลงขายมาด้วย — ล็อกตัวนี้ ไม่ใช่บัญชีหลักที่อาจยังเซฟไม่ขึ้น (review รอบ C ข้อ 3)
    const l = await call(db, 'A', 'ryuma_market_list', ['t-oi5', 1, 600, { account_name: 'Alice', promptpay: '0811111111' }]);
    ok('B1 ลงประกาศสำเร็จ', !!l.ok, l);
    await asUser(db, AUTH.X, () => db.query(`update users set payout_info = '{"account_name":"Alice","promptpay":"0822222222"}' where id = 'uA'`));
    const rs = await call(db, 'B', 'ryuma_market_reserve', [l.id]);
    const p = await call(db, 'B', 'ryuma_market_payout', [l.id]);
    ok('B2 คนขายเปลี่ยนบัญชีหลักหลังลงประกาศ → ผู้ซื้อยังเห็นบัญชีตอนลงประกาศ', !!rs.ok && p.promptpay === '0811111111', { rs, p });
    await db.exec('set session_replication_role = replica;');
    await db.query(`update ticket_transfers set hold_until = now() - interval '1 hour' where id = $1`, [l.id]);
    await db.exec('set session_replication_role = origin;');
    const p2 = await call(db, 'B', 'ryuma_market_payout', [l.id]);
    ok('B3 หมดเวลาจองแล้ว ผู้ซื้อกระดานอ่านบัญชีไม่ได้ (R1-08)', p2.error === 'not_found', p2);
    await db.exec('set session_replication_role = replica;');
    await db.query(`update ticket_transfers set hold_until = null, status = 'reserved', to_user_id = 'uB' where id = $1`, [l.id]);
    await db.exec('set session_replication_role = origin;');
    const p3 = await call(db, 'B', 'ryuma_market_payout', [l.id]);
    ok('B4 แถวที่ hold_until ว่าง → ไม่หลุดด่าน (null ไม่ถือว่ามีสิทธิ์ · ข้อ 5)', p3.error === 'not_found', p3);
    const l2 = await call(db, 'A', 'ryuma_market_list', ['t-oi6', 1, 600]);
    const pv = (await q(db, `select payout from ticket_transfer_payouts where transfer_id = $1`, [l2.id]))[0]?.payout;
    ok('B5 ไม่ส่งบัญชีมา = ใช้บัญชีหลัก (เข้ากันกับแอปรุ่นเก่า)', !!l2.ok && pv?.promptpay === '0822222222', { l2, pv }); // บัญชีหลักล่าสุด (เปลี่ยนในขั้น B2)
    await call(db, 'A', 'ryuma_market_cancel', [l2.id]);
  }

  // ── สลิปที่อนุมัติแล้วลบไม่ได้ (R1-25) + ลบสมาชิกยังทำงาน ──────────────────────────────────
  {
    await db.exec('set session_replication_role = replica;');
    await db.query(`insert into remaining_payments (id, ticket_id, user_id, amount, slip_url, status, created_at) values
      ('rp-ok','t-oi6','uA',100,'https://x/s.jpg','approved',now()), ('rp-pend','t-oi6','uA',100,'https://x/s2.jpg','pending',now())`);
    await db.exec('set session_replication_role = origin;');
    const d1 = await run(db, 'X', `delete from remaining_payments where id = 'rp-ok'`);
    const still = (await q(db, `select id from remaining_payments where id = 'rp-ok'`)).length;
    ok('R1 แอดมินลบสลิปที่อนุมัติแล้วไม่ได้ (เครื่องเก่ากดปฏิเสธทับ)', !!d1.THROWN && /อนุมัติไปแล้ว/.test(d1.THROWN) && still === 1, d1);
    const d2 = await run(db, 'X', `delete from remaining_payments where id = 'rp-pend'`);
    ok('R2 สลิปที่ยังรอตรวจ ลบ (ปฏิเสธ) ได้ตามปกติ', !!d2.ok && (await q(db, `select id from remaining_payments where id = 'rp-pend'`)).length === 0, d2);

    await db.exec('set session_replication_role = replica;');
    await db.query(`insert into users (id, display_name, auth_id, approved, rank) values ('uZ','Zed',null,true,'bronze')`);
    await db.query(`insert into orders (id, user_id, status, total_deposit) values ('oZ','uZ','approved',300)`);
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount) values ('oiZ','oZ','P1',1,300)`);
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status)
                    values ('t-oiZ','NR-Z-1','P1','uZ','uZ',1,300,1390,100,'active','production')`);
    await db.query(`insert into remaining_payments (id, ticket_id, user_id, amount, slip_url, status, created_at) values ('rp-z','t-oiZ','uZ',100,'https://x/z.jpg','approved',now())`);
    await db.exec('set session_replication_role = origin;');
    const pg = await call(db, 'X', 'ryuma_admin_purge_user', ['uZ']);
    ok('R3 ลบสมาชิกที่มีสลิปอนุมัติแล้ว (ไม่มีประวัติตลาด) ยังลบได้', !!pg.ok && (await q(db, `select id from users where id = 'uZ'`)).length === 0, pg);
  }

  console.log(`\nroundC-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
