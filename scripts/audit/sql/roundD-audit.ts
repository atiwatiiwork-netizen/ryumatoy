/**
 * เทสต์ระดับ SQL ของรอบ D (v77) — Postgres จริง (PGlite) รัน migration ครบทุกไฟล์
 * สิทธิ์อ่าน/เขียนตั๋ว (คนถือ + แอดมินเท่านั้น) + ไฟนอลดึงโบนัสยศรายเดือนคืนจากคนขาย
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
  X: '00000000-0000-4000-8000-0000000000ad',
} as const;
type Who = keyof typeof AUTH;
type Res = Record<string, any> & { THROWN?: string };
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const call = (db: PGlite, who: Who, fn: string, args: unknown[] = []) =>
  asUser(db, AUTH[who], () => rpc<Res>(db, fn, args)).catch((e) => ({ THROWN: (e as Error).message } as Res));
const run = (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  asUser(db, AUTH[who], async () => { const r = await db.query<Record<string, any>>(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows ?? 0 } as Res; })
    .catch((e) => ({ THROWN: (e as Error).message } as Res));
const PAY = { account_name: 'Alice A', promptpay: '0812345678' };

async function boot() {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v77) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  const u = (id: string, name: string, auth: string, admin = false, mc = '') =>
    db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank) values ($1,$2,$3,true,'addr',$4,$5,'bronze')`, [id, name, auth, mc, admin]);
  await u('uA', 'Alice', AUTH.A, false, 'RYU-0011'); await u('uB', 'Bob', AUTH.B, false, 'RYU-0022'); await u('uX', 'Admin', AUTH.X, true, 'RYU-0001');
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status) values ('P1','Series One',1690,300,'production')`);
  await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ('o1','uA','approved',now(),3000)`);
  const tk = async (n: number, qty: number) => {
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit, std_deposit) values ($1,'o1','P1',$2,$3,1690,300,300)`, [`oi${n}`, qty, 300 * qty]);
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at)
                    values ($1,$2,'P1','uA','uA',$3,$4,$5,0,'active','production',now())`, [`t-oi${n}`, `NR-2026-10-30${n}`, qty, 300 * qty, 1390 * qty]);
  };
  await tk(1, 1); await tk(2, 2); await tk(3, 1); await tk(4, 1); await tk(5, 4);
  // โบนัสยศที่ผูกกับใบ (ใช้เป็นส่วนลดไปแล้ว: +share / −share คู่กัน) — สูตรเดียวกับ bonusRows ในแอป
  await db.query(`insert into point_ledger (id, user_id, delta, kind, ref_type, ref_id, note, created_by, created_at) values
    ('pl-mbonus-2026-09-t-oi2','uA',100,'monthly_reward','ticket','t-oi2','โบนัสยศ','uX',now()),
    ('pl-mbonus-use-2026-09-t-oi2','uA',-100,'redeem_remaining','ticket','t-oi2|mbonus','หัก','uX',now()),
    ('pl-mbonus-2026-09-t-oi3','uA',25,'monthly_reward','ticket','t-oi3','โบนัสยศ','uX',now()),
    ('pl-mbonus-2026-09-t-oi5','uA',100,'monthly_reward','ticket','t-oi5','โบนัสยศ','uX',now())`);
  await db.query(`insert into app_config (key, value) values ('market_direct', '{"enabled": true}')`);
  await db.exec('set session_replication_role = origin;');
  return db;
}

async function deal(db: PGlite, ticket: string, qty: number) {
  const code = (await call(db, 'B', 'ryuma_wallet_code')).code as string;
  const o = await call(db, 'A', 'ryuma_market_offer', [ticket, qty, 500, code, PAY, 'uB']);
  if (!o.ok) return { o };
  const p = await call(db, 'B', 'ryuma_market_pay', [o.id, 'https://x/s.jpg']);
  const c = await call(db, 'A', 'ryuma_market_seller_confirm', [o.id]);
  const f = await call(db, 'X', 'ryuma_market_finalize', [o.id, null]);
  return { o, p, c, f, id: o.id as string };
}
const claws = async (db: PGlite, ticket: string) =>
  (await q(db, `select delta from point_ledger where kind = 'reverse_ticket' and ref_id like $1`, [`${ticket}|mbonus-claw|%`])).map((r) => Number(r.delta));

(async () => {
  const db = await boot();

  // ── สิทธิ์ตั๋ว: คนสั่งเดิมอ่าน/เขียนใบที่ขายไปแล้วไม่ได้ ───────────────────────────────────
  {
    const d = await deal(db, 't-oi1', 1);
    ok('S1 ดีลตรงจบครบ (ไฟนอลผ่าน)', !!d.f?.ok, d);
    const a = await run(db, 'A', `select id, delivery from preorder_tickets where id = 't-oi1'`);
    const b = await run(db, 'B', `select id from preorder_tickets where id = 't-oi1'`);
    ok('S2 คนขายมองไม่เห็นใบที่ขายไปแล้ว (เดิม RLS v21 ให้คนสั่งเห็น/เขียนได้) · ผู้รับเห็น', (a.rows ?? []).length === 0 && (b.rows ?? []).length === 1, { a, b });
    const up = await run(db, 'A', `update preorder_tickets set delivery = '{"method":"pickup"}'::jsonb where id = 't-oi1'`);
    const dv = (await q(db, `select delivery from preorder_tickets where id = 't-oi1'`))[0]?.delivery;
    ok('S3 คนขายแก้ตั๋วที่ขายไปแล้วไม่ได้', dv === null, { up, dv });
    const ad = await run(db, 'X', `select id from preorder_tickets where id = 't-oi1'`);
    ok('S4 แอดมินยังเห็นทุกใบ', (ad.rows ?? []).length === 1, ad);
    const own = await run(db, 'A', `select id from preorder_tickets where owner_id = 'uA' order by id`);
    ok('S5 คนขายยังเห็นใบของตัวเองครบ', (own.rows ?? []).map((r: any) => r.id).join(',') === 't-oi2,t-oi3,t-oi4,t-oi5', own);
  }

  // ── ดึงโบนัสยศคืนตอนไฟนอล ─────────────────────────────────────────────────────────
  {
    const d1 = await deal(db, 't-oi2', 1); // แตกขาย 1 ใน 2 ชิ้น
    ok('B1 แตกขาย 1/2 ชิ้น → ดึงโบนัสคืนครึ่งเดียว (−50)', !!d1.f?.ok && JSON.stringify(await claws(db, 't-oi2')) === '[-50]', { f: d1.f, c: await claws(db, 't-oi2') });
    const child = (await q(db, `select id from preorder_tickets where split_from = 't-oi2'`))[0]?.id;
    const ac = await run(db, 'A', `select id from preorder_tickets where id = $1`, [child]);
    ok('B2 คนขายมองไม่เห็นตั๋วลูกที่แตกขายไป', !!child && (ac.rows ?? []).length === 0, ac);
    const again = await call(db, 'X', 'ryuma_market_finalize', [d1.id, null]);
    ok('B3 กดไฟนอลซ้ำ ไม่ดึงซ้ำ', !!again.again && (await claws(db, 't-oi2')).length === 1, { again, c: await claws(db, 't-oi2') });
    const d2 = await deal(db, 't-oi2', 1); // ขายชิ้นที่เหลือ
    const c2 = await claws(db, 't-oi2');
    ok('B4 ขายชิ้นที่เหลือ → ดึงอีก −50 รวมไม่เกินโบนัส 100', !!d2.f?.ok && c2.reduce((s, x) => s + x, 0) === -100 && c2.length === 2, { f: d2.f, c2 });
    const d3 = await deal(db, 't-oi3', 1);
    ok('B5 ขายทั้งใบ → ดึงโบนัสคืนเต็ม (−25)', !!d3.f?.ok && JSON.stringify(await claws(db, 't-oi3')) === '[-25]', await claws(db, 't-oi3'));
    const d4 = await deal(db, 't-oi4', 1);
    ok('B6 ใบที่ไม่มีโบนัส → ไม่มีแถวดึงคืน', !!d4.f?.ok && (await claws(db, 't-oi4')).length === 0);
    // ขายทีละชิ้นจาก 4 ชิ้น (review รอบ D: เดิมดึงเกิน −25 −33 −42 = ครบ 100 ทั้งที่ยังถือ 1 ชิ้น)
    for (let i = 0; i < 3; i++) await deal(db, 't-oi5', 1);
    const c5 = await claws(db, 't-oi5');
    ok('B8 ขาย 3 ใน 4 ชิ้นทีละชิ้น → ดึงคืน −25 ×3 = −75 (ยังถือ 1 ชิ้น)', JSON.stringify(c5) === '[-25,-25,-25]', c5);
    await deal(db, 't-oi5', 1);
    const c5b = await claws(db, 't-oi5');
    ok('B9 ขายชิ้นสุดท้าย → ดึงส่วนที่เหลือ รวม −100 พอดี', c5b.reduce((s, x) => s + x, 0) === -100 && c5b.length === 4, c5b);
    await db.exec(`delete from point_ledger where ref_id like 't-oi5%'`);
    const bal = Number((await q(db, `select coalesce(sum(delta),0) as s from point_ledger where user_id = 'uA'`))[0].s);
    ok('B7 ยอดแต้มคนขาย = −100 (โบนัส 100 ที่ใช้เป็นส่วนลดไปแล้วถูกดึงคืน · โบนัส 25 ได้มาแล้วดึงคืน)', bal === -100, bal);
  }

  console.log(`\nroundD-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
