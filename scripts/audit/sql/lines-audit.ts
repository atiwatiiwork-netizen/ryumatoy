/**
 * เทสต์ระดับ SQL ของ v81 ไลน์ (พรียกไลน์ · 2026-10-07) — Postgres จริง (PGlite) รัน migration ครบทุกไฟล์
 *   ตาราง product_lines + RLS: แอดมินอ่าน/เขียนทุกแถว · ลูกค้าที่อนุมัติแล้วอ่านได้เฉพาะไลน์ active ตอนสวิตช์ใหญ่เปิด ·
 *   anon/ยังไม่อนุมัติ อ่านไม่ได้ · ลูกค้าเขียนไม่ได้ · members ต้องเป็น array · ค่าสวิตช์แปลกๆ ไม่ทำให้ select พัง
 * รัน: npm run audit:sql
 */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { bootDb, asUser, splitSql } from './pgdb';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const AUTH = { A: '00000000-0000-4000-8000-00000000000a', P: '00000000-0000-4000-8000-00000000000c', X: '00000000-0000-4000-8000-0000000000ad' } as const;
type Who = keyof typeof AUTH | 'anon';
type Res = { ok?: boolean; rows?: Record<string, any>[]; THROWN?: string };
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const run = (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  asUser(db, who === 'anon' ? null : AUTH[who], async () => ({ ok: true, rows: (await db.query<Record<string, any>>(sql, params)).rows } as Res))
    .catch((e) => ({ THROWN: (e as Error).message } as Res));
const ids = (r: Res) => (r.rows ?? []).map((x) => x.id).sort().join();

(async () => {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v81) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  await db.query(`insert into users (id, display_name, auth_id, approved, member_code, is_admin, rank, phone) values
    ('uA','A',$1,true,'RYU-0011',false,'bronze','0811111111'),
    ('uP','Pending',$2,false,'RYU-0033',false,'bronze','0822222222'),
    ('uX','X',$3,true,'RYU-0001',true,'bronze','0800000000')`, [AUTH.A, AUTH.P, AUTH.X]);
  await db.query(`insert into product_lines (id, maker_id, name, cover_url, members, active) values
    ('L1','mk','กองโจรเงามายา','c.jpg','[{"id":"m1","name":"Chrollo","product_ids":["p1"],"pin_x":50,"pin_y":40}]',true),
    ('L2','mk','ร่าง','c2.jpg','[]',false)`);
  await db.exec('set session_replication_role = origin;');

  // ── อ่าน ──────────────────────────────────────────────────────────────────────────────────
  ok('R1 anon อ่านไม่ได้เลย', ids(await run(db, 'anon', `select id from product_lines`)) === '');
  ok('R2 สวิตช์ปิด (ไม่มีแถว): ลูกค้าอนุมัติแล้วอ่านไม่ได้', ids(await run(db, 'A', `select id from product_lines`)) === '');
  ok('R3 แอดมินอ่านได้ทุกแถว (รวมร่าง)', ids(await run(db, 'X', `select id from product_lines`)) === 'L1,L2');
  const sw = await run(db, 'X', `insert into app_config (key, value) values ('lines_public', '{"enabled": true}') on conflict (key) do update set value = excluded.value`);
  ok('R4 แอดมินเปิดสวิตช์ได้ (app_config)', !!sw.ok, sw);
  ok('R5 สวิตช์เปิด: ลูกค้าอ่านได้เฉพาะไลน์ active (ร่างยังซ่อน)', ids(await run(db, 'A', `select id from product_lines`)) === 'L1');
  ok('R6 สวิตช์เปิด: สมาชิกที่ยังไม่อนุมัติ/anon ยังอ่านไม่ได้', ids(await run(db, 'P', `select id from product_lines`)) === '' && ids(await run(db, 'anon', `select id from product_lines`)) === '');
  const sw2 = await run(db, 'A', `update app_config set value = '{"enabled": false}' where key = 'lines_public' returning key`);
  ok('R7 ลูกค้าปิด/เปิดสวิตช์เองไม่ได้', (sw2.rows ?? []).length === 0 || !!sw2.THROWN, sw2);
  await run(db, 'X', `update app_config set value = '{"enabled": "yes"}' where key = 'lines_public'`);
  const weird = await run(db, 'A', `select id from product_lines`);
  ok('R8 ค่าสวิตช์แปลก (ไม่ใช่ true) → ถือว่าปิด และ select ไม่พัง', !weird.THROWN && ids(weird) === '', weird);
  await run(db, 'X', `update app_config set value = '{"enabled": true}' where key = 'lines_public'`);
  ok('R9 ryuma_lines_open() = true หลังเปิด', (await q(db, `select ryuma_lines_open() as v`))[0].v === true);

  // ── เขียน ─────────────────────────────────────────────────────────────────────────────────
  const ins = await run(db, 'A', `insert into product_lines (id, maker_id, name, members, active) values ('Lx','mk','hack','[]',true)`);
  ok('W1 ลูกค้าสร้างไลน์เองไม่ได้ (RLS)', /row-level security/i.test(ins.THROWN ?? ''), ins);
  const upd = await run(db, 'A', `update product_lines set name = 'hacked', active = true where id in ('L1','L2') returning id`);
  const after = await q(db, `select id, name, active from product_lines order by id`);
  ok('W2 ลูกค้าแก้ไลน์ไม่ได้ (0 แถว · ร่างยังเป็นร่าง)', (upd.rows ?? []).length === 0 && after[0].name === 'กองโจรเงามายา' && after[1].active === false, { upd, after });
  const del = await run(db, 'A', `delete from product_lines where id = 'L1' returning id`);
  ok('W3 ลูกค้าลบไลน์ไม่ได้', (del.rows ?? []).length === 0 && (await q(db, `select count(*)::int as n from product_lines`))[0].n === 2, del);
  const aIns = await run(db, 'X', `insert into product_lines (id, maker_id, name, cover_url, members, active, created_at, updated_at)
    values ('L3','mk','โฮคาเงะ',null,'[{"id":"m1","name":"Naruto","product_ids":[],"manual_state":"sourcing"}]',false,'2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z')`);
  ok('W4 แอดมินสร้างไลน์ได้ (คอลัมน์ตรงกับที่แอปส่ง: franchise_id/cover_url/note เป็น null ได้)', !!aIns.ok, aIns);
  const aUpd = await run(db, 'X', `update product_lines set cover_url = null, franchise_id = null, note = null, members = '[]' where id = 'L1' returning id`);
  ok('W5 แอดมินล้างรูปปก/เรื่อง/โน้ตเป็น null ได้', (aUpd.rows ?? []).length === 1 && (await q(db, `select cover_url from product_lines where id = 'L1'`))[0].cover_url === null, aUpd);
  const bad = await run(db, 'X', `insert into product_lines (id, maker_id, name, members) values ('L9','mk','x','{"not":"array"}')`);
  ok('W6 members ต้องเป็น array (object → ปฏิเสธ)', /check constraint|product_lines_members_array/i.test(bad.THROWN ?? ''), bad);
  const aDel = await run(db, 'X', `delete from product_lines where id = 'L3' returning id`);
  ok('W7 แอดมินลบไลน์ได้', (aDel.rows ?? []).length === 1, aDel);

  // ── รันซ้ำ (idempotent) ────────────────────────────────────────────────────────────────────
  const again: string[] = [];
  for (const stmt of splitSql(readFileSync('supabase/migration_lines_v81.sql', 'utf8'))) {
    try { await db.exec(stmt); } catch (e) { again.push((e as Error).message); }
  }
  ok('I1 รัน v81 ซ้ำได้ ไม่มี error · ข้อมูลเดิมอยู่ครบ', again.length === 0 && (await q(db, `select count(*)::int as n from product_lines`))[0].n === 2, again);

  console.log(`\nlines-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
