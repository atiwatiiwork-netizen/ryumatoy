/** เทสต์ฝั่งแอปของรอบ B (audit เปลี่ยนใบพรี 2026-10-03) — รัน: npm run audit:roundB
 *  ฝั่งฐานข้อมูลอยู่ที่ scripts/audit/sql/roundB-audit.ts (npm run audit:sql) */
process.env.TZ = 'Asia/Bangkok';
import { SEED_DATABASE } from '../../src/data/seed';
import { dealStatusLabel, myDeals, marketQueue, effectiveStatus } from '../../src/domain/services/market';
import { MARKET_ERR_TH, marketErrText } from '../../src/lib/market';
import type { Database, TicketTransfer } from '../../src/domain/entities';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); } };

const when = new Date(Date.now() - 2 * 3_600_000).toISOString();
const base = (over: Partial<TicketTransfer>): TicketTransfer => ({ id: 'tr', ticket_id: 't1', from_user_id: 'uA', to_user_id: 'uB', asking_price: 500, status: 'cancelled', listed_at: when, kind: 'direct', ...over } as TicketTransfer);

{
  const late = base({ id: 'tr-late', cancel_reason: 'seller', paid_at: when, slip_url: 'https://x/s.jpg', review_reason: 'late_slip' });
  const lateExp = base({ id: 'tr-exp', status: 'reserved', hold_until: new Date(Date.now() - 3_600_000).toISOString(), expires_at: new Date(Date.now() - 3_600_000).toISOString(), paid_at: when, review_reason: 'late_slip' });
  const done = base({ id: 'tr-done', cancel_reason: 'seller', paid_at: when, review_reason: 'late_slip_done' });
  const plainExp = base({ id: 'tr-plain', status: 'reserved', hold_until: new Date(Date.now() - 3_600_000).toISOString(), expires_at: new Date(Date.now() - 3_600_000).toISOString() });
  ok('L1 ป้าย: โอนแล้วแต่ดีลปิด = "โอนแล้ว · รอร้านเคลียร์คืนเงิน" · เคลียร์แล้ว = "เคลียร์คืนเงินแล้ว" · ถอนเฉยๆ = "ถอนข้อเสนอแล้ว"',
    dealStatusLabel(late) === 'โอนแล้ว · รอร้านเคลียร์คืนเงิน' && dealStatusLabel(lateExp) === 'โอนแล้ว · รอร้านเคลียร์คืนเงิน'
    && dealStatusLabel(done) === 'เคลียร์คืนเงินแล้ว' && dealStatusLabel(base({ cancel_reason: 'seller' })) === 'ถอนข้อเสนอแล้ว', [dealStatusLabel(late), dealStatusLabel(lateExp), dealStatusLabel(done)]);
  const db: Database = { ...structuredClone(SEED_DATABASE), transfers: [late, lateExp, done, plainExp] };
  const hist = myDeals(db, 'uB').history.map((x) => x.id).sort();
  ok('L2 ประวัติของผู้รับ: ดีลที่โอนเงินไปแล้วต้องเห็นเสมอ (รวมที่หมดเวลา) · ข้อเสนอหมดเวลาที่ไม่ได้โอน ซ่อนได้',
    JSON.stringify(hist) === JSON.stringify(['tr-done', 'tr-exp', 'tr-late']) && effectiveStatus(plainExp) === 'expired', hist);
  const q = marketQueue(db);
  ok('L3 คิวแอดมิน: "ผู้รับโอนแล้วแต่ดีลปิด" = งาน (ที่เคลียร์แล้วไม่นับ)', q.lateSlips.length === 2 && q.jobs === 2, { late: q.lateSlips.map((x) => x.id), jobs: q.jobs });
}
{
  const codes = ['code_changed', 'recipient_paying', 'withdrawn', 'use_decline', 'free_deal', 'too_many', 'not_owner', 'bad_code', 'hold_expired', 'gone'];
  const missing = codes.filter((c) => !MARKET_ERR_TH[c]);
  ok('E1 ทุกรหัสที่ v75 คืนมามีข้อความไทย', missing.length === 0, missing);
  ok('E2 hold_expired ไม่พูดถึง "จอง" (ใช้กับข้อเสนอเปลี่ยนใบด้วย)', !/จอง/.test(marketErrText({ error: 'hold_expired' })));
}

console.log(`\nroundB-audit (app): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
