/** ตรวจตลาดใบพรี เฟส 0 (ฐานกันพัง) — รัน: npm run audit:market (ryuma-p2p-spec)
 *  ⚠ ด่านจริง/การย้ายเจ้าของอยู่ใน SQL (migration_market_v71.sql) ซึ่งรันในเครื่องไม่ได้ —
 *    สคริปต์นี้จำลอง ryuma_market_finalize เป็น TS ทีละบรรทัด (simulateFinalize) แล้วตรวจว่า
 *    "ตั๋วเปลี่ยนมือแล้ว ระบบเงิน/ตัวกู้ตั๋ว/เพดาน/รางวัล ยังถูกหมด" + ตรวจกติกาใน market.ts */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import { submitRemainingPayment, approveRemainingPayment, chooseDelivery, completeTicketOffline, editTicketDeposit, markShippedOffline, deleteTicket, fillMissingTicketsFor } from '../../src/data/mutations';
import { cashIn, grantedTicketIds, outstanding, debtors } from '../../src/domain/services/money';
import { ticketSourceOf } from '../../src/domain/services/ticketSource';
import { orderOfTicket } from '../../src/domain/services/journey';
import { unmatchedApprovedItems, hasPreorderTicket, ticketPayer } from '../../src/domain/services/tickets';
import { userTakenInBatch } from '../../src/domain/services/reservations';
import { qualifyingCount } from '../../src/domain/services/campaigns';
import { missionStateFor } from '../../src/domain/services/missions';
import { MARKET, effectiveStatus, marketLocked, hasMarketHistory, standardDepositPerUnit, depositGap, splitShare, nextTransferNo, sellerMask, sellBlockReason, marketQueue, myDeals, listingPreview, marketPublicEnabled, boughtFromMarket } from '../../src/domain/services/market';
import { crc16ccitt, promptPayPayload, promptPayTarget } from '../../src/lib/promptpay';
import { ticketSelectable } from '../../src/domain/services/payments';
import { setMarketPublic, setPayoutInfo } from '../../src/data/mutations';
import type { Database, PreorderTicket, Order, TicketTransfer, Campaign } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail ?? ''); } };

const NOW = Date.now();
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000, D = 24 * H;
const S = 'u-seller', B = 'u-buyer', C = 'u-third';

const base: Database = structuredClone(SEED_DATABASE);
base.users.push(
  { id: S, display_name: 'Seller', rank: 'bronze', member_code: 'RYU-0012', shipping_address: 'x', payout_info: { promptpay: '0800000000', account_name: 'S' } } as any,
  { id: B, display_name: 'Buyer', rank: 'bronze', member_code: 'RYU-0031', shipping_address: 'y' } as any,
  { id: C, display_name: 'Third', rank: 'bronze', member_code: 'RYU-0045', shipping_address: 'z' } as any,
);
base.transfers = []; // seed มีแถวทดลองสมัย scaffold — เริ่มจากศูนย์
const P = base.products.find((p) => !p.is_stock)!;
P.deposit_amount = 300; P.price_total = 1690; P.status = 'production';

let seq = 0;
/** ใบพรีจากออเดอร์จริง (id ผูกรายการ = t-<item>) หรือ legacy (id ไม่ผูก) */
function orderTicket(db: Database, userId: string, o: { qty?: number; dep?: number; price?: number; legacy?: boolean; batchId?: string; paid?: number; status?: PreorderTicket['product_status'] } = {}): PreorderTicket {
  seq += 1;
  const qty = o.qty ?? 1, dep = o.dep ?? 300, price = o.price ?? 1690;
  const itemId = `oi-m${seq}`, when = iso(-10 * D);
  db.orders.push({ id: `o-m${seq}`, user_id: userId, total_deposit: dep * qty, slip_url: 'https://x/s.jpg', status: 'approved', created_at: when, approved_at: when,
    items: [{ id: itemId, order_id: `o-m${seq}`, product_id: P.id, qty, deposit_amount: dep * qty, unit_price: price, unit_deposit: dep, batch_id: o.batchId }] } as Order);
  const t = { id: o.legacy ? `legacy-${seq}` : `t-${itemId}`, ticket_no: `NR-2026-08-${String(100 + seq).padStart(4, '0')}`, product_id: P.id, batch_id: o.batchId,
    owner_id: userId, original_buyer_id: userId, qty, deposit_paid: dep * qty, remaining_amount: (price - dep) * qty, remaining_paid: o.paid ?? 0,
    status: 'active', product_status: o.status ?? 'production', qr_code_url: '', created_at: when, approved_at: when } as PreorderTicket;
  db.tickets.push(t);
  return t;
}
function listing(t: PreorderTicket, over: Partial<TicketTransfer> = {}): TicketTransfer {
  seq += 1;
  return { id: `tr-${seq}`, ticket_id: t.id, from_user_id: t.owner_id, asking_price: 650, status: 'listed', listed_at: iso(-H), expires_at: iso(14 * D),
    qty: t.qty, product_id: t.product_id, batch_id: t.batch_id, order_item_id: t.id.startsWith('t-') ? t.id.slice(2) : undefined, ...over };
}

/** TS mirror ของ ryuma_market_finalize (SQL) — ย้ายเจ้าของ/แตกตั๋ว + เลข -T<n> + ปิดดีล */
function simulateFinalize(db: Database, trId: string, orderItemId?: string): Database {
  const tr = db.transfers.find((x) => x.id === trId)!;
  const t = db.tickets.find((x) => x.id === tr.ticket_id)!;
  const qty = tr.qty ?? t.qty, payer = ticketPayer(t);
  const no = nextTransferNo(db.tickets.map((x) => x.ticket_no), t.ticket_no);
  let tickets: PreorderTicket[]; let child: string | undefined;
  if (qty === t.qty) {
    tickets = db.tickets.map((x) => (x.id === t.id ? { ...x, original_buyer_id: payer, owner_id: tr.to_user_id!, ticket_no: no } : x));
  } else {
    const s = splitShare(t, qty);
    child = `tc-${trId}`;
    const c: PreorderTicket = { ...t, id: child, ticket_no: no, owner_id: tr.to_user_id!, original_buyer_id: payer, split_from: t.id, created_at: iso(), delivery: undefined,
      ...s.child, status: s.child.remaining_paid >= s.child.remaining_amount ? 'paid_full' : 'active' };
    tickets = [...db.tickets.map((x) => (x.id === t.id ? { ...x, original_buyer_id: payer, ...s.parent, status: (s.parent.remaining_paid >= s.parent.remaining_amount ? 'paid_full' : 'active') as PreorderTicket['status'] } : x)), c];
  }
  return { ...db, tickets, transfers: db.transfers.map((x) => (x.id === trId ? { ...x, status: 'done', approved_at: iso(), prev_ticket_no: t.ticket_no, new_ticket_no: no, child_ticket_id: child, order_item_id: x.order_item_id ?? orderItemId } : x)) };
}
/** มุมมองเซสชันลูกค้า (RLS): ตั๋ว/ออเดอร์ของตัวเอง + ดีลที่ตัวเองเป็นคนขาย/คนซื้อ */
const asCustomer = (db: Database, uid: string): Database => ({
  ...db,
  tickets: db.tickets.filter((t) => t.owner_id === uid),
  orders: db.orders.filter((o) => o.user_id === uid),
  transfers: db.transfers.filter((tr) => tr.from_user_id === uid || tr.to_user_id === uid),
});
const moneyKey = (db: Database) => { const m = cashIn(db); return `${m.deposits}|${m.remaining}|${m.granted}|${m.sourcing}|${m.total}`; };

// ── A) ขายยกใบ: เงินร้านไม่ขยับ · ตัวกู้ตั๋วไม่เสกคืน · ตัวจับคู่ออเดอร์ยังเจอ ─────────────
{
  let db = structuredClone(base);
  const t = orderTicket(db, S);
  const before = moneyKey(db), srcBefore = ticketSourceOf(db, t);
  db.transfers.push(listing(t, { status: 'seller_ok', to_user_id: B, paid_at: iso(-H), seller_confirmed_at: iso(-H / 2) }));
  db = simulateFinalize(db, db.transfers[0].id);
  const moved = db.tickets.find((x) => x.id === t.id)!;
  ok('A1 ย้ายเจ้าของแถวเดิม (id เดิม) · คนสั่งคงเดิม', moved.owner_id === B && moved.original_buyer_id === S && db.tickets.length === base.tickets.length + 1);
  ok('A2 เลขใหม่ = เลขเดิม-T1', moved.ticket_no === `${t.ticket_no}-T1`, moved.ticket_no);
  ok('A3 cashIn ไม่ขยับสักบาท', moneyKey(db) === before, [before, moneyKey(db)]);
  ok('A4 ไม่ถูกตีเป็นตั๋วมอบ', !grantedTicketIds(db).has(t.id));
  ok('A5 แหล่งที่มาเดิม (preorder)', ticketSourceOf(db, moved) === srcBefore && srcBefore === 'preorder', [srcBefore, ticketSourceOf(db, moved)]);
  ok('A6 orderOfTicket เจอออเดอร์ของคนสั่ง', orderOfTicket(db, moved)?.user_id === S);
  ok('A7 แอดมินเห็นทุกใบ: ไม่มีตั๋วหาย', unmatchedApprovedItems(db, undefined, 0).length === 0, unmatchedApprovedItems(db, undefined, 0));
  const sellerView = asCustomer(db, S);
  ok('A8 เซสชันคนขาย (RLS ซ่อนใบที่ขาย): ไม่มีตั๋วหาย', unmatchedApprovedItems(sellerView, S, 0).length === 0);
  const noTransfers = { ...sellerView, transfers: [] };
  ok('A9 (พิสูจน์ระเบิด) ถ้าไม่มีบันทึกโอน ตัวตรวจจะเห็นตั๋วหาย 1 ใบ', unmatchedApprovedItems(noTransfers, S, 0).length === 1);
  const healed = fillMissingTicketsFor(S)(sellerView);
  ok('A10 self-heal ฝั่งคนขายไม่มินต์อะไร', healed.tickets.length === sellerView.tickets.length);
  ok('A11 หนี้ส่วนต่างย้ายไปอยู่ที่ผู้ซื้อ', debtors(db).some((d) => d.userId === B && d.due === 1390) && !debtors(db).some((d) => d.userId === S));
  ok('A12 ยอดค้างรวมร้านเท่าเดิม', outstanding(db).total === outstanding({ ...db, tickets: db.tickets.map((x) => (x.id === t.id ? t : x)) }).total);
}

// ── B) ตั๋วรุ่นเก่า (id ไม่ผูกรายการ) ขายยกใบ ──────────────────────────────────────────
{
  let db = structuredClone(base);
  const t = orderTicket(db, S, { legacy: true });
  const itemId = db.orders[db.orders.length - 1].items[0].id;
  db.transfers.push(listing(t, { status: 'seller_ok', to_user_id: B, order_item_id: undefined }));
  db = simulateFinalize(db, db.transfers[0].id, itemId);
  ok('B1 แอดมิน: จับคู่รอบเดาด้วยคนสั่ง ไม่เห็นตั๋วหาย', unmatchedApprovedItems(db, undefined, 0).length === 0);
  ok('B2 คนขาย: order_item_id จากแอดมินกันเสกคืน', unmatchedApprovedItems(asCustomer(db, S), S, 0).length === 0);
  ok('B3 ไม่ถูกตีเป็นตั๋วมอบ', !grantedTicketIds(db).has(t.id));
}

// ── C) แตกขาย (ข้อ 3B) — เงินแบ่งเป๊ะ ยอดรวมไม่ขยับ ──────────────────────────────────
{
  let db = structuredClone(base);
  const t = orderTicket(db, S, { qty: 3, paid: 1000 });
  const before = moneyKey(db);
  db.transfers.push(listing(t, { qty: 1, status: 'seller_ok', to_user_id: B }));
  db = simulateFinalize(db, db.transfers[0].id);
  const parent = db.tickets.find((x) => x.id === t.id)!, child = db.tickets.find((x) => x.split_from === t.id)!;
  ok('C1 ลูก 1 ชิ้น: มัดจำ 300 · ส่วนต่าง 1390 · จ่ายแล้ว 333', child.qty === 1 && child.deposit_paid === 300 && child.remaining_amount === 1390 && child.remaining_paid === 333, child);
  ok('C2 แม่เหลือ 2 ชิ้น: 600 · 2780 · 667', parent.qty === 2 && parent.deposit_paid === 600 && parent.remaining_amount === 2780 && parent.remaining_paid === 667, parent);
  ok('C3 ลูกเป็นของผู้ซื้อ คนสั่งคือคนขาย · แม่ยังเป็นของคนขาย', child.owner_id === B && child.original_buyer_id === S && parent.owner_id === S);
  ok('C4 เลขลูก = เลขแม่-T1 · แม่เลขเดิม', child.ticket_no === `${t.ticket_no}-T1` && parent.ticket_no === t.ticket_no);
  ok('C5 cashIn ไม่ขยับ', moneyKey(db) === before, [before, moneyKey(db)]);
  ok('C6 ลูกไม่ใช่ตั๋วมอบ + แหล่งเดียวกับแม่', !grantedTicketIds(db).has(child.id) && ticketSourceOf(db, child) === ticketSourceOf(db, parent));
  ok('C7 ไม่มีตั๋วหาย/ตั๋วเกิน (แอดมิน + คนขาย)', unmatchedApprovedItems(db, undefined, 0).length === 0 && unmatchedApprovedItems(asCustomer(db, S), S, 0).length === 0);
  // แตกขายซ้ำ → -T2
  db.transfers.push(listing(parent, { qty: 1, status: 'seller_ok', to_user_id: C }));
  db = simulateFinalize(db, db.transfers[1].id);
  ok('C8 แตกขายครั้งที่ 2 ได้เลข -T2 (ไม่ชน -T1)', db.tickets.some((x) => x.ticket_no === `${t.ticket_no}-T2` && x.owner_id === C));
  ok('C9 ยอดรวมทุกชิ้นยังเท่าตั๋วตั้งต้น', ['deposit_paid', 'remaining_amount', 'remaining_paid', 'qty'].every((k) =>
    db.tickets.filter((x) => x.id === t.id || x.split_from === t.id).reduce((s, x) => s + (x as any)[k], 0) === (t as any)[k]));
}

// ── D) ตั๋วลูกของตั๋วมอบ: ช่อง granted รวมเท่าเดิม ────────────────────────────────────
{
  let db = structuredClone(base);
  const batch = { id: 'b-grant', product_id: P.id, label: 'ไล่เก็บ', price_total: 1690, deposit_amount: 300, stock_qty: 5, status: 'open', created_at: iso(-20 * D) } as any;
  db.batches.push(batch);
  const g: PreorderTicket = { id: 'g-1', ticket_no: 'NR-2026-07-0900', product_id: P.id, batch_id: batch.id, owner_id: S, original_buyer_id: S, qty: 2, deposit_paid: 600,
    remaining_amount: 2780, remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '', created_at: iso(-20 * D), approved_at: iso(-20 * D) } as PreorderTicket;
  db.tickets.push(g);
  const before = cashIn(db).granted;
  ok('D0 ตั๋วมอบก่อนขาย = granted', grantedTicketIds(db).has(g.id));
  db.transfers.push(listing(g, { qty: 1, status: 'seller_ok', to_user_id: B }));
  db = simulateFinalize(db, db.transfers[0].id);
  const child = db.tickets.find((x) => x.split_from === g.id)!;
  ok('D1 ลูกของตั๋วมอบ = granted ตามแม่', grantedTicketIds(db).has(child.id) && ticketSourceOf(db, child) === 'granted');
  ok('D2 cashIn.granted รวมเท่าเดิม (แบ่งกัน ไม่นับซ้ำ)', cashIn(db).granted === before, [before, cashIn(db).granted]);
}

// ── E) splitShare fuzz 5,000 เคส — อนุรักษ์ยอด + ไม่ติดลบ + จ่ายไม่เกินหนี้ ──────────────
{
  let bad = 0, sample: unknown = null, r = 12345;
  const rnd = (n: number) => { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return r % n; };
  for (let i = 0; i < 5000; i++) {
    const qty = 2 + rnd(5), take = 1 + rnd(qty - 1);
    const dep = rnd(4000), rem = rnd(9000), paid = rnd(rem + 1);
    const s = splitShare({ qty, deposit_paid: dep, remaining_amount: rem, remaining_paid: paid }, take);
    const good = s.child.deposit_paid + s.parent.deposit_paid === dep && s.child.remaining_amount + s.parent.remaining_amount === rem
      && s.child.remaining_paid + s.parent.remaining_paid === paid && s.child.qty + s.parent.qty === qty
      && [s.child, s.parent].every((x) => x.deposit_paid >= 0 && x.remaining_amount >= 0 && x.remaining_paid >= 0 && x.remaining_paid <= x.remaining_amount);
    if (!good) { bad++; sample = sample ?? { qty, take, dep, rem, paid, s }; }
  }
  ok('E1 splitShare 5,000 เคส อนุรักษ์ยอดทุกช่อง', bad === 0, sample);
  const e = splitShare({ qty: 2, deposit_paid: 301, remaining_amount: 1, remaining_paid: 1 }, 1);
  ok('E2 ปัดครึ่งขึ้นให้ลูก (301 → 151/150) · จ่ายเกินโยกให้ถูกฝั่ง', e.child.deposit_paid === 151 && e.parent.deposit_paid === 150 && e.parent.remaining_paid <= e.parent.remaining_amount, e);
}

// ── F) ล็อกตั๋วที่ลงขาย (ด่านอยู่ใน mutation) ─────────────────────────────────────────
{
  const db = structuredClone(base);
  const t = orderTicket(db, S, { status: 'arrived' });
  const paidFull = orderTicket(db, S, { status: 'arrived', paid: 1390 });
  db.transfers.push(listing(t), listing(paidFull));
  ok('F1 marketLocked = true ตอนลงขาย', marketLocked(db, t.id));
  ok('F2 จ่ายส่วนต่างซ้อนดีลไม่ได้', submitRemainingPayment(t.id, S, 0, 'https://x/a.jpg')(db).remainingPayments.length === db.remainingPayments.length);
  ok('F3 เลือกวิธีรับของไม่ได้', !chooseDelivery(paidFull.id, S, 'registered')(db).tickets.find((x) => x.id === paidFull.id)!.delivery);
  ok('F4 แอดมินปิดงานนอกระบบไม่ได้', completeTicketOffline(paidFull.id)(db).tickets.find((x) => x.id === paidFull.id)!.status !== 'shipped');
  ok('F5 markShippedOffline ไม่ได้', markShippedOffline(paidFull.id)(db).tickets.find((x) => x.id === paidFull.id)!.status !== 'shipped');
  ok('F6 แก้มัดจำไม่ได้', editTicketDeposit(t.id, 500)(db).tickets.find((x) => x.id === t.id)!.deposit_paid === 300);
  ok('F7 ลบตั๋วที่มีประวัติตลาดไม่ได้', deleteTicket(t.id)(db).tickets.some((x) => x.id === t.id) && hasMarketHistory(db, t));
  const expired = { ...db, transfers: db.transfers.map((x) => ({ ...x, expires_at: iso(-H) })) };
  ok('F8 ประกาศหมดอายุ → ปลดล็อก จ่ายส่วนต่างได้', !marketLocked(expired, t.id) && submitRemainingPayment(t.id, S, 0, 'https://x/a.jpg')(expired).remainingPayments.length === db.remainingPayments.length + 1);
  const cancelled = { ...db, transfers: db.transfers.map((x) => ({ ...x, status: 'cancelled' as const })) };
  ok('F9 ยกเลิกประกาศ → ปลดล็อก', !marketLocked(cancelled, t.id));
  const other = orderTicket(db, S);
  ok('F10 ตั๋วที่ไม่เคยผ่านตลาด ลบได้ตามปกติ', !deleteTicket(other.id)(db).tickets.some((x) => x.id === other.id));
}

// ── G) เวลาจอง: 15 นาที + ผ่อนผัน 10 นาที · ประกาศ 14 วัน ──────────────────────────────
{
  const tr = { status: 'reserved', hold_until: iso(-5 * 60_000), expires_at: iso(D) } as TicketTransfer;
  ok('G1 หมดเวลาจอง 5 นาที (ยังอยู่ในช่วงผ่อนผัน) = ยังจอง', effectiveStatus(tr) === 'reserved');
  ok('G2 เกินผ่อนผัน → กลับเป็นลงขาย', effectiveStatus({ ...tr, hold_until: iso(-11 * 60_000) }) === 'listed');
  ok('G3 เกินผ่อนผัน + ประกาศหมดอายุ → expired', effectiveStatus({ ...tr, hold_until: iso(-11 * 60_000), expires_at: iso(-1) }) === 'expired');
  ok('G4 listed เกินอายุ → expired', effectiveStatus({ status: 'listed', expires_at: iso(-1) } as TicketTransfer) === 'expired');
  ok('G5 ค่าคงที่ตรงคำตอบเจ้าของ', MARKET.holdMin === 15 && MARKET.sellerSlaH === 12 && MARKET.listingDays === 14 && MARKET.maxActive === 5 && MARKET.resellDays === 3);
}

// ── H) เติมมัดจำก่อนลงขาย (ข้อ 9) ───────────────────────────────────────────────────
{
  let db = structuredClone(base);
  const gold = orderTicket(db, S, { dep: 150 });          // Gold มัดจำครึ่ง
  const diamond = orderTicket(db, S, { dep: 0 });          // Diamond มัดจำ 0
  ok('H1 มัดจำปกติของรอบ = 300', standardDepositPerUnit(db, gold) === 300);
  ok('H2 Gold ต้องเติม 150 · Diamond ต้องเติม 300', depositGap(db, gold) === 150 && depositGap(db, diamond) === 300, [depositGap(db, gold), depositGap(db, diamond)]);
  ok('H3 ยังไม่เติม = ลงขายไม่ได้ (บอกยอด)', (sellBlockReason(db, gold, S) ?? '').includes('150'), sellBlockReason(db, gold, S));
  db = submitRemainingPayment(gold.id, S, 0, 'https://x/top.jpg', undefined, { purpose: 'topup' })(db);
  const rp = db.remainingPayments.find((r) => r.ticket_id === gold.id)!;
  ok('H4 สลิปเติมมัดจำ = 150 · purpose topup · จ่ายได้ทั้งที่ของยังผลิต', rp?.amount === 150 && rp.purpose === 'topup' && gold.product_status === 'production');
  ok('H5 ระหว่างรอตรวจ ลงขายไม่ได้ (มีสลิปรอตรวจ)', sellBlockReason(db, gold, S) === 'มีสลิปส่วนต่างรอตรวจ');
  db = approveRemainingPayment(rp.id)(db);
  const after = db.tickets.find((x) => x.id === gold.id)!;
  ok('H6 อนุมัติแล้ว: ส่วนต่างค้างลด 150 ราคารวมเท่าเดิม · ลงขายได้', after.remaining_paid === 150 && after.deposit_paid + after.remaining_amount === 1690 && depositGap(db, after) === 0 && sellBlockReason(db, after, S) === null, [after, sellBlockReason(db, after, S)]);
  const dup = submitRemainingPayment(after.id, S, 0, 'https://x/top2.jpg', undefined, { purpose: 'topup' })(db);
  ok('H7 เติมครบแล้ว กดเติมซ้ำ = ไม่มีอะไรเกิด', dup.remainingPayments.length === db.remainingPayments.length);
}

// ── I) เงื่อนไขลงขาย (ข้อ 1/2/4/5) ─────────────────────────────────────────────────
{
  const db = structuredClone(base);
  const open = orderTicket(db, S, { status: 'open' });
  ok('I1 ยังเปิดจอง = ขายไม่ได้', (sellBlockReason(db, open, S) ?? '').includes('เปิดจอง'));
  const d1 = orderTicket(db, S, { status: 'arrived', paid: 1390 });
  const withDelivery = { ...db, tickets: db.tickets.map((x) => (x.id === d1.id ? { ...x, delivery: { method: 'registered', requested_at: iso() } as any } : x)) };
  ok('I2 เลือกวิธีรับของแล้ว = ขายไม่ได้', sellBlockReason(withDelivery, withDelivery.tickets.find((x) => x.id === d1.id)!, S) === 'เลือกวิธีรับของแล้ว');
  ok('I3 ใบของคนอื่น', sellBlockReason(db, d1, B) === 'ไม่ใช่ใบของคุณ');
  const five = structuredClone(db);
  for (let i = 0; i < 5; i++) five.transfers.push(listing(orderTicket(five, S)));
  const sixth = orderTicket(five, S);
  ok('I4 ประกาศค้างครบ 5 = ใบที่ 6 ลงไม่ได้', (sellBlockReason(five, sixth, S) ?? '').includes('5'), sellBlockReason(five, sixth, S));
  const bought = orderTicket(db, S);
  const rs = { ...db, tickets: db.tickets.map((x) => (x.id === bought.id ? { ...x, owner_id: B } : x)),
    transfers: [...db.transfers, listing(bought, { status: 'done', to_user_id: B, approved_at: iso(-D) })] };
  const heldB = rs.tickets.find((x) => x.id === bought.id)!;
  ok('I5 ซื้อมา 1 วัน = ยังขายต่อไม่ได้ (ถือ 3 วัน)', (sellBlockReason(rs, heldB, B) ?? '').includes('3 วัน'), sellBlockReason(rs, heldB, B));
  const rs4 = { ...rs, transfers: rs.transfers.map((x) => (x.ticket_id === bought.id ? { ...x, approved_at: iso(-4 * D) } : x)) };
  ok('I6 ถือครบ 3 วัน = ขายต่อได้', sellBlockReason(rs4, heldB, B) === null, sellBlockReason(rs4, heldB, B));
  ok('I7 จำนวนชิ้นเกินใบ = ไม่ได้', sellBlockReason(db, d1, S, 2) === 'จำนวนชิ้นไม่ถูกต้อง');
}

// ── J) เพดานต่อรอบ (ข้อ 27B) · ยศ/Event/ภารกิจ (ข้อ 26A) · ด่านรอบพิเศษ ─────────────────
{
  let db = structuredClone(base);
  const batch = { id: 'b-hot', product_id: P.id, label: 'รอบ hot', price_total: 1690, deposit_amount: 300, stock_qty: 10, status: 'open', created_at: iso(-30 * D) } as any;
  db.batches.push(batch);
  const h1 = orderTicket(db, S, { batchId: batch.id }); orderTicket(db, S, { batchId: batch.id });
  db.transfers.push(listing(h1, { status: 'seller_ok', to_user_id: B }));
  db = simulateFinalize(db, db.transfers[0].id);
  ok('J1 ผู้ซื้อจากตลาด: ไม่กินเพดานรอบ (0)', userTakenInBatch(db, B, batch.id) === 0 && userTakenInBatch(asCustomer(db, B), B, batch.id) === 0);
  ok('J2 คนขาย: ใบที่ขายไปยังนับ (2) ทั้งมุมแอดมินและเซสชันตัวเอง', userTakenInBatch(db, S, batch.id) === 2 && userTakenInBatch(asCustomer(db, S), S, batch.id) === 2,
    [userTakenInBatch(db, S, batch.id), userTakenInBatch(asCustomer(db, S), S, batch.id)]);
  const camp = { id: 'c1', name: 'x', starts_at: iso(-60 * D).slice(0, 10), ends_at: iso(D).slice(0, 10), active: true, tiers: [], reward_scope: 'both', reward_expiry_days: 7, created_at: iso() } as unknown as Campaign;
  const p1 = orderTicket(db, S); orderTicket(db, S);
  const beforeS = qualifyingCount(db, camp, S);
  db.transfers.push(listing(p1, { status: 'seller_ok', to_user_id: B }));
  db = simulateFinalize(db, db.transfers[db.transfers.length - 1].id);
  ok('J3 Event: ใบที่ขายไม่นับให้คนขาย (−1) ไม่นับให้ผู้ซื้อ (0)', beforeS >= 2 && qualifyingCount(db, camp, S) === beforeS - 1 && qualifyingCount(db, camp, B) === 0,
    [beforeS, qualifyingCount(db, camp, S), qualifyingCount(db, camp, B)]);
  ok('J4 ภารกิจ: ตั๋วที่ซื้อจากตลาดไม่นับ', missionStateFor(asCustomer(db, B), B).hasTicket === false);
  ok('J5 ด่านรอบพิเศษ: "เคยพรี" = คนสั่ง (คนขายผ่าน · ผู้ซื้อที่ได้จากตลาดอย่างเดียวไม่ผ่าน)', hasPreorderTicket(db, S) && !hasPreorderTicket(db, B));
}

// ── K) เลขตั๋ว + ชื่อบนกระดาน ──────────────────────────────────────────────────────
{
  ok('K1 เลขแรก -T1', nextTransferNo(['NR-2026-08-0142'], 'NR-2026-08-0142') === 'NR-2026-08-0142-T1');
  ok('K2 มี -T1 แล้ว → -T2', nextTransferNo(['NR-2026-08-0142', 'NR-2026-08-0142-T1'], 'NR-2026-08-0142') === 'NR-2026-08-0142-T2');
  ok('K3 ขายต่อจากใบ -T1 → -T2 (ฐานเดียวกัน)', nextTransferNo(['NR-2026-08-0142-T1'], 'NR-2026-08-0142-T1') === 'NR-2026-08-0142-T2');
  ok('K4 ไม่สับสนกับเลขอื่นที่ขึ้นต้นเหมือนกัน', nextTransferNo(['NR-2026-08-01421-T5'], 'NR-2026-08-0142') === 'NR-2026-08-0142-T1');
  ok('K5 ปิดชื่อคนขาย RYU-0012 → R•••12', sellerMask({ id: 'u-x', member_code: 'RYU-0012' }) === 'R•••12');
}

// ── L) ข้อมูลเดิม (ไม่มีใบไหนเปลี่ยนมือ) — ผลลัพธ์ต้องเหมือนก่อนแก้เป๊ะ ───────────────────
{
  const db = structuredClone(SEED_DATABASE);
  ok('L1 seed: ไม่มีตั๋วใบไหน owner ≠ คนสั่ง', db.tickets.every((t) => ticketPayer(t) === t.owner_id));
  ok('L2 seed: ประกาศที่ยังไม่ปิดการขายไม่กระทบตัวกู้ตั๋ว', unmatchedApprovedItems(db, undefined, 0).length === unmatchedApprovedItems({ ...db, transfers: [] }, undefined, 0).length);
}

// ── M) เฟส 1: QR พร้อมเพย์ · คิวแอดมิน · ดีลของฉัน · ตัวเลขหน้าลงขาย · สวิตช์ ─────────────────
{
  ok('M1 CRC16-CCITT มาตรฐาน ("123456789" → 29B1)', crc16ccitt('123456789') === '29B1');
  const p = promptPayPayload('081-234-5678', 650)!;
  ok('M2 payload มือถือ: 0066 + 9 หลัก · QR ครั้งเดียว (12) · ยอด 650.00 · CRC ท้าย', !!p && p.startsWith('000201010212') && p.includes('0113' + '0066812345678') && p.includes('5406650.00') && p.slice(-8, -4) === '6304' && crc16ccitt(p.slice(0, -4)) === p.slice(-4), p);
  ok('M3 เลขบัตร 13 หลัก = tag 02 · ไม่ใส่ยอด = QR ใช้ซ้ำ (11)', (promptPayPayload('1234567890123') ?? '').includes('02131234567890123') && (promptPayPayload('1234567890123') ?? '').startsWith('000201010211'));
  ok('M4 เบอร์ผิดรูป = null (โชว์เลขบัญชีแทน)', promptPayPayload('12345') === null && promptPayTarget('02-123-4567') === null);

  let db = structuredClone(base);
  const a = orderTicket(db, S, { status: 'arrived' }), b = orderTicket(db, S, { status: 'arrived' }), c = orderTicket(db, S), d = orderTicket(db, S);
  db.transfers.push(
    listing(a, { status: 'seller_ok', to_user_id: B, paid_at: iso(-2 * H), seller_confirmed_at: iso(-H) }),
    listing(b, { status: 'paid', to_user_id: B, paid_at: iso(-13 * H), slip_url: 'https://x/s.jpg' }),
    listing(c, { status: 'paid', to_user_id: C, paid_at: iso(-1 * H), slip_url: 'https://x/s2.jpg' }),
    listing(d, { status: 'reviewing', to_user_id: B, review_reason: 'not_received' }),
  );
  const q = marketQueue(db);
  ok('M5 คิวแอดมิน: พร้อมโอน 1 · ตรวจสอบ 1 · เงียบเกิน 12 ชม. 1 · รอในเวลา 1 · งาน 3', q.ready.length === 1 && q.reviewing.length === 1 && q.overdue.length === 1 && q.waiting.length === 1 && q.jobs === 3, q);
  const dealsS = myDeals(db, S), dealsB = myDeals(db, B);
  ok('M6 ดีลของคนขาย: ต้องทำ = เงินเข้ารอยืนยัน 2 ใบ', dealsS.todo.length === 2 && dealsS.todo.every((x) => x.status === 'paid'), dealsS.todo.map((x) => x.status));
  ok('M7 ดีลของผู้ซื้อ: กำลังดำเนินการ 3 · ไม่มีงานต้องทำ', dealsB.todo.length === 0 && dealsB.active.length === 3, [dealsB.todo.length, dealsB.active.length]);
  const pv = listingPreview({ ...a, qty: 3, deposit_paid: 900, remaining_amount: 4170, remaining_paid: 1000 } as PreorderTicket, 1, 650);
  ok('M8 หน้าลงขาย: ขาย 1 จาก 3 → จ่ายแล้ว 633 · ค้างร้าน 1057 · ผู้ซื้อจ่ายรวม 1707 · กำไร 17', pv.paid === 633 && pv.due === 1057 && pv.buyerTotal === 1707 && pv.profit === 17, pv);
  ok('M9 ใบที่ลงขายอยู่ เลือกจ่ายรวมหลายใบไม่ได้ (ticketSelectable)', !ticketSelectable(db, { ...a, product_status: 'arrived' }) && ticketSelectable({ ...db, transfers: [] }, { ...a, product_status: 'arrived' }));
  ok('M10 สวิตช์ตลาด: ไม่มีแถว = ปิด · เปิดแล้ว = เปิด', !marketPublicEnabled(db) && marketPublicEnabled(setMarketPublic(true)(db)) && !marketPublicEnabled(setMarketPublic(false)(setMarketPublic(true)(db))));
  db = simulateFinalize(db, db.transfers[0].id);
  ok('M11 ป้าย "ได้มาจากตลาด" เฉพาะผู้ซื้อของใบนั้น', !!boughtFromMarket(db, db.tickets.find((x) => x.id === a.id)!, B) && !boughtFromMarket(db, db.tickets.find((x) => x.id === b.id)!, B));
  const pay = setPayoutInfo(S, { promptpay: '081-234-5678', account_name: '  สมชาย ใจดี ' })(base);
  ok('M12 บัญชีรับเงิน: เก็บเฉพาะตัวเลข + ตัดช่องว่าง · ไม่มีชื่อ = ไม่บันทึก', pay.users.find((u) => u.id === S)?.payout_info?.promptpay === '0812345678' && pay.users.find((u) => u.id === S)?.payout_info?.account_name === 'สมชาย ใจดี'
    && setPayoutInfo(S, { promptpay: '0812345678', account_name: ' ' })(base) === base);
}

console.log(`\nmarket-audit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
