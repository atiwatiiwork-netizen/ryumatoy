/* ใบปะหน้า: เรียงตามเวลารับเรื่อง + เลขคิว (labelSlots) — ฐานปลอม ไม่แตะ Supabase
 *   npx --yes tsx scripts/audit/labels-audit.ts */
import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, PreorderTicket } from '../../src/domain/entities';
import { labelSlots } from '../../src/domain/services/delivery';

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
console.log(`ใบปะหน้า: ${p} ผ่าน / ${f} ตก`);
if (f) process.exit(1);
