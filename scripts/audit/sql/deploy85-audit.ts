/**
 * เทสต์ระดับ SQL ของ v85 (audit 2026-10-12: production ไม่มี v74) — Postgres จริง (PGlite)
 *   A) chain เต็ม (v74 อยู่แล้ว + v85 ทับซ้ำ) บูตผ่าน · ryuma_schema_check ครบ 25 · ลูกค้าได้ผลว่าง · anon เรียกไม่ได้
 *   B) จำลอง production (ทุกไฟล์ ยกเว้น v74 และ v85): ไฟนอลพัง (market_rev) = อาการจริงที่เจอ
 *   C) production + v85 → catalog (ฟังก์ชัน/สิทธิ์/trigger/policy/คอลัมน์) เหมือน chain เต็มทุกตัว · รัน v85 ซ้ำก็ยังเหมือน
 *   D) production + v85: ดีลกระดานไฟนอลได้ (-T1) · self-heal ตั๋วซ้ำถูกปฏิเสธ
 * รัน: npm run audit:sql
 */
import { mkdtempSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { bootDb, asUser, rpc, splitSql, BELL_ALL } from './pgdb';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 1500)); }
};
const AUTH = { A: '00000000-0000-4000-8000-00000000085a', B: '00000000-0000-4000-8000-00000000085b', X: '00000000-0000-4000-8000-0000000008ad' } as const;
type Who = keyof typeof AUTH;
type Res = Record<string, any> & { THROWN?: string };
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const call = (db: PGlite, who: Who, fn: string, args: unknown[] = []) =>
  asUser(db, AUTH[who], () => rpc<Res>(db, fn, args)).catch((e) => ({ THROWN: (e as Error).message } as Res));
const asQ = (db: PGlite, who: Who | null, sql: string) =>
  asUser(db, who ? AUTH[who] : null, () => q(db, sql)).catch((e) => [{ THROWN: (e as Error).message }]);
const SLIP = 'https://abcdefghijklmnop.supabase.co/storage/v1/object/public/logos/mkslip/1.jpg';
const PAY = { account_name: 'Alice A', promptpay: '0812345678' };
const V85 = readFileSync(join('supabase', 'migration_deploy_v85.sql'), 'utf8');

async function applyV85(db: PGlite): Promise<string[]> {
  const errs: string[] = [];
  for (const stmt of splitSql(V85)) { try { await db.exec(stmt); } catch (e) { errs.push((e as Error).message); } }
  return errs;
}

/** ภาพรวม catalog ที่ต้องเหมือนกัน: ฟังก์ชัน (body/secdef/config/ACL) · trigger · policy · คอลัมน์ */
async function catalog(db: PGlite): Promise<Set<string>> {
  const rows = [
    ...(await q(db, `select 'fn' k, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' n,
        md5(regexp_replace(p.prosrc, '\\s+', ' ', 'g')) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '') v
        from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'`)),
    ...(await q(db, `select 'trg' k, c.relname || '.' || t.tgname n, p.proname || '|' || t.tgtype::text || '|' || t.tgenabled::text v
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal`)),
    ...(await q(db, `select 'pol' k, tablename || '.' || policyname n, cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') v
        from pg_policies where schemaname = 'public'`)),
    ...(await q(db, `select 'col' k, table_name || '.' || column_name n, data_type || '|' || is_nullable || '|' || coalesce(column_default, '') v
        from information_schema.columns where table_schema = 'public'`)),
  ];
  return new Set(rows.map((r) => `${r.k} ${r.n} ${r.v}`));
}
const diff = (a: Set<string>, b: Set<string>) => ({ onlyA: [...a].filter((x) => !b.has(x)), onlyB: [...b].filter((x) => !a.has(x)) });

async function fixtures(db: PGlite) {
  await db.exec('set session_replication_role = replica;');
  const u = (id: string, auth: string, admin = false, mc = '') =>
    db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank, payout_info) values ($1,$1,$2,true,'addr',$3,$4,'bronze',$5)`, [id, auth, mc, admin, PAY]);
  await u('uA', AUTH.A, false, 'RYU-0851'); await u('uB', AUTH.B, false, 'RYU-0852'); await u('uX', AUTH.X, true, 'RYU-0001');
  await db.query(BELL_ALL);
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status) values ('P1','Series One',1690,300,'production')`);
  await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ('o1','uA','approved',now(),600)`);
  for (const i of [1, 2]) {
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit, std_deposit) values ($1,'o1','P1',1,300,1690,300,300)`, [`oi${i}`]);
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at)
                    values ($1,$2,'P1','uA','uA',1,300,1390,0,'active','production',now())`, [`t-oi${i}`, `NR-2026-10-85${i}`]);
  }
  await db.query(`insert into app_config (key, value) values ('market_public', '{"enabled": true}') on conflict (key) do update set value = excluded.value`);
  await db.exec('set session_replication_role = origin;');
}

/** ลงขาย → จอง → โอน+สลิป → คนขายยืนยัน → แอดมินโอนสิทธิ์ */
async function boardDeal(db: PGlite, ticketId: string) {
  const l = await call(db, 'A', 'ryuma_market_list', [ticketId, 1, 900, PAY]);
  const r = await call(db, 'B', 'ryuma_market_reserve', [l.id]);
  const p = await call(db, 'B', 'ryuma_market_pay', [l.id, SLIP]);
  const c = await call(db, 'A', 'ryuma_market_seller_confirm', [l.id]);
  const f = await call(db, 'X', 'ryuma_market_finalize', [l.id, null]);
  return { l, r, p, c, f };
}

(async () => {
  // สภาพ "ตอนรัน v85" — ใช้เฉพาะไฟล์ถึง v85 (ไฟล์ใหม่กว่า เช่น v86 ทับตัวตรวจต่อ จึงไม่นำมาเทียบ)
  const ver = (f: string) => (f === 'schema.sql' ? 0 : Number(/_v(\d+)/.exec(f)?.[1] ?? 9999));
  const upTo = (n: number, skip: string[] = []) => {
    const d = mkdtempSync(join(tmpdir(), 'ryuma-v85-'));
    for (const f of readdirSync('supabase')) if (f.endsWith('.sql') && ver(f) <= n && !skip.includes(f)) copyFileSync(join('supabase', f), join(d, f));
    return d;
  };
  // ── A) chain เต็มถึง v85 (v74 อยู่แล้ว และ v85 รันทับ) ──────────────────────────────────────
  const full = await bootDb(upTo(85));
  ok('A1 chain เต็ม (รวม v85 ที่ทับ v74 ซ้ำ) บูตผ่าน 0 error', full.errors.length === 0, full.errors.slice(0, 3));
  const fullCat = await catalog(full.db);
  const chk = await q(full.db, `select * from ryuma_schema_check()`);
  ok('A2 ryuma_schema_check (SQL Editor / ไม่มี session) = 25 แถว true ทั้งหมด', chk.length === 25 && chk.every((r) => r.ok === true), chk.filter((r) => !r.ok));
  await fixtures(full.db);
  const cust = await asQ(full.db, 'A', `select * from ryuma_schema_check()`);
  ok('A3 ลูกค้าเรียกได้แต่ได้ผลว่าง (ไม่บอกโครงสร้างฐานข้อมูล)', Array.isArray(cust) && cust.length === 0, cust);
  const adm = await asQ(full.db, 'X', `select * from ryuma_schema_check()`);
  ok('A4 แอดมินได้ 25 แถว', adm.length === 25 && adm.every((r) => r.ok === true), adm.slice(0, 2));
  const anon = await asQ(full.db, null, `select * from ryuma_schema_check()`);
  ok('A5 คนไม่ล็อกอินเรียกไม่ได้ (permission denied)', /permission denied/.test(String(anon[0]?.THROWN ?? '')), anon);

  // ── B) จำลอง production: ทุกไฟล์ ยกเว้น v74 และ v85 ───────────────────────────────────────
  const dir = upTo(84, ['migration_roundA_v74.sql']);
  const prod = await bootDb(dir);
  ok('B1 chain แบบ production (ไม่มี v74) บูตผ่าน 0 error', prod.errors.length === 0, prod.errors.slice(0, 3));
  await fixtures(prod.db);
  const broken = await boardDeal(prod.db, 't-oi1');
  ok('B2 อาการจริง: ไม่มี v74 → ลงขาย/จอง/โอน/ยืนยันผ่าน แต่ไฟนอลพัง (market_rev)', !!broken.l.ok && !!broken.c.ok && /market_rev/.test(broken.f.THROWN ?? ''), broken.f);

  // ── C) production + v85 ─────────────────────────────────────────────────────────────────
  const fresh = await bootDb(dir);
  const e1 = await applyV85(fresh.db);
  ok('C1 v85 รันบนฐานแบบ production ผ่าน 0 error', e1.length === 0, e1.slice(0, 3));
  const d1 = diff(fullCat, await catalog(fresh.db));
  ok('C2 หลัง v85: catalog เหมือน chain เต็มทุกตัว (ฟังก์ชัน/สิทธิ์/trigger/policy/คอลัมน์)', d1.onlyA.length === 0 && d1.onlyB.length === 0, d1);
  const e2 = await applyV85(fresh.db);
  const d2 = diff(fullCat, await catalog(fresh.db));
  ok('C3 รัน v85 ซ้ำอีกรอบ: ไม่ error และยังเหมือน chain เต็ม (ไม่ย้อนอะไร)', e2.length === 0 && d2.onlyA.length === 0 && d2.onlyB.length === 0, { e2, d2 });
  const chk2 = await q(fresh.db, `select * from ryuma_schema_check()`);
  ok('C4 fingerprint ท้ายไฟล์: ok_count 25 / total 25', chk2.length === 25 && chk2.every((r) => r.ok === true), chk2.filter((r) => !r.ok));
  const chkPre = await q(prod.db, `select count(*)::int n from pg_proc where proname = 'ryuma_schema_check'`);
  ok('C5 ก่อนรัน v85 ไม่มีตัวตรวจ (หน้าแอดมินจะขึ้น "ยังไม่ได้รัน v85")', chkPre[0].n === 0);

  // ── D) production + v85: ใช้งานจริง ───────────────────────────────────────────────────────
  await fixtures(fresh.db);
  const good = await boardDeal(fresh.db, 't-oi1');
  const moved = (await q(fresh.db, `select owner_id, ticket_no, market_rev from preorder_tickets where id = 't-oi1'`))[0];
  ok('D1 หลัง v85: ดีลกระดานไฟนอลได้ · ตั๋วย้ายไปผู้ซื้อ + เลข -T1 + market_rev ขยับ', !!good.f.ok && moved.owner_id === 'uB' && /-T1$/.test(moved.ticket_no) && Number(moved.market_rev) > 0, { f: good.f, moved });
  const dup = await asUser(fresh.db, AUTH.A, () => q(fresh.db, `insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status)
      values ('t-oi2-dup','NR-X','P1','uA','uA',1,300,0,0,'active','arrived')`).then(() => 'inserted')).catch((e) => (e as Error).message);
  const dupId = await asUser(fresh.db, AUTH.A, () => q(fresh.db, `insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status)
      values ('t-oi2','NR-Y','P1','uA','uA',1,300,0,0,'active','arrived') on conflict (id) do nothing`).then(() => 'ok')).catch((e) => (e as Error).message);
  const t2 = (await q(fresh.db, `select remaining_amount, product_status from preorder_tickets where id = 't-oi2'`))[0];
  ok('D2 ลูกค้ายิงตั๋วซ้ำ/แก้ยอดผ่าน REST ไม่ได้ (M01): ตั๋วเดิมไม่เปลี่ยน · ตั๋วใหม่ไม่เกิด', dup !== 'inserted' && Number(t2.remaining_amount) === 1390 && t2.product_status === 'production', { dup, dupId, t2 });

  console.log(`\ndeploy85-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
