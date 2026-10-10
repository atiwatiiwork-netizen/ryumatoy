/* ตามของ (collect.ts) — เทสต์การจัดกลุ่ม/ตัวกรอง บนฐานปลอม (ไม่แตะ Supabase)
 *   npx --yes tsx scripts/audit/collect-audit.ts */
import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, PreorderTicket } from '../../src/domain/entities';
import { collectBoard, collectPushPayload, collectMessage, awaitingSlipTickets, REMIND_ACTION } from '../../src/domain/services/collect';

let p = 0, f = 0;
const ok = (n: string, c: boolean) => { if (c) p++; else { f++; console.log('FAIL', n); } };

const base = (): Database => {
  const db = structuredClone(SEED_DATABASE) as Database;
  db.users = [
    { id: 'u1', display_name: 'สมชาย', rank: 'bronze', total_spent: 0, preferred_lang: 'th', member_code: 'RYU-0001', phone: '0812345678' },
    { id: 'u2', display_name: 'สมหญิง', rank: 'bronze', total_spent: 0, preferred_lang: 'th', line_id: 'ying' },
    { id: 'u3', display_name: 'มานี', rank: 'bronze', total_spent: 0, preferred_lang: 'th' },
  ] as Database['users'];
  db.products = [
    { id: 'pA', series_name: 'Luffy Gear 5', franchise_id: 'f', manufacturer_id: 'm', wcf_type: 'wcf', images: [], price_total: 1890, deposit_amount: 300, is_stock: false, status: 'arrived', created_at: '2026-10-01' },
    { id: 'pB', series_name: 'Itachi', franchise_id: 'f', manufacturer_id: 'm', wcf_type: 'wcf', images: [], price_total: 3090, deposit_amount: 300, is_stock: false, status: 'shipping', created_at: '2026-10-01' },
  ] as unknown as Database['products'];
  db.batches = []; db.variants = []; db.transfers = [] as never; db.remainingPayments = []; db.activityLogs = []; db.paymentPlans = []; db.pushSubscriptions = [];
  db.paymentAccounts = [{ id: 'acc', name: 'พร้อมเพย์ ริวมะ', number: '0853475681', active: true }];
  const tk = (id: string, owner: string, product: string, ps: PreorderTicket['product_status'], rem: number, paid = 0, extra: Partial<PreorderTicket> = {}): PreorderTicket => ({
    id, ticket_no: id.toUpperCase(), product_id: product, owner_id: owner, original_buyer_id: owner, qty: 1, deposit_paid: 300,
    remaining_amount: rem, remaining_paid: paid, status: 'active', product_status: ps, qr_code_url: '', created_at: '2026-10-01', ...extra,
  });
  db.tickets = [
    tk('t1', 'u1', 'pA', 'arrived', 1590),            // ทวงได้
    tk('t2', 'u2', 'pA', 'arrived', 1590),            // ทวงได้
    tk('t3', 'u3', 'pA', 'arrived', 1590),            // ส่งสลิปแล้ว (ด้านล่าง)
    tk('t4', 'u1', 'pB', 'shipping', 2790),           // ของยังไม่ถึง → ไม่ขึ้น
    tk('t5', 'u2', 'pA', 'arrived', 1590, 1590),      // จ่ายครบ → ไม่ขึ้น
    tk('t6', 'u1', 'pA', 'delivered', 800, 0, { status: 'shipped' }), // ส่งแล้วยังค้าง → แถบแดง
    tk('t11', 'u3', 'pA', 'shipping', 1590),          // ใบรอบอื่นของ pA ของยังไม่ถึง → นับใน others.notArrived
  ];
  db.remainingPayments = [{ id: 'rp3', ticket_id: 't3', user_id: 'u3', amount: 1590, slip_url: 'x', status: 'pending', created_at: '2026-10-09' }];
  return db;
};

// 1) จัดกลุ่มรายสินค้า + ยอดรวมเฉพาะที่ทวงได้
let db = base();
let b = collectBoard(db, new Date('2026-10-10T10:00:00+07:00'));
ok('มี 1 สินค้าที่ค้าง (pA) — pB ของยังไม่ถึงไม่ขึ้น', b.products.length === 1 && b.products[0].productId === 'pA');
ok('ยอดทวงได้ = t1+t2 (t3 รอตรวจไม่นับ · t5 จ่ายครบ · t6 ส่งแล้วแยกไว้)', b.totalDue === 3180 && b.ticketCount === 2 && b.customerCount === 2);
ok('สินค้า pA โชว์ครบ 3 คน (รวมคนรอตรวจสลิปแบบจาง) · awaitingSlip 1', b.products[0].customers.length === 3 && b.products[0].awaitingSlip === 1 && b.awaitingSlip === 1);
const u3 = b.products[0].customers.find((c) => c.userId === 'u3')!;
ok('คนที่ส่งสลิปแล้ว: chaseable ว่าง due 0', u3.chaseable.length === 0 && u3.due === 0 && u3.tickets[0].awaitingSlip);
ok('ส่งแล้วยังค้าง = t6 ขึ้นแถบแดง', b.shippedUnpaid.length === 1 && b.shippedUnpaid[0].id === 't6');
ok('นับใบทั้งหมดของ pA = 6 (ในหน้า 3 + จ่ายครบ 1 + ส่งแล้ว 1 + รอบอื่นยังไม่ถึง 1)', b.products[0].totalTickets === 6 && b.products[0].others.paidFull === 1 && b.products[0].others.shipped === 1 && b.products[0].others.notArrived === 1);
ok('เรียงลูกค้าในสินค้า: ค้างมากก่อน แล้วคนรอสลิปท้าย', b.products[0].customers[2].userId === 'u3');
ok('ข้อมูลติดต่อ', b.products[0].customers.find((c) => c.userId === 'u1')!.phone === '0812345678' && b.products[0].customers.find((c) => c.userId === 'u2')!.lineId === 'ying');

// 2) มุมมองรายคน: u1 ค้างแค่ pA (t4 ของยังไม่ถึงไม่นับ) · นัดชำระ · เตือนล่าสุดจาก log
db = base();
db.paymentPlans = [{ id: 'pl', user_id: 'u1', due_date: '2026-10-15', amount: 1590, items: [], status: 'open', created_at: '2026-10-09' }];
db.activityLogs = [
  { id: 'l1', actor_id: 'adm', actor_name: 'แอดมิน', action: REMIND_ACTION, summary: 'x', target_id: 'u1', created_at: '2026-10-08T10:00:00Z' },
  { id: 'l2', actor_id: 'adm', actor_name: 'แอดมิน', action: REMIND_ACTION, summary: 'x', target_id: 'u1', created_at: '2026-10-09T10:00:00Z' },
  { id: 'l3', actor_id: 'adm', actor_name: 'แอดมิน', action: 'other', summary: 'x', target_id: 'u1', created_at: '2026-10-10T10:00:00Z' },
];
b = collectBoard(db);
const c1 = b.customers.find((c) => c.userId === 'u1')!;
ok('รายคน u1: ค้าง 1590 ใบเดียว', c1.due === 1590 && c1.chaseable.length === 1 && c1.tickets.length === 1);
ok('u1 มีนัดเปิดอยู่ → plan แสดง', c1.plan?.id === 'pl');
ok('เตือนล่าสุด = log remind_collect ล่าสุด (ไม่ใช่ action อื่น)', c1.lastRemindedAt === '2026-10-09T10:00:00Z');
ok('u1 ไม่มีกระดิ่ง', c1.hasBell === false);

// 3) ติดประกาศขายในตลาด → ไม่ทวง (marketLocked)
db = base();
(db as unknown as { transfers: unknown[] }).transfers = [{ id: 'tr', ticket_id: 't1', seller_id: 'u1', from_user_id: 'u1', status: 'listed', ask_price: 500, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z' }];
b = collectBoard(db, new Date('2026-10-10T10:00:00+07:00'));
const lockedRow = b.products[0].customers.find((c) => c.userId === 'u1')!.tickets[0];
ok('ตั๋วที่ลงขายอยู่ = locked และไม่นับยอด', lockedRow.locked === true && b.totalDue === 1590 && b.customerCount === 1);

// 4) ตั๋วลูกจากการแตกขาย (split_from) มี remaining ของตัวเอง → นับปกติ
db = base();
db.tickets.push({ ...db.tickets[0], id: 't7', ticket_no: 'T7', owner_id: 'u3', original_buyer_id: 'u1', split_from: 't1', remaining_amount: 700, remaining_paid: 0 });
b = collectBoard(db);
ok('ตั๋วลูก split นับตาม owner ปัจจุบัน (u3) ด้วยยอดของมันเอง', b.customers.find((c) => c.userId === 'u3')!.chaseable.some((r) => r.ticket.id === 't7' && r.due === 700));

// 5) ข้อความ push/ก๊อป — มียอด ไม่มีจำนวนสต๊อก มีบัญชีรับเงิน
db = base(); b = collectBoard(db);
const u1 = b.customers.find((c) => c.userId === 'u1')!;
const pay = collectPushPayload(u1);
ok('push: ชื่อสินค้า + ยอด', pay.body.includes('Luffy Gear 5') && pay.body.includes('฿1,590') && pay.url === '/wallet');
const msg = collectMessage(db, u1);
ok('ก๊อป: ชื่อลูกค้า + ตั๋ว + ยอด + พร้อมเพย์ + ลิงก์', msg.includes('สมชาย') && msg.includes('T1') && msg.includes('฿1,590') && msg.includes('0853475681') && msg.includes('/wallet'));
ok('awaitingSlipTickets = t3', awaitingSlipTickets(base()).map((t) => t.id).join() === 't3');

// 6) ไม่มีอะไรค้าง → บอร์ดว่าง
db = base(); db.tickets = []; db.remainingPayments = [];
b = collectBoard(db);
ok('ว่าง', b.products.length === 0 && b.totalDue === 0 && b.shippedUnpaid.length === 0);

console.log(`ตามของ: ${p} ผ่าน / ${f} ตก`);
if (f) process.exit(1);
