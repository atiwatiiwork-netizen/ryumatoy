'use client';

/**
 * สร้าง "รูปหมู่" เองจากรูปเดี่ยว (เจ้าของ 2026-10-08: บางค่ายไม่มีรูปรวม) — วาดบน canvas ฝั่งเบราว์เซอร์
 * ตารางช่อง: ≤3 ตัว = แถวเดียว · 4–6 = 3 คอลัมน์ · 7+ = 4 คอลัมน์ · ช่องเป็นแนวตั้ง 4:5 (ฟิกเกอร์ยืน) ใส่รูปแบบ cover
 * ช่องที่ไม่มีรูป = พื้นเข้ม + ชื่อตัว · คืน blob JPEG + ตำแหน่งหัว (% ของรูป) ของแต่ละช่องสำหรับวางป้ายอัตโนมัติ
 * ⚠ รูปต้องโหลดแบบ crossOrigin (Supabase storage สาธารณะส่ง CORS ให้) — ไม่งั้น canvas ส่งออกไม่ได้ (SecurityError) → โยนให้ผู้เรียกแจ้ง
 */
export interface CollageTile { id: string; src?: string; label: string }
export interface CollageResult { blob: Blob; pins: { id: string; x: number; y: number }[]; width: number; height: number }

const load = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

export function collageGrid(n: number): { cols: number; rows: number } {
  const cols = n <= 3 ? Math.max(1, n) : n <= 6 ? 3 : 4;
  return { cols, rows: Math.ceil(n / cols) };
}

export async function composeCollage(tiles: CollageTile[], opts: { width?: number } = {}): Promise<CollageResult> {
  if (tiles.length === 0) throw new Error('ไม่มีรูปให้รวม');
  const W = opts.width ?? 1200;
  const { cols, rows } = collageGrid(tiles.length);
  const tw = W / cols;
  const th = Math.round(tw * 1.25);
  const H = th * rows;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('เบราว์เซอร์นี้วาดรูปไม่ได้');
  ctx.fillStyle = '#0d0a0b';
  ctx.fillRect(0, 0, W, H);
  const imgs = await Promise.all(tiles.map((t) => (t.src ? load(t.src) : Promise.resolve(null))));
  const pins: CollageResult['pins'] = [];
  tiles.forEach((t, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = col * tw, y = row * th;
    const img = imgs[i];
    if (img && img.naturalWidth > 0) {
      // cover-fit: ขยายให้เต็มช่องแล้วตัดส่วนเกิน (เน้นส่วนบน = หัว)
      const s = Math.max(tw / img.naturalWidth, th / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      ctx.drawImage(img, x + (tw - dw) / 2, y + Math.min(0, (th - dh) / 2) * 0.4, dw, dh);
    } else {
      ctx.fillStyle = '#1a1413';
      ctx.fillRect(x + 2, y + 2, tw - 4, th - 4);
      ctx.fillStyle = '#9a9290';
      ctx.font = `bold ${Math.round(tw / 9)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(t.label.slice(0, 18), x + tw / 2, y + th / 2);
    }
    // เส้นแบ่งช่องบางๆ
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
    // ตำแหน่งป้าย = กลางช่อง สูงจากขอบบนช่อง 16% (ประมาณยอดหัวของฟิกเกอร์ยืนเต็มตัว)
    pins.push({ id: t.id, x: Math.round(((x + tw / 2) / W) * 10000) / 100, y: Math.round(((y + th * 0.16) / H) * 10000) / 100 });
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('ส่งออกรูปไม่ได้ — รูปต้นทางไม่อนุญาตให้นำไปรวม (CORS)');
  return { blob, pins, width: W, height: H };
}
