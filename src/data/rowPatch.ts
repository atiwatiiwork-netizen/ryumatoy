/**
 * ส่วนต่างระดับคอลัมน์ของแถวเดียว (audit 2026-10-03 รอบ A · R2A-01 / R2A-03 / R3-06 / R3-13)
 *
 * ทำไม: เดิม adapter เซฟด้วย upsert "ทั้งแถว" — เครื่องที่โหลดข้อมูลไว้นาน (แท็บแอดมินอีกเครื่อง / แท็บที่ซ่อนไว้ /
 * เครื่องลูกค้าที่เซฟพลาดแล้ววนลองใหม่) กดแก้แค่ช่องเดียว แต่ส่งค่า "เก่า" ของทุกช่องขึ้นไปทับด้วย
 * เช่น กดเปลี่ยนสถานะรอบ → เจ้าของตั๋ว/เลขตั๋วที่เพิ่งไฟนอลถูกเขียนกลับเป็นของคนขาย, แอดมินเปลี่ยนยศ → บัญชีรับเงินที่ลูกค้าเพิ่งแก้ย้อนกลับ
 * ตอนนี้: แถวที่มีอยู่แล้วส่งเฉพาะช่องที่เปลี่ยนจริง (เทียบกับฐานที่โหลดมา) — ช่องที่ไม่ได้แตะคงค่าบนเซิร์ฟเวอร์เสมอ
 *
 * `tokens` = ช่องที่ต้องส่ง "ค่าจากฐาน" ไปด้วยทุกครั้ง (optimistic token) เช่น preorder_tickets.market_rev:
 * เซิร์ฟเวอร์เทียบกับค่าปัจจุบัน ถ้าไม่ตรง (หน้าจอเก่ากว่าไฟนอล) จะปฏิเสธการแก้เงิน/สถานะ
 */
export type Row = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** คืน null = ไม่มีอะไรเปลี่ยน · ช่องที่ถูกลบ (undefined/หายไป) ส่งเป็น null เพื่อเคลียร์บนเซิร์ฟเวอร์ */
export function rowPatch(base: Row, next: Row, key = 'id', tokens: string[] = []): Row | null {
  const patch: Row = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (k === key || tokens.includes(k)) continue;
    if (!same(base[k], next[k])) patch[k] = next[k] === undefined ? null : next[k];
  }
  if (Object.keys(patch).length === 0) return null;
  for (const t of tokens) if (t in base && base[t] !== undefined) patch[t] = base[t];
  return patch;
}
