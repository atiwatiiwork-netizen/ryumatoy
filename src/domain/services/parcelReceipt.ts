import type { Carrier, Database } from '../entities';
import { labelSlots, parcelQueue, SENDER_PHONE, type LabelSlot } from './delivery';

/**
 * 📷 อ่านใบเสร็จขนส่ง (J&T/Flash/Kerry/EMS) → เลขพัสดุ + ผู้รับ + เบอร์ → จับคู่กับคิว "รอใส่เลขพัสดุ"
 * (เจ้าของ 2026-10-10: ถ่ายใบเสร็จแล้วให้ระบบกรอก tracking เอง · ใบที่ไม่เจอในระบบ = โชว์ชื่อ–เลขให้ก๊อป)
 *
 * ของจริงจาก OCR (tesseract eng+tha กับใบเสร็จ J&T):
 * - ตัวอักษรไทยถูกเว้นวรรคทีละตัว "ผู ้ ร ั บ : ส ่ ง ย ศ" → ต้องยุบช่องว่างระหว่างอักษรไทยก่อน
 * - "โทร" อ่านเป็น "Ins" ได้ · เลขพัสดุอ่านผิดได้ 1 หลัก (829→820) → ตารางตรวจต้องแก้เลขได้ก่อนยืนยันเสมอ
 * - โลโก้ J&T อ่านเป็น "&1 EXPRESS" → เดาขนส่งจากรูปแบบเลขพัสดุด้วย แต่ให้แอดมินยืนยัน
 * ตัวเลข (เลขพัสดุ/เบอร์) คือตัวจับคู่ ชื่อไทยไว้โชว์/ก๊อป และเป็นแค่ "คำแนะนำ" (ไม่ติ๊กให้)
 */
export interface ReceiptRow { waybill: string; name?: string; phone?: string; line: number }
export interface ParsedReceipt { carrier?: Carrier; carrierGuessed: boolean; rows: ReceiptRow[] }

const THAI = '\\u0E00-\\u0E7F';
/** ยุบช่องว่างระหว่างอักษรไทย (OCR tha เว้นทีละตัว) + ช่องว่างซ้ำ */
export const squashThai = (s: string) => s.replace(new RegExp(`(?<=[${THAI}])\\s+(?=[${THAI}])`, 'g'), '').replace(/[ \t]+/g, ' ').trim();
/** แก้ตัวอักษรที่ OCR สับสนกับตัวเลข ภายในก้อนที่ "ควรเป็นตัวเลข" */
const fixDigits = (s: string) => s.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8');
/** เบอร์โทร → ตัวเลขล้วน ขึ้นต้น 0 (รับ +66 / 66 / มีขีด/เว้นวรรค) · ไม่ใช่เบอร์ = '' */
export function normalizePhone(raw: string): string {
  let d = fixDigits(raw).replace(/\D/g, '');
  if (d.startsWith('66') && d.length >= 11) d = '0' + d.slice(2);
  return /^0\d{8,9}$/.test(d) ? d : '';
}
/** ชื่อคล้ายกัน: ซ้อนกันทั้งก้อน หรือมีช่วงอักษรร่วมยาวพอ (OCR อ่านชื่อไทยผิด 1-2 ตัวได้ เช่น ศรัณยู→ศริณยู แต่ "วายาโม" ยังตรง) */
export function nameSimilar(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const need = Math.max(4, Math.ceil(Math.min(a.length, b.length) * 0.5));
  let best = 0;
  const prev: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) { const tmp = prev[j]; prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0; if (prev[j] > best) best = prev[j]; diag = tmp; }
  }
  return best >= need;
}
/** ชื่อไว้เทียบ: ตัดคำนำหน้า/ช่องว่าง/เครื่องหมาย */
export const normalizeName = (s: string) => squashThai(s).replace(/^(คุณ|นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|k\.|khun)\s*/i, '').replace(/[\s.\-_,]/g, '').toLowerCase();

const CARRIER_PAT: { key: Carrier; head: RegExp; waybill: RegExp }[] = [
  { key: 'jt', head: /J\s*&\s*T|J&1|&1\s*EXPRESS|JT\s*EXPRESS|เจแอนด์ที/i, waybill: /\b\d{12}\b/ },
  { key: 'flash', head: /FLASH/i, waybill: /\bTH\d{13}[A-Z0-9]?\b/i },
  { key: 'kerry', head: /KERRY|เคอรี่/i, waybill: /\b[A-Z]{2,4}\d{8,12}\b/ },
  { key: 'ems', head: /\bEMS\b|ไปรษณีย์|THAILAND POST/i, waybill: /\b[A-Z]{2}\d{9}TH\b/i },
];

export function parseParcelReceipt(text: string): ParsedReceipt {
  const lines = text.split(/\r?\n/).map(squashThai);
  const joined = lines.join('\n');
  let carrier: Carrier | undefined = CARRIER_PAT.find((c) => c.head.test(joined))?.key;
  let carrierGuessed = false;

  const rows: ReceiptRow[] = [];
  const seen = new Set<string>();
  const sender = normalizePhone(SENDER_PHONE);
  const pushRow = (waybill: string, i: number) => {
    if (!waybill || seen.has(waybill)) return; // บรรทัดซ้ำจาก OCR
    seen.add(waybill);
    const row: ReceiptRow = { waybill, line: i };
    // มองไปข้างหน้าไม่เกิน 4 บรรทัด (ก่อนถึงเลขพัสดุถัดไป) หาผู้รับ + เบอร์
    for (let j = i; j <= Math.min(lines.length - 1, i + 4); j++) {
      const l = lines[j];
      if (j > i && /waybill/i.test(l)) break;
      const nm = /ผู้รับ\s*[:：]?\s*(.+)$/.exec(l) ?? /(?:^|\s)(?:Receiver|To)\s*[:：]\s*(.+)$/i.exec(l);
      if (nm && !row.name) row.name = nm[1].replace(/\s*(COD|cop|ob|น้ำหนัก).*$/i, '').trim();
      // เบอร์: บรรทัดที่มี โทร/Tel/Ins(OCR ของ โทร) หรือเลข 9-10 หลักขึ้นต้น 0 ที่ไม่ใช่เบอร์ร้าน/เลขพัสดุ
      if (!row.phone) {
        const cands = (l.match(/\+?[\d][\d\- ]{7,13}\d/g) ?? []).map(normalizePhone).filter((p) => p && p !== sender && p !== waybill);
        const tagged = /โทร|tel|ins|phone|มือถือ/i.test(l);
        if (cands.length && (tagged || j > i)) row.phone = cands[0];
      }
    }
    rows.push(row);
  };

  // 1) บรรทัดที่มีคำว่า Waybill/Tracking/เลขพัสดุ → เลขที่ตามมา (แก้ O/l/S/B ที่ OCR สับสน)
  lines.forEach((l, i) => {
    if (!/waybill|tracking|เลขพัสดุ|หมายเลขพัสดุ/i.test(l)) return;
    const after = l.split(/waybill\s*(?:number|no\.?)?|tracking\s*(?:number|no\.?)?|เลขพัสดุ|หมายเลขพัสดุ/i)[1] ?? '';
    const m = /[A-Za-z0-9|]{10,16}/.exec(after.replace(/[:：]/g, ' '));
    if (!m) return;
    const tok = m[0];
    const wb = /^[A-Z]{2}/i.test(tok) ? tok.toUpperCase().replace(/\|/g, '1') : fixDigits(tok);
    pushRow(wb, i);
  });
  // 2) ไม่เจอป้าย Waybill เลย (ใบเสร็จรูปแบบอื่น) → ไล่หาเลขตามรูปแบบของขนส่งที่รู้
  if (rows.length === 0) {
    const pats = carrier ? CARRIER_PAT.filter((c) => c.key === carrier) : CARRIER_PAT;
    lines.forEach((l, i) => {
      if (/tax|ภาษี|สาขา/i.test(l)) return;
      for (const c of pats) { const m = c.waybill.exec(fixDigits(l)); if (m) { pushRow(m[0].toUpperCase(), i); if (!carrier) { carrier = c.key; carrierGuessed = true; } break; } }
    });
  }
  // 3) หัวใบเสร็จอ่านไม่ออก แต่เลขพัสดุทุกใบเป็น 12 หลัก = รูปแบบ J&T → เดา (ให้แอดมินยืนยัน)
  if (!carrier && rows.length && rows.every((r) => /^\d{12}$/.test(r.waybill))) { carrier = 'jt'; carrierGuessed = true; }
  return { carrier, carrierGuessed, rows };
}

export type MatchStatus = 'ok' | 'suggest' | 'ambiguous' | 'used' | 'unmatched';
export interface ReceiptMatch {
  row: ReceiptRow;
  status: MatchStatus;
  slot?: LabelSlot;         // ช่องที่จับคู่ได้ (ok) หรือแนะนำ (suggest)
  candidates: LabelSlot[];  // ช่องที่เป็นไปได้ทั้งหมด (ambiguous → ให้เลือกเอง)
  usedBy?: string;          // เลขพัสดุนี้ถูกกรอกไปแล้วที่ตั๋วไหน
}

/** จับคู่แถวใบเสร็จกับช่องในคิว: เบอร์ตรง = ok (ติ๊กให้) · ชื่อคล้าย = suggest (ไม่ติ๊ก) · หลายช่อง = ambiguous · เลขซ้ำในระบบ = used */
export function matchReceiptRows(db: Database, rows: ReceiptRow[], slots: LabelSlot[] = labelSlots(db, parcelQueue(db))): ReceiptMatch[] {
  const sender = normalizePhone(SENDER_PHONE);
  const taken = new Map<string, LabelSlot[]>(); // ช่องที่ถูกแถวอื่นจับไปแล้ว → แถวที่ 2 ชนช่องเดิม = ambiguous
  const out: ReceiptMatch[] = rows.map((row) => {
    const used = db.tickets.find((t) => t.parcel_no && t.parcel_no.toUpperCase() === row.waybill.toUpperCase());
    if (used) return { row, status: 'used', candidates: [], usedBy: used.ticket_no };
    const phone = row.phone && row.phone !== sender ? row.phone : '';
    const byPhone = phone ? slots.filter((s) => normalizePhone(s.to.phone) === phone) : [];
    if (byPhone.length === 1) return { row, status: 'ok', slot: byPhone[0], candidates: byPhone };
    if (byPhone.length > 1) return { row, status: 'ambiguous', candidates: byPhone };
    const nm = row.name ? normalizeName(row.name) : '';
    const byName = nm.length >= 3 ? slots.filter((s) => nameSimilar(nm, normalizeName(s.to.name))) : [];
    if (byName.length === 1) return { row, status: 'suggest', slot: byName[0], candidates: byName };
    if (byName.length > 1) return { row, status: 'ambiguous', candidates: byName };
    return { row, status: 'unmatched', candidates: [] };
  });
  // สองแถวชี้ช่องเดียวกัน (ลูกค้าคนเดียวได้ 2 พัสดุ หรือ OCR อ่านเบอร์ผิด) → ห้ามกรอกให้เองทั้งคู่
  for (const m of out) if (m.slot) taken.set(m.slot.key, [...(taken.get(m.slot.key) ?? []), m.slot]);
  for (const m of out) if (m.slot && (taken.get(m.slot.key)?.length ?? 0) > 1) { m.status = 'ambiguous'; m.candidates = [m.slot]; m.slot = undefined; }
  return out;
}

/** ข้อความ "ชื่อ – เลข" สำหรับก๊อปไปแจ้งลูกค้านอกระบบ */
export const unmatchedText = (ms: ReceiptMatch[]) =>
  ms.filter((m) => m.status === 'unmatched').map((m) => `${m.row.name ?? 'ไม่ทราบชื่อ'}${m.row.phone ? ` (${m.row.phone})` : ''} – ${m.row.waybill}`).join('\n');
