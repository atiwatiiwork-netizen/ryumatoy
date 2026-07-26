import { supabase } from '@/data/supabaseClient';

/**
 * Upload an image to the public `logos` Storage bucket and return its public URL.
 * One bucket is reused for all images (maker logos, product photos, QR, slips)
 * with a name prefix. When Supabase isn't configured (offline preview), fall back
 * to an inline data URL so the UI still works.
 */
export async function uploadImage(file: File, prefix: string): Promise<string> {
  if (!supabase) {
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
      supabase.storage.from('logos').upload(path, file, { upsert: true, contentType: file.type }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('อัปโหลดรูปช้าเกินไป — ลองใหม่อีกครั้ง')), 45_000); }),
    ]);
    if (error) throw error;
  } finally {
    clearTimeout(timer);
  }
  return supabase.storage.from('logos').getPublicUrl(path).data.publicUrl;
}
