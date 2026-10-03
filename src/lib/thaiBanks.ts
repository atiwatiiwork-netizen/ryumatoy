/**
 * ธนาคารไทยสำหรับ "บัญชีรับเงิน" (เปลี่ยนใบพรี / ลงขายกระดาน · v73)
 * ตอนนี้วาดโลโก้เป็นวงกลมสีประจำธนาคาร + ตัวย่อ (ไม่ต้องโหลดไฟล์นอก) — เฟส 3 ค่อยสลับเป็น SVG จริง
 * (ชุด open source omise/banks-logo, MIT) โดยไม่ต้องแก้ที่อื่น: ทุกหน้าจอเรียก BankLogo ตัวเดียว
 */
export interface ThaiBank {
  code: string;   // รหัสที่เก็บลง payout_accounts.bank
  name: string;   // ชื่อเต็มไทย
  short: string;  // ตัวย่อบนโลโก้
  color: string;  // สีประจำธนาคาร (พื้นวงกลม)
  ink?: string;   // สีตัวอักษรบนโลโก้ (ค่าเริ่มต้นขาว)
}

export const THAI_BANKS: ThaiBank[] = [
  { code: 'promptpay', name: 'พร้อมเพย์ (เบอร์/บัตรประชาชน)', short: 'PP', color: '#1a3d8f' },
  { code: 'kbank', name: 'กสิกรไทย', short: 'KBANK', color: '#138f2d' },
  { code: 'scb', name: 'ไทยพาณิชย์', short: 'SCB', color: '#4e2e7f' },
  { code: 'bbl', name: 'กรุงเทพ', short: 'BBL', color: '#1e4598' },
  { code: 'ktb', name: 'กรุงไทย', short: 'KTB', color: '#1ba5e1' },
  { code: 'bay', name: 'กรุงศรีอยุธยา', short: 'BAY', color: '#fec43b', ink: '#3b2a00' },
  { code: 'ttb', name: 'ทหารไทยธนชาต', short: 'ttb', color: '#0050f0' },
  { code: 'gsb', name: 'ออมสิน', short: 'GSB', color: '#eb198d' },
  { code: 'baac', name: 'ธ.ก.ส.', short: 'BAAC', color: '#4b9b1d' },
  { code: 'kkp', name: 'เกียรตินาคินภัทร', short: 'KKP', color: '#199cc5' },
  { code: 'cimb', name: 'ซีไอเอ็มบี ไทย', short: 'CIMB', color: '#7e2f36' },
  { code: 'uob', name: 'ยูโอบี', short: 'UOB', color: '#0b3979' },
  { code: 'lhb', name: 'แลนด์ แอนด์ เฮ้าส์', short: 'LHB', color: '#6d6e71' },
  { code: 'tisco', name: 'ทิสโก้', short: 'TISCO', color: '#12549f' },
  { code: 'ghb', name: 'ธอส.', short: 'GHB', color: '#f57d23' },
  { code: 'icbc', name: 'ไอซีบีซี (ไทย)', short: 'ICBC', color: '#c50f1c' },
  { code: 'other', name: 'ธนาคารอื่น', short: '฿', color: '#444' },
];

export const bankOf = (code?: string | null): ThaiBank =>
  THAI_BANKS.find((b) => b.code === code) ?? THAI_BANKS.find((b) => b.code === 'other')!;

/** เลขบัญชีแบบปิดบางส่วน (โชว์ในรายการ/ดีล): 1234567890 → 123-4-••••-890 */
export const maskAccount = (no?: string | null): string => {
  const d = (no ?? '').replace(/\D/g, '');
  if (d.length < 6) return d ? '••••' : '';
  return `${d.slice(0, 3)}•••${d.slice(-3)}`;
};

/** ชื่อธนาคารที่โชว์ได้จากค่าที่เก็บใน payout_info.bank — รหัส ('kbank') → ชื่อเต็ม · ข้อความอิสระ (บัญชีรุ่นเก่า/ธนาคารอื่น) → ตามที่พิมพ์
 *  (audit รอบ C R1-14: เดิมการ์ดฝั่งผู้โอนโชว์รหัสดิบ 'kbank' / 'other') */
export const bankDisplayName = (bank?: string | null): string => {
  const v = (bank ?? '').trim();
  if (!v) return '';
  const b = THAI_BANKS.find((x) => x.code === v);
  if (!b) return v;
  return b.code === 'other' ? 'ธนาคารอื่น' : b.code === 'promptpay' ? 'พร้อมเพย์' : b.name;
};

/** ความยาวเลขบัญชีของแต่ละธนาคาร (audit รอบ C R1-51) — ธนาคารที่ไม่แน่ใจรับ 10–15 หลัก */
const ACCOUNT_LEN: Record<string, number[]> = {
  kbank: [10], scb: [10], bbl: [10], ktb: [10], bay: [10], ttb: [10],
  gsb: [12], baac: [12], ghb: [12],
};
export function accountNoError(bank: string, no: string): string | null {
  const d = no.replace(/\D/g, '');
  const lens = ACCOUNT_LEN[bank];
  if (lens) return lens.includes(d.length) ? null : `เลขบัญชี${bankOf(bank).name}ต้องมี ${lens.join(' หรือ ')} หลัก (ตอนนี้ ${d.length} หลัก)`;
  return d.length >= 10 && d.length <= 15 ? null : 'เลขบัญชีต้องมี 10–15 หลัก';
}
