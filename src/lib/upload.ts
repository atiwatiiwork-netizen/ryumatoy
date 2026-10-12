import { supabase } from '@/data/supabaseClient';
import { simActive, SIM_BLOCKED } from './sim';
import { marketSandbox } from './marketSandbox';

/**
 * Upload an image to the public `logos` Storage bucket and return its public URL.
 * One bucket is reused for all images (maker logos, product photos, QR, slips)
 * with a name prefix. When Supabase isn't configured (offline preview), fall back
 * to an inline data URL so the UI still works.
 */
export async function uploadImage(file: File, prefix: string): Promise<string> {
  if (simActive()) throw new Error(SIM_BLOCKED); // โหมดจำลองดูเป็นลูกค้า — ห้ามอัปโหลดจริง
  // โหมดทดลองเล่นตลาด (แอดมิน): สลิป/หลักฐานอยู่ในหน้าเว็บอย่างเดียว ไม่ขึ้นที่เก็บรูปจริง
  if (!supabase || marketSandbox()) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.readAsDataURL(file);
    });
  }
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  // DNA: ต้องมีเพดานเวลา — เน็ตอ่อนๆ ตอนแนบสลิปเคยทำให้ปุ่มค้าง "กำลังอัปโหลด…" ตลอดกาล
  // (ปุ่มส่งถูก disable ด้วย busy) ลูกค้าต้องปิดแอปทิ้ง = สลิปหาย (audit persist #6)
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { error } = await Promise.race([
      // upsert:false — ชื่อไฟล์ไม่ซ้ำอยู่แล้ว และ v86 ให้ลูกค้าอ่านได้เฉพาะไฟล์ตัวเอง (upsert ต้องสิทธิ์อ่าน/เขียนทับ ซึ่งปิดไว้)
      supabase.storage.from('logos').upload(path, file, { upsert: false, contentType: file.type }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('อัปโหลดรูปช้าเกินไป — ลองใหม่อีกครั้ง')), 45_000); }),
    ]);
    if (error) throw error;
  } finally {
    clearTimeout(timer);
  }
  return supabase.storage.from('logos').getPublicUrl(path).data.publicUrl;
}
