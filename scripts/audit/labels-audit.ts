/* ใบปะหน้า: เรียงตามเวลารับเรื่อง + เลขคิว (labelSlots) — ฐานปลอม ไม่แตะ Supabase
 *   npx --yes tsx scripts/audit/labels-audit.ts */
import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, PreorderTicket } from '../../src/domain/entities';
import { labelSlots, slotPrintState, labelPrintSummary, labelPrintTarget, LABEL_PRINT_ACTION, type LabelSlot } from '../../src/domain/services/delivery';
import { logActivity } from '../../src/data/mutations';

let p = 0, f = 0;
const ok = (n: string, c: boolean) => { if (c) p++; else { f++; console.log('FAIL', n); } };

const db = structuredClone(SEED_DATABASE) as Database;
db.users = [
  { id: 'u1', display_name: 'A', rank: 'bronze', total_spent: 0, preferred_lang: 'th', phone: '01', shipping_address: 'บ้าน A' },
  { id: 'u2', display_name: 'B', rank: 'bronze', total_spent: 0, preferred_lang: 'th', phone: '02', shipping_address: 'บ้าน B' },
  { id: 'u3', display_name: 'C', rank: 'bronze', total_spent: 0, preferred_lang: 'th', phone: '03', shipping_address: 'บ้าน C' },
] as Database['users'];
db.products = [{ id: 'pA', series_name: 'Luffy', franchise_id: 'f', manufacturer_id: 'm', wcf_type: 'wcf', images: [], price_total: 1890, deposit_amount: 300, is_stock: false, status: 'arrived', created_at: '2026-10-01' }] as unknown as Database['products'];
const tk = (id: string, owner: string, delivery?: PreorderTicket['delivery']): PreorderTicket => ({
  id, ticket_no: id, product_id: 'pA', owner_id: owner, original_buyer_id: owner, qty: 1, deposit_paid: 300, remaining_amount: 1590, remaining_paid: 1590,
  status: 'paid_full', product_status: 'arrived', qr_code_url: '', created_at: '2026-10-01', delivery,
});
const tickets = [
  tk('t1', 'u1', { method: 'registered', requested_at: '2026-10-09T02:00:00Z', accepted_at: '2026-10-09T03:00:00Z' }),
  tk('t2', 'u2', { method: 'registered', requested_at: '2026-10-07T02:00:00Z', accepted_at: '2026-10-08T01:00:00Z' }), // รับเรื่องก่อนสุด
  tk('t3', 'u1', { method: 'registered', requested_at: '2026-10-10T02:00:00Z', accepted_at: '2026-10-10T03:00:00Z' }), // ลูกค้าเดิม ที่อยู่เดิม → รวมช่อง u1 ใช้เวลาเก่าสุด
  tk('t4', 'u3'), // ตั๋วเก่าไม่มี delivery → ท้ายสุด
];
const slots = labelSlots(db, tickets);
ok('รวมช่องตามลูกค้า = 3 ช่อง', slots.length === 3);
ok('เรียงเก่าสุดก่อน: B (8 ต.ค.) → A (9 ต.ค.) → C (ไม่มีเวลา)', slots.map((s) => s.to.name).join() === 'B,A,C');
ok('เลขคิว 1..3', slots.map((s) => s.queueNo).join() === '1,2,3');
ok('ช่อง A ใช้เวลารับเรื่องเก่าสุดของช่อง (t1) ไม่ใช่ t3', slots[1].since === '2026-10-09T03:00:00Z' && slots[1].requestedAt === '2026-10-09T02:00:00Z' && slots[1].tickets.length === 2);
ok('ตั๋วเก่า since ว่าง', slots[2].since === undefined);

// ── สถานะพิมพ์ (เจ้าของ 2026-10-11: "ติ๊กพิมพ์แล้ว มีรายการใหม่มา งงว่าอันไหนเคยพิมพ์") ──
// จำลองการกด "สร้างใบปะหน้า" = logActivity แถวละช่อง (ทางเดียวกับ LabelSheet.generate)
const printSlots = (d: Database, ss: LabelSlot[], at: string): Database => {
  let out = d;
  for (const s of ss) out = logActivity('adm', LABEL_PRINT_ACTION, labelPrintSummary(s.to), labelPrintTarget(s))(out);
  // ตั้งเวลาให้แน่นอน (logActivity ใช้ now) — แถวใหม่อยู่หัว array
  out = { ...out, activityLogs: out.activityLogs.map((l, i) => (i < ss.length ? { ...l, created_at: at } : l)) };
  return out;
};
const byName = (d: Database, ts: PreorderTicket[], n: string) => labelSlots(d, ts).find((s) => s.to.name === n)!;
let d2: Database = { ...db, activityLogs: [] };
ok('P1 ยังไม่เคยพิมพ์ = new ทุกช่อง', labelSlots(d2, tickets).every((s) => slotPrintState(d2, s).kind === 'new'));
// พิมพ์รอบแรก: เฉพาะ B และ C (A ยังไม่ติ๊ก)
d2 = printSlots(d2, labelSlots(d2, tickets).filter((s) => s.to.name !== 'A'), '2026-10-11T03:00:00Z');
ok('P2 พิมพ์แล้ว = printed · A ยัง new', slotPrintState(d2, byName(d2, tickets, 'B')).kind === 'printed' && slotPrintState(d2, byName(d2, tickets, 'C')).kind === 'printed' && slotPrintState(d2, byName(d2, tickets, 'A')).kind === 'new');
ok('P3 printed มีเวลา+คนกด · อยู่ใน 1 ใบ', (() => { const st = slotPrintState(d2, byName(d2, tickets, 'B')); return st.at === '2026-10-11T03:00:00Z' && st.labels === 1 && !!st.by; })());
// ของใหม่ของลูกค้า B เข้ามารวมช่องเดิม (ที่อยู่เดียวกัน) → ใบที่พิมพ์ไปขาดรายการนี้
const t5 = tk('t5', 'u2', { method: 'registered', requested_at: '2026-10-11T05:00:00Z', accepted_at: '2026-10-11T06:00:00Z' });
const tickets2 = [...tickets, t5];
const stB = slotPrintState(d2, byName(d2, tickets2, 'B'));
ok('P4 มีตั๋วใหม่มารวมช่องที่พิมพ์แล้ว = added + บอกเลขตั๋วใหม่', stB.kind === 'added' && stB.newTicketNos.join() === 't5' && stB.at === '2026-10-11T03:00:00Z');
// พิมพ์ช่อง B ใหม่ทั้งช่อง → printed (ใบใหม่ครอบทั้ง t2+t5)
d2 = printSlots(d2, [byName(d2, tickets2, 'B')], '2026-10-11T07:00:00Z');
const stB2 = slotPrintState(d2, byName(d2, tickets2, 'B'));
ok('P5 พิมพ์ใหม่ทั้งช่อง → printed · เวลาล่าสุด · 1 ใบ', stB2.kind === 'printed' && stB2.at === '2026-10-11T07:00:00Z' && stB2.labels === 1);
// ลูกค้า C แก้ที่อยู่หลังพิมพ์ → ใบที่พิมพ์จ่าหน้าผิด
const d3: Database = { ...d2, users: d2.users.map((u) => (u.id === 'u3' ? { ...u, shipping_address: 'บ้านใหม่ C' } : u)) };
ok('P6 ที่อยู่เปลี่ยนหลังพิมพ์ = readdressed', slotPrintState(d3, byName(d3, tickets2, 'C')).kind === 'readdressed');
const d4 = printSlots(d3, [byName(d3, tickets2, 'C')], '2026-10-11T08:00:00Z');
ok('P7 พิมพ์ซ้ำหลังแก้ที่อยู่ → printed', slotPrintState(d4, byName(d4, tickets2, 'C')).kind === 'printed');
// แถวพิมพ์ที่มี id ตั๋วที่ไม่อยู่ในช่องแล้ว (เช่น ส่งไปแล้ว) ต้องไม่ทำให้เพี้ยน
const d5: Database = { ...d4, activityLogs: [{ id: 'lx', actor_id: 'adm', actor_name: 'x', action: LABEL_PRINT_ACTION, summary: 'อื่น', target_id: 'gone1,gone2', created_at: '2026-10-11T09:00:00Z' }, ...d4.activityLogs] };
ok('P8 แถวที่มีแต่ตั๋วนอกช่อง ไม่กระทบ (A ยัง new · B ยัง printed)', slotPrintState(d5, byName(d5, tickets2, 'A')).kind === 'new' && slotPrintState(d5, byName(d5, tickets2, 'B')).kind === 'printed');
// พิมพ์แยก 2 ครั้ง (A: t1 รอบหนึ่ง t3 อีกรอบ) ที่อยู่เดียวกัน → printed แต่บอกว่าอยู่ 2 ใบ
const aOnly1 = labelSlots(d5, [tickets[0]]); // t1 อย่างเดียว
let d6 = printSlots(d5, aOnly1, '2026-10-11T10:00:00Z');
ok('P9 A: t1 พิมพ์ไปแล้ว t3 ยังไม่ = added', slotPrintState(d6, byName(d6, tickets2, 'A')).kind === 'added');
d6 = printSlots(d6, labelSlots(d6, [tickets[2]]), '2026-10-11T11:00:00Z');
const stA = slotPrintState(d6, byName(d6, tickets2, 'A'));
ok('P10 พิมพ์ครบแต่แยกกัน 2 ใบ = printed + labels 2', stA.kind === 'printed' && stA.labels === 2 && stA.at === '2026-10-11T11:00:00Z');
// ลำดับใน array สลับ (โหลดจาก DB เรียงต่างกัน) ต้องได้ผลเดิม
const d7: Database = { ...d6, activityLogs: [...d6.activityLogs].reverse() };
ok('P11 ไม่พึ่งลำดับ array', slotPrintState(d7, byName(d7, tickets2, 'C')).kind === 'printed' && slotPrintState(d7, byName(d7, tickets2, 'B')).at === '2026-10-11T07:00:00Z');
// action อื่นที่ target_id บังเอิญเป็นตั๋ว (เช่น set_parcel) ห้ามนับเป็นพิมพ์
const d8: Database = { ...db, activityLogs: [{ id: 'ly', actor_id: 'adm', actor_name: 'x', action: 'set_parcel', summary: 'x', target_id: 't4', created_at: '2026-10-11T09:00:00Z' }] };
ok('P12 action อื่นไม่นับว่าพิมพ์', slotPrintState(d8, byName(d8, tickets, 'C')).kind === 'new');
console.log(`ใบปะหน้า: ${p} ผ่าน / ${f} ตก`);
if (f) process.exit(1);
