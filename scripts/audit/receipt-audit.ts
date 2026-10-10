/* อ่านใบเสร็จขนส่ง (parcelReceipt.ts) — parser กับข้อความ OCR จริง + ตัวจับคู่ บนฐานปลอม
 *   npx --yes tsx scripts/audit/receipt-audit.ts */
import { SEED_DATABASE } from '../../src/data/seed';
import type { Database, PreorderTicket } from '../../src/domain/entities';
import { parseParcelReceipt, matchReceiptRows, normalizePhone, normalizeName, unmatchedText, extParcelId, externalParcelLists, externalParcelText } from '../../src/domain/services/parcelReceipt';
import { addExternalParcels, markExternalNotified, dropExternalParcel, editExternalParcel } from '../../src/data/mutations';
import { labelSlots, parcelQueue } from '../../src/domain/services/delivery';

let p = 0, f = 0;
const ok = (n: string, c: boolean) => { if (c) p++; else { f++; console.log('FAIL', n); } };

// ── ข้อความจริงจาก tesseract (eng+tha) อ่านใบเสร็จ J&T ตัวอย่าง 2026-10-10 — ตัวอักษรไทยเว้นทีละตัว · "โทร"→"Ins" · เลขใบแรกอ่านผิด 1 หลัก (829→820)
const OCR = `| &1 EXPRESS
บ ร ิ ษั ท เฟ ื ่ อ ง ฟ่า 682 โล จ ิ ส ต ิ ก ส ์ จ ํ า ก ั ด
ไ โตะ 10: 0-115564027395 ส า ขา : 301670
ว ั น ท ี ่ : 09-10-2026 oa: 17:01:25
ผู ้ ส ่ ง : ร ิ ว ม ะ , 0853475681
บ า ง น า ใต ้ เข ต บ า ง น า ก ร ุ ง เท พ ม ห า น ค ร 10260
1. Waybill Number : 820448021975 น ้ า เห น ิ ก ท ี ่ ใช ้ ค ิ ด เง ิ น : 049 KG
ผู ้ ร ั บ : ส ่ ง ย ศพ ั ฒ น ์ ส า ท ิ ส ร ิ ต น โส ก ิ ต cop: ob 378
Ins : 0915662447 CODFE: OB
2. Waybill Number : 829449553855 น ้ า เห น ิ ก ท ี ่ ใช ้ ค ิ ด เง ิ น : 142 KG
ผู ้ ร ั บ : ส ุ เม ธ ร อ ด แก ้ ว cop: ob 42
โท ร : 0943745425 CODFE: OB
3 . Waybill Number : 829449786351 น ้ า เห น ิ ก ท ี ่ ใช ้ ค ิ ด เง ิ น : 177 KG
ผู ้ ร ั บ : ค ุ ณ ศ ร ิ ณ ย ู ว า ย า โม cop: ob 43
Ins : 0835564221 CODFE: OB
จ ํ า น ว น ใบ น ํ า ส ่ ง : 3 6 ๐ ส โร ร :  000B ค ่ า ขน ส ่ ง : 122008
Total: 122.00 B`;

// 1) parser
const r = parseParcelReceipt(OCR);
ok('อ่านได้ 3 ใบ', r.rows.length === 3);
ok('เลขพัสดุตามที่ OCR อ่าน (ใบแรกอ่านผิด 1 หลัก → แอดมินแก้ในตาราง)', r.rows.map((x) => x.waybill).join() === '820448021975,829449553855,829449786351');
ok('เบอร์ผู้รับครบ 3 (รวมบรรทัด "Ins" ที่ OCR อ่านจาก โทร)', r.rows.map((x) => x.phone).join() === '0915662447,0943745425,0835564221');
ok('ชื่อผู้รับไทยถูกยุบช่องว่าง + ตัดส่วน COD', r.rows[1].name === 'สุเมธรอดแก้ว' && r.rows[2].name === 'คุณศริณยูวายาโม');
ok('เบอร์ร้านผู้ส่ง (0853475681) ไม่ถูกจับเป็นเบอร์ลูกค้า', !r.rows.some((x) => x.phone === '0853475681'));
ok('เลขภาษี/สาขา ไม่ถูกอ่านเป็นเลขพัสดุ', !r.rows.some((x) => /115564027395|301670/.test(x.waybill)));
ok('ขนส่ง: โลโก้ J&T อ่านเป็น "&1 EXPRESS" → ยังรู้ว่า jt', r.carrier === 'jt');
// ไม่มีหัวเลย → เดาจากรูปแบบเลข 12 หลัก + ติดธงเดา
const r2 = parseParcelReceipt(OCR.split('\n').slice(1).join('\n'));
ok('ไม่มีหัวใบเสร็จ → เดา jt จากเลข 12 หลัก (carrierGuessed)', r2.carrier === 'jt' && r2.carrierGuessed);
ok('บรรทัดซ้ำจาก OCR ไม่เพิ่มแถวซ้ำ', parseParcelReceipt(OCR + '\n' + OCR).rows.length === 3);
ok('Flash: TH + 13 หลัก', parseParcelReceipt('FLASH EXPRESS\nTracking no: TH0123456789012A\nผู้รับ: สมชาย\nโทร 081-234-5678').rows[0]?.waybill === 'TH0123456789012A');
ok('EMS: EX…TH', parseParcelReceipt('ไปรษณีย์ไทย EMS\nหมายเลขพัสดุ EB123456789TH\nผู้รับ: สมชาย โทร 0812345678').rows[0]?.waybill === 'EB123456789TH');
ok('normalizePhone: +66 / ขีด / เว้นวรรค', normalizePhone('+66 91-566-2447') === '0915662447' && normalizePhone('091 566 2447') === '0915662447' && normalizePhone('12345') === '');
ok('normalizeName ตัดคำนำหน้า', normalizeName('คุณ ศรัณยู วายาโม') === 'ศรัณยูวายาโม' && normalizeName('นาย สุเมธ') === 'สุเมธ');

// 2) matcher บนฐานปลอม
const base = (): Database => {
  const db = structuredClone(SEED_DATABASE) as Database;
  db.users = [
    { id: 'u1', display_name: 'Sumet R.', rank: 'bronze', total_spent: 0, preferred_lang: 'th', phone: '094-374-5425', shipping_address: 'บ้าน A' },        // ตรงเบอร์ใบ 2 (ชื่อเฟสไม่ตรง)
    { id: 'u2', display_name: 'ศรัณยู วายาโม', rank: 'bronze', total_spent: 0, preferred_lang: 'th', phone: '0800000000', shipping_address: 'บ้าน B' }, // เบอร์ไม่ตรง ชื่อคล้ายใบ 3 → suggest
    { id: 'u3', display_name: 'Nut R.', rank: 'bronze', total_spent: 0, preferred_lang: 'th', phone: '0943745425', shipping_address: 'บ้าน C' },      // เบอร์ซ้ำกับ u1 → ambiguous (เปิดทีหลัง)
  ] as Database['users'];
  db.products = [{ id: 'pA', series_name: 'Luffy', franchise_id: 'f', manufacturer_id: 'm', wcf_type: 'wcf', images: [], price_total: 1890, deposit_amount: 300, is_stock: false, status: 'arrived', created_at: '2026-10-01' }] as unknown as Database['products'];
  const tk = (id: string, owner: string, paid = 1590, extra: Partial<PreorderTicket> = {}): PreorderTicket => ({
    id, ticket_no: id.toUpperCase(), product_id: 'pA', owner_id: owner, original_buyer_id: owner, qty: 1, deposit_paid: 300, remaining_amount: 1590, remaining_paid: paid,
    status: 'paid_full', product_status: 'arrived', qr_code_url: '', created_at: '2026-10-01',
    delivery: { method: 'registered', requested_at: '2026-10-09T02:00:00Z', accepted_at: '2026-10-09T03:00:00Z' }, ...extra,
  });
  db.tickets = [tk('t1', 'u1'), tk('t1b', 'u1'), tk('t2', 'u2')]; // u1 มี 2 ใบ ที่อยู่เดียว = ช่องเดียว
  return db;
};
let db = base();
let ms = matchReceiptRows(db, r.rows, labelSlots(db, parcelQueue(db)));
ok('ใบ 2 (เบอร์ตรง u1) = ok และช่องมี 2 ใบ', ms[1].status === 'ok' && ms[1].slot?.tickets.length === 2);
ok('ใบ 3 (ชื่อคล้าย u2 เบอร์ไม่ตรง) = suggest (ไม่ติ๊กให้)', ms[2].status === 'suggest' && ms[2].slot?.to.name === 'ศรัณยู วายาโม');
ok('ใบ 1 ไม่มีใครในระบบ = unmatched', ms[0].status === 'unmatched');
ok('ข้อความก๊อปใบที่ไม่เจอ = ชื่อ (เบอร์) – เลข', unmatchedText(ms) === 'ส่งยศพัฒน์สาทิสริตนโสกิต (0915662447) – 820448021975');
// เลขพัสดุที่กรอกไปแล้ว
db = base(); db.tickets.push({ ...db.tickets[0], id: 'old', ticket_no: 'OLD', status: 'shipped', parcel_no: '829449553855', carrier: 'jt' });
ms = matchReceiptRows(db, r.rows, labelSlots(db, parcelQueue(db)));
ok('เลขที่กรอกไปแล้ว = used + บอกเลขตั๋ว', ms[1].status === 'used' && ms[1].usedBy === 'OLD');
// เบอร์เดียวกัน 2 ช่อง (u1 กับ u3) → ambiguous
db = base(); db.tickets.push({ ...db.tickets[0], id: 't3', ticket_no: 'T3', owner_id: 'u3', original_buyer_id: 'u3' });
ms = matchReceiptRows(db, r.rows, labelSlots(db, parcelQueue(db)));
ok('เบอร์ตรง 2 ช่อง = ambiguous ให้เลือกเอง', ms[1].status === 'ambiguous' && ms[1].candidates.length === 2);
// 2 แถวชี้ช่องเดียวกัน (OCR อ่านเบอร์ซ้ำ) → ทั้งคู่ ambiguous
db = base();
ms = matchReceiptRows(db, [{ waybill: 'A1', phone: '0943745425', line: 1 }, { waybill: 'A2', phone: '0943745425', line: 2 }], labelSlots(db, parcelQueue(db)));
ok('2 แถวชี้ช่องเดียว → ambiguous ทั้งคู่', ms.every((m) => m.status === 'ambiguous'));
// ตั๋วค้างเงินไม่อยู่ในคิว → ไม่ถูกจับคู่
db = base(); db.tickets = [db.tickets[0]].map((t) => ({ ...t, remaining_paid: 0 }));
ms = matchReceiptRows(db, r.rows, labelSlots(db, parcelQueue(db)));
ok('ตั๋วค้างเงินไม่อยู่ในคิว → unmatched', ms[1].status === 'unmatched');

// 3) ลูกค้านอกระบบ (v82): เก็บ/ติ๊ก/เอาออก/ประวัติ
{
  let d = base();
  d.externalParcels = [];
  const rows = [
    { id: extParcelId('jt', '829444227721'), carrier: 'jt' as const, waybill: '829444227721', name: 'ธัตณพล', phone: '0858555686' },
    { id: extParcelId('jt', '829445242640'), carrier: 'jt' as const, waybill: '829445242640', name: 'นิว', phone: '0831628638' },
  ];
  d = addExternalParcels(rows, 'adm')(d);
  ok('เก็บ 2 ใบเข้ารายการรอแจ้ง', externalParcelLists(d).pending.length === 2 && d.externalParcels[0].created_by === 'adm');
  d = addExternalParcels(rows, 'adm')(d);
  ok('ใบเสร็จเดิมซ้ำ = ไม่เพิ่มซ้ำ (id = ขนส่ง:เลข)', d.externalParcels.length === 2 && extParcelId('jt', ' 829444227721 ') === 'jt:829444227721');
  d = markExternalNotified(rows[0].id, 'adm2')(d);
  let ls = externalParcelLists(d);
  ok('ติ๊กแจ้งแล้ว → ย้ายไปประวัติ พร้อมคนกด', ls.pending.length === 1 && ls.history.length === 1 && ls.history[0].notified_by === 'adm2' && !!ls.history[0].notified_at);
  const t1 = ls.history[0].notified_at;
  d = markExternalNotified(rows[0].id, 'adm3')(d);
  ok('ติ๊กซ้ำ = เวลาเดิม คนเดิม', externalParcelLists(d).history[0].notified_at === t1 && externalParcelLists(d).history[0].notified_by === 'adm2');
  d = dropExternalParcel(rows[1].id)(d);
  ls = externalParcelLists(d);
  ok('เอาออก = หายจากรอแจ้ง ไม่เข้าประวัติ แถวยังอยู่', ls.pending.length === 0 && ls.history.length === 1 && d.externalParcels.length === 2);
  d = addExternalParcels(rows, 'adm')(d);
  ok('อ่านใบเสร็จเดิมอีกรอบหลังติ๊ก/เอาออก = ไม่ฟื้นกลับมารอแจ้ง', externalParcelLists(d).pending.length === 0);
  d = editExternalParcel(rows[0].id, { name: 'ธัตณพล เนติประมุข', phone: '0858555686' })(d);
  ok('แก้ชื่อ + ข้อความก๊อป', externalParcelText(d.externalParcels[0]) === 'ธัตณพล เนติประมุข (0858555686) – J&T 829444227721');
}

console.log(`ใบเสร็จขนส่ง: ${p} ผ่าน / ${f} ตก`);
if (f) process.exit(1);
