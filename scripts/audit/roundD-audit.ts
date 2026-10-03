/** เทสต์ฝั่งแอปของรอบ D (audit เปลี่ยนใบพรี 2026-10-03 · แต้ม/ยศ/เงินในรายงาน) — รัน: npm run audit:roundD
 *  ฝั่งฐานข้อมูลอยู่ที่ scripts/audit/sql/roundD-audit.ts (npm run audit:sql) */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import { countsForMonthly, monthlyConfig, DEFAULT_MONTHLY } from '../../src/domain/services/monthly';
import { qualifyingCount } from '../../src/domain/services/campaigns';
import { closerOf, earnRowForTicket, ticketEarnBlock, ticketIsFullPay, earnIdFor } from '../../src/domain/services/points';
import { userTakenInBatch } from '../../src/domain/services/reservations';
import { ticketsInMonth } from '../../src/domain/services/analytics';
import { orderOfTicket } from '../../src/domain/services/journey';
import { paidByUser } from '../../src/domain/services/money';
import { unmatchedApprovedItems } from '../../src/domain/services/tickets';
import type { Database, Order, PreorderTicket, TicketTransfer, Campaign } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); } };
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const product = { ...SEED_DATABASE.products[0], id: 'P1', deposit_amount: 300, price_total: 1690, is_stock: false, status: 'production' } as Database['products'][number];
const tk = (over: Partial<PreorderTicket>): PreorderTicket => ({ id: 't', ticket_no: 'NR-1', product_id: 'P1', owner_id: 'uA', original_buyer_id: 'uA', qty: 1, deposit_paid: 300, remaining_amount: 1390, remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '', created_at: ago(40), approved_at: ago(40), ...over } as PreorderTicket);
const order = (id: string, user: string, items: Order['items'], at = ago(40)): Order => ({ id, user_id: user, total_deposit: items.reduce((s, i) => s + i.deposit_amount, 0), slip_url: '', status: 'approved', created_at: at, approved_at: at, items });
const tr = (over: Partial<TicketTransfer>): TicketTransfer => ({ id: 'tr', ticket_id: 't', from_user_id: 'uA', to_user_id: 'uB', asking_price: 500, status: 'done', listed_at: ago(1), approved_at: ago(1), kind: 'direct', ...over } as TicketTransfer);
const base = (over: Partial<Database>): Database => ({ ...structuredClone(SEED_DATABASE), products: [product], orders: [], tickets: [], remainingPayments: [], transfers: [], pointLedger: [], ...over });

// ── ยศรายเดือน / Event ─────────────────────────────────────────────────────────────────
{
  const db = base({});
  const cfg = { ...DEFAULT_MONTHLY, enabled: true };
  ok('M1 ใบที่ขาย/เปลี่ยนมือไปแล้ว ไม่นับยศรายเดือน (R1-06)', !countsForMonthly(db, cfg, tk({ owner_id: 'uB', original_buyer_id: 'uA' })) && countsForMonthly(db, cfg, tk({})));
  void monthlyConfig;
  const c = { id: 'c1', name: 'E', starts_at: ago(60), ends_at: ago(-10), tiers: [{ threshold: 1, reward_coupon_id: 'x' }], status: 'active', created_at: ago(60) } as unknown as Campaign;
  const dbE = base({ tickets: [tk({ id: 't-a', created_at: ago(30) }), tk({ id: 'tc-kid', split_from: 't-a', created_at: ago(1) })] });
  ok('M2 Event "พรีครบ N": ตั๋วลูกที่แตกขายแล้วรับคืน ไม่นับเป็นใบใหม่ (R1-27)', qualifyingCount(dbE, c, 'uA') === 1, qualifyingCount(dbE, c, 'uA'));
}

// ── แต้มปิดใบ: ของคนปิด · ตั๋วลูกไม่ได้ซ้ำ · ชนิดตั๋วลูก ───────────────────────────────────────
{
  const closed = tk({ id: 't-oiA', remaining_paid: 1390, owner_id: 'uB', original_buyer_id: 'uA' });
  const db = base({
    orders: [order('oA', 'uA', [{ id: 'oiA', order_id: 'oA', product_id: 'P1', qty: 1, deposit_amount: 300, unit_price: 1690, unit_deposit: 300 }])],
    tickets: [closed],
    remainingPayments: [{ id: 'rp1', ticket_id: 't-oiA', user_id: 'uA', amount: 1390, slip_url: 'https://x', status: 'approved', created_at: ago(5), approved_at: ago(5) }],
    settings: { ...SEED_DATABASE.settings, points_enabled: true },
  });
  ok('P1 คนปิดยอด = เจ้าของสลิปที่อนุมัติล่าสุด (คนขาย) แม้ใบเปลี่ยนมือแล้ว', closerOf(db, closed) === 'uA');
  const row = earnRowForTicket(db, closed);
  ok('P2 แต้มที่ออกทีหลัง (เปิดตัว/ให้ย้อนหลัง) เข้าคนปิด ไม่ใช่คนถือ (R1-28)', row?.user_id === 'uA', row);
  const dbR = { ...db, remainingPayments: [...db.remainingPayments, { id: 'rp2', ticket_id: 't-oiA', user_id: 'uB', amount: 0, slip_url: 'https://y', status: 'approved' as const, created_at: ago(1), approved_at: ago(1) }] };
  ok('P3 ผู้รับจ่ายปิดเองทีหลัง → แต้มเป็นของผู้รับ', closerOf(dbR, closed) === 'uB');
  const parent = tk({ id: 't-oiP', qty: 1, remaining_paid: 1390 });
  const kid = tk({ id: 'tc-k', split_from: 't-oiP', owner_id: 'uB', original_buyer_id: 'uA', deposit_paid: 300, remaining_amount: 1390, remaining_paid: 1390 });
  const dbS = base({ tickets: [parent, kid], pointLedger: [{ id: earnIdFor('t-oiP'), user_id: 'uA', delta: 40, kind: 'earn_ticket', ref_type: 'ticket', ref_id: 't-oiP', created_at: ago(3) }], settings: { ...SEED_DATABASE.settings, points_enabled: true } });
  ok('P4 ตั๋วลูกของใบที่ได้แต้มปิดยอดไปแล้ว ไม่ได้แต้มซ้ำ (เฟส 2)', !!ticketEarnBlock(dbS, kid) && earnRowForTicket(dbS, kid) === null, ticketEarnBlock(dbS, kid));
  const dbS2 = { ...dbS, pointLedger: [] };
  ok('P5 ตั๋วแม่ยังไม่ปิดตอนแตกขาย → ตั๋วลูกที่ผู้รับจ่ายปิดได้แต้มปกติ', ticketEarnBlock(dbS2, kid) === null);
  const preParent = tk({ id: 't-oiQ', remaining_amount: 0 });
  const dbC = base({ orders: [order('oQ', 'uA', [{ id: 'oiQ', order_id: 'oQ', product_id: 'P1', qty: 1, deposit_amount: 300, unit_price: 1690, unit_deposit: 300 }])], tickets: [preParent, tk({ id: 'tc-q', split_from: 't-oiQ', remaining_amount: 0, owner_id: 'uB' })] });
  ok('P6 ตั๋วลูกของใบพรี (ยอดค้าง 0) ยังเป็นใบพรี ไม่ใช่พร้อมส่ง (R1-29)', ticketIsFullPay(dbC, dbC.tickets[1]) === false);
  const dbRecv = base({ tickets: [tk({ id: 't-oiZ', owner_id: 'uB', original_buyer_id: 'uA', remaining_amount: 0 })] });
  ok('P7 เครื่องผู้รับ (มองไม่เห็นออเดอร์คนสั่ง): ใบที่รับมาเป็นใบพรีเสมอ (R2B-16)', ticketIsFullPay(dbRecv, dbRecv.tickets[0]) === false);
}

// ── เพดานต่อคน / รายงาน / ออเดอร์ต้นทาง ────────────────────────────────────────────────────
{
  const db = base({
    transfers: [tr({ id: 'in', ticket_id: 'tb-1', from_user_id: 'uA', to_user_id: 'uB', batch_id: 'B1' }), tr({ id: 'out', ticket_id: 'tb-1', from_user_id: 'uB', to_user_id: 'uC', batch_id: 'B1' })],
  });
  ok('Q1 ใบรอบพิเศษที่ได้รับมาแล้วส่งต่อ ไม่กินเพดานของคนส่งต่อ (R3-10)', userTakenInBatch(db, 'uB', 'B1') === 0 && userTakenInBatch(db, 'uA', 'B1') === 1, { b: userTakenInBatch(db, 'uB', 'B1'), a: userTakenInBatch(db, 'uA', 'B1') });
  const old = new Date(2026, 7, 15).toISOString(), now = new Date(2026, 9, 2).toISOString();
  const dbA = base({ tickets: [tk({ id: 't-r', created_at: old }), tk({ id: 'tc-r', split_from: 't-r', created_at: now })] });
  ok('Q2 รายงานรายเดือน: ตั๋วลูกนับในเดือนของตั๋วแม่ ไม่ใช่เดือนไฟนอล (R3-23)', ticketsInMonth(dbA, '2026-08').length === 2 && ticketsInMonth(dbA, '2026-10').length === 0);
  const o1 = order('o1', 'uA', [{ id: 'oi1', order_id: 'o1', product_id: 'P1', qty: 2, deposit_amount: 600 }], ago(40));
  const o2 = order('o2', 'uA', [{ id: 'oi2', order_id: 'o2', product_id: 'P1', qty: 1, deposit_amount: 300 }], ago(1));
  const dbO = base({ orders: [o1, o2], tickets: [tk({ id: 't-oi1', qty: 1 }), tk({ id: 'tc-x', split_from: 't-oi1', owner_id: 'uB', created_at: ago(1) })] });
  ok('Q3 ตั๋วลูกลิงก์ออเดอร์ของตั๋วแม่ (ไม่ใช่ออเดอร์ที่เวลาใกล้วันไฟนอล) (R3-21)', orderOfTicket(dbO, dbO.tickets[1])?.id === 'o1', orderOfTicket(dbO, dbO.tickets[1])?.id);
}

// ── เงินที่ลูกค้าจ่ายเอง (ประวัติ / Customer 360) ───────────────────────────────────────────
{
  const db = base({
    orders: [order('o1', 'uA', [{ id: 'oi1', order_id: 'o1', product_id: 'P1', qty: 1, deposit_amount: 300 }, { id: 'oi2', order_id: 'o1', product_id: 'P1', qty: 1, deposit_amount: 300 }])],
    tickets: [tk({ id: 't-oi1', owner_id: 'uB', original_buyer_id: 'uA', remaining_paid: 500 }), tk({ id: 't-oi2', remaining_paid: 100 })],
    remainingPayments: [
      { id: 'top', ticket_id: 't-oi1', user_id: 'uA', amount: 200, slip_url: 'https://a', status: 'approved', created_at: ago(9), purpose: 'topup' },
      { id: 'byB', ticket_id: 't-oi1', user_id: 'uB', amount: 300, slip_url: 'https://b', status: 'approved', created_at: ago(2) },
      { id: 'own', ticket_id: 't-oi2', user_id: 'uA', amount: 100, slip_url: 'https://c', status: 'approved', created_at: ago(2) },
    ],
    transfers: [tr({ id: 'd1', ticket_id: 't-oi1', order_item_id: 'oi1' })],
  });
  ok('W1 คนขาย: มัดจำใบที่ขาย + เงินเติมมัดจำ + ใบที่ถือเอง (R2B-04)', paidByUser(db, 'uA') === 300 + 200 + 400, paidByUser(db, 'uA'));
  ok('W2 ผู้รับ: นับเฉพาะเงินที่ตัวเองจ่าย ไม่ใช่เงินของคนขาย', paidByUser(db, 'uB') === 300, paidByUser(db, 'uB'));
  const sellerView = { ...db, tickets: db.tickets.filter((t) => t.owner_id === 'uA') }; // v77: คนขายมองไม่เห็นใบที่ขายแล้ว
  ok('W3 เครื่องคนขาย (มองไม่เห็นใบที่ขาย) ยอดยังตรง', paidByUser(sellerView, 'uA') === 900, paidByUser(sellerView, 'uA'));
  const heal = base({
    orders: [order('oL', 'uA', [{ id: 'oiL', order_id: 'oL', product_id: 'P1', qty: 1, deposit_amount: 300 }])],
    tickets: [],
    transfers: [tr({ id: 'dL', ticket_id: 'legacy-1', product_id: 'P1', from_user_id: 'uA' })],
  });
  ok('W4 ใบรุ่นเก่าที่ขายไปแล้ว (มองไม่เห็น) ไม่ถูกตีว่า "ตั๋วหาย" ให้กู้คืนผิดๆ', unmatchedApprovedItems(heal, 'uA', 0).length === 0, unmatchedApprovedItems(heal, 'uA', 0).length);
}

console.log(`\nroundD-audit (app): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
