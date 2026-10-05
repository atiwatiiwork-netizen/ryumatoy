/**
 * เทสต์ระดับ SQL ของ v79 (คำตอบเจ้าของหลังดูพรีวิว 2026-10-05) — Postgres จริง (PGlite) รัน migration ครบทุกไฟล์
 * ถอน/ยกเลิกพร้อมเหตุผล (บังคับ) · cool down 2 วัน · push แจ้งเหตุผล
 * รัน: npm run audit:sql
 */
import type { PGlite } from '@electric-sql/pglite';
import { bootDb, asUser, rpc } from './pgdb';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const AUTH = { A: '00000000-0000-4000-8000-00000000000a', B: '00000000-0000-4000-8000-00000000000b', X: '00000000-0000-4000-8000-0000000000ad' } as const;
type Who = keyof typeof AUTH;
type Res = Record<string, any> & { THROWN?: string };
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const call = (db: PGlite, who: Who, fn: string, args: unknown[] = []) =>
  asUser(db, AUTH[who], () => rpc<Res>(db, fn, args)).catch((e) => ({ THROWN: (e as Error).message } as Res));
const PAY = { account_name: 'Alice A', promptpay: '0812345678' };

(async () => {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v79) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  const u = (id: string, auth: string, admin = false, mc = '') =>
    db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank, payout_info) values ($1,$1,$2,true,'addr',$3,$4,'bronze',$5)`, [id, auth, mc, admin, PAY]);
  await u('uA', AUTH.A, false, 'RYU-0011'); await u('uB', AUTH.B, false, 'RYU-0022'); await u('uX', AUTH.X, true, 'RYU-0001');
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status) values ('P1','Series One',1690,300,'production')`);
  await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ('o1','uA','approved',now(),3000)`);
  for (let i = 1; i <= 4; i++) {
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit, std_deposit) values ($1,'o1','P1',1,300,1690,300,300)`, [`oi${i}`]);
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at)
                    values ($1,$2,'P1','uA','uA',1,300,1390,0,'active','production',now())`, [`t-oi${i}`, `NR-2026-10-50${i}`]);
  }
  await db.query(`insert into app_config (key, value) values ('market_direct', '{"enabled": true}'), ('market_public', '{"enabled": true}')`);
  await db.exec('set session_replication_role = origin;');
  const codeB = (await call(db, 'B', 'ryuma_wallet_code')).code as string;

  // ── ข้อ 3: ถอนพร้อมเหตุผล ─────────────────────────────────────────────────────────────
  const o = await call(db, 'A', 'ryuma_market_offer', ['t-oi1', 1, 500, codeB, PAY, 'uB']);
  await call(db, 'B', 'ryuma_market_payout', [o.id]); // ผู้รับเปิดหน้าโอนแล้ว
  const n1 = await call(db, 'A', 'ryuma_market_cancel', [o.id]);
  const n2 = await call(db, 'A', 'ryuma_market_cancel', [o.id, ' ']);
  ok('F1 ถอนข้อเสนอโดยไม่ใส่เหตุผล → reason_required (ยังไม่ถอน)', n1.error === 'reason_required' && n2.error === 'reason_required'
    && (await q(db, `select status from ticket_transfers where id = $1`, [o.id]))[0].status === 'reserved', { n1, n2 });
  const y = await call(db, 'A', 'ryuma_market_cancel', [o.id, 'ส่งผิดคน · จะส่งใหม่']);
  const row = (await q(db, `select status, cancel_reason, cancel_note, to_user_id from ticket_transfers where id = $1`, [o.id]))[0];
  ok('F2 ผู้รับเปิดหน้าโอนแล้ว ถอนได้เมื่อใส่เหตุผล · เก็บเหตุผล · ชื่อผู้รับยังอยู่', !!y.ok && row.status === 'cancelled' && row.cancel_reason === 'seller' && row.cancel_note === 'ส่งผิดคน · จะส่งใหม่' && row.to_user_id === 'uB', { y, row });
  const pw = await call(db, 'A', 'ryuma_market_push_targets', [o.id, 'withdrawn']);
  ok('F3 push ถึงผู้รับมีเหตุผล + บอกให้แนบสลิปถ้าโอนแล้ว', /เหตุผล: ส่งผิดคน/.test(pw.body ?? '') && /แนบสลิป/.test(pw.body ?? ''), pw);
  const late = await call(db, 'B', 'ryuma_market_pay', [o.id, 'https://x/late.jpg']);
  ok('F4 ผู้รับโอนไปแล้ว → แนบสลิปได้ เก็บเป็นหลักฐานให้ร้านเคลียร์ (late slip ยังทำงาน)', late.error === 'withdrawn' && late.recorded === true, late);
  const long = await call(db, 'A', 'ryuma_market_offer', ['t-oi2', 1, 500, codeB, PAY, 'uB']);
  await call(db, 'A', 'ryuma_market_cancel', [long.id, 'x'.repeat(500)]);
  ok('F5 เหตุผลยาวเกินถูกตัดที่ 300 ตัวอักษร', ((await q(db, `select cancel_note from ticket_transfers where id = $1`, [long.id]))[0].cancel_note ?? '').length === 300);
  const l = await call(db, 'A', 'ryuma_market_list', ['t-oi3', 1, 700]);
  const lc = await call(db, 'A', 'ryuma_market_cancel', [l.id]);
  ok('F6 ถอนประกาศกระดาน (ยังไม่มีคนจอง) ไม่บังคับเหตุผล', !!l.ok && !!lc.ok, { l, lc });

  // ── ข้อ 5: cool down 2 วัน ────────────────────────────────────────────────────────────
  const d = await call(db, 'A', 'ryuma_market_offer', ['t-oi4', 1, 500, codeB, PAY, 'uB']);
  await call(db, 'B', 'ryuma_market_pay', [d.id, 'https://x/s.jpg']);
  await call(db, 'A', 'ryuma_market_seller_confirm', [d.id]);
  const fin = await call(db, 'X', 'ryuma_market_finalize', [d.id, null]);
  const reason = async () => (await q(db, `select ryuma_market_block_reason('t-oi4', 'uB', 1) as r`))[0].r;
  const r0 = await reason();
  await db.exec('set session_replication_role = replica;');
  await db.query(`update ticket_transfers set approved_at = now() - interval '47 hours' where id = $1`, [d.id]);
  const r1 = await (async () => { await db.exec('set session_replication_role = origin;'); return reason(); })();
  await db.exec('set session_replication_role = replica;');
  await db.query(`update ticket_transfers set approved_at = now() - interval '49 hours' where id = $1`, [d.id]);
  await db.exec('set session_replication_role = origin;');
  const r2 = await reason();
  ok('F7 ได้ใบมาแล้ว cool down 2 วัน: เพิ่งได้/47 ชม. = resell_hold · 49 ชม. = ส่งต่อได้', !!fin.ok && r0 === 'resell_hold' && r1 === 'resell_hold' && r2 !== 'resell_hold', { fin, r0, r1, r2 });

  console.log(`\nownerfb-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
