/* เรื่องซ่อม (repair.ts + mutations) — เทสต์กฎเคลม/ด่านสถานะ บนฐานปลอม (ไม่แตะ Supabase)
 *   npx --yes tsx scripts/audit/repair-audit.ts */
import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, PreorderTicket, RepairClaim } from '../../src/domain/entities';
import { repairWindow, repairDeadline, repairLastDay, repairLive, repairConfig, repairQueue, repairAdminTodo, openRepairClaim, repairStep, repairNextActor, REPAIR_CONFIG_KEY } from '../../src/domain/services/repair';
import { fileRepairClaim, sendRepairAddress, setRepairOutTracking, setRepairBackTracking, markRepairReceived, rejectRepairClaim, setRepairConfig, setRepairNote } from '../../src/data/mutations';

let p = 0, f = 0;
const ok = (n: string, c: boolean) => { if (c) p++; else { f++; console.log('FAIL', n); } };
const DAY = 86_400_000;
const SHIP = '2026-10-01T10:00:00.000Z';
const at = (days: number) => new Date(new Date(SHIP).getTime() + days * DAY);

const base = (): Database => {
  const db = structuredClone(SEED_DATABASE) as Database;
  db.users = [
    { id: 'u1', display_name: 'สมชาย', rank: 'bronze', total_spent: 0, preferred_lang: 'th' },
    { id: 'u2', display_name: 'สมหญิง', rank: 'bronze', total_spent: 0, preferred_lang: 'th' },
    { id: 'adm', display_name: 'แอดมิน', rank: 'bronze', total_spent: 0, preferred_lang: 'th', is_admin: true },
  ] as unknown as Database['users'];
  db.products = [
    { id: 'pA', series_name: 'Luffy', franchise_id: 'f', manufacturer_id: 'm', wcf_type: 'wcf', images: [], price_total: 1890, deposit_amount: 300, is_stock: false, status: 'delivered', created_at: '2026-09-01' },
  ] as unknown as Database['products'];
  db.batches = []; db.variants = []; db.activityLogs = []; db.repairClaims = []; db.appConfig = [];
  const tk = (id: string, owner: string, extra: Partial<PreorderTicket> = {}): PreorderTicket => ({
    id, ticket_no: id.toUpperCase(), product_id: 'pA', owner_id: owner, original_buyer_id: owner, qty: 1, deposit_paid: 300,
    remaining_amount: 1590, remaining_paid: 1590, status: 'shipped', product_status: 'delivered', qr_code_url: '', created_at: '2026-09-01',
    shipped_out_at: SHIP, carrier: 'jt', parcel_no: 'JT1', ...extra,
  });
  db.tickets = [
    tk('t1', 'u1'),                                                   // ส่งพัสดุ → กำหนด = 1 ต.ค. + 15 + 3
    tk('t2', 'u1', { delivery: { method: 'pickup', requested_at: SHIP, accepted_at: SHIP, closed_at: SHIP }, carrier: undefined, parcel_no: undefined }), // รับเอง → ไม่บวกเผื่อขนส่ง
    tk('t3', 'u1', { shipped_out_at: undefined }),                   // ตั๋วเก่า ไม่มีวันส่ง
    tk('t4', 'u1', { status: 'active', product_status: 'arrived', shipped_out_at: undefined }), // ยังไม่ส่ง
    tk('t5', 'u2'),                                                   // ของคนอื่น
  ];
  return db;
};

// ── 1) กฎเคลม: กำหนด = วันส่ง + 15 + 3 (ส่งพัสดุ) / + 15 (รับเอง) ──
{
  const db = base();
  const t1 = db.tickets[0], t2 = db.tickets[1];
  ok('cfg default 15/3', repairConfig(db).days === 15 && repairConfig(db).transit_days === 3 && repairConfig(db).address === '');
  // SHIP = 1 ต.ค. 10:00Z = 17:00 ไทย → จุดตัด = เที่ยงคืนไทยหลังวันสุดท้าย = 00:00 ไทย 20 ต.ค. = SHIP + 18 วัน + 7 ชม.
  const H = 3_600_000;
  ok('cutoff parcel = +18d +7h (เที่ยงคืนไทยหลังวันที่ 18)', repairDeadline(db, t1)!.getTime() === at(18).getTime() + 7 * H);
  ok('cutoff pickup = +15d +7h', repairDeadline(db, t2)!.getTime() === at(15).getTime() + 7 * H);
  ok('day 18 ok (parcel)', repairWindow(db, t1, 'u1', at(18)).ok);
  ok('day 18 23:59 ไทย ok (parcel)', repairWindow(db, t1, 'u1', new Date(at(18).getTime() + 7 * H - 60_000)).ok);
  ok('day 19 00:00 ไทย expired (parcel)', repairWindow(db, t1, 'u1', new Date(at(18).getTime() + 7 * H)).reason === 'expired');
  ok('day 15 ok (pickup)', repairWindow(db, t2, 'u1', at(15)).ok);
  ok('day 16 expired (pickup)', repairWindow(db, t2, 'u1', at(16)).reason === 'expired');
  ok('daysLeft day 0 = 19 (รวมวันนี้)', repairWindow(db, t1, 'u1', at(0)).daysLeft === 19);
  ok('repairLastDay = cutoff − 1ms', new Date(repairLastDay(repairDeadline(db, t1)!.toISOString())).getTime() === at(18).getTime() + 7 * H - 1);
  ok('no ship date blocked', repairWindow(db, db.tickets[2], 'u1', at(1)).reason === 'no_date');
  ok('not shipped blocked', repairWindow(db, db.tickets[3], 'u1', at(1)).reason === 'not_shipped');
  ok('not owner blocked', repairWindow(db, db.tickets[4], 'u1', at(1)).reason === 'not_owner');
  // ตั้งค่าใหม่ 20 วัน เผื่อ 0 → กำหนดขยับตาม
  const db2 = setRepairConfig('adm', { days: 20, transit_days: 0, address: ' บ้านช่าง ' })(db);
  ok('config saved + trimmed', repairConfig(db2).days === 20 && repairConfig(db2).transit_days === 0 && repairConfig(db2).address === 'บ้านช่าง');
  ok('config logged', db2.activityLogs[0]?.action === 'repair_config');
  ok('deadline follows config', repairDeadline(db2, t1)!.getTime() === at(20).getTime() + 7 * H);
  // ตรา v (จาก SQL) ต้องรอดหลังเซฟ · ไม่มีตรา = ระบบยังไม่เปิด
  ok('repairLive false ไม่มีตรา', !repairLive(db2));
  const db2v: Database = { ...db, appConfig: [{ key: REPAIR_CONFIG_KEY, value: { days: 15, transit_days: 3, address: '', v: 89 } }] };
  ok('repairLive true มีตรา v=89', repairLive(db2v));
  ok('setRepairConfig keeps v', repairLive(setRepairConfig('adm', { days: 10, transit_days: 1, address: 'x' })(db2v)));
  // ค่าขยะใน app_config → กลับไปค่าตั้งต้น
  const db3: Database = { ...db, appConfig: [{ key: REPAIR_CONFIG_KEY, value: { days: -5, transit_days: 'x', address: 7 } }] };
  ok('garbage config → defaults', repairConfig(db3).days === 15 && repairConfig(db3).transit_days === 3 && repairConfig(db3).address === '');
}

// ── 2) ยื่นเรื่อง: ด่านใน mutation ──
{
  const db = base();
  const file = (d: Database, id: string, ticketId: string, userId: string, now: Date) =>
    fileRepairClaim({ id, ticketId, userId, description: '  แขนหัก ', images: ['a.jpg', '', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'] }, now)(d);
  const d1 = file(db, 'c1', 't1', 'u1', at(2));
  const c1 = d1.repairClaims[0];
  ok('filed', d1.repairClaims.length === 1 && c1.status === 'filed' && c1.user_id === 'u1' && c1.ticket_id === 't1');
  ok('description trimmed · images ≤4 no blanks', c1.description === 'แขนหัก' && c1.images.length === 4 && !c1.images.includes(''));
  ok('snapshot ship + deadline', c1.shipped_out_at === SHIP && c1.deadline_at === new Date(at(18).getTime() + 7 * 3_600_000).toISOString());
  ok('filed_at = now', c1.filed_at === at(2).toISOString());
  ok('open claim found', openRepairClaim(d1, 't1')?.id === 'c1');
  ok('window now says open_claim', repairWindow(d1, db.tickets[0], 'u1', at(3)).reason === 'open_claim');
  ok('second claim same ticket no-op', file(d1, 'c1b', 't1', 'u1', at(3)) === d1);
  ok('duplicate id no-op', file(d1, 'c1', 't2', 'u1', at(3)) === d1);
  ok('expired no-op', file(db, 'cx', 't1', 'u1', at(19)) === db);
  ok('not owner no-op', file(db, 'cx', 't5', 'u1', at(1)) === db);
  ok('not shipped no-op', file(db, 'cx', 't4', 'u1', at(1)) === db);
  ok('no ship date no-op', file(db, 'cx', 't3', 'u1', at(1)) === db);
  ok('unknown ticket no-op', file(db, 'cx', 'nope', 'u1', at(1)) === db);
  ok('customer filing does not log activity', d1.activityLogs.length === 0);
}

// ── 3) เดินสถานะเต็ม flow + ด่านทุกจังหวะ ──
{
  const db0 = setRepairConfig('adm', { days: 15, transit_days: 3, address: 'ช่าง A' })(base());
  const d1 = fileRepairClaim({ id: 'c1', ticketId: 't1', userId: 'u1', description: 'x', images: ['a'] }, at(1))(db0);
  const get = (d: Database) => d.repairClaims.find((c) => c.id === 'c1')!;

  // ยังไม่ส่งที่อยู่ → จังหวะอื่นทำไม่ได้
  ok('out tracking before address no-op', setRepairOutTracking('c1', 'jt', 'JT9')(d1) === d1);
  ok('back tracking before sent no-op', setRepairBackTracking('c1', 'adm', 'jt', 'JT9')(d1) === d1);
  ok('received before returned no-op', markRepairReceived('c1')(d1) === d1);
  ok('empty address no-op', sendRepairAddress('c1', 'adm', '   ')(d1) === d1);

  const d2 = sendRepairAddress('c1', 'adm', ' ช่าง A ', ' แพ็คดีๆ ')(d1);
  ok('address_sent', get(d2).status === 'address_sent' && get(d2).tech_address === 'ช่าง A' && get(d2).address_note === 'แพ็คดีๆ' && get(d2).address_sent_by === 'adm' && !!get(d2).address_sent_at);
  ok('address logged', d2.activityLogs[0]?.action === 'repair_address' && d2.activityLogs[0]?.target_label === 'T1');
  ok('send address twice no-op', sendRepairAddress('c1', 'adm', 'ช่าง B')(d2) === d2);
  // แก้ค่าตั้งต้นทีหลัง → snapshot ในเรื่องไม่เปลี่ยน
  const d2b = setRepairConfig('adm', { days: 15, transit_days: 3, address: 'ช่าง Z' })(d2);
  ok('address snapshot survives config change', get(d2b).tech_address === 'ช่าง A');

  ok('empty tracking no-op', setRepairOutTracking('c1', 'jt', '  ')(d2) === d2);
  const d3 = setRepairOutTracking('c1', 'flash', ' FL123 ')(d2);
  ok('sent_to_tech (customer, no log)', get(d3).status === 'sent_to_tech' && get(d3).out_carrier === 'flash' && get(d3).out_tracking === 'FL123' && !!get(d3).out_sent_at && d3.activityLogs.length === d2.activityLogs.length);
  const d3a = setRepairOutTracking('c1', 'flash', 'FL123', 'adm')(d2);
  ok('sent_to_tech by admin logs', d3a.activityLogs[0]?.action === 'repair_out');
  ok('out tracking twice no-op', setRepairOutTracking('c1', 'jt', 'X')(d3) === d3);
  ok('reject after sent no-op', rejectRepairClaim('c1', 'adm', 'late')(d3) === d3);

  const d4 = setRepairBackTracking('c1', 'adm', 'kerry', 'KR77')(d3);
  ok('returned', get(d4).status === 'returned' && get(d4).back_carrier === 'kerry' && get(d4).back_tracking === 'KR77' && get(d4).back_sent_by === 'adm');
  ok('back logged', d4.activityLogs[0]?.action === 'repair_back');
  ok('back twice no-op', setRepairBackTracking('c1', 'adm', 'jt', 'X')(d4) === d4);

  const d5 = markRepairReceived('c1')(d4);
  ok('done (customer)', get(d5).status === 'done' && !!get(d5).received_at && d5.activityLogs.length === d4.activityLogs.length);
  ok('done by admin logs', markRepairReceived('c1', 'adm')(d4).activityLogs[0]?.action === 'repair_done');
  ok('done twice no-op', markRepairReceived('c1')(d5) === d5);
  ok('closed → ticket claimable again', repairWindow(d5, d5.tickets[0], 'u1', at(5)).ok);
  ok('closed → new claim allowed', fileRepairClaim({ id: 'c2', ticketId: 't1', userId: 'u1', description: 'y', images: ['b'] }, at(5))(d5).repairClaims.length === 2);
  ok('note set/clear', setRepairNote('c1', ' ภายใน ')(d5).repairClaims[0].admin_note === 'ภายใน' && setRepairNote('c1', '  ')(d5).repairClaims[0].admin_note === undefined);

  // ปฏิเสธ: ได้จาก filed / address_sent เท่านั้น · ต้องมีเหตุผล
  ok('reject needs reason', rejectRepairClaim('c1', 'adm', ' ')(d1) === d1);
  const r1 = rejectRepairClaim('c1', 'adm', ' เกินกำหนด ')(d1);
  ok('rejected from filed', get(r1).status === 'rejected' && get(r1).reject_reason === 'เกินกำหนด' && get(r1).rejected_by === 'adm' && r1.activityLogs[0]?.action === 'repair_reject');
  ok('rejected from address_sent', get(rejectRepairClaim('c1', 'adm', 'x')(d2)).status === 'rejected');
  ok('rejected → claimable again', repairWindow(r1, r1.tickets[0], 'u1', at(5)).ok);
  ok('unknown claim no-op', sendRepairAddress('zzz', 'adm', 'x')(d1) === d1);

  // คิวแอดมิน / ใครต้องทำ
  ok('next actor', repairNextActor('filed') === 'admin' && repairNextActor('address_sent') === 'customer' && repairNextActor('sent_to_tech') === 'admin' && repairNextActor('returned') === 'customer' && repairNextActor('done') === 'none' && repairNextActor('rejected') === 'none');
  ok('steps', repairStep('filed') === 0 && repairStep('done') === 4 && repairStep('rejected') === -1);
  const mix: Database = { ...d5, repairClaims: [get(d1), get(d2), get(d3), get(d4), get(d5), get(r1)].map((c, i) => ({ ...c, id: `m${i}`, filed_at: at(i).toISOString() })) as RepairClaim[] };
  const q = repairQueue(mix);
  ok('queue todo = filed + sent_to_tech', q.todo.length === 2 && q.todo.every((c) => c.status === 'filed' || c.status === 'sent_to_tech'));
  ok('queue waiting = address_sent + returned', q.waiting.length === 2);
  ok('queue closed = done + rejected', q.closed.length === 2);
  ok('queue newest first', q.todo[0].filed_at > q.todo[1].filed_at);
  ok('admin todo badge', repairAdminTodo(mix) === 2);
}

console.log(`repair-audit: ${p} passed, ${f} failed`);
if (f > 0) process.exit(1);
