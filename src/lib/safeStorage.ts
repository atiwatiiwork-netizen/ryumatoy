/**
 * localStorage / sessionStorage ที่ "ไม่มีวันโยน" (audit persist #7/#8).
 *
 * ทำไมต้องมี: Safari ที่ตั้ง Block All Cookies, โหมดส่วนตัว, และ webview ในแอป (LINE/FB)
 * ทำให้แค่ "อ่าน" ก็โยน SecurityError ได้ — และแอปนี้ไม่มี error boundary
 * (ไม่มี app/error.tsx) ดังนั้น exception ที่หลุดจาก effect = จอขาวทั้งแอป รีเฟรชกี่ครั้งก็ขาว
 * ส่วนที่หลุดจาก onClick = ปุ่มกดแล้วไม่มีอะไรเกิดขึ้นตลอดกาล (ลูกค้าเข้าหน้าล็อกอินไม่ได้เลย)
 */
type Store = 'local' | 'session';

const raw = (which: Store): Storage | null => {
  try { return which === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; }
};

export const readStore = (which: Store, key: string): string | null => {
  try { return raw(which)?.getItem(key) ?? null; } catch { return null; }
};

/** คืน true ถ้าเขียนได้จริง (ผู้เรียกส่วนใหญ่ไม่สนใจ — แต่ห้ามโยนเด็ดขาด) */
export const writeStore = (which: Store, key: string, value: string): boolean => {
  try { raw(which)?.setItem(key, value); return true; } catch { return false; }
};

export const removeStore = (which: Store, key: string): void => {
  try { raw(which)?.removeItem(key); } catch { /* ignore */ }
};
