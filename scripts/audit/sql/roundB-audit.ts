/**
 * เทสต์ระดับ SQL ของรอบ B (v75) — Postgres จริง (PGlite) รัน migration ครบทุกไฟล์
 * รัน: npm run audit:sql  (ไฟล์นี้ถูกเรียกต่อจาก roundA-audit)
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
const tr = async (db: PGlite, id: string) => (await q(db, 'select * from ticket_transfers where id = $1', [id]))[0];
const PAY = { account_name: 'Alice A', promptpay: '0812345678' };

const DIR = 'supabase'; // รันจากรากโปรเจกต์ (เหมือน roundA-audit)

async function boot() {
  const { db, errors } = await bootDb(DIR);
  ok('boot: migration ทุกไฟล์ (รวม v75) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  const u = (id: string, name: string, auth: string, admin = false, mc = '') =>
    db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank) values ($1,$2,$3,true,'addr',$4,$5,'bronze')`, [id, name, auth, mc, admin]);
  await u('uA', 'Alice', AUTH.A, false, 'RYU-0011'); await u('uB', 'Bob', AUTH.B, false, 'RYU-0022');
  await u('uC', 'Carl', AUTH.C, false, 'RYU-0033'); await u('uX', 'Admin', AUTH.X, true, 'RYU-0001');
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status) values ('P1','Series One',1690,300,'production')`);
  await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ('o1','uA','approved',now(),3000)`);
  for (let i = 1; i <= 10; i++) {
    await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount) values ($1,'o1','P1',1,300)`, [`oi${i}`]);
    await db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at)
                    values ($1,$2,'P1','uA','uA',1,300,1390,0,'active','production',now())`, [`t-oi${i}`, `NR-2026-10-00${String(i).padStart(2, '0')}`]);
  }
  for (const [uid, ep] of [['uA', 'epA'], ['uB', 'epB'], ['uX', 'epX']]) await db.query(`insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values ($1,$2,$3,'k','a')`, ['ps-' + uid, uid, ep]);
  await db.query(`insert into app_config (key, value) values ('market_direct', '{"enabled": true}')`);
  await db.exec('set session_replication_role = origin;');
  return db;
}

(async () => {
  const db = await boot();
  const codeB = (await call(db, 'B', 'ryuma_wallet_code')).code as string;
  const codeC = (await call(db, 'C', 'ryuma_wallet_code')).code as string;
  const offer = (ticket: string, price: number, code = codeB, expect = 'uB') => call(db, 'A', 'ryuma_market_offer', [ticket, 1, price, code, PAY, expect]);

  // ── R1-02 / R1-03 เลขกระเป๋า ────────────────────────────────────────────────────────────
  {
    const r1 = await offer('t-oi1', 500, codeB, 'uC');
    ok('K1 ส่งข้อเสนอ: เลขเป็นของ B แต่ยืนยันไว้ว่า C → code_changed (ไม่ส่งไปคนที่ไม่ได้ยืนยัน)', r1.error === 'code_changed', r1);
    const probe = await call(db, 'C', 'ryuma_market_offer', ['no-such-ticket', 1, 0, codeB, PAY, 'uB']);
    const probe2 = await call(db, 'C', 'ryuma_market_offer', ['no-such-ticket', 1, 0, '0000', PAY, 'uB']);
    ok('K2 ใช้ตั๋วปลอมไล่เดาเลข → คำตอบเดียวกัน not_owner ไม่ว่าเลขจะมีเจ้าของหรือไม่ (ปิด oracle)', probe.error === 'not_owner' && probe2.error === 'not_owner', { probe, probe2 });
    const before = Number((await q(db, `select coalesce(max(n),0) n from wallet_lookups where user_id='uA'`))[0].n);
    let last: Res = {};
    for (let i = 0; i < 25; i++) last = await offer('t-oi1', 500, String(1000 + i).padStart(4, '0') === codeB ? '9999' : String(1000 + i), 'uB');
    const after = Number((await q(db, `select coalesce(max(n),0) n from wallet_lookups where user_id='uA'`))[0].n);
    ok('K3 เดาเลขผิดผ่านการส่งข้อเสนอ = นับโควตาค้นเลข · เกิน 20 → too_many', after > before && last.error === 'too_many', { before, after, last });
    await db.query(`delete from wallet_lookups`);
    // ข้ามเที่ยงคืน: เลขเดิมของ B วันนี้เป็นของ C
    await db.exec('set session_replication_role = replica;');
    await db.query(`update wallet_codes set code = '7777' where user_id = 'uC'`);
    await db.exec('set session_replication_role = origin;');
    const r4 = await offer('t-oi1', 500, '7777', 'uB');
    ok('K4 เลขที่ยืนยันไว้ตอนนี้เป็นของคนอื่น (ข้ามเที่ยงคืน) → code_changed ไม่ส่งไปคนแปลกหน้า', r4.error === 'code_changed', r4);
    const r5 = await offer('t-oi1', 500);
    const r6 = await offer('t-oi1', 500);
    ok('K5 ส่งข้อเสนอสำเร็จ · ส่งซ้ำแบบเดิม (เน็ตหลุดแล้วกดใหม่) = ok again id เดิม (R1-38)', !!r5.ok && !!r6.ok && r6.again === true && r6.id === r5.id, { r5, r6 });
    const r7 = await call(db, 'A', 'ryuma_market_offer', ['t-oi1', 1, 500, codeB, PAY]);
    ok('K6 แอปรุ่นเก่า (5 พารามิเตอร์) เรียกไม่ได้แล้ว', !!r7.THROWN, r7);
  }

  // ── R1-01 ถอนหลังผู้รับเริ่มโอน + สลิปหลังดีลปิด ────────────────────────────────────────────
  let idPay = '';
  {
    const o = await offer('t-oi2', 500); idPay = o.id;
    const p = await call(db, 'B', 'ryuma_market_payout', [o.id]);
    const t1 = await tr(db, o.id);
    ok('W1 ผู้รับเปิดดูบัญชีโอนเงิน → บันทึก payout_viewed_at', !!p.ok && !!t1.payout_viewed_at, { p, t1: t1.payout_viewed_at });
    const c = await call(db, 'A', 'ryuma_market_cancel', [o.id]);
    ok('W2 ผู้รับเปิดหน้าโอนแล้ว คนส่งถอนเองไม่ได้ (recipient_paying)', c.error === 'recipient_paying' && (await tr(db, o.id)).status === 'reserved', c);
    const pay = await call(db, 'B', 'ryuma_market_pay', [o.id, 'https://x/slip.jpg']);
    ok('W3 ผู้รับแนบสลิปได้ตามปกติ → paid', !!pay.ok && (await tr(db, o.id)).status === 'paid', pay);

    const o2 = await offer('t-oi3', 500);
    const c2 = await call(db, 'A', 'ryuma_market_cancel', [o2.id]);
    ok('W4 ผู้รับยังไม่เปิดหน้าโอน → คนส่งถอนได้', !!c2.ok, c2);
    const late = await call(db, 'B', 'ryuma_market_pay', [o2.id, 'https://x/late.jpg']);
    const t2 = await tr(db, o2.id);
    ok('W5 โอนไปแล้วแต่คนส่งถอนก่อน → แนบสลิปได้ เก็บเป็นหลักฐาน (withdrawn + recorded) · ดีลยังปิด',
      late.error === 'withdrawn' && late.recorded === true && t2.status === 'cancelled' && t2.review_reason === 'late_slip' && !!t2.paid_at && t2.slip_url === 'https://x/late.jpg', { late, t2 });
    const d = await call(db, 'B', 'ryuma_market_decline', [o2.id]);
    ok('W6 กด "ไม่รับ" กับดีลที่คนส่งถอนแล้ว → withdrawn (ไม่บอก "แจ้งคนส่งแล้ว")', d.error === 'withdrawn', d);
    const push = await call(db, 'B', 'ryuma_market_push_targets', [o2.id, 'late_slip']);
    const eps = (push.targets ?? []).map((x: any) => x.endpoint).sort();
    ok('W7 push "โอนแล้วแต่ดีลปิด" ไปคนส่ง + แอดมิน', JSON.stringify(eps) === JSON.stringify(['epA', 'epX']), push);
    const rsv = await call(db, 'A', 'ryuma_market_late_slip_resolve', [o2.id, 'x']);
    const rs = await call(db, 'X', 'ryuma_market_late_slip_resolve', [o2.id, 'คนส่งคืนเงินแล้ว']);
    ok('W8 ปิดเรื่องสลิปหลังดีลปิด: ลูกค้าทำไม่ได้ · แอดมินทำได้ + บันทึกโน้ต', rsv.error === 'admin_only' && !!rs.ok && (await tr(db, o2.id)).review_reason === 'late_slip_done', { rsv, rs });

    const o3 = await offer('t-oi4', 500);
    await db.exec('set session_replication_role = replica;');
    await db.query(`update ticket_transfers set hold_until = now() - interval '1 hour', expires_at = now() - interval '1 hour' where id = $1`, [o3.id]);
    await db.exec('set session_replication_role = origin;');
    const late2 = await call(db, 'B', 'ryuma_market_pay', [o3.id, 'https://x/late2.jpg']);
    const t3 = await tr(db, o3.id);
    ok('W9 หมดเวลา 24 ชม. แล้วค่อยแนบสลิป → hold_expired + recorded · สถานะ expired · เก็บสลิป', late2.error === 'hold_expired' && late2.recorded === true && t3.status === 'expired' && t3.review_reason === 'late_slip', { late2, t3 });
  }

  // ── R1-60 / R1-09 / R1-16 ──────────────────────────────────────────────────────────────
  {
    const o = await offer('t-oi5', 500);
    await db.exec('set session_replication_role = replica;');
    await db.query(`update preorder_tickets set delivery = '{"method":"pickup","requested_at":"2026-10-03T00:00:00Z"}' where id = 't-oi5'`);
    await db.exec('set session_replication_role = origin;');
    const p = await call(db, 'B', 'ryuma_market_pay', [o.id, 'https://x/s.jpg']);
    const t = await tr(db, o.id);
    ok('X1 ตั๋วเปลี่ยนระหว่าง 24 ชม. (เลือกวิธีรับของ) → จ่ายไม่ผ่าน gone + เก็บสลิปเป็นหลักฐาน · ดีลปิด', p.error === 'gone' && p.recorded === true && t.status === 'cancelled' && t.cancel_reason === 'ticket_changed' && t.review_reason === 'late_slip', { p, t });

    const o2 = await offer('t-oi6', 500);
    const r = await call(db, 'B', 'ryuma_market_release', [o2.id]);
    const t2 = await tr(db, o2.id);
    ok('X2 ผู้รับเรียก release กับดีลตรงไม่ได้ (use_decline) · ดีลไม่กลายเป็นประกาศล่องหน', r.error === 'use_decline' && t2.status === 'reserved' && t2.to_user_id === 'uB', { r, t2 });

    const of = await offer('t-oi7', 0);
    const bad = await call(db, 'B', 'ryuma_market_pay', [of.id, 'javascript:alert(1)']);
    ok('X3 ดีลยกให้ฟรี: "สลิป" ที่ไม่ใช่ลิงก์ http(s) → bad_slip', bad.error === 'bad_slip', bad);
    const acc = await call(db, 'B', 'ryuma_market_pay', [of.id, '']);
    ok('X4 ดีลยกให้ฟรี: กดรับโดยไม่มีสลิป = ok · ไม่เก็บ slip_url', !!acc.ok && (await tr(db, of.id)).slip_url === null, acc);
    const rej = await call(db, 'A', 'ryuma_market_seller_reject', [of.id, 'x', null]);
    ok('X5 ดีลยกให้ฟรี: คนส่งกด "ยังไม่ได้รับเงิน" ไม่ได้ (free_deal)', rej.error === 'free_deal', rej);
    const rem = await call(db, 'B', 'ryuma_market_push_targets', [of.id, 'remind']);
    ok('X6 ดีลยกให้ฟรี: push "มีเงินรอคุณยืนยัน" ไม่ออก', (rem.targets ?? []).length === 0, rem);
    const o3 = await offer('t-oi8', 300);
    const bad2 = await call(db, 'B', 'ryuma_market_pay', [o3.id, 'ftp://x']);
    ok('X7 ดีลมีเงิน: สลิปต้องเป็นลิงก์ http(s)', bad2.error === 'bad_slip', bad2);
    const cv = await call(db, 'A', 'ryuma_market_cancel', [o3.id]);
    ok('X8 ดีลมีเงินที่ผู้รับยังไม่เปิดดูบัญชี ถอนได้ (ไม่ล็อกเกินจำเป็น)', !!cv.ok, cv);
  }

  // ── R1-04 / ทั่วไป ────────────────────────────────────────────────────────────────────
  {
    const conf = await call(db, 'A', 'ryuma_market_seller_confirm', [idPay]);
    const fin = await call(db, 'X', 'ryuma_market_finalize', [idPay, null]);
    ok('Y2 ดีลตรงปกติยังจบได้ครบ (ยืนยัน → ไฟนอล)', !!conf.ok && !!fin.ok, { conf, fin });
    await db.query(`insert into app_config (key, value) values ('market_public', '{"enabled": true}') on conflict (key) do update set value = excluded.value`);
    await asUser(db, AUTH.X, () => db.query(`update users set payout_info = '{"account_name":"Alice","promptpay":"0812345678"}' where id = 'uA'`));
    const l = await call(db, 'A', 'ryuma_market_list', ['t-oi9', 1, 600]);
    const r1 = await call(db, 'B', 'ryuma_market_reserve', [l.id]);
    const rl = await call(db, 'B', 'ryuma_market_release', [l.id]);
    const r2 = await call(db, 'C', 'ryuma_market_reserve', [l.id]);
    const py = await call(db, 'C', 'ryuma_market_pay', [l.id, 'https://x/s.jpg']);
    ok('Y3 กระดาน: จอง → ปล่อยจอง → คนอื่นจอง → จ่าย ยังทำงานเหมือนเดิม', !!l.ok && !!r1.ok && !!rl.ok && !!r2.ok && !!py.ok, { l, r1, rl, r2, py });
  }

  console.log(`\nroundB-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
