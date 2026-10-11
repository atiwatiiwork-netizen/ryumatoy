/**
 * จำลองสถานการณ์ "กระดานตลาดใบพรี" เฟส 1 บน Postgres จริง (PGlite · migration ครบทุกไฟล์) — เจ้าของ 2026-09-24/10-11
 *   ผู้ขายหลายคน หลายค่าย ลงขาย → ผู้ซื้อจอง/โอน/แนบสลิป → ผู้ขายยืนยัน → แอดมินโอนสิทธิ์ (ยกใบ / แตกขาย)
 *   + ด่านทุกตัวของกระดาน + ข้อค้าง "รอบ 4" ของ audit 1005 (ตลาดก่อนเปิดสวิตช์)
 * รัน: npm run audit:sql
 */
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { bootDb, asUser, rpc, splitSql, BELL_ALL } from './pgdb';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const AUTH: Record<string, string> = {};
const who = ['S1', 'S2', 'S3', 'B1', 'B2', 'B3', 'X', 'S4', 'B4', 'N'] as const;
type Who = typeof who[number];
who.forEach((w, i) => { AUTH[w] = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`; });
type Res = Record<string, any> & { THROWN?: string };
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const call = (db: PGlite, w: Who, fn: string, args: unknown[] = []) =>
  asUser(db, AUTH[w], () => rpc<Res>(db, fn, args)).catch((e) => ({ THROWN: (e as Error).message } as Res));
const raw = async (db: PGlite, sql: string, params: unknown[] = []) => {
  await db.exec('set session_replication_role = replica;');
  try { return await q(db, sql, params); } finally { await db.exec('set session_replication_role = origin;'); }
};
const SLIP = 'https://abcdefghijklmnop.supabase.co/storage/v1/object/public/logos/mkslip/1.jpg';
const PAY = (name: string) => ({ account_name: name, promptpay: '0812345678' });
const ticket = async (db: PGlite, id: string) => (await q(db, `select * from preorder_tickets where id = $1`, [id]))[0];
const deal = async (db: PGlite, id: string) => (await q(db, `select * from ticket_transfers where id = $1`, [id]))[0];
const n = (x: unknown) => Number(x ?? 0);

async function boot() {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  const u = (id: string, name: string, w: Who, mc: string, rank: string, opts: { admin?: boolean; addr?: boolean; pay?: boolean } = {}) =>
    db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank, payout_info)
              values ($1,$2,$3,true,$4,$5,$6,$7,$8)`, [id, name, AUTH[w], opts.addr === false ? null : 'addr', mc, !!opts.admin, rank, opts.pay === false ? null : PAY(name)]);
  await u('uS1', 'Sam', 'S1', 'RYU-0012', 'silver'); await u('uS2', 'Gina', 'S2', 'RYU-0023', 'gold');
  await u('uS3', 'Nick', 'S3', 'RYU-0034', 'bronze'); await u('uB1', 'Bea', 'B1', 'RYU-0045', 'bronze');
  await u('uB2', 'Ben', 'B2', 'RYU-0056', 'silver'); await u('uB3', 'Noaddr', 'B3', 'RYU-0067', 'bronze', { addr: false, pay: false });
  await u('uX', 'Admin', 'X', 'RYU-0001', 'bronze', { admin: true });
  await u('uS4', 'Sora', 'S4', 'RYU-0078', 'silver'); await u('uB4', 'Bow', 'B4', 'RYU-0089', 'bronze'); await u('uN', 'Nobell', 'N', 'RYU-0090', 'bronze');
  await db.query(`insert into manufacturers (id, name) values ('mk-bandai','Bandai'),('mk-mh','MegaHouse'),('mk-bp','Banpresto') on conflict do nothing`);
  await db.query(`insert into franchises (id, name, abbr) values ('fr-op','One Piece','OP'),('fr-nr','Naruto','NR') on conflict do nothing`);
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status, is_stock, manufacturer_id, franchise_id) values
    ('P1','Luffy Gear 5',4000,1000,'production',false,'mk-bandai','fr-op'),
    ('P2','Zoro Enma',5200,1500,'shipping',false,'mk-mh','fr-op'),
    ('P3','Sasuke Susanoo',3000,800,'arrived',false,'mk-bp','fr-nr'),
    ('P4','Open Round',2000,500,'open',false,'mk-bandai','fr-op'),
    ('P5','Special Round',3500,1200,'production',false,'mk-mh','fr-nr')`);
  await db.query(`insert into product_batches (id, product_id, label, price_total, deposit_amount, stock_qty, status) values
    ('B5o','P5','รอบ 2',3500,1200,5,'open'), ('B5c','P5','รอบ 1',3500,1200,0,'closed')`);
  // ตั๋ว: [id, ผู้ถือ, สินค้า, จำนวน, มัดจำ, ค้าง, จ่ายค้างแล้ว, สถานะของ, รอบ]
  const T: [string, string, string, number | null, number, number, number, string, string | null][] = [
    ['t-s1a', 'uS1', 'P1', 1, 1000, 3000, 0, 'production', null],
    ['t-s1b', 'uS1', 'P2', 3, 4500, 11100, 0, 'shipping', null],
    ['t-s1c', 'uS1', 'P3', 1, 800, 2200, 2200, 'arrived', null],
    ['t-s1d', 'uS1', 'P4', 1, 500, 1500, 0, 'open', null],
    ['t-s1e', 'uS1', 'P5', 1, 1200, 2300, 0, 'production', 'B5o'],
    ['t-s1f', 'uS1', 'P5', 1, 1200, 2300, 0, 'production', 'B5c'],
    ['t-s1g', 'uS1', 'P1', 1, 1000, 3000, 0, 'production', null],
    ['t-s1h', 'uS1', 'P1', 1, 1000, 3000, 0, 'production', null],
    ['t-s1i', 'uS1', 'P1', 1, 1000, 3000, 0, 'production', null],
    ['t-s1j', 'uS1', 'P1', 1, 1000, 3000, 0, 'production', null],
    ['t-s2a', 'uS2', 'P1', 1, 500, 3500, 0, 'production', null],
    ['t-s2b', 'uS2', 'P3', 1, 800, 2200, 0, 'arrived', null],
    ['t-s2k', 'uS2', 'P3', 1, 800, 2200, 0, 'arrived', null],
    ['t-s3a', 'uS3', 'P2', 1, 1500, 3700, 0, 'shipping', null],
    ['t-s3n', 'uS3', 'P2', 0, 1500, 3700, 0, 'shipping', null],
    ['t-s4a', 'uS4', 'P2', 1, 1500, 3700, 0, 'shipping', null],
    ['t-n1', 'uN', 'P2', 1, 1500, 3700, 0, 'shipping', null],
    ['t-x1', 'uX', 'P2', 1, 1500, 3700, 0, 'shipping', null],
  ];
  let k = 0;
  for (const [id, owner, pid, qty, dep, rem, paid, ps, batch] of T) {
    const item = id.slice(2), o = `o-${item}`;
    const price = (dep + rem) / Math.max(qty ?? 1, 1), std = id === 't-s2a' ? 1000 : dep / Math.max(qty ?? 1, 1);
    await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ($1,$2,'approved',now(),$3)`, [o, owner, dep]);
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount, unit_price, unit_deposit, std_deposit, batch_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [item, o, pid, qty ?? 1, dep, price, dep / Math.max(qty ?? 1, 1), std, batch]);
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at, batch_id)
                    values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,now(),$11)`,
      [id, `OP-2026-10-${String(100 + ++k).padStart(4, '0')}`, pid, owner, qty, dep, rem, paid, paid >= rem ? 'paid_full' : 'active', ps, batch]);
  }
  await db.query(`insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values
    ('ps1','uB1','https://push/b1','k','a'),('ps2','uB2','https://push/b2','k','a'),('ps3','uX','https://push/x','k','a'),('ps4','uS2','https://push/s2','k','a')`);
  await db.query(`insert into push_prefs (user_id, maker_ids, franchise_ids) values ('uB2', '{mk-bandai}', '{}')`); // B2 ปิดค่าย Bandai
  await db.query(BELL_ALL); // v84: ต้องเปิดกระดิ่งก่อนลงขาย/จอง
  await db.exec('set session_replication_role = origin;');
  return db;
}

(async () => {
  const db = await boot();

  // ── A. สวิตช์ยังปิด: ลูกค้าใช้ไม่ได้ แอดมินลองได้ ─────────────────────────────
  const c1 = await call(db, 'S1', 'ryuma_market_list', ['t-s1a', 1, 1500]);
  const f1 = await call(db, 'B1', 'ryuma_market_feed');
  const fx = await call(db, 'X', 'ryuma_market_feed');
  ok('A1 ตลาดปิด: ลูกค้าลงขายไม่ได้ (closed) · กระดานลูกค้าว่าง+closed · แอดมินเห็นกระดาน', c1.error === 'closed' && f1.closed === true && (f1.rows ?? []).length === 0 && fx.ok === true, { c1, f1, fx });
  await raw(db, `insert into app_config (key, value) values ('market_public', '{"enabled": true}')`);

  // ── B. ผู้ขายหลายคน หลายค่าย ลงขาย ──────────────────────────────────────────
  const l1 = await call(db, 'S1', 'ryuma_market_list', ['t-s1a', 1, 1500]);                 // Bandai · ยกใบ
  const l2 = await call(db, 'S1', 'ryuma_market_list', ['t-s1b', 1, 2000]);                 // MegaHouse · แตก 1/3
  const l3 = await call(db, 'S1', 'ryuma_market_list', ['t-s1c', 1, 900]);                  // Banpresto · จ่ายครบแล้ว
  const l4 = await call(db, 'S3', 'ryuma_market_list', ['t-s3a', 1, 1800]);
  const l5 = await call(db, 'S2', 'ryuma_market_list', ['t-s2b', 1, 1000]);
  ok('B1 ลงขาย 5 ประกาศจาก 3 คน 3 ค่าย ผ่านหมด', [l1, l2, l3, l4, l5].every((r) => r.ok), [l1, l2, l3, l4, l5]);
  const s2 = await deal(db, l2.id);
  ok('B2 แตกขาย 1/3: snapshot = ชิ้นที่ขาย (จ่ายแล้ว 1,500 · ค้าง 3,700 · รวม 5,200)', n(s2?.snap?.paid) === 1500 && n(s2?.snap?.due) === 3700 && n(s2?.snap?.total) === 5200, s2?.snap);
  const feed = await call(db, 'B1', 'ryuma_market_feed');
  const rows: any[] = feed.rows ?? [];
  const r1 = rows.find((r) => r.id === l1.id), r2 = rows.find((r) => r.id === l2.id);
  ok('B3 กระดานผู้ซื้อ: 5 ประกาศ · ปิดชื่อคนขาย R•••12 · ไม่ใช่ของฉัน · ยอดตรง', rows.length === 5 && r1?.seller === 'R•••12' && r1?.mine === false
    && n(r1?.paid) === 1000 && n(r1?.due) === 3000 && n(r2?.qty) === 1 && n(r2?.ticket_qty) === 3 && n(r2?.due) === 3700, { len: rows.length, r1, r2 });
  ok('B4 กระดานไม่มีชื่อจริง/เลขตั๋วเต็ม/ไอดีผู้ใช้หลุด', !JSON.stringify(rows).match(/Sam|Gina|Nick|uS1|uS2|uS3|OP-2026-10-01/), rows[0]);
  const fs = await call(db, 'S1', 'ryuma_market_feed');
  ok('B5 คนขายเห็นประกาศตัวเองเป็น "ของฉัน"', (fs.rows ?? []).filter((r: any) => r.mine).length === 3, fs.rows?.map((r: any) => r.mine));

  // ── C. ด่านลงขาย ────────────────────────────────────────────────────────────
  const reason = async (t: string, uid = 'uS1', qty = 1) => (await q(db, `select ryuma_market_block_reason($1, $2, $3) as r`, [t, uid, qty]))[0].r;
  ok('C1 ยังเปิดจอง → still_open', (await reason('t-s1d')) === 'still_open', await reason('t-s1d'));
  ok('C2 [รอบ4] ตั๋วรอบพิเศษที่รอบยังเปิดขายอยู่ → still_open (ร้านยังขายรอบนี้)', (await reason('t-s1e')) === 'still_open', await reason('t-s1e'));
  ok('C3 ตั๋วรอบพิเศษที่ปิดรอบแล้ว → ขายได้', (await reason('t-s1f')) === null, await reason('t-s1f'));
  ok('C4 มัดจำ Gold ครึ่งเดียว → topup_needed', (await reason('t-s2a', 'uS2')) === 'topup_needed', await reason('t-s2a', 'uS2'));
  ok('C5 จำนวน 0 / เกินใบ → bad_qty', (await reason('t-s1g', 'uS1', 0)) === 'bad_qty' && (await reason('t-s1b', 'uS1', 4)) === 'bad_qty');
  const bp1 = await call(db, 'S1', 'ryuma_market_list', ['t-s1g', 1, 10.5]);
  const bp2 = await call(db, 'S1', 'ryuma_market_list', ['t-s1g', 1, -1]);
  ok('C6 ราคาเศษสตางค์/ติดลบ → bad_price', bp1.error === 'bad_price' && bp2.error === 'bad_price', { bp1, bp2 });
  const np = await call(db, 'B3', 'ryuma_market_list', ['t-s1g', 1, 100]);
  ok('C7 ไม่มีบัญชีรับเงิน → no_payout', np.error === 'no_payout', np);
  const nn = await call(db, 'S3', 'ryuma_market_list', ['t-s1g', 1, 100]);
  ok('C8 ตั๋วคนอื่น → not_owner', nn.error === 'not_owner', nn);
  const dup = await call(db, 'S1', 'ryuma_market_list', ['t-s1a', 1, 1600]);
  ok('C9 ลงซ้ำใบเดิม → already_listed', dup.error === 'already_listed', dup);
  await call(db, 'S1', 'ryuma_market_list', ['t-s1g', 1, 1500]);
  await call(db, 'S1', 'ryuma_market_list', ['t-s1h', 1, 1500]);
  const six = await call(db, 'S1', 'ryuma_market_list', ['t-s1i', 1, 1500]);
  ok('C10 เพดานประกาศพร้อมกัน 5 ใบ → ใบที่ 6 max_active', six.error === 'max_active', six);
  // [รอบ4] จำนวนชิ้นว่าง: เดิม greatest(null,1)=1 → ลง 2 ชิ้น = มัดจำ ×2 (เสกเงิน) · v83: ห้ามว่าง + ตั๋ว 0 ชิ้นขายไม่ได้
  const nul = await raw(db, `insert into preorder_tickets (id, ticket_no, product_id, owner_id, qty, deposit_paid, remaining_amount) values ('t-null','OP-N-1','P2','uS3',null,1500,3700)`)
    .then(() => 'inserted').catch((e) => (e as Error).message);
  const qn = await call(db, 'S3', 'ryuma_market_list', ['t-s3n', 1, 100]);
  ok('C11 [รอบ4] ตั๋วจำนวนชิ้นว่างมีไม่ได้ (not null) · ตั๋ว 0 ชิ้นลงขายไม่ได้ (bad_qty)', /null/i.test(nul) && qn.error === 'bad_qty', { nul, qn });
  if (qn.ok) await call(db, 'S3', 'ryuma_market_cancel', [qn.id, null]);

  // ── D. ผู้ซื้อจอง ───────────────────────────────────────────────────────────
  const na = await call(db, 'B3', 'ryuma_market_reserve', [l1.id]);
  const own = await call(db, 'S1', 'ryuma_market_reserve', [l1.id]);
  const rv1 = await call(db, 'B1', 'ryuma_market_reserve', [l1.id]);
  const rv2 = await call(db, 'B2', 'ryuma_market_reserve', [l1.id]);
  const one = await call(db, 'B1', 'ryuma_market_reserve', [l3.id]);
  const again = await call(db, 'B1', 'ryuma_market_reserve', [l1.id]);
  ok('D1 ไม่มีที่อยู่ → no_address · จองของตัวเอง → own_listing', na.error === 'no_address' && own.error === 'own_listing', { na, own });
  ok('D2 B1 จองได้ · B2 จองซ้อน → reserved · B1 จองใบที่ 2 → one_at_a_time · กดซ้ำ → again', !!rv1.ok && rv2.error === 'reserved' && one.error === 'one_at_a_time' && again.again === true, { rv1, rv2, one, again });
  const fb2 = await call(db, 'B2', 'ryuma_market_feed');
  const rowB2 = (fb2.rows ?? []).find((r: any) => r.id === l1.id);
  ok('D3 คนอื่นเห็นป้าย "มีคนจอง" + เวลา (ไม่รู้ว่าใคร)', rowB2?.status === 'reserved' && !!rowB2?.hold_until && rowB2?.reserved_by_me === false, rowB2);
  const po1 = await call(db, 'B1', 'ryuma_market_payout', [l1.id]);
  const po2 = await call(db, 'B2', 'ryuma_market_payout', [l1.id]);
  ok('D4 บัญชีรับเงินเปิดให้เฉพาะคนที่จองอยู่', po1.ok === true && po1.account_name === 'Sam' && po2.error === 'not_found', { po1, po2 });
  const cn = await call(db, 'S1', 'ryuma_market_cancel', [l1.id, null]);
  ok('D5 มีคนจองอยู่ คนขายถอนประกาศไม่ได้', cn.error === 'reserved', cn);

  // หมดเวลาจอง (15 + ผ่อนผัน 10) → คนอื่นแย่งได้ · คนเดิมแนบสลิปไม่ทัน
  await raw(db, `update ticket_transfers set hold_until = now() - interval '11 minutes' where id = $1`, [l1.id]);
  const grab = await call(db, 'B2', 'ryuma_market_reserve', [l1.id]);
  const late = await call(db, 'B1', 'ryuma_market_pay', [l1.id, SLIP]);
  ok('D6 จองหมดเวลา → B2 จองต่อได้ · B1 แนบสลิปช้า → hold_expired/not_found', !!grab.ok && !!late.error, { grab, late });

  // ── E. โอน + สลิป + ยืนยัน + โอนสิทธิ์ (ยกใบ) ──────────────────────────────────
  const bad1 = await call(db, 'B2', 'ryuma_market_pay', [l1.id, 'javascript:alert(1)']);
  const bad2 = await call(db, 'B2', 'ryuma_market_pay', [l1.id, 'https://evil.example.com/fake-slip.jpg']);
  ok('E1 สลิปที่ไม่ใช่ลิงก์ → bad_slip', bad1.error === 'bad_slip', bad1);
  ok('E2 [รอบ4] สลิปจากเว็บอื่น (ไม่ใช่ที่เก็บรูปของร้าน) → bad_slip', bad2.error === 'bad_slip', bad2);
  if (bad2.ok) await raw(db, `update ticket_transfers set status = 'reserved', slip_url = null, paid_at = null where id = $1`, [l1.id]);
  const pay = await call(db, 'B2', 'ryuma_market_pay', [l1.id, SLIP]);
  const lock = await asUser(db, AUTH.S1, () => db.query(`insert into remaining_payments (id, ticket_id, user_id, amount, slip_url, status) values ('rp-x','t-s1a','uS1',3000,$1,'pending')`, [SLIP]))
    .then(() => 'inserted').catch((e) => (e as Error).message);
  ok('E3 ผู้ซื้อแนบสลิป → paid · ระหว่างนี้คนขายจ่ายส่วนต่างใบนี้ไม่ได้ (ล็อก)', !!pay.ok && (await deal(db, l1.id))?.status === 'paid' && /ryuma:/.test(lock), { pay, lock });
  const esc = await call(db, 'B2', 'ryuma_market_escalate', [l1.id, 'เงียบ']);
  ok('E4 ผู้ซื้อขอตรวจสอบก่อนครบ 12 ชม. → too_early', esc.error === 'too_early', esc);
  const conf = await call(db, 'S1', 'ryuma_market_seller_confirm', [l1.id]);
  const before = await ticket(db, 't-s1a');
  const fin = await call(db, 'X', 'ryuma_market_finalize', [l1.id, null]);
  const after = await ticket(db, 't-s1a');
  ok('E5 ยืนยัน → แอดมินโอนสิทธิ์: ผู้ถือ = B2 · เลข -T1 · คนสั่ง (คนจ่ายมัดจำ) ยังเป็นคนขาย · เงินบนใบไม่ขยับ',
    !!conf.ok && !!fin.ok && after?.owner_id === 'uB2' && after?.ticket_no === `${before.ticket_no}-T1` && after?.original_buyer_id === 'uS1'
    && n(after?.deposit_paid) === 1000 && n(after?.remaining_amount) === 3000, { fin, after });
  const seeS1 = await asUser(db, AUTH.S1, () => q(db, `select id from preorder_tickets where id = 't-s1a'`));
  const seeB2 = await asUser(db, AUTH.S1, () => q(db, `select status, new_ticket_no from ticket_transfers where id = $1`, [l1.id]));
  ok('E6 หลังขาย: คนขายมองไม่เห็นตั๋วแล้ว (RLS) แต่ยังเห็นประวัติดีลของตัวเอง', seeS1.length === 0 && seeB2[0]?.status === 'done', { seeS1, seeB2 });
  const fin2 = await call(db, 'X', 'ryuma_market_finalize', [l1.id, null]);
  ok('E7 กดโอนสิทธิ์ซ้ำ → again (ไม่โอนสองรอบ)', fin2.again === true && (await ticket(db, 't-s1a'))?.ticket_no === after.ticket_no, fin2);

  // ── F. แตกขาย 1 ชิ้นจาก 3 ─────────────────────────────────────────────────────
  await call(db, 'B1', 'ryuma_market_reserve', [l2.id]);
  await call(db, 'B1', 'ryuma_market_pay', [l2.id, SLIP]);
  await call(db, 'S1', 'ryuma_market_seller_confirm', [l2.id]);
  const parent0 = await ticket(db, 't-s1b');
  const fsplit = await call(db, 'X', 'ryuma_market_finalize', [l2.id, null]);
  const child = fsplit.child_ticket_id ? await ticket(db, fsplit.child_ticket_id) : null;
  const parent1 = await ticket(db, 't-s1b');
  const sum = (k: string) => n(child?.[k]) + n(parent1?.[k]);
  ok('F1 แตกขาย: ตั๋วลูก 1 ชิ้นของ B1 (มัดจำ 1,500 · ค้าง 3,700) · ตั๋วแม่เหลือ 2 ชิ้นของคนขาย',
    !!child && child.owner_id === 'uB1' && n(child.qty) === 1 && n(child.deposit_paid) === 1500 && n(child.remaining_amount) === 3700
    && parent1.owner_id === 'uS1' && n(parent1.qty) === 2, { child, parent1 });
  ok('F2 แตกขายแล้วเงินรวมไม่ขยับสักบาท (มัดจำ/ค้าง/จ่ายแล้ว/จำนวน)',
    sum('deposit_paid') === n(parent0.deposit_paid) && sum('remaining_amount') === n(parent0.remaining_amount)
    && sum('remaining_paid') === n(parent0.remaining_paid) && sum('qty') === n(parent0.qty), { parent0, child, parent1 });
  ok('F3 ตั๋วลูก: คนสั่ง = คนขาย (เงินมาจากออเดอร์เดิม) · split_from = แม่ · เลข -T1', child?.original_buyer_id === 'uS1' && child?.split_from === 't-s1b' && /-T1$/.test(child?.ticket_no ?? ''), child);
  // ขายชิ้นที่ 2 จากใบแม่ → เลข -T2 ไม่ชนกับตั๋วลูกใบแรก
  const l6 = await call(db, 'S1', 'ryuma_market_list', ['t-s1b', 1, 2100]);
  await call(db, 'B2', 'ryuma_market_reserve', [l6.id]);
  await call(db, 'B2', 'ryuma_market_pay', [l6.id, SLIP]);
  await call(db, 'S1', 'ryuma_market_seller_confirm', [l6.id]);
  const f6 = await call(db, 'X', 'ryuma_market_finalize', [l6.id, null]);
  ok('F4 แตกขายรอบที่ 2 จากใบแม่ → เลข -T2', !!f6.ok && /-T2$/.test(f6.new_ticket_no ?? ''), f6);

  // ── G. ทางแยก: คนขายแจ้งไม่ได้รับเงิน / เงียบเกิน 12 ชม. / แอดมินยกเลิกหลังโอน ─────────
  await call(db, 'B1', 'ryuma_market_reserve', [l3.id]);
  await call(db, 'B1', 'ryuma_market_pay', [l3.id, SLIP]);
  const rj = await call(db, 'S1', 'ryuma_market_seller_reject', [l3.id, 'ไม่มีเงินเข้า 900', null]);
  ok('G1 คนขายแจ้ง "ยังไม่ได้รับเงิน" → ตรวจสอบ (not_received)', !!rj.ok && (await deal(db, l3.id))?.review_reason === 'not_received', rj);
  await call(db, 'B2', 'ryuma_market_reserve', [l4.id]);
  await call(db, 'B2', 'ryuma_market_pay', [l4.id, SLIP]);
  await raw(db, `update ticket_transfers set paid_at = now() - interval '13 hours' where id = $1`, [l4.id]);
  const esc2 = await call(db, 'B2', 'ryuma_market_escalate', [l4.id, 'คนขายเงียบ']);
  const cfr = await call(db, 'S3', 'ryuma_market_seller_confirm', [l4.id]);
  ok('G2 เงียบเกิน 12 ชม. → ผู้ซื้อส่งตรวจได้ · แอดมินโทรตามแล้วคนขายกดยืนยันจากหน้าตรวจสอบได้', !!esc2.ok && !!cfr.ok && (await deal(db, l4.id))?.status === 'seller_ok', { esc2, cfr });
  await call(db, 'B1', 'ryuma_market_reserve', [l5.id]);
  await call(db, 'B1', 'ryuma_market_pay', [l5.id, SLIP]);
  const ac = await call(db, 'X', 'ryuma_market_admin_cancel', [l5.id, 'คนขายติดต่อไม่ได้']);
  const acd = await deal(db, l5.id);
  ok('G3 [รอบ4] แอดมินยกเลิกดีลที่ผู้ซื้อโอนแล้ว → ค้างคิว "เคลียร์คืนเงิน" (late_slip) ไม่หายจากทุกคิว',
    !!ac.ok && acd?.status === 'cancelled' && acd?.review_reason === 'late_slip', { ac, st: acd?.status, rr: acd?.review_reason });
  const unl = await asUser(db, AUTH.S2, () => db.query(`insert into remaining_payments (id, ticket_id, user_id, amount, slip_url, status) values ('rp-y','t-s2b','uS2',2200,$1,'pending')`, [SLIP]))
    .then(() => 'inserted').catch((e) => (e as Error).message);
  ok('G4 ดีลถูกยกเลิก → ตั๋วปลดล็อก คนขายจ่ายส่วนต่างต่อได้', unl === 'inserted', unl);

  // ── H. ประวัติ / แอดมินแก้ตั๋ว ─────────────────────────────────────────────────
  const lw = await call(db, 'S1', 'ryuma_market_list', ['t-s1f', 1, 1300]);
  await call(db, 'S1', 'ryuma_market_cancel', [lw.id, null]);
  const hist = (await q(db, `select ryuma_ticket_market_history('t-s1f', null) as h`))[0].h;
  ok('H1 [รอบ4] ลงขายแล้วถอนเอง (ไม่มีเงินเปลี่ยนมือ) ไม่นับเป็น "ประวัติซื้อขาย" — แอดมินยังแก้/ลบตั๋วได้', hist === false, { hist });
  const histSold = (await q(db, `select ryuma_ticket_market_history('t-s1a', null) as h`))[0].h;
  ok('H2 ใบที่ขายไปแล้ว ยังนับเป็นประวัติ (ลบไม่ได้)', histSold === true, histSold);
  const ex = await call(db, 'S1', 'ryuma_market_list', ['t-s1j', 1, 1500]);
  await raw(db, `update ticket_transfers set expires_at = now() - interval '1 minute' where id = $1`, [ex.id]);
  const exr = await call(db, 'B1', 'ryuma_market_reserve', [ex.id]);
  const exf = await call(db, 'B1', 'ryuma_market_feed');
  const relist = await call(db, 'S1', 'ryuma_market_list', ['t-s1j', 1, 1400]);
  ok('H3 ประกาศครบ 14 วัน → หายจากกระดาน · จองไม่ได้ (gone) · ลงใหม่ได้', exr.error === 'gone' && !(exf.rows ?? []).some((r: any) => r.id === ex.id) && !!relist.ok, { exr, relist });

  // ── I. push ─────────────────────────────────────────────────────────────────
  const lp = await call(db, 'S2', 'ryuma_market_list', ['t-s2a', 1, 900]); // topup_needed → ใช้ใบอื่น
  const lpi = lp.ok ? lp : await call(db, 'S1', 'ryuma_market_list', ['t-s1i', 1, 1500]);
  const pushed = await call(db, lp.ok ? 'S2' : 'S1', 'ryuma_market_push_targets', [lpi.id, 'listed']);
  const t1 = JSON.stringify(pushed.targets ?? []);
  ok('I1 ลงขายใหม่ → push ถึงทุกคน ยกเว้นคนขาย และคนที่ปิดค่ายนั้น (B2 ปิด Bandai)', !!pushed.title && t1.includes('push/b1') && !t1.includes('push/b2') && !/\d+ ชิ้น|เหลือ/.test(pushed.body ?? ''), pushed);
  const pushed2 = await call(db, lp.ok ? 'S2' : 'S1', 'ryuma_market_push_targets', [lpi.id, 'listed']);
  ok('I2 push ชนิดเดิมยิงซ้ำไม่ได้', (pushed2.targets ?? []).length === 0, pushed2);
  const strangers = await call(db, 'B3', 'ryuma_market_push_targets', [l2.id, 'done']);
  ok('I3 คนนอกดีลขอ push ไม่ได้', (strangers.targets ?? []).length === 0, strangers);

  // ── J. ด่านใน definition ที่ทดสอบแบบพร้อมกันไม่ได้ใน PGlite (connection เดียว) ─────────
  const def = async (fn: string) => (await q(db, `select string_agg(pg_get_functiondef(p.oid), ' ') as d from pg_proc p where p.proname = $1`, [fn]))[0].d as string;
  ok('J1 [รอบ4] จองล็อกแถวผู้ซื้อ (กันจองพร้อมกัน 2 ใบทะลุ "ทีละใบ")', /from users where id = v_uid for update/i.test(await def('ryuma_market_reserve')));
  ok('J2 [รอบ4] โอนสิทธิ์ล็อกเลขฐานตั๋ว (กัน -T<n> ชนเมื่อโอนพร้อมกัน)', /pg_advisory_xact_lock/i.test(await def('ryuma_market_finalize')));

  // ── K. เดาเลขกระเป๋าผ่านการส่งข้อเสนอ (เปลี่ยนใบ) ─────────────────────────────
  await raw(db, `insert into app_config (key, value) values ('market_direct', '{"enabled": true}') on conflict (key) do update set value = excluded.value`);
  const codeB1 = (await call(db, 'B1', 'ryuma_wallet_code')).code as string;
  const wrong = String((Number(codeB1) + 1) % 10000).padStart(4, '0');
  let lastWrong: Res = {};
  for (let i = 0; i < 21; i++) lastWrong = await call(db, 'S2', 'ryuma_market_offer', ['t-s2k', 1, 0, wrong, null, 'uB1']);
  const right = await call(db, 'S2', 'ryuma_market_offer', ['t-s2k', 1, 0, codeB1, null, 'uB1']);
  ok('K1 [รอบ4] เดาเลขผิดครบเพดาน → ต่อให้เดาถูกก็ถูกปฏิเสธ (เดิมเดาถูกยังผ่าน = เดาได้ไม่จำกัด)', lastWrong.error === 'too_many' && right.error === 'too_many', { lastWrong, right });

  // ── M. v84 (เจ้าของลองเล่น 2026-10-11): ต้องเปิดกระดิ่ง · คนขายแจ้ง "ยังไม่ได้รับเงิน" + เหตุผล → ผู้ซื้อตอบ ─────────
  await raw(db, `delete from push_subscriptions where user_id in ('uN', 'uX')`);
  const nb1 = await call(db, 'N', 'ryuma_market_list', ['t-n1', 1, 1500]);
  const ls4 = await call(db, 'S4', 'ryuma_market_list', ['t-s4a', 1, 1600]);
  const nb2 = await call(db, 'N', 'ryuma_market_reserve', [ls4.id]);
  const adm = await call(db, 'X', 'ryuma_market_list', ['t-x1', 1, 1500]);
  ok('M1 ไม่มีกระดิ่ง: ลงขายไม่ได้ · จองไม่ได้ (no_bell) · แอดมินยกเว้น (ไว้ทดสอบ)', nb1.error === 'no_bell' && nb2.error === 'no_bell' && !!ls4.ok && !!adm.ok, { nb1, nb2, ls4, adm });
  if (adm.ok) await call(db, 'X', 'ryuma_market_cancel', [adm.id, null]);
  await raw(db, BELL_ALL); // คืนกระดิ่งให้ทุกคน (แอดมินต้องได้ push ในข้อถัดไป)
  const nf = await call(db, 'B4', 'ryuma_market_seller_flag', [ls4.id, 'wrong_slip', null, null]);
  await call(db, 'B4', 'ryuma_market_reserve', [ls4.id]);
  const early = await call(db, 'S4', 'ryuma_market_seller_flag', [ls4.id, 'wrong_slip', null, null]);
  await call(db, 'B4', 'ryuma_market_pay', [ls4.id, SLIP]);
  const noflag = await call(db, 'B4', 'ryuma_market_buyer_reply', [ls4.id, 'escalate', null, null]);
  const badr = await call(db, 'S4', 'ryuma_market_seller_flag', [ls4.id, 'whatever', null, null]);
  ok('M2 ด่าน: คนนอกแจ้งไม่ได้ · ยังไม่โอนแจ้งไม่ได้ · ยังไม่มีธงผู้ซื้อตอบไม่ได้ · เหตุผลแปลกไม่รับ',
    nf.error === 'not_found' && early.error === 'bad_status' && noflag.error === 'no_flag' && badr.error === 'bad_reason', { nf, early, noflag, badr });
  const PROOF = SLIP.replace('1.jpg', 'proof.jpg');
  const fl = await call(db, 'S4', 'ryuma_market_seller_flag', [ls4.id, 'wrong_slip', 'ไม่เจอยอด 1,600', [PROOF, 'https://evil.example.com/x.jpg']]);
  const d1 = await deal(db, ls4.id);
  const pf1 = await call(db, 'S4', 'ryuma_market_push_targets', [ls4.id, 'flagged']);
  const pf1b = await call(db, 'S4', 'ryuma_market_push_targets', [ls4.id, 'flagged']);
  const rm = await call(db, 'B4', 'ryuma_market_push_targets', [ls4.id, 'remind']);
  ok('M3 คนขายแจ้ง "สลิปผิด": ดีลยัง paid (ใบยังล็อก) · มีธง+โน้ต · หลักฐานเก็บเฉพาะรูปร้าน · push ถึงผู้ซื้อ (ครั้งเดียว) · ไม่เตือนคนขายซ้ำ',
    !!fl.ok && d1?.status === 'paid' && d1?.seller_flag === 'wrong_slip' && d1?.seller_flag_note === 'ไม่เจอยอด 1,600'
    && JSON.stringify(d1?.review_evidence) === JSON.stringify([PROOF]) && JSON.stringify(pf1.targets ?? []).includes('push.test/uB4')
    && /สลิปผิด/.test(pf1.body ?? '') && (pf1b.targets ?? []).length === 0 && (rm.targets ?? []).length === 0, { fl, d1, pf1, pf1b, rm });
  const SLIP2 = SLIP.replace('1.jpg', '2.jpg');
  const paid0 = d1.paid_at;
  await new Promise((r) => setTimeout(r, 20));
  const rs = await call(db, 'B4', 'ryuma_market_buyer_reply', [ls4.id, 'reslip', SLIP2, 'แนบสลิปที่ถูกแล้วครับ']);
  const d2 = await deal(db, ls4.id);
  const pr = await call(db, 'B4', 'ryuma_market_push_targets', [ls4.id, 'reslip']);
  ok('M4 ผู้ซื้อแนบสลิปใหม่: สลิปเปลี่ยน · เวลาโอนเริ่มนับใหม่ (คนขายได้ 12 ชม.) · ธงหาย · สลิปเก่า+เหตุผลเก็บในประวัติ · push ถึงคนขาย+แอดมิน',
    !!rs.ok && d2?.slip_url === SLIP2 && new Date(d2?.paid_at) > new Date(paid0) && d2?.seller_flag === null
    && d2?.slip_history?.length === 1 && d2.slip_history[0].slip === SLIP && d2.slip_history[0].flag === 'wrong_slip'
    && JSON.stringify(pr.targets ?? []).includes('push.test/uS4') && JSON.stringify(pr.targets ?? []).includes('push.test/uX'), { rs, d2, pr });
  const fl2 = await call(db, 'S4', 'ryuma_market_seller_flag', [ls4.id, 'not_arrived', null, null]);
  const pf2 = await call(db, 'S4', 'ryuma_market_push_targets', [ls4.id, 'flagged']);
  const escB = await call(db, 'B4', 'ryuma_market_buyer_reply', [ls4.id, 'escalate', null, 'โอนจาก KBank 14:05 จริง']);
  const d3 = await deal(db, ls4.id);
  ok('M5 คนขายแจ้งอีกรอบ (push ส่งได้อีก) → ผู้ซื้อมั่นใจ ส่งเรื่อง → ร้านตรวจสอบ (โน้ตรวมคำของสองฝั่ง)',
    !!fl2.ok && (pf2.targets ?? []).length > 0 && !!escB.ok && d3?.status === 'reviewing' && d3?.review_reason === 'not_received'
    && /สลิปถูกแต่เงินไม่เข้า/.test(d3?.review_note ?? '') && /ผู้ซื้อยืนยันว่าสลิปถูก: โอนจาก KBank/.test(d3?.review_note ?? ''), { fl2, escB, note: d3?.review_note });
  const cf = await call(db, 'S4', 'ryuma_market_seller_confirm', [ls4.id]);
  const fin4 = await call(db, 'X', 'ryuma_market_finalize', [ls4.id, null]);
  ok('M6 เคลียร์กันได้ → คนขายกดยืนยันจากหน้าตรวจสอบ → ร้านโอนสิทธิ์ได้ตามปกติ', !!cf.ok && !!fin4.ok && (await ticket(db, 't-s4a'))?.owner_id === 'uB4', { cf, fin4 });
  // ปุ่ม "ผู้ซื้อไม่ตอบ — ส่งเรื่องให้ร้านตรวจ" ของคนขายตอนมีธง = seller_reject เดิม → ต้องยังใช้ได้
  const ln = await call(db, 'N', 'ryuma_market_list', ['t-n1', 1, 1500]);
  await call(db, 'B4', 'ryuma_market_reserve', [ln.id]);
  await call(db, 'B4', 'ryuma_market_pay', [ln.id, SLIP]);
  const fl3 = await call(db, 'N', 'ryuma_market_seller_flag', [ln.id, 'not_arrived', null, null]);
  const sr = await call(db, 'N', 'ryuma_market_seller_reject', [ln.id, 'แจ้งผู้ซื้อแล้ว: สลิปถูก แต่เงินไม่เข้า · ยังไม่ได้ข้อสรุป', null]);
  const d4 = await deal(db, ln.id);
  const prv = await call(db, 'N', 'ryuma_market_push_targets', [ln.id, 'reviewing']);
  ok('M7 มีธงแล้วผู้ซื้อเงียบ → คนขายส่งเรื่องให้ร้านเองได้ (ตรวจสอบ · ไม่ได้รับเงิน) · push ถึงผู้ซื้อ+แอดมิน',
    !!ln.ok && !!fl3.ok && !!sr.ok && d4?.status === 'reviewing' && d4?.review_reason === 'not_received'
    && JSON.stringify(prv.targets ?? []).includes('push.test/uB4') && JSON.stringify(prv.targets ?? []).includes('push.test/uX'), { ln, fl3, sr, st: d4?.status, prv });

  // ── L. v83 รันซ้ำได้ + เติมจำนวนชิ้นให้แถวเก่าที่ว่าง (จำลองข้อมูลจริงก่อนรัน) ─────────────
  await db.exec(`alter table preorder_tickets alter column qty drop not null`);
  await raw(db, `insert into preorder_tickets (id, ticket_no, product_id, owner_id, qty, deposit_paid, remaining_amount) values ('t-legacy','OP-L-1','P2','uS3',null,1500,3700)`);
  const errs: string[] = [];
  for (const stmt of splitSql(readFileSync('supabase/migration_board_v83.sql', 'utf8'))) {
    try { await db.exec(stmt); } catch (e) { errs.push((e as Error).message); }
  }
  const leg = await ticket(db, 't-legacy');
  const nn2 = (await q(db, `select is_nullable from information_schema.columns where table_name = 'preorder_tickets' and column_name = 'qty'`))[0]?.is_nullable;
  ok('L1 รัน v83 ซ้ำบนข้อมูลที่มีตั๋วจำนวนว่าง → ไม่มี error · แถวเก่าได้ 1 ชิ้น · คอลัมน์ห้ามว่างกลับมา', errs.length === 0 && n(leg?.qty) === 1 && nn2 === 'NO', { errs, qty: leg?.qty, nn2 });

  console.log(`\nboard-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
