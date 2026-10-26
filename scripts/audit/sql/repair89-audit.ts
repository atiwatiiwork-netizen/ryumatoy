/**
 * เรื่องซ่อม v89 — เทสต์ RLS + trigger ryuma_guard_repair บน Postgres จริง (PGlite · migration ครบทุกไฟล์)
 *   ลูกค้ายื่นได้/ไม่ได้ตามกฎ · แก้ได้ 3 จังหวะ · ช่องแอดมินแตะไม่ได้ · ส่งซ้ำไม่พัง · แอดมินทำได้ทุกอย่าง
 * รัน: npx --yes tsx scripts/audit/sql/repair89-audit.ts
 */
import { bootDb, asUser } from './pgdb';
import type { PGlite } from '@electric-sql/pglite';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const AUTH = { C: '00000000-0000-4000-8000-000000000101', D: '00000000-0000-4000-8000-000000000102', S: '00000000-0000-4000-8000-000000000103', X: '00000000-0000-4000-8000-000000000109' } as const;
type Who = keyof typeof AUTH | 'anon';
type Res = { ok: boolean; rows: Record<string, any>[]; err?: string };
const run = (db: PGlite, who: Who, sql: string, params: unknown[] = []): Promise<Res> =>
  asUser(db, who === 'anon' ? null : AUTH[who], async () => ({ ok: true, rows: (await db.query<Record<string, any>>(sql, params)).rows } as Res))
    .catch((e) => ({ ok: false, rows: [], err: (e as Error).message }));
const claim = async (db: PGlite, id: string) => (await db.query<Record<string, any>>(`select * from repair_claims where id = $1`, [id])).rows[0];
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

async function main() {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v89) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  await db.query(`insert into users (id, display_name, auth_id, approved, member_code, is_admin, rank, phone) values
    ('uC','ลูกค้า C',$1,true,'RYU-0101',false,'bronze','0811111111'),
    ('uD','ลูกค้า D',$2,true,'RYU-0102',false,'bronze','0822222222'),
    ('uS','ระงับ S',$3,true,'RYU-0103',false,'bronze','0833333333'),
    ('uX','แอดมิน',$4,true,'RYU-0001',true,'bronze','0800000000')`, [AUTH.C, AUTH.D, AUTH.S, AUTH.X]);
  await db.query(`update users set suspended = true where id = 'uS'`);
  await db.query(`insert into manufacturers (id, name) values ('mk','Maker') on conflict do nothing`);
  await db.query(`insert into franchises (id, name, abbr) values ('fr','Series','SR') on conflict do nothing`);
  await db.query(`insert into products (id, series_name, franchise_id, manufacturer_id, wcf_type, images, price_total, deposit_amount, is_stock, status)
                  values ('P1','Zoro','fr','mk','wcf','{}',1890,300,false,'delivered')`);
  const tk = (id: string, owner: string, status: string, shipped: string | null, delivery: string | null = null) =>
    db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at, shipped_out_at, delivery)
              values ($1,$2,'P1',$3,$3,1,300,1590,1590,$4,'delivered',now(),$5,$6)`, [id, id.toUpperCase(), owner, status, shipped, delivery]);
  await tk('t1', 'uC', 'shipped', ago(2));                         // ปกติ → ยื่นได้ (กำหนด +18 วัน)
  await tk('t2', 'uC', 'shipped', ago(19));                        // เกินกำหนด (ส่งพัสดุ 15+3)
  await tk('t3', 'uC', 'active', null);                            // ยังไม่ส่ง
  await tk('t4', 'uD', 'shipped', ago(1));                         // ของคนอื่น
  await tk('t5', 'uC', 'shipped', ago(16), '{"method":"pickup","requested_at":"2026-10-01"}'); // รับเอง 16 วัน → เกิน (ไม่บวกเผื่อขนส่ง)
  await tk('t6', 'uC', 'shipped', ago(17));                        // ส่งพัสดุ 17 วัน → ยังทัน
  await tk('t7', 'uC', 'shipped', null);                           // ตั๋วเก่า ไม่มีวันส่ง
  await tk('t8', 'uS', 'shipped', ago(1));                         // ของสมาชิกที่ถูกระงับ
  await db.exec('set session_replication_role = origin;');

  const INS = `insert into repair_claims (id, ticket_id, user_id, status, description, images, tech_address, admin_note) values ($1,$2,$3,'filed','แขนหัก','["a.jpg"]',$4,$5)`;

  // ── ยื่นเรื่อง ──
  const i1 = await run(db, 'C', INS, ['c1', 't1', 'uC', 'HACK', 'HACK']);
  const c1 = await claim(db, 'c1');
  ok('I1 ลูกค้ายื่นเรื่องใบที่ส่งแล้วได้', i1.ok && c1?.status === 'filed', i1.err);
  ok('I2 server ล้างช่องแอดมินที่แอปแอบส่งมา', c1?.tech_address === null && c1?.admin_note === null);
  // จุดตัด = 00:00 ไทยของ (วันส่ง + 15 + 3 + 1) — สูตรเดียวกับ repair.ts
  const cutoff = (shippedIso: string, days: number) => { const b = new Date(new Date(shippedIso).getTime() + 7 * 3_600_000); return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 7 * 3_600_000 + days * DAY; };
  ok('I3 server คำนวณจุดตัด = เที่ยงคืนไทยหลังวันที่ 18 (ส่งพัสดุ) ตรงสูตร TS', c1 && new Date(c1.deadline_at).getTime() === cutoff(c1.shipped_out_at, 19), c1?.deadline_at);
  ok('I4 filed_at เป็นของ server', c1 && Math.abs(new Date(c1.filed_at).getTime() - Date.now()) < 60_000);
  const i1b = await run(db, 'C', INS, ['c1', 't1', 'uC', null, null]);
  ok('I5 ส่งแถวเดิมซ้ำ (ลองใหม่) ไม่ error ไม่ซ้ำแถว', i1b.ok && (await db.query<{ n: number }>(`select count(*)::int as n from repair_claims`)).rows[0].n === 1, i1b.err);
  const i2 = await run(db, 'C', INS, ['c2', 't1', 'uC', null, null]);
  ok('I6 ใบเดียวมีเรื่องค้างได้เรื่องเดียว', !i2.ok && /ryuma:.*ค้าง/.test(i2.err ?? ''), i2.err);
  const i3 = await run(db, 'C', INS, ['c3', 't2', 'uC', null, null]);
  ok('I7 เกินกำหนด (ส่งพัสดุ 19 วัน) ยื่นไม่ได้ · ข้อความ ryuma:', !i3.ok && /^.*ryuma: เกินกำหนด/.test(i3.err ?? ''), i3.err);
  const i4 = await run(db, 'C', INS, ['c4', 't3', 'uC', null, null]);
  ok('I8 ใบที่ยังไม่ส่ง ยื่นไม่ได้', !i4.ok && /ryuma:/.test(i4.err ?? ''), i4.err);
  const i5 = await run(db, 'C', INS, ['c5', 't4', 'uC', null, null]);
  ok('I9 ใบของคนอื่น (user_id ตัวเอง) ยื่นไม่ได้', !i5.ok && /ryuma:/.test(i5.err ?? ''), i5.err);
  const i5b = await run(db, 'C', INS, ['c5b', 't4', 'uD', null, null]);
  ok('I10 ปลอมเป็นคนอื่น (user_id ของเขา) โดน RLS', !i5b.ok && /row-level security|ryuma:/.test(i5b.err ?? ''), i5b.err);
  const i6 = await run(db, 'C', INS, ['c6', 't5', 'uC', null, null]);
  ok('I11 รับเอง 16 วัน → เกิน (ไม่บวกเผื่อขนส่ง)', !i6.ok && /เกินกำหนด/.test(i6.err ?? ''), i6.err);
  const i7 = await run(db, 'C', INS, ['c7', 't6', 'uC', null, null]);
  ok('I12 ส่งพัสดุ 17 วัน → ยังทัน', i7.ok, i7.err);
  const i8 = await run(db, 'C', INS, ['c8', 't7', 'uC', null, null]);
  ok('I13 ตั๋วเก่าไม่มีวันส่ง ยื่นไม่ได้', !i8.ok && /ไม่มีวันที่ส่ง/.test(i8.err ?? ''), i8.err);
  const i9 = await run(db, 'C', `insert into repair_claims (id, ticket_id, user_id, status) values ('c9','t1','uC','address_sent')`);
  ok('I14 ยื่นข้ามขั้น (status ไม่ใช่ filed) ไม่ได้', !i9.ok, i9.err);
  const i10 = await run(db, 'S', INS, ['c10', 't8', 'uS', null, null]);
  ok('I15 สมาชิกที่ถูกระงับ ยื่นไม่ได้ (RLS)', !i10.ok && /row-level security/.test(i10.err ?? ''), i10.err);
  const i11 = await run(db, 'anon', INS, ['c11', 't1', 'uC', null, null]);
  ok('I16 anon ยื่นไม่ได้', !i11.ok, i11.err);

  // ── อ่าน ──
  ok('R1 เจ้าของอ่านเรื่องตัวเองได้', (await run(db, 'C', `select id from repair_claims order by id`)).rows.map((r) => r.id).join() === 'c1,c7');
  ok('R2 คนอื่นอ่านไม่เห็น', (await run(db, 'D', `select id from repair_claims`)).rows.length === 0);
  ok('R3 anon อ่านไม่เห็น', (await run(db, 'anon', `select id from repair_claims`)).rows.length === 0);
  const r4 = await run(db, 'X', `select id from repair_claims`);
  ok('R4 แอดมินเห็นทุกเรื่อง', r4.rows.length === 2, r4);
  ok('R5 ลูกค้าที่อนุมัติแล้วอ่าน repair_config ได้ (ตรา v=89)', (await run(db, 'C', `select value from app_config where key = 'repair_config'`)).rows[0]?.value?.v === 89);

  // ── เดินสถานะ ──
  const u1 = await run(db, 'C', `update repair_claims set status = 'sent_to_tech', out_carrier = 'jt', out_tracking = 'JT1', out_sent_at = now() where id = 'c1'`);
  ok('U1 ลูกค้าข้ามขั้น (filed → sent_to_tech) ไม่ได้', !u1.ok && /ryuma:/.test(u1.err ?? ''), u1.err);
  const u2 = await run(db, 'C', `update repair_claims set description = 'แขนหัก ฐานร้าว', images = '["a.jpg","b.jpg"]', user_id = 'uD', filed_at = '2020-01-01' where id = 'c1'`);
  const c1b = await claim(db, 'c1');
  ok('U2 filed: ลูกค้าแก้อาการ/รูปได้ · ช่อง server ถูกตรึง (user_id/filed_at ไม่เปลี่ยน)', u2.ok && c1b.description === 'แขนหัก ฐานร้าว' && c1b.user_id === 'uC' && String(c1b.filed_at) === String(c1.filed_at), { err: u2.err, c1b: { d: c1b?.description, u: c1b?.user_id, f: c1b?.filed_at, f0: c1?.filed_at } });
  const u3 = await run(db, 'C', `update repair_claims set tech_address = 'ME' where id = 'c1'`);
  ok('U3 ลูกค้าใส่ที่อยู่ช่างเองไม่ได้', !u3.ok && /เฉพาะแอดมิน/.test(u3.err ?? ''), u3.err);
  const a1 = await run(db, 'X', `update repair_claims set status = 'address_sent', tech_address = 'ช่าง A', address_sent_at = now(), address_sent_by = 'uX' where id = 'c1'`);
  ok('A1 แอดมินส่งที่อยู่ช่าง', a1.ok && (await claim(db, 'c1')).status === 'address_sent', a1.err);
  const u4 = await run(db, 'C', `update repair_claims set status = 'sent_to_tech', out_carrier = 'jt', out_tracking = '' where id = 'c1'`);
  ok('U4 แจ้งเลขว่างไม่ได้', !u4.ok && /ใส่เลขพัสดุ/.test(u4.err ?? ''), u4.err);
  const u5 = await run(db, 'C', `update repair_claims set status = 'sent_to_tech', out_carrier = 'jt', out_tracking = 'JT1', out_sent_at = now(), tech_address = 'X' where id = 'c1'`);
  ok('U5 แจ้งเลขพร้อมแอบแก้ที่อยู่ → ไม่ผ่าน', !u5.ok && /เฉพาะแอดมิน/.test(u5.err ?? ''), u5.err);
  const u6 = await run(db, 'C', `update repair_claims set status = 'sent_to_tech', out_carrier = 'flash', out_tracking = 'FL1', out_sent_at = now() where id = 'c1'`);
  const c1c = await claim(db, 'c1');
  ok('U6 ลูกค้าแจ้งเลขส่งไปช่าง (patch แบบที่แอปส่ง)', u6.ok && c1c.status === 'sent_to_tech' && c1c.out_tracking === 'FL1' && c1c.tech_address === 'ช่าง A', u6.err);
  const u7 = await run(db, 'C', `update repair_claims set status = 'done', received_at = now() where id = 'c1'`);
  ok('U7 ลูกค้ากดได้รับก่อนช่างส่งคืนไม่ได้', !u7.ok && /ryuma:/.test(u7.err ?? ''), u7.err);
  const u8 = await run(db, 'C', `update repair_claims set status = 'rejected', rejected_at = now() where id = 'c1'`);
  ok('U8 ลูกค้าปิดเรื่องเองเป็น rejected ไม่ได้', !u8.ok, u8.err);
  const a2 = await run(db, 'X', `update repair_claims set status = 'returned', back_carrier = 'kerry', back_tracking = 'KR1', back_sent_at = now(), back_sent_by = 'uX' where id = 'c1'`);
  ok('A2 แอดมินแจ้งเลขส่งกลับ', a2.ok && (await claim(db, 'c1')).status === 'returned', a2.err);
  const u9 = await run(db, 'C', `update repair_claims set status = 'done', received_at = now() where id = 'c1'`);
  ok('U9 ลูกค้ากดได้รับของ = จบ', u9.ok && (await claim(db, 'c1')).status === 'done', u9.err);
  const u10 = await run(db, 'C', `update repair_claims set description = 'x' where id = 'c1'`);
  ok('U10 เรื่องจบแล้ว ลูกค้าแก้ไม่ได้', !u10.ok, u10.err);
  const i12 = await run(db, 'C', INS, ['c12', 't1', 'uC', null, null]);
  ok('I17 เรื่องเก่าจบแล้ว → ยื่นใบเดิมใหม่ได้', i12.ok, i12.err);
  const d1 = await run(db, 'D', `update repair_claims set description = 'hack' where id = 'c12'`);
  ok('U11 คนอื่นแก้เรื่องของเราไม่ได้ (RLS กรองแถว → 0 แถว)', d1.ok && (await claim(db, 'c12')).description === 'แขนหัก', d1.err);
  const del = await run(db, 'C', `delete from repair_claims where id = 'c12'`);
  ok('U12 ลูกค้าลบเรื่องไม่ได้', (await claim(db, 'c12')) !== undefined, del.err);
  const a3 = await run(db, 'X', `update repair_claims set status = 'rejected', rejected_at = now(), rejected_by = 'uX', reject_reason = 'เกินกำหนด', admin_note = 'n' where id = 'c12'`);
  ok('A3 แอดมินไม่รับเรื่อง + โน้ต', a3.ok && (await claim(db, 'c12')).status === 'rejected', a3.err);

  // ── ตั้งค่า + fingerprint ──
  const cfg = await run(db, 'X', `update app_config set value = '{"days":20,"transit_days":0,"address":"ช่าง B","v":89}' where key = 'repair_config' returning key`);
  ok('S1 แอดมินแก้ repair_config ได้', cfg.ok && cfg.rows.length === 1, cfg.err);
  const cfgC = await run(db, 'C', `update app_config set value = '{}' where key = 'repair_config' returning key`);
  ok('S2 ลูกค้าแก้ repair_config ไม่ได้', !cfgC.ok || cfgC.rows.length === 0, cfgC.err);
  const i13 = await run(db, 'C', INS, ['c13', 't2', 'uC', null, null]); // 19 วัน · กฎใหม่ 20+0 → ทัน
  ok('I18 กฎวันตามตั้งค่าใหม่ (20+0): 19 วันยื่นได้', i13.ok, i13.err);
  const fp = (await db.query<Record<string, any>>(`select
    (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'repair_claims') as cols,
    (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'repair_claims') as policies,
    (select count(*)::int from pg_trigger where tgname = 'repair_guard' and not tgisinternal) as trig,
    (select count(*)::int from app_config where key = 'repair_config' and (value->>'v')::int = 89) as cfg_v89`)).rows[0];
  ok('F1 fingerprint cols 26 · policies 4 · trig 1 · cfg_v89 1', fp.cols === 26 && fp.policies === 4 && fp.trig === 1 && fp.cfg_v89 === 1, fp);

  console.log(`repair89-audit: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
