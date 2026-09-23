import type { Database } from '../entities';
import { userById } from './indexes';

/**
 * "คนนี้เป็นแอดมินไหม" — ตัวเดียวที่ mutation ใช้ตัดสินสิทธิ์แอดมิน (v57).
 *
 * ต้องให้ผลตรงกับ AuthProvider เป๊ะๆ ไม่งั้นจะเกิดเคสร้ายที่สุด: แผงแอดมินเปิดให้ใช้
 * (AuthProvider บอกว่าเป็นแอดมิน) แต่ mutation ปัดตกเงียบๆ (guard บอกว่าไม่ใช่)
 * → กดปุ่มแล้วไม่มีอะไรเกิดขึ้น หาสาเหตุไม่เจอ. เงื่อนไขจึงต้องเป็น OR เหมือนกัน:
 *   1) ไม่มี backend (โหมด preview/seed) = เปิดให้ทุกคน — AdminShell ก็ไม่ล็อกในโหมดนี้
 *   2) อยู่ในรายชื่อ NEXT_PUBLIC_ADMIN_IDS (เจ้าของล็อกอินด้วย Facebook uid)
 *   3) แถวใน users มี is_admin = true (ผู้ช่วยที่ตั้งจากฐานข้อมูล)
 *
 * อ่าน env ตอนเรียก (ไม่ใช่ตอน import) เพื่อให้ test สลับโหมดได้.
 */
const adminIds = (): string[] =>
  (process.env.NEXT_PUBLIC_ADMIN_IDS ?? '08809e6a-cfd1-4d57-a8f1-06a133bd2df6')
    .split(',').map((s) => s.trim()).filter(Boolean);

const noBackend = (): boolean =>
  !(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export function isAdminUser(db: Database, userId: string): boolean {
  if (noBackend()) return true;
  if (userId && adminIds().includes(userId)) return true;
  return db.users.find((u) => u.id === userId)?.is_admin === true;
}

/** บัญชีทีมงาน/แอดมิน "จริง" (ไม่สนโหมด seed) — ใช้ตัดสิทธิ์รางวัลลูกค้า เช่น คะแนนสะสม (audit 2026-09-23:
 *  ตั๋วทดสอบของแอดมินได้แต้มแล้วไปพองหนี้คะแนนร้าน) · ต่างจาก isAdminUser ที่เปิดทุกคนในโหมด seed */
export function isStaffAccount(db: Database, userId: string): boolean {
  if (!userId) return false;
  if (userId === 'u-admin' || adminIds().includes(userId)) return true;
  return userById(db).get(userId)?.is_admin === true; // ดัชนี — ถูกเรียกต่อตั๋วตอนคิดคะแนนทั้งร้าน
}
