/**
 * PromptPay QR (Thai QR Payment · EMVCo) — สร้าง payload ใส่ยอดให้ผู้ซื้อสแกนจ่าย "คนขาย" ในตลาดใบพรี (ข้อ 11A)
 * ใช้แทนการให้คนขายอัปรูป QR เอง: ยอดถูกใส่ในโค้ดแล้ว ผู้ซื้อโอนผิดยอดไม่ได้
 *
 * รูปแบบ: 00 (เวอร์ชัน) · 01 (11 = ใช้ซ้ำ / 12 = ครั้งเดียว มียอด) · 29 (บัญชีพร้อมเพย์: AID A000000677010111
 *   + 01 เบอร์มือถือ 0066xxxxxxxxx / 02 เลขบัตร/ภาษี 13 หลัก / 03 e-wallet 15 หลัก) · 58 TH · 53 764 (บาท)
 *   · 54 ยอด · 63 CRC16-CCITT (FALSE: init 0xFFFF, poly 0x1021) ของทั้งสตริงรวม "6304"
 */
const f = (id: string, v: string) => id + String(v.length).padStart(2, '0') + v;

export function crc16ccitt(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** ประเภทปลายทางจากตัวเลขที่คนขายกรอก — null = ไม่ใช่พร้อมเพย์ที่รองรับ */
export function promptPayTarget(raw: string): { tag: '01' | '02' | '03'; value: string } | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) return { tag: '01', value: `0066${d.slice(1)}` }; // มือถือ → 0066 + 9 หลัก (13 หลัก)
  if (d.length === 13) return { tag: '02', value: d };                                       // เลขบัตรประชาชน / เลขผู้เสียภาษี
  if (d.length === 15) return { tag: '03', value: d };                                       // e-wallet
  return null;
}

/** payload สำหรับทำ QR — amount > 0 = QR ครั้งเดียวใส่ยอด · ใช้ไม่ได้ = null (ให้โชว์เลขบัญชีแทน) */
export function promptPayPayload(target: string, amount?: number): string | null {
  const t = promptPayTarget(target);
  if (!t) return null;
  const withAmount = typeof amount === 'number' && amount > 0;
  let data = f('00', '01') + f('01', withAmount ? '12' : '11')
    + f('29', f('00', 'A000000677010111') + f(t.tag, t.value))
    + f('58', 'TH') + f('53', '764');
  if (withAmount) data += f('54', amount!.toFixed(2));
  data += '6304';
  return data + crc16ccitt(data);
}

/** โชว์เลขพร้อมเพย์แบบอ่านง่าย: 0812345678 → 081-234-5678 */
export function formatPromptPay(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 13) return `${d.slice(0, 1)}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d.slice(12)}`;
  return d;
}
