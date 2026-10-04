/** เทสต์ฝั่งแอปของรอบ E (audit เปลี่ยนใบพรี 2026-10-03 · หน้าจอ/ข้อความ/พฤติกรรมที่เหลือ) — รัน: npm run audit:roundE
 *  ฝั่งฐานข้อมูลอยู่ที่ scripts/audit/sql/roundE-audit.ts (npm run audit:sql) */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import { sellBlockReason, sellBlockedForGood, hasLiveDeal, incomingOffers, myDeals } from '../../src/domain/services/market';
import { closeBatch, closeProduction } from '../../src/data/mutations';
import { MARKET_ERR_TH, lookupErrText, marketErrText } from '../../src/lib/market';
import type { Database, PreorderTicket, TicketTransfer } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); } };
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const P = (over: Partial<Database['products'][number]>) => ({ ...SEED_DATABASE.products[0], deposit_amount: 300, price_total: 1690, is_stock: false, status: 'production', ...over } as Database['products'][number]);
const tk = (over: Partial<PreorderTicket>): PreorderTicket => ({ id: 't', ticket_no: 'NR-1', product_id: 'P1', owner_id: 'uA', original_buyer_id: 'uA', qty: 1, deposit_paid: 300, remaining_amount: 1390, remaining_paid: 0, status: 'active', product_status: 'production', qr_code_url: '', created_at: ago(100), approved_at: ago(100), ...over } as PreorderTicket);
const tr = (over: Partial<TicketTransfer>): TicketTransfer => ({ id: 'tr', ticket_id: 't', from_user_id: 'uA', to_user_id: 'uB', asking_price: 500, status: 'reserved', listed_at: ago(1), hold_until: ago(-20), expires_at: ago(-20), kind: 'direct', ...over } as TicketTransfer);
const base = (over: Partial<Database>): Database => ({ ...structuredClone(SEED_DATABASE), products: [P({ id: 'P1' })], orders: [], tickets: [], remainingPayments: [], transfers: [], batches: [], ...over });

// ── ปุ่ม/เหตุผลขายไม่ได้ ───────────────────────────────────────────────────────────────
{
  const db = base({ products: [P({ id: 'P1' }), P({ id: 'PS', is_stock: true, status: 'open', deposit_amount: 2500, price_total: 2500 })] });
  const stock = tk({ id: 't-s', product_id: 'PS', product_status: 'open', remaining_amount: 0, deposit_paid: 2500 });
  ok('U1 ของพร้อมส่ง: เหตุผล "ของพร้อมส่งไม่ใช่ใบพรี" ไม่ใช่ "ยังเปิดจองอยู่" (R2B-17)', sellBlockReason(db, stock, 'uA') === 'ของพร้อมส่งไม่ใช่ใบพรี', sellBlockReason(db, stock, 'uA'));
  ok('U2 ใบที่ส่งแล้ว/พร้อมส่ง/ยังเปิดรอบ → ซ่อนปุ่มเปลี่ยนใบ (R3-19)',
    sellBlockedForGood(db, stock, 'uA') && sellBlockedForGood(db, tk({ status: 'shipped' }), 'uA') && sellBlockedForGood(db, tk({ product_status: 'open' }), 'uA') && !sellBlockedForGood(db, tk({}), 'uA'));
  const dbP = { ...db, remainingPayments: [{ id: 'rp', ticket_id: 't', user_id: 'uA', amount: 100, slip_url: 'https://x', status: 'pending' as const, created_at: ago(1) }] };
  ok('U3 เหตุผลชั่วคราว (สลิปรอตรวจ) ยังโชว์ปุ่ม', !sellBlockedForGood(dbP, tk({}), 'uA') && !!sellBlockReason(dbP, tk({}), 'uA'));
  const dbH = { ...db, batches: [{ id: 'BH', product_id: 'P1', label: 'หาของ', price_total: 2000, deposit_amount: 500, stock_qty: 1, status: 'open' } as Database['batches'][number]] };
  ok('U4 ตั๋วในรอบ "หาของ" (เรื่องหาของถูกลบแล้ว) ขายไม่ได้ (R2B-19)', sellBlockReason(dbH, tk({ batch_id: 'BH' }), 'uA') === 'ตั๋วงานหาของขายในตลาดไม่ได้');
}

// ── ดีลค้าง / ข้อเสนอเข้า / ประวัติ ──────────────────────────────────────────────────────
{
  const live = tr({ id: 'live' });
  const exp = tr({ id: 'exp', hold_until: ago(30), expires_at: ago(30) });
  const db = base({ transfers: [live, exp] });
  ok('D1 มีดีลค้าง → ยังเข้าหน้าดีลได้แม้ปิดสวิตช์ (R1-12)', hasLiveDeal(db, 'uB') && hasLiveDeal(db, 'uA') && !hasLiveDeal(db, 'uC'));
  ok('D2 แบนเนอร์ข้อเสนอเข้าในกระเป๋า: เฉพาะข้อเสนอที่ยังรอตอบ (R3-07)', incomingOffers(db, 'uB').map((x) => x.id).join() === 'live');
  ok('D3 ข้อเสนอหมดเวลา ผู้รับยังเห็นในประวัติ (R1-36)', myDeals(db, 'uB').history.some((x) => x.id === 'exp'));
}

// ── ปิดรอบ: ตั๋วรอบพิเศษแบบมัดจำที่ค้าง 'open' ตามไปผลิต (R2B-18) ─────────────────────────────
{
  const batch = { id: 'B1', product_id: 'P1', label: 'รอบพิเศษ', price_total: 1690, deposit_amount: 300, stock_qty: 5, status: 'open' } as Database['batches'][number];
  const full = { ...batch, id: 'BF', deposit_amount: 1690 };
  const db = base({ products: [P({ id: 'P1', status: 'open' })], batches: [batch, full], tickets: [tk({ id: 'tb', batch_id: 'B1', product_status: 'open' }), tk({ id: 'tf', batch_id: 'BF', product_status: 'open', remaining_amount: 0, deposit_paid: 1690 }), tk({ id: 'tm', product_status: 'open' })] });
  const after = closeProduction([{ productId: 'P1', finalQty: 10 }])(db);
  const st = (id: string) => after.tickets.find((t) => t.id === id)?.product_status;
  ok('C1 ปิดกระดานหลัก → ตั๋วรอบพิเศษแบบมัดจำที่ค้าง open ไปผลิตด้วย · รอบจ่ายเต็มไม่แตะ', st('tm') === 'production' && st('tb') === 'production' && st('tf') === 'open', { tm: st('tm'), tb: st('tb'), tf: st('tf') });
  const db2 = base({ products: [P({ id: 'P1', status: 'shipping' })], batches: [batch], tickets: [tk({ id: 'tb', batch_id: 'B1', product_status: 'open' })] });
  const after2 = closeBatch('B1')(db2);
  ok('C2 ปิดรอบพิเศษตอนสินค้าเดินทางแล้ว → ตั๋วที่ค้าง open สืบสถานะ "เดินทาง"', after2.tickets[0].product_status === 'shipping' && after2.batches[0].status === 'closed', after2.tickets[0].product_status);
}

// ── ข้อความ ──────────────────────────────────────────────────────────────────────────
{
  ok('T1 โหมดดูเป็นลูกค้า มีข้อความบอกว่ากดจริงไม่ได้ (R2B-09)', !!MARKET_ERR_TH.sim);
  ok('T2 ค้นเลขกระเป๋าไม่เจอ ≠ "รายการหาย" (R1-18)', /เลขกระเป๋า/.test(lookupErrText({ error: 'not_found' })) && !/เลขกระเป๋า/.test(marketErrText({ error: 'not_found' })));
  ok('T3 ข้อความกลางใช้ได้ทั้งกระดานและเปลี่ยนใบ (R1-31/R1-34)', /ส่งข้อเสนอ/.test(MARKET_ERR_TH.already_listed) && /ถ้าเป็นคุณ/.test(MARKET_ERR_TH.no_address) && !/ซื้อจากตลาด/.test(MARKET_ERR_TH.resell_hold));
}

console.log(`\nroundE-audit (app): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
