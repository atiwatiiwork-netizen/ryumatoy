/**
 * แยก "เซิร์ฟเวอร์ปฏิเสธถาวร" (ด่าน ryuma: / RLS / constraint → ส่งซ้ำกี่รอบก็ไม่ผ่าน) ออกจากที่เหลือ (ลองใหม่ได้)
 * — audit 2026-10-03 รอบ A · R3-05 / R3-06 · แก้ตาม review รอบ A · audit 2026-10-05 รอบ 1 (#2 #3)
 *
 * ค่าเริ่มต้น = ลองใหม่ (ปลอดภัยกว่า): เน็ตหลุด/เซิร์ฟเวอร์รีสตาร์ท (PGRST000-003, 502/503/504, deadlock, …) ต้องไม่ทำให้
 * งานของผู้ใช้หาย · ถาวรเฉพาะลายเซ็นที่รู้แน่ว่าส่งซ้ำไม่มีวันผ่าน → แจ้งครั้งเดียว + โหลดของจริงมาแทน (ไม่วนค้างทุก 5 วิ)
 *
 * 3 กลุ่ม:
 *  · ถาวร (PERMANENT)      → ไม่ลองใหม่ บอกเหตุผลจริง
 *  · schema ยังไม่พร้อม     → ลองใหม่ "ช้าๆ" (30 วิ) — โค้ดขึ้น Vercel ก่อนเจ้าของรัน SQL เสมอ (auto-push) งานลูกค้าต้องรอได้ ไม่ใช่ถูกทิ้ง
 *                            (audit 1005 #2: รอบ A เผลอจัดเป็นถาวร = แก้ไขหายทันทีที่ขาดคอลัมน์)
 *  · ที่เหลือ = ชั่วคราว     → ลองใหม่ทุก 5 วิ
 */
const PERMANENT = [
  /^ryuma:/i,                                    // ด่านของเราเอง (trigger/RPC raise) — ตัวเลขในข้อความ (เช่นแต้มคงเหลือ 503) ไม่ทำให้กลายเป็นชั่วคราว
  /row-level security/i,                         // 42501 RLS (⚠ กรณี "ไม่มี session" adapter แปลงเป็นข้อความชั่วคราวให้ก่อนถึงตรงนี้)
  /permission denied/i,
  /violates (foreign key|unique|check|not-null) constraint/i, // 23xxx
  /duplicate key value/i,
  /not allowed to modify protected/i,
  /invalid input syntax/i,                       // 22P02
  // Postgres ปฏิเสธ "ค่า" ที่ส่ง — ส่งซ้ำก็เหมือนเดิม (audit 1005 #3: เดิมเป็นชั่วคราว → วนทุก 5 วิ และ reload({safe}) บล็อกปุ่มจ่าย/อนุมัติทั้งแท็บ)
  /value too long for type/i,                    // 22001
  /invalid input value for enum/i,
  /null value in column .* violates/i,           // 23502
  /numeric field overflow/i,                     // 22003
  /out of range/i,
  // ด่านของเราเองรุ่นเก่าที่ไม่มีคำนำหน้า ryuma: (v39 คูปอง · v44 หาของ — v80 เติมคำนำหน้าให้แล้ว แต่ต้องรู้จักข้อความเดิมด้วย)
  /admin-only/i,
  /invalid status change/i,
  /can only be (filed|issued)/i,
];

/** ฐานข้อมูลยังไม่ได้รัน migration ที่โค้ดรุ่นนี้ต้องใช้ (คอลัมน์/ตาราง/ฟังก์ชันยังไม่มี · PostgREST schema cache เก่า) */
const SCHEMA_DRIFT = [
  /column .* does not exist/i,
  /could not find the .* column/i,               // PGRST204
  /relation .* does not exist/i,
  /could not find the function/i,                // PGRST202
  /schema cache/i,
];

const partText = (part: string) => part.replace(/^[a-z_]+:\s*/, '').trim();
const parts = (message: string) => message.split(' | ').map(partText).filter(Boolean);

/** true = ลองใหม่ได้ · false = เซิร์ฟเวอร์ปฏิเสธถาวร (อย่าวนส่งซ้ำ) */
export function isTransientPersistError(message: string): boolean {
  const ps = parts(message);
  if (ps.length === 0) return true;
  // ถาวรเฉพาะเมื่อ "ทุกส่วน" เป็นลายเซ็นถาวร — มีส่วนไหนเป็นอย่างอื่น (เน็ต/เซิร์ฟเวอร์/schema) ลองใหม่ทั้งก้อน ไม่ทิ้งงาน
  return !ps.every((p) => PERMANENT.some((re) => re.test(p)));
}

/** true = มีส่วนที่ล้มเพราะ schema ยังไม่พร้อม → ลองใหม่ช้าๆ (รอเจ้าของรัน SQL) ไม่ยิงรัว */
export function isSchemaDriftError(message: string): boolean {
  return parts(message).some((p) => SCHEMA_DRIFT.some((re) => re.test(p)));
}

/** ข้อความที่คนอ่านรู้เรื่อง: ตัดชื่อตาราง + คำนำหน้า "ryuma:" ออก · ข้อความซ้ำกันเหลืออันเดียว · schema ยังไม่พร้อม = บอกเป็นภาษาคน */
export function friendlyPersistError(message: string): string {
  const ps = message.split(' | ').map((p) => partText(p).replace(/^ryuma:\s*/i, '').trim()).filter(Boolean)
    .map((p) => (SCHEMA_DRIFT.some((re) => re.test(p)) ? 'ร้านกำลังอัปเดตระบบ — จะบันทึกให้เองเมื่อพร้อม' : p));
  return [...new Set(ps)].join(' · ') || message;
}

/** ข้อความหลังเซฟไม่ผ่าน สำหรับหน้าจอที่เคยบอก "ระบบลองใหม่ให้เอง" — ถ้าถูกปฏิเสธถาวร ต้องบอกเหตุผลจริง + ว่าไม่ได้บันทึก
 *  (review รอบ A: เดิมทับข้อความเหตุผลด้วย "ลองใหม่ให้เอง ห้ามกดซ้ำ" ทั้งที่ไม่มีการลองใหม่แล้ว) */
export function persistFailText(message: string, retryText: string): string {
  return isTransientPersistError(message) ? retryText : `ไม่ได้บันทึก — ${friendlyPersistError(message)}`;
}
