/**
 * เทสต์ระดับ SQL ของ v80 (รอบ 1 "ตรวจหาบัค" 2026-10-05) — Postgres จริง (PGlite) รัน migration ครบทุกไฟล์
 *   #7 ลูกค้าที่ยังไม่มีเบอร์ตั้งเบอร์ครั้งแรกได้ (พร้อมที่อยู่ในรอบเดียว) · เบอร์ที่มีแล้วห้ามเปลี่ยนเอง
 *   #3 ด่านหาของ/คูปอง ข้อความมีคำนำหน้า ryuma: (แอปแยกถาวร/ชั่วคราวจากคำนำหน้านี้)
 * รัน: npm run audit:sql
 */
import type { PGlite } from '@electric-sql/pglite';
import { bootDb, asUser } from './pgdb';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const AUTH = { A: '00000000-0000-4000-8000-00000000000a', B: '00000000-0000-4000-8000-00000000000b', X: '00000000-0000-4000-8000-0000000000ad' } as const;
type Who = keyof typeof AUTH;
type Res = { ok?: boolean; THROWN?: string };
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const run = (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  asUser(db, AUTH[who], async () => { await db.query(sql, params); return { ok: true } as Res; }).catch((e) => ({ THROWN: (e as Error).message } as Res));

(async () => {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v80) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  await db.query(`insert into users (id, display_name, auth_id, approved, member_code, is_admin, rank, phone) values
    ('uA','A',$1,true,'RYU-0011',false,'bronze',null), ('uB','B',$2,true,'RYU-0022',false,'bronze','0811111111'), ('uX','X',$3,true,'RYU-0001',true,'bronze','0800000000')`, [AUTH.A, AUTH.B, AUTH.X]);
  await db.exec('set session_replication_role = origin;');

  // ── #7 เบอร์ครั้งแรก ─────────────────────────────────────────────────────────────────────
  const first = await run(db, 'A', `update users set phone = '0899999999', shipping_address = 'บ้านเลขที่ 1' where id = 'uA'`);
  const rowA = (await q(db, `select phone, shipping_address from users where id = 'uA'`))[0];
  ok('U1 ยังไม่มีเบอร์ (สมัคร FB) → ตั้งเบอร์ + ที่อยู่ในรอบเดียวได้ (ProfileGate)', !!first.ok && rowA.phone === '0899999999' && rowA.shipping_address === 'บ้านเลขที่ 1', { first, rowA });
  const again = await run(db, 'A', `update users set phone = '0877777777' where id = 'uA'`);
  ok('U2 มีเบอร์แล้ว → เปลี่ยนเองไม่ได้ (ข้อความ ryuma: protected)', /ryuma: not allowed to modify protected/.test(again.THROWN ?? ''), again);
  const other = await run(db, 'B', `update users set phone = null where id = 'uB'`);
  ok('U3 ล้างเบอร์ที่มีอยู่ก็ไม่ได้', /protected/.test(other.THROWN ?? ''), other);
  const addr = await run(db, 'B', `update users set shipping_address = 'addr B' where id = 'uB'`);
  ok('U4 แก้ที่อยู่อย่างเดียวยังได้เหมือนเดิม', !!addr.ok, addr);
  const adm = await run(db, 'X', `update users set phone = '0866666666' where id = 'uB'`);
  ok('U5 แอดมินแก้เบอร์ลูกค้าได้', !!adm.ok && (await q(db, `select phone from users where id = 'uB'`))[0].phone === '0866666666', adm);

  // ── #3 ด่านหาของ/คูปอง มีคำนำหน้า ryuma: ─────────────────────────────────────────────────
  const srcBad = await run(db, 'A', `insert into sourcing_requests (id, user_id, maker_name, franchise_name, character_name, status, price) values ('sr1','uA','M','F','C','quoted',999)`);
  ok('S1 ลูกค้าสร้างคำขอหาของพร้อมราคาเอง → ปฏิเสธด้วย ryuma: (แอปรู้ว่าถาวร ไม่วน)', /^ryuma: /.test(srcBad.THROWN ?? ''), srcBad);
  const srcOk = await run(db, 'A', `insert into sourcing_requests (id, user_id, maker_name, franchise_name, character_name) values ('sr2','uA','M','F','C')`);
  const srcQuote = await run(db, 'A', `update sourcing_requests set price = 500 where id = 'sr2'`);
  const srcStatus = await run(db, 'A', `update sourcing_requests set status = 'working' where id = 'sr2'`);
  ok('S2 ลูกค้าแก้ราคา/ข้ามสถานะเอง → ปฏิเสธด้วย ryuma: ทั้งคู่ · สร้างปกติผ่าน', !!srcOk.ok && /^ryuma: /.test(srcQuote.THROWN ?? '') && /^ryuma: /.test(srcStatus.THROWN ?? ''), { srcOk, srcQuote, srcStatus });
  const fns = await q(db, `select proname from pg_proc where proname in ('ryuma_guard_sourcing','ryuma_guard_coupon_grant','guard_user_columns') and prosrc like '%ryuma:%' and prosrc not like '%exception ''quote fields%'`);
  ok('S3 ฟังก์ชันด่านทั้ง 3 ตัวเป็นรุ่น v80 (ทุก raise มี ryuma:)', fns.length === 3, fns);

  console.log(`\nround1-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
