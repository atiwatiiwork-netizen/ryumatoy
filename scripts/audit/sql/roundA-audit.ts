/**
 * เทสต์ระดับ SQL ของรอบ A (v74 · audit เปลี่ยนใบพรี 2026-10-03) — รันกับ Postgres จริง (PGlite) ที่รัน migration ครบทุกไฟล์
 * รัน: npm run audit:sql
 *
 * จำลองการเขียนของแอปสองแบบ:
 *   wholeUpsert = แอปรุ่นเก่า/หน้าจอที่โหลดไว้นาน ส่ง "ทั้งแถว" (PostgREST merge-duplicates → ON CONFLICT DO UPDATE ทุกคอลัมน์)
 *   patch       = แอปรุ่นใหม่ ส่งเฉพาะช่องที่เปลี่ยน + market_rev ที่โหลดมา (syncTablePatch)
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
type Res = Record<string, unknown> & { THROWN?: string };

const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const call = (db: PGlite, who: Who, fn: string, args: unknown[] = []) =>
  asUser(db, AUTH[who], () => rpc<Res>(db, fn, args)).catch((e) => ({ THROWN: (e as Error).message } as Res));
const run = (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  asUser(db, AUTH[who], async () => { await db.query(sql, params); return { ok: true } as Res; }).catch((e) => ({ THROWN: (e as Error).message } as Res));
const ticket = async (db: PGlite, id: string) => (await q(db, 'select * from preorder_tickets where id = $1', [id]))[0];

/** upsert ทั้งแถวแบบ PostgREST (ทุกคอลัมน์ที่ส่งมา = EXCLUDED) */
async function wholeUpsert(db: PGlite, who: Who, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const sql = `insert into preorder_tickets (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
               on conflict (id) do update set ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`;
  return run(db, who, sql, cols.map((c) => row[c]));
}
async function patch(db: PGlite, who: Who, id: string, set: Record<string, unknown>) {
  const cols = Object.keys(set);
  return run(db, who, `update preorder_tickets set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [id, ...cols.map((c) => set[c])]);
}

async function boot() {
  const { db, errors } = await bootDb('supabase');
  ok('boot: migration ทุกไฟล์ (รวม v74) รันผ่าน 0 error', errors.length === 0, errors.slice(0, 3));
  await db.exec('set session_replication_role = replica;');
  const u = (id: string, name: string, auth: string, admin = false, mc = '') =>
    db.query(`insert into users (id, display_name, auth_id, approved, shipping_address, member_code, is_admin, rank) values ($1,$2,$3,true,'addr',$4,$5,'bronze')`, [id, name, auth, mc, admin]);
  await u('uA', 'Alice', AUTH.A, false, 'RYU-0011');
  await u('uB', 'Bob', AUTH.B, false, 'RYU-0022');
  await u('uC', 'Carl', AUTH.C, false, 'RYU-0033');
  await u('uX', 'Admin', AUTH.X, true, 'RYU-0001');
  await db.query(`insert into products (id, series_name, price_total, deposit_amount, status) values ('P1','Series One',1690,300,'production')`);
  const order = async (oid: string, user: string, items: [string, number, number][]) => {
    await db.query(`insert into orders (id, user_id, status, approved_at, total_deposit) values ($1,$2,'approved',now(),$3)`, [oid, user, items.reduce((s, i) => s + i[2], 0)]);
    for (const [iid, qty, dep] of items) await db.query(`insert into order_items (id, order_id, product_id, qty, deposit_amount) values ($1,$2,'P1',$3,$4)`, [iid, oid, qty, dep]);
  };
  await order('o1', 'uA', [['oi1', 1, 300], ['oi2', 3, 900], ['oi3', 1, 300], ['oi4', 1, 300], ['oi5', 1, 300], ['oi6', 1, 300]]);
  await order('o7', 'uC', [['oi7', 1, 300]]);
  await order('o8', 'uB', [['oi8', 1, 300]]);
  const tk = (id: string, no: string, owner: string, qty: number, dep: number, rem: number) =>
    db.query(`insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, approved_at)
              values ($1,$2,'P1',$3,$3,$4,$5,$6,0,'active','production',now())`, [id, no, owner, qty, dep, rem]);
  await tk('t-oi1', 'NR-2026-10-0001', 'uA', 1, 300, 1390);
  await tk('t-oi2', 'NR-2026-10-0002', 'uA', 3, 900, 4170);
  await tk('t-oi3', 'NR-2026-10-0003', 'uA', 1, 300, 1390);
  await tk('t-oi4', 'NR-2026-10-0004', 'uA', 1, 300, 1390);
  await tk('t-oi5', 'NR-2026-10-0005', 'uA', 1, 300, 1390);
  await tk('t-oi6', 'NR-2026-10-0006', 'uA', 1, 300, 1390);
  await tk('t-oi7', 'NR-2026-10-0007', 'uC', 1, 300, 1390);
  await tk('t-oi8', 'NR-2026-10-0008', 'uB', 1, 300, 1390);
  // ตั๋วรุ่นเก่า (id ไม่ผูกรายการ) สำหรับเคส self-heal / ออกตั๋วซ้ำ (review รอบ A)
  await order('o9', 'uA', [['oi9', 1, 300], ['oi10', 1, 300], ['oi11', 1, 300]]);
  await tk('legacy-9', 'NR-2026-10-0009', 'uA', 1, 300, 1390);
  await tk('legacy-11', 'NR-2026-10-0011', 'uA', 1, 300, 1390);
  await db.query(`insert into app_config (key, value) values ('market_direct', '{"enabled": true}')`);
  await db.exec('set session_replication_role = origin;');
  return db;
}

const PAY = { account_name: 'Alice A', promptpay: '0812345678' };
/** ดีลตรงจนถึงสถานะที่ต้องการ: 'reserved' | 'seller_ok' | 'done' */
async function directDeal(db: PGlite, ticketId: string, qty: number, price: number, upto: 'reserved' | 'seller_ok' | 'done') {
  const code = (await call(db, 'B', 'ryuma_wallet_code')).code as string;
  const offer = await call(db, 'A', 'ryuma_market_offer', [ticketId, qty, price, code, PAY, 'uB']);
  if (!offer.ok) throw new Error('offer failed ' + JSON.stringify(offer));
  const id = offer.id as string;
  if (upto === 'reserved') return { id, fin: null as Res | null };
  await call(db, 'B', 'ryuma_market_pay', [id, 'https://x/slip.jpg']);
  await call(db, 'A', 'ryuma_market_seller_confirm', [id]);
  if (upto === 'seller_ok') return { id, fin: null };
  const fin = await call(db, 'X', 'ryuma_market_finalize', [id, null]);
  return { id, fin };
}

(async () => {
  const db = await boot();

  // ── R2A-01 ขายยกใบ: หน้าจอเก่าเซฟทั้งแถวหลังไฟนอล ─────────────────────────────────────────
  {
    const stale = await ticket(db, 't-oi1');
    const { fin } = await directDeal(db, 't-oi1', 1, 500, 'done');
    ok('A1 ไฟนอลยกใบสำเร็จ + เลข -T1', !!fin?.ok && fin?.new_ticket_no === 'NR-2026-10-0001-T1', fin);
    const after = await ticket(db, 't-oi1');
    ok('A2 ไฟนอลเพิ่มเลขรุ่น market_rev 0 → 1', after.market_rev === 1, after.market_rev);
    const r = await wholeUpsert(db, 'X', { ...stale, product_status: 'shipping' });
    const t = await ticket(db, 't-oi1');
    ok('A3 แอดมินหน้าจอเก่า upsert ทั้งแถว: เจ้าของ/เลขตั๋วไม่ถอยกลับ (ยังเป็นผู้รับ -T1) · สถานะรอบเปลี่ยนได้', !r.THROWN && t.owner_id === 'uB' && t.ticket_no === 'NR-2026-10-0001-T1' && t.original_buyer_id === 'uA' && t.product_status === 'shipping', { r, t });
    const r2 = await patch(db, 'X', 't-oi1', { product_status: 'arrived', market_rev: 0 });
    ok('A4 แอปใหม่ส่งเฉพาะช่องที่เปลี่ยน (สถานะรอบ) แม้เลขรุ่นเก่า = ผ่าน ไม่แตะเงิน', !r2.THROWN && (await ticket(db, 't-oi1')).product_status === 'arrived', r2);
    const r3 = await patch(db, 'X', 't-oi1', { status: 'shipped', market_rev: 0 });
    ok('A5 แอดมินหน้าจอเก่า (เลขรุ่นเก่า) จะปิดใบ → ถูกปฏิเสธ "รีเฟรชก่อน"', !!r3.THROWN && /รีเฟรช/.test(r3.THROWN), r3);
    const blk = await asUser(db, AUTH.A, () => rpc<Res>(db, 'ryuma_market_block_reason', ['t-oi1', 'uA', 1])).catch((e) => ({ THROWN: (e as Error).message }));
    ok('A6 คนขายเดิมขายซ้ำไม่ได้ (ฟังก์ชันภายในเรียกตรงไม่ได้ / ตั๋วไม่ใช่ของเขาแล้ว)', !!(blk as Res).THROWN || blk !== null, blk);
    const reoffer = await call(db, 'A', 'ryuma_market_offer', ['t-oi1', 1, 900, (await call(db, 'C', 'ryuma_wallet_code')).code, PAY, 'uC']);
    ok('A7 คนขายเดิมส่งข้อเสนอซ้ำไม่ได้ (not_owner)', reoffer.error === 'not_owner', reoffer);
  }

  // ── R2A-01 แตกขาย: หน้าจอเก่าเซฟทั้งแถวของใบแม่ ─────────────────────────────────────────────
  {
    const stale = await ticket(db, 't-oi2');
    const { fin } = await directDeal(db, 't-oi2', 1, 400, 'done');
    const parent = await ticket(db, 't-oi2');
    const child = await ticket(db, fin?.child_ticket_id as string);
    ok('B1 แตกขายสำเร็จ: แม่ 2 ชิ้น (600/2780) · ลูก 1 ชิ้น (300/1390) · ทั้งคู่ market_rev 1', !!fin?.ok && parent.qty === 2 && Number(parent.deposit_paid) === 600 && Number(parent.remaining_amount) === 2780
      && child.qty === 1 && Number(child.deposit_paid) === 300 && child.owner_id === 'uB' && parent.market_rev === 1 && child.market_rev === 1, { parent, child });
    const r = await wholeUpsert(db, 'X', { ...stale, product_status: 'arrived' });
    const p2 = await ticket(db, 't-oi2');
    ok('B2 หน้าจอเก่า upsert ทั้งแถวใบแม่ (จำนวน/เงินก่อนแตก) → ถูกปฏิเสธ ใบแม่ยังเป็น 2 ชิ้น 600', !!r.THROWN && p2.qty === 2 && Number(p2.deposit_paid) === 600, { r, p2 });
    const r2 = await patch(db, 'X', 't-oi2', { product_status: 'arrived', market_rev: 0 });
    ok('B3 แอปใหม่เปลี่ยนสถานะรอบใบแม่จากหน้าจอเก่า = ผ่าน (ไม่แตะจำนวน/เงิน)', !r2.THROWN && (await ticket(db, 't-oi2')).product_status === 'arrived' && (await ticket(db, 't-oi2')).qty === 2, r2);
    const r3 = await patch(db, 'X', 't-oi2', { qty: 3, market_rev: 1 });
    ok('B4 แอดมินแก้จำนวนชิ้นของตั๋วที่เคยผ่านตลาดไม่ได้ (เก็บค่าเดิมเงียบๆ)', !r3.THROWN && (await ticket(db, 't-oi2')).qty === 2, r3);
    // R3-12: เครื่องเก่าของคนขายจ่ายยอดก่อนแตก (4170) บนใบแม่ที่เหลือค้าง 2780
    const rp = await run(db, 'A', `insert into remaining_payments (id, ticket_id, user_id, amount, slip_url) values ('rp-over','t-oi2','uA',4170,'https://x/s.jpg')`);
    ok('B5 สลิปยอดเกินยอดค้าง (เครื่องเก่าจ่ายยอดก่อนแตกขาย) → ถูกปฏิเสธ', !!rp.THROWN && /เกินยอดค้าง/.test(rp.THROWN), rp);
    const rpOk = await run(db, 'A', `insert into remaining_payments (id, ticket_id, user_id, amount, slip_url) values ('rp-okay','t-oi2','uA',2780,'https://x/s.jpg')`);
    ok('B6 สลิปยอดพอดียอดค้าง = ผ่านตามปกติ', !rpOk.THROWN, rpOk);
  }

  // ── R2B-01 ระหว่างดีลค้าง แอดมินแก้เงินไม่ได้ · ไฟนอลเทียบ snapshot ─────────────────────────────
  {
    const { id } = await directDeal(db, 't-oi3', 1, 800, 'reserved');
    const r = await patch(db, 'X', 't-oi3', { deposit_paid: 0, remaining_amount: 1690, market_rev: 0 });
    ok('C1 ดีลค้าง: แอดมินแก้มัดจำ → ถูกปฏิเสธ', !!r.THROWN && /ระหว่างซื้อขาย/.test(r.THROWN), r);
    const r2 = await run(db, 'X', `insert into remaining_payments (id, ticket_id, user_id, amount, slip_url, status, approved_at) values ('rp-off-x','t-oi3','uA',1390,'','approved',now())`);
    ok('C2 ดีลค้าง: แอดมิน "จบงานนอกระบบ" แทรกสลิปไม่ได้ (rp_lock ไม่ยกเว้นแอดมินแล้ว)', !!r2.THROWN, r2);
    const r3 = await patch(db, 'X', 't-oi3', { product_status: 'shipping', market_rev: 0 });
    ok('C3 ดีลค้าง: แอดมินยังเปลี่ยนสถานะรอบได้ (ของเดินทาง)', !r3.THROWN, r3);
    await call(db, 'B', 'ryuma_market_pay', [id, 'https://x/slip.jpg']);
    await call(db, 'A', 'ryuma_market_seller_confirm', [id]);
    await db.exec('set session_replication_role = replica;');
    await db.query(`update preorder_tickets set deposit_paid = 0, remaining_amount = 1690 where id = 't-oi3'`); // จำลองทางหลุดอื่น
    await db.exec('set session_replication_role = origin;');
    const fin = await call(db, 'X', 'ryuma_market_finalize', [id, null]);
    ok('C4 ยอดของใบไม่ตรง snapshot ตอนตกลง → ไฟนอลปฏิเสธ ticket_changed (ตั๋วไม่ย้าย)', fin.error === 'ticket_changed' && (await ticket(db, 't-oi3')).owner_id === 'uA', fin);
  }

  // ── R2A-02 แอดมินหน้าจอเก่าทำงานกับตั๋วที่โอนไปแล้ว ─────────────────────────────────────────
  {
    const r = await run(db, 'X', `insert into remaining_payments (id, ticket_id, user_id, amount, slip_url, status, approved_at) values ('rp-off-t-oi1','t-oi1','uA',1390,'','approved',now())`);
    ok('D1 "จบงานนอกระบบ" จากหน้าจอเก่า บันทึกเงินในชื่อคนขาย (ไม่ใช่คนถือ) → ถูกปฏิเสธ', !!r.THROWN && /เปลี่ยนเจ้าของ/.test(r.THROWN), r);
    const r2 = await patch(db, 'X', 't-oi1', { deposit_paid: 500, remaining_amount: 1190, market_rev: 1 });
    ok('D2 แก้มัดจำตั๋วที่เปลี่ยนมือแล้ว (เลขรุ่นปัจจุบัน) → ถูกปฏิเสธ', !!r2.THROWN && /แก้มัดจำไม่ได้/.test(r2.THROWN), r2);
    const r3 = await run(db, 'X', `delete from preorder_tickets where id = 't-oi1'`);
    ok('D3 ลบตั๋วที่มีประวัติเปลี่ยนมือ (แม้แอดมิน) → ถูกปฏิเสธ', !!r3.THROWN, r3);
    const r4 = await run(db, 'X', `update order_items set qty = 0 where id = 'oi1'`);
    ok('D4 ยกเลิกรายการในออเดอร์ที่ตั๋วเกิดมา (ตั๋วเปลี่ยนมือแล้ว) → ถูกปฏิเสธ ไม่ครึ่งทาง', !!r4.THROWN && Number((await q(db, `select qty from order_items where id='oi1'`))[0].qty) === 1, r4);
    const r5 = await run(db, 'X', `update order_items set qty = 0 where id = 'oi6'`);
    const r6 = await run(db, 'X', `delete from preorder_tickets where id = 't-oi6'`);
    ok('D5 ตั๋วธรรมดา (ไม่เคยผ่านตลาด) แอดมินยังลบ/ยกเลิกรายการได้เหมือนเดิม', !r5.THROWN && !r6.THROWN && !(await ticket(db, 't-oi6')), { r5, r6 });
    const r7 = await patch(db, 'X', 't-oi5', { deposit_paid: 500, remaining_amount: 1190, market_rev: 0 });
    ok('D6 ตั๋วธรรมดา แอดมินยังแก้มัดจำได้เหมือนเดิม', !r7.THROWN && Number((await ticket(db, 't-oi5')).deposit_paid) === 500, r7);
    const r8 = await run(db, 'X', `insert into remaining_payments (id, ticket_id, user_id, amount, slip_url, status, approved_at) values ('rp-off-t-oi5','t-oi5','uA',1190,'','approved',now())`);
    ok('D7 ตั๋วธรรมดา แอดมิน "จบงานนอกระบบ" บันทึกเงินได้ตามปกติ', !r8.THROWN, r8);
    const r9 = await run(db, 'X', `update remaining_payments set status='approved', approved_at=now() where id='rp-okay'`);
    const r10 = await patch(db, 'X', 't-oi2', { remaining_paid: 2780, status: 'paid_full', market_rev: 1 });
    ok('D8 อนุมัติสลิปของตั๋วที่เคยแตกขาย (เลขรุ่นปัจจุบัน) = ผ่านตามปกติ', !r9.THROWN && !r10.THROWN && Number((await ticket(db, 't-oi2')).remaining_paid) === 2780, { r9, r10 });
  }

  // ── R3-01 / R3-02 / R2B-02 ลบสมาชิก ────────────────────────────────────────────────────────
  {
    const r0 = await call(db, 'X', 'ryuma_admin_purge_user', ['uB']);
    ok('E0 ลบผู้รับที่ยังมีดีลค้าง (เคส C ค้าง seller_ok) → ปฏิเสธ live_deal', r0.error === 'live_deal', r0);
    const stuck = (await q(db, `select id from ticket_transfers where ticket_id = 't-oi3' and status = 'seller_ok'`))[0]?.id as string;
    const cx = await call(db, 'X', 'ryuma_market_admin_cancel', [stuck, 'ยอดเปลี่ยนระหว่างดีล']);
    const r1 = await call(db, 'X', 'ryuma_admin_purge_user', ['uB']);
    ok('E1 ยกเลิกดีลค้างแล้ว ลบผู้รับที่ถือตั๋วที่ได้มาผ่านตลาด → ปฏิเสธ market_history', !!cx.ok && r1.error === 'market_history', { cx, r1 });
    const r2 = await call(db, 'X', 'ryuma_admin_purge_user', ['uA']);
    ok('E2 ลบคนขายที่มีดีลค้าง → ปฏิเสธ live_deal (หรือ market_history)', r2.error === 'live_deal' || r2.error === 'market_history', r2);
    const r3 = await call(db, 'X', 'ryuma_admin_purge_user', ['uC']);
    ok('E3 ลบสมาชิกธรรมดา (ไม่มีประวัติตลาด) = ลบได้เหมือนเดิม', r3.ok === true && (await q(db, `select 1 from users where id='uC'`)).length === 0 && !(await ticket(db, 't-oi7')), r3);
    const tr = await q(db, `select count(*)::int n from ticket_transfers where status = 'done'`);
    ok('E4 แถวดีลที่ไฟนอลแล้วยังอยู่ครบ (หลักฐาน)', Number(tr[0].n) >= 2, tr);
  }

  // ── ด่านลูกค้า: suspended / วิธีรับของหลังรับเรื่อง / market_rev ────────────────────────────────
  {
    await run(db, 'X', `update users set suspended = true where id = 'uB'`);
    const r = await run(db, 'B', `update users set suspended = false where id = 'uB'`);
    ok('F1 ลูกค้าปลดระงับตัวเองไม่ได้ (เดิมเครื่องที่เซฟซ้ำปลดได้)', !!r.THROWN && (await q(db, `select suspended from users where id='uB'`))[0].suspended === true, r);
    await run(db, 'X', `update users set suspended = false where id = 'uB'`);
    await run(db, 'X', `update preorder_tickets set delivery = '{"method":"courier","requested_at":"2026-10-03T00:00:00Z","accepted_at":"2026-10-03T01:00:00Z"}' where id = 't-oi8'`);
    await run(db, 'B', `update preorder_tickets set delivery = '{"method":"pickup","requested_at":"2026-10-03T00:00:00Z"}' where id = 't-oi8'`);
    const d = (await ticket(db, 't-oi8')).delivery as Record<string, string>;
    ok('F2 แอดมินรับเรื่องจัดส่งแล้ว เครื่องลูกค้าเซฟซ้ำลบการรับเรื่องไม่ได้', d?.accepted_at === '2026-10-03T01:00:00Z' && d?.method === 'courier', d);
    await run(db, 'B', `update preorder_tickets set market_rev = 99 where id = 't-oi8'`);
    ok('F3 ลูกค้าแก้เลขรุ่นตั๋วเองไม่ได้', (await ticket(db, 't-oi8')).market_rev === 0);
  }

  // ── review รอบ A: ช่องที่เจอเพิ่ม ─────────────────────────────────────────────────────────────
  {
    // คนขายเดิม (ยังเป็น original_buyer ตาม RLS v21) แก้ตั๋วที่ขายไปแล้วไม่ได้
    await run(db, 'A', `update preorder_tickets set delivery = '{"method":"custom","address":"บ้านคนขาย","requested_at":"2026-10-03T00:00:00Z"}' where id = 't-oi1'`);
    ok('H1 คนขายเดิมเปลี่ยนวิธีรับของ/ที่อยู่ของตั๋วที่ขายไปแล้วไม่ได้', (await ticket(db, 't-oi1')).delivery === null);
    // เปลี่ยน id ตั๋วลูกเพื่อหลบกฎถือ 3 วันไม่ได้
    const child = (await q(db, `select id from preorder_tickets where split_from = 't-oi2'`))[0].id as string;
    await run(db, 'B', `update preorder_tickets set id = 'tc-bypass', created_at = now() - interval '9 days' where id = $1`, [child]);
    ok('H2 ผู้รับเปลี่ยน id/วันที่สร้างของตั๋วลูกไม่ได้ (หลบกฎถือ 3 วัน)', !!(await ticket(db, child)) && !(await ticket(db, 'tc-bypass')));
    // self-heal ถูกกติกา: รายการที่ตั๋วหายจริง → ออกได้ แต่ยอดค้าง/สถานะ/คนจ่าย คำนวณที่เซิร์ฟเวอร์
    const heal = await run(db, 'A', `insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status)
                                     values ('t-oi10','NR-2026-10-0010','P1','uA','uB',1,300,0,0,'paid_full','arrived')`);
    const h = await ticket(db, 't-oi10');
    ok('H3 ลูกค้าออกตั๋วที่หายเองได้ แต่ตั้งยอดค้าง 0 / ถึงไทย / คนจ่ายเป็นคนอื่นเองไม่ได้ (เซิร์ฟเวอร์คำนวณใหม่)',
      !heal.THROWN && Number(h?.remaining_amount) === 1390 && h?.product_status === 'production' && h?.original_buyer_id === 'uA' && h?.status === 'active', { heal, h });
    const dup = await run(db, 'A', `insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status)
                                    values ('t-oi11','NR-2026-10-0012','P1','uA','uA',1,300,0,0,'paid_full','arrived')`);
    ok('H4 ออกตั๋วซ้ำให้รายการที่มีตั๋วรุ่นเก่าอยู่แล้วไม่ได้', !!dup.THROWN && /มีอยู่แล้ว/.test(dup.THROWN), dup);
    // ตั๋วรุ่นเก่าที่ขายไปแล้ว: คนขายออกตั๋ว t-<item> ใหม่ไม่ได้
    const codeB = (await call(db, 'B', 'ryuma_wallet_code')).code as string;
    const off = await call(db, 'A', 'ryuma_market_offer', ['legacy-9', 1, 0, codeB, PAY, 'uB']);
    if (off.ok) { await call(db, 'B', 'ryuma_market_pay', [off.id, '']); await call(db, 'A', 'ryuma_market_seller_confirm', [off.id]); }
    const fin = off.ok ? await call(db, 'X', 'ryuma_market_finalize', [off.id, 'oi9']) : off;
    const remint = await run(db, 'A', `insert into preorder_tickets (id, ticket_no, product_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status)
                                       values ('t-oi9','NR-X-9999','P1','uA','uA',1,300,0,0,'paid_full','arrived')`);
    ok('H5 ขายตั๋วรุ่นเก่าไปแล้ว คนขายออกตั๋วใหม่ให้รายการเดิมไม่ได้ (เดิมได้ตั๋วฟรีที่ยอดค้าง 0)', !!fin.ok && !!remint.THROWN && !(await ticket(db, 't-oi9')), { fin, remint });
    const up = await patch(db, 'X', 't-oi1', { remaining_amount: 9999, market_rev: 1 });
    ok('H6 แอดมินเพิ่มยอดค้างของตั๋วที่เปลี่ยนมือแล้วไม่ได้ (กันหน้าจอรุ่นเก่าดันยอดก่อนแตกขายกลับ)', !!up.THROWN, up);
  }

  // ── กระดานยังทำงานครบหลัง v74 ──────────────────────────────────────────────────────────────
  {
    await db.query(`insert into app_config (key, value) values ('market_public', '{"enabled": true}') on conflict (key) do update set value = excluded.value`);
    await run(db, 'X', `update users set payout_info = '{"account_name":"Alice","promptpay":"0812345678"}' where id = 'uA'`);
    const l = await call(db, 'A', 'ryuma_market_list', ['t-oi4', 1, 600]);
    const rs = await call(db, 'B', 'ryuma_market_reserve', [l.id]);
    const py = await call(db, 'B', 'ryuma_market_pay', [l.id, 'https://x/s.jpg']);
    const cf = await call(db, 'A', 'ryuma_market_seller_confirm', [l.id]);
    const fn = await call(db, 'X', 'ryuma_market_finalize', [l.id, null]);
    const t = await ticket(db, 't-oi4');
    ok('G1 กระดาน: ลงขาย → จอง → จ่าย → ยืนยัน → ไฟนอล ครบ · ตั๋วไปผู้ซื้อ · เลขรุ่น 1', !!l.ok && !!rs.ok && !!py.ok && !!cf.ok && !!fn.ok && t.owner_id === 'uB' && t.market_rev === 1, { l, rs, py, cf, fn });
    const again = await call(db, 'X', 'ryuma_market_finalize', [l.id, null]);
    ok('G2 ไฟนอลซ้ำ = ok again ไม่ย้ายซ้ำ ไม่เพิ่มเลขรุ่นซ้ำ', !!again.again && (await ticket(db, 't-oi4')).market_rev === 1, again);
  }

  console.log(`\nroundA-audit (sql): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
