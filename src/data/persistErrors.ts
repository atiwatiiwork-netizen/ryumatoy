/**
 * แยก "เซิร์ฟเวอร์ปฏิเสธถาวร" (ด่าน ryuma: / RLS / constraint → ส่งซ้ำกี่รอบก็ไม่ผ่าน) ออกจากที่เหลือ (ลองใหม่ได้)
 * — audit 2026-10-03 รอบ A · R3-05 / R3-06 · แก้ตาม review รอบ A
 *
 * ค่าเริ่มต้น = ลองใหม่ (ปลอดภัยกว่า): เน็ตหลุด/เซิร์ฟเวอร์รีสตาร์ท (PGRST000-003, 502/503/504, deadlock, …) ต้องไม่ทำให้
 * งานของผู้ใช้หาย · ถาวรเฉพาะลายเซ็นที่รู้แน่ว่าส่งซ้ำไม่มีวันผ่าน → แจ้งครั้งเดียว + โหลดของจริงมาแทน (ไม่วนค้างทุก 5 วิ)
 */
const PERMANENT = [
  /^ryuma:/i,                                    // ด่านของเราเอง (trigger/RPC raise) — ตัวเลขในข้อความ (เช่นแต้มคงเหลือ 503) ไม่ทำให้กลายเป็นชั่วคราว
  /row-level security/i,                         // 42501 RLS
  /permission denied/i,
  /violates (foreign key|unique|check|not-null) constraint/i, // 23xxx
  /duplicate key value/i,
  /not allowed to modify protected/i,
  /column .* does not exist/i,                   // schema ยังไม่รัน migration
  /could not find the .* column/i,               // PGRST204
  /invalid input syntax/i,                       // 22P02
];

const partText = (part: string) => part.replace(/^[a-z_]+:\s*/, '').trim();

/** true = ลองใหม่ได้ · false = เซิร์ฟเวอร์ปฏิเสธถาวร (อย่าวนส่งซ้ำ) */
export function isTransientPersistError(message: string): boolean {
  const parts = message.split(' | ').map(partText).filter(Boolean);
  if (parts.length === 0) return true;
  // ถาวรเฉพาะเมื่อ "ทุกส่วน" เป็นลายเซ็นถาวร — มีส่วนไหนเป็นอย่างอื่น (เน็ต/เซิร์ฟเวอร์) ลองใหม่ทั้งก้อน ไม่ทิ้งงาน
  return !parts.every((p) => PERMANENT.some((re) => re.test(p)));
}

/** ข้อความที่คนอ่านรู้เรื่อง: ตัดชื่อตาราง + คำนำหน้า "ryuma:" ออก · ข้อความซ้ำกันเหลืออันเดียว */
export function friendlyPersistError(message: string): string {
  const parts = message.split(' | ').map((p) => partText(p).replace(/^ryuma:\s*/i, '').trim()).filter(Boolean);
  return [...new Set(parts)].join(' · ') || message;
}

/** ข้อความหลังเซฟไม่ผ่าน สำหรับหน้าจอที่เคยบอก "ระบบลองใหม่ให้เอง" — ถ้าถูกปฏิเสธถาวร ต้องบอกเหตุผลจริง + ว่าไม่ได้บันทึก
 *  (review รอบ A: เดิมทับข้อความเหตุผลด้วย "ลองใหม่ให้เอง ห้ามกดซ้ำ" ทั้งที่ไม่มีการลองใหม่แล้ว) */
export function persistFailText(message: string, retryText: string): string {
  return isTransientPersistError(message) ? retryText : `ไม่ได้บันทึก — ${friendlyPersistError(message)}`;
}
