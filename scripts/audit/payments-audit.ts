/** ตรวจ "รอชำระ / สลิปเดียวหลายใบ" (2026-09-12) — รัน: npm run audit:points */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import { submitRemainingPayment, approveRemainingPayment, rejectRemainingPayment } from '../../src/data/mutations';
import { ticketPayable, ticketSelectable, pendingRpGroups, payableTickets, walletTabOf, type WalletTab } from '../../src/domain/services/payments';
import { ticketDone } from '../../src/domain/services/delivery';
import type { Database, PreorderTicket } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail ?? ''); } };
const U = 'u-me';
const mk = (over: Partial<PreorderTicket>): PreorderTicket => ({ id: 'x', ticket_no: 'X', product_id: 'p', owner_id: U, original_buyer_id: U, qty: 1, deposit_paid: 300, remaining_amount: 700, remaining_paid: 0, status: 'active', product_status: 'open', qr_code_url: '', created_at: '2026-09-01T05:00:00.000Z', approved_at: '2026-09-01T05:00:00.000Z', ...over } as PreorderTicket);

// ── P1: กติกา "เปิดให้จ่าย" ─────────────────────────────────────────────────
ok('P1a ถึงไทย+ค้าง = จ่ายได้ (เดิมหลุดไปแท็บเรียบร้อย)', ticketPayable(mk({ product_status: 'arrived' })) && ticketDone(mk({ product_status: 'arrived' })));
ok('P1b กำลังเดินทาง+ค้าง = จ่ายได้', ticketPayable(mk({ product_status: 'shipping' })));
ok('P1c ผลิตอยู่+ค้าง = ยังจ่ายไม่ได้', !ticketPayable(mk({ product_status: 'production' })));
ok('P1d ถึงไทย จ่ายครบ = ไม่อยู่รอชำระ', !ticketPayable(mk({ product_status: 'arrived', remaining_paid: 700 })));
ok('P1e ส่งของแล้วแต่ยังค้าง (ผิดปกติ) = ไม่ให้จ่ายซ้ำในแท็บ', !ticketPayable(mk({ product_status: 'delivered', status: 'shipped' })));

// ── P2: สลิปเดียวหลายใบ → กลุ่มเดียว · อนุมัติทีละใบ · ปฏิเสธบางใบ ─────────────
{
  let db: Database = structuredClone(SEED_DATABASE);
  // seed ไม่มีใบที่ของถึงไทย → ทำให้ 2 ใบแรกที่ค้างของ u-me เป็น 'arrived' (จำลองของถึง)
  let made = 0;
  db.tickets = db.tickets.map((t) => (t.owner_id === U && t.status === 'active' && t.remaining_amount - t.remaining_paid > 0 && made++ < 2 ? { ...t, product_status: 'arrived' as const } : t));
  const tix = payableTickets(db, U).filter((t) => ticketSelectable(db, t));
  ok('P2a seed มีใบรอชำระอย่างน้อย 2 ใบ', tix.length >= 2, tix.length);
  const slip = 'https://x/slip-1.jpg';
  for (const t of tix.slice(0, 2)) db = submitRemainingPayment(t.id, U, 0, slip)(db);
  const groups = pendingRpGroups(db);
  ok('P2b 2 แถว slip เดียวกัน = 1 กลุ่ม ยอดรวม = ผลรวมค้าง', groups.length === 1 && groups[0].rps.length === 2 && groups[0].total === tix.slice(0, 2).reduce((s, t) => s + (t.remaining_amount - t.remaining_paid), 0), groups);
  ok('P2c ใบที่ส่งสลิปแล้ว ติ๊กไม่ได้ แต่ยังอยู่รอชำระ', tix.slice(0, 2).every((t) => !ticketSelectable(db, db.tickets.find((x) => x.id === t.id)!) && ticketPayable(db.tickets.find((x) => x.id === t.id)!)));
  // ส่งซ้ำใบเดิม → ถูกปัดตก (มีสลิปค้าง)
  const n = db.remainingPayments.length;
  db = submitRemainingPayment(tix[0].id, U, 0, 'https://x/slip-2.jpg')(db);
  ok('P2d ส่งซ้ำใบที่มีสลิปค้าง → ไม่เพิ่มแถว', db.remainingPayments.length === n);
  // ปฏิเสธเฉพาะใบแรก → กลุ่มเหลือ 1 · ใบแรกกลับมาติ๊กได้
  const g = pendingRpGroups(db)[0];
  db = rejectRemainingPayment(g.rps[0].id)(db);
  const g2 = pendingRpGroups(db);
  ok('P2e ปฏิเสธบางใบ: กลุ่มเหลือ 1 แถว + ใบนั้นเลือกได้อีก', g2.length === 1 && g2[0].rps.length === 1 && ticketSelectable(db, db.tickets.find((x) => x.id === g.rps[0].ticket_id)!));
  // อนุมัติใบที่เหลือ → ปิดใบ
  db = approveRemainingPayment(g2[0].rps[0].id)(db);
  const closed = db.tickets.find((x) => x.id === g2[0].rps[0].ticket_id)!;
  ok('P2f อนุมัติ: ใบปิด (paid_full) และหลุดจากรอชำระ', closed.status === 'paid_full' && !ticketPayable(closed) && pendingRpGroups(db).length === 0);
}

// ── P3: กลุ่มแยกตามคน แม้ slip_url ซ้ำ (กันเคสประหลาด) ──────────────────────────
{
  let db: Database = structuredClone(SEED_DATABASE);
  const other = db.users.find((u) => !u.is_admin && u.id !== U)!;
  const a = mk({ id: 't-mine', ticket_no: 'MN-1', product_status: 'arrived', product_id: db.products[0].id });
  db.tickets.push(a, mk({ id: 't-other', ticket_no: 'OT-1', owner_id: other.id, original_buyer_id: other.id, product_status: 'arrived', product_id: db.products[0].id }));
  db = submitRemainingPayment(a.id, U, 0, 'https://x/same.jpg')(db);
  db = submitRemainingPayment('t-other', other.id, 0, 'https://x/same.jpg')(db);
  ok('P3 คนละคน slip เดียวกัน = คนละกลุ่ม', pendingRpGroups(db).length === 2);
}


// ── P4: แท็บกระเป๋าพรี walletTabOf ──────────────────────────────────────────────
{
  const db: Database = structuredClone(SEED_DATABASE);
  const pre = db.products.find((p) => !p.is_stock)!.id;
  const stock = db.products.find((p) => p.is_stock)!.id;
  // ตั๋ว in-stock จากออเดอร์: snapshot มัดจำ = ราคา (จ่ายเต็มตั้งแต่เกิด)
  db.orders.push({ id: 'o-tab', user_id: U, total_deposit: 1000, slip_url: '', status: 'approved', created_at: '2026-09-01T05:00:00.000Z', items: [{ id: 'oi-tab', order_id: 'o-tab', product_id: stock, qty: 1, deposit_amount: 1000, unit_price: 1000, unit_deposit: 1000 }] } as any);
  const instock = mk({ id: 't-oi-tab', product_id: stock, deposit_paid: 1000, remaining_amount: 0, remaining_paid: 0, status: 'paid_full', product_status: 'open' });
  const cases: [string, PreorderTicket, WalletTab][] = [
    ['พร้อมส่ง จ่ายเต็ม (open) → เรียบร้อย', instock, 'done'],
    ['ใบพรี เปิดจอง ค้าง → ใบพรี', mk({ product_id: pre, product_status: 'open' }), 'preorder'],
    ['ใบพรี ผลิต ค้าง → ใบพรี', mk({ product_id: pre, product_status: 'production' }), 'preorder'],
    ['ใบพรี ผลิต จ่ายครบก่อนของออก → ยังเป็นใบพรี (เดิมหลุดไปเรียบร้อย)', mk({ product_id: pre, product_status: 'production', remaining_paid: 700, status: 'paid_full' }), 'preorder'],
    ['เดินทาง ค้าง → รอชำระ', mk({ product_id: pre, product_status: 'shipping' }), 'pay'],
    ['เดินทาง จ่ายครบ → กำลังเดินทาง', mk({ product_id: pre, product_status: 'shipping', remaining_paid: 700 }), 'shipping'],
    ['ถึงไทย ค้าง → รอชำระ (เดิมหลุดไปเรียบร้อย)', mk({ product_id: pre, product_status: 'arrived' }), 'pay'],
    ['ถึงไทย จ่ายครบ → เรียบร้อย', mk({ product_id: pre, product_status: 'arrived', remaining_paid: 700 }), 'done'],
    ['ส่งมอบ ค้าง → รอชำระ', mk({ product_id: pre, product_status: 'delivered' }), 'pay'],
    ['เสร็จสิ้น (shipped) → เรียบร้อย', mk({ product_id: pre, product_status: 'delivered', status: 'shipped', remaining_paid: 700 }), 'done'],
    ['ส่งของแล้วแต่ค้าง (ผิดปกติ) → เรียบร้อย ไม่ให้จ่ายซ้ำ', mk({ product_id: pre, product_status: 'delivered', status: 'shipped' }), 'done'],
  ];
  for (const [name, t, want] of cases) ok(`P4 ${name}`, walletTabOf(db, t) === want, walletTabOf(db, t));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
