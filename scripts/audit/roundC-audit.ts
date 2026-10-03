/** เทสต์ฝั่งแอปของรอบ C (audit เปลี่ยนใบพรี 2026-10-03 · บัญชีรับเงิน + เติมมัดจำ) — รัน: npm run audit:roundC
 *  ฝั่งฐานข้อมูลอยู่ที่ scripts/audit/sql/roundC-audit.ts (npm run audit:sql) */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import { standardDepositPerUnit, depositGap, topupIsFullPayment } from '../../src/domain/services/market';
import { pendingRpGroups } from '../../src/domain/services/payments';
import { worklist } from '../../src/domain/services/worklist';
import { setPayoutAccounts, payoutInfoOf, submitRemainingPayment } from '../../src/data/mutations';
import { payoutAccountsOf, payoutLines, primaryPayoutId } from '../../src/components/market/PayoutPicker';
import { bankDisplayName, accountNoError } from '../../src/lib/thaiBanks';
import type { Database, Order, PreorderTicket, PayoutAccount, User } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); } };
const now = new Date().toISOString();

// ── เติมมัดจำ: คิดจากรายการ "ตอนซื้อ" ───────────────────────────────────────────────────────
const product = { ...SEED_DATABASE.products[0], id: 'P1', deposit_amount: 400, price_total: 1690, is_stock: false, status: 'production' } as Database['products'][number];
const tk = (over: Partial<PreorderTicket>): PreorderTicket => ({ id: 't', ticket_no: 'NR-1', product_id: 'P1', owner_id: 'uA', original_buyer_id: 'uA', qty: 1, deposit_paid: 300, remaining_amount: 1390, remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '', created_at: now, approved_at: now, ...over } as PreorderTicket);
const order = (id: string, user: string, items: Order['items']): Order => ({ id, user_id: user, total_deposit: 0, slip_url: '', status: 'approved', created_at: now, approved_at: now, items });
const db0: Database = {
  ...structuredClone(SEED_DATABASE),
  products: [product],
  orders: [
    order('oA', 'uA', [{ id: 'oiA', order_id: 'oA', product_id: 'P1', qty: 1, deposit_amount: 300, unit_price: 1690, unit_deposit: 300, std_deposit: 300 }]),
    order('oG', 'uG', [{ id: 'oiG', order_id: 'oG', product_id: 'P1', qty: 2, deposit_amount: 300, unit_price: 1690, unit_deposit: 150, std_deposit: 400 },
                       { id: 'oiL', order_id: 'oG', product_id: 'P1', qty: 1, deposit_amount: 150, unit_price: 1690, unit_deposit: 150, std_deposit: 400 }]),
  ],
  tickets: [
    tk({ id: 't-oiA' }),
    tk({ id: 't-oiG', owner_id: 'uG', original_buyer_id: 'uG', qty: 2, deposit_paid: 300, remaining_amount: 3080 }),
    tk({ id: 'legacy-x', owner_id: 'uG', original_buyer_id: 'uG', deposit_paid: 150, remaining_amount: 1540 }),
    tk({ id: 'tg-gift', owner_id: 'uG', original_buyer_id: 'uG', deposit_paid: 0, remaining_amount: 1690 }),
    tk({ id: 'tc-kid', owner_id: 'uB', original_buyer_id: 'uG', split_from: 't-oiG', deposit_paid: 150, remaining_amount: 1540 }),
  ],
  remainingPayments: [],
  transfers: [],
};
{
  const T = (id: string) => db0.tickets.find((t) => t.id === id)!;
  ok('D1 bronze มัดจำเต็ม 300 · ร้านขึ้นมัดจำเป็น 400 ทีหลัง → ไม่ต้องเติม (R1-22)', standardDepositPerUnit(db0, T('t-oiA')) === 300 && depositGap(db0, T('t-oiA')) === 0);
  ok('D2 gold มัดจำครึ่ง 2 ชิ้น → ต้องเติม 2×(400−150) = 500', depositGap(db0, T('t-oiG')) === 500, depositGap(db0, T('t-oiG')));
  ok('D3 ตั๋วรุ่นเก่า (id ไม่ผูกรายการ) จับคู่ด้วยมัดจำต่อชิ้น → std 400', standardDepositPerUnit(db0, T('legacy-x')) === 400);
  ok('D4 ตั๋วแอดมินมอบ (ไม่มีออเดอร์) → ไม่ต้องเติม (R2B-05)', standardDepositPerUnit(db0, T('tg-gift')) === 0 && depositGap(db0, T('tg-gift')) === 0);
  ok('D5 ตั๋วลูกใช้รายการของตั๋วแม่ → std 400', standardDepositPerUnit(db0, T('tc-kid')) === 400);
  const near = { ...db0, tickets: [tk({ id: 't-oiG', owner_id: 'uG', original_buyer_id: 'uG', qty: 1, deposit_paid: 150, remaining_amount: 200, remaining_paid: 0 })] };
  const tNear = near.tickets[0];
  ok('D6 ยอดเติม ≥ ยอดค้างทั้งหมด = งวดปิดใบ (R1-44)', topupIsFullPayment(near, tNear) && !topupIsFullPayment(db0, T('t-oiG')));
  const after = submitRemainingPayment(tNear.id, 'uG', 0, 'https://x/s.jpg', undefined, { purpose: 'topup' })(near);
  ok('D7 ส่งสลิปเติมมัดจำที่เท่ากับยอดปิดใบไม่ได้ (ต้องจ่ายส่วนต่างตามปกติ)', after === near);
  const ok2 = submitRemainingPayment('t-oiG', 'uG', 0, 'https://x/s.jpg', undefined, { purpose: 'topup' })(db0);
  ok('D8 เติมมัดจำปกติยังส่งได้ ยอด = ส่วนที่ขาด', ok2.remainingPayments[0]?.amount === 500 && ok2.remainingPayments[0]?.purpose === 'topup', ok2.remainingPayments[0]);
}

// ── คิวเดียว: สลิปเติมมัดจำไม่โผล่ในคิวสลิปส่วนต่าง/badge (R1-23) ─────────────────────────────
{
  const db = { ...db0, remainingPayments: [
    { id: 'rp-top', ticket_id: 't-oiG', user_id: 'uG', amount: 500, slip_url: 'https://x/a.jpg', status: 'pending' as const, created_at: now, purpose: 'topup' as const },
    { id: 'rp-norm', ticket_id: 't-oiA', user_id: 'uA', amount: 1390, slip_url: 'https://x/b.jpg', status: 'pending' as const, created_at: now },
  ] };
  const groups = pendingRpGroups(db);
  ok('Q1 คิวสลิปส่วนต่างไม่มีสลิปเติมมัดจำ', groups.length === 1 && groups[0].rps[0].id === 'rp-norm', groups.map((g) => g.rps.map((r) => r.id)));
  const rp = worklist(db).find((w) => w.key === 'rp');
  ok('Q2 งานค้าง "สลิปส่วนต่าง" นับ 1 (ไม่นับเติมมัดจำซ้ำ)', rp?.count === 1, rp);
}

// ── บัญชีรับเงิน ────────────────────────────────────────────────────────────────────────
{
  const acc = (id: string, over: Partial<PayoutAccount> = {}): PayoutAccount => ({ id, bank: 'kbank', account_no: `12345678${id.slice(-2)}`, account_name: 'Alice', ...over });
  const u = { ...SEED_DATABASE.users[0], id: 'uA' } as User;
  const withUser = (x: User): Database => ({ ...db0, users: [x] });
  let db = setPayoutAccounts('uA', [acc('pa-01'), acc('pa-02'), acc('pa-03')], 'pa-02')(withUser(u));
  const me = () => db.users[0];
  ok('A1 เลือกบัญชีที่ 2 = บัญชีหลัก', primaryPayoutId(me()) === 'pa-02');
  db = setPayoutAccounts('uA', me().payout_accounts!.filter((a) => a.id !== 'pa-03'), undefined)(db);
  ok('A2 ลบบัญชีอื่น บัญชีหลักไม่กระโดด (R1-05)', primaryPayoutId(me()) === 'pa-02', me().payout_info);
  db = setPayoutAccounts('uA', [], undefined)(db);
  ok('A3 ลบจนหมด = ไม่มีบัญชีหลักแล้วจริง (R1-20)', !me().payout_info && payoutAccountsOf(me()).length === 0, me().payout_info);
  const legacyUser = { ...u, payout_accounts: undefined, payout_info: { account_name: 'Old', bank: 'ธนาคารออมทรัพย์ชุมชน', account_no: '9876543210' } } as User;
  const legacy = payoutAccountsOf(legacyUser);
  ok('A4 บัญชีรุ่นเก่าที่พิมพ์ชื่อธนาคารเอง ไม่ถูกทับเป็น "ธนาคารอื่น" (R1-14)', legacy[0]?.bank === 'other' && legacy[0]?.bank_name === 'ธนาคารออมทรัพย์ชุมชน');
  const db2 = setPayoutAccounts('uA', [...legacy, acc('pa-09')], 'pa-09')(withUser(legacyUser));
  const ids = db2.users[0].payout_accounts!.map((a) => a.id);
  ok('A5 เพิ่มบัญชีที่สอง บัญชีรุ่นเก่ายังอยู่ (R1-30)', ids.includes('pa-legacy') && ids.includes('pa-09'), ids);
  const db3 = setPayoutAccounts('uA', [{ id: 'pa-pp', bank: 'promptpay', promptpay: '0812345678', account_no: '1112223334', account_name: 'Alice' }], 'pa-pp')(withUser(u));
  ok('A6 พร้อมเพย์ล้วน ไม่เก็บเลขบัญชีที่พิมพ์ค้าง (R1-19)', !db3.users[0].payout_accounts![0].account_no && !db3.users[0].payout_info!.account_no, db3.users[0].payout_info);
  const info = payoutInfoOf({ id: 'x', bank: 'other', bank_name: 'ธ.ชุมชน', account_no: '1234567890', account_name: 'A' });
  ok('A7 ธนาคารอื่น: ชื่อธนาคารที่พิมพ์ไปถึงผู้โอน', info.bank === 'ธ.ชุมชน');
  ok('A8 ชื่อธนาคารจากรหัส ไม่ใช่รหัสดิบ', bankDisplayName('kbank') === 'กสิกรไทย' && bankDisplayName('other') === 'ธนาคารอื่น' && bankDisplayName('ธ.ชุมชน') === 'ธ.ชุมชน');
  const l = payoutLines({ bank: 'kbank', account_no: '1234567890', promptpay: '0812345678', account_name: 'Alice' }, true);
  ok('A9 คำอธิบายบัญชีชุดเดียว: ธนาคาร + เลขเต็ม (แอดมิน) + พร้อมเพย์ที่ผูก (R2B-08)', l.title === 'กสิกรไทย 1234567890' && /พร้อมเพย์/.test(l.sub) && l.logo === 'kbank', l);
  ok('A10 ตรวจเลขบัญชีตามธนาคาร (R1-51)', accountNoError('kbank', '123456789') !== null && accountNoError('kbank', '1234567890') === null && accountNoError('gsb', '123456789012') === null && accountNoError('gsb', '1234567890') !== null);
}

console.log(`\nroundC-audit (app): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
