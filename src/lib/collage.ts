'use client';

/**
 * สร้าง "รูปหมู่" เองจากรูปเดี่ยว (เจ้าของ 2026-10-08: บางค่ายไม่มีรูปรวม) — วาดบน canvas ฝั่งเบราว์เซอร์
 * ตารางช่อง: ≤3 ตัว = แถวเดียว · 4–6 = 3 คอลัมน์ · 7+ = 4 คอลัมน์ · ช่องเป็นแนวตั้ง 4:5 (ฟิกเกอร์ยืน)
 * ช่องละ: พื้นเบลอจากรูปเดียวกัน + รูปเต็มตัวไม่ตัด (contain) + แถบชื่อด้านล่าง · ช่องไฟ/มุมโค้ง/พื้นไล่สีเดียวกันทั้งแผ่น (2026-10-12)
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
  // ช่องไฟระหว่างช่อง + ขอบนอก (เจ้าของ 2026-10-12 "ออกมายังเละ": เดิม cover ตัดหัว/ตัดข้อความ · ช่องชนกันไม่มีช่องไฟ · พื้นหลังแต่ละรูปตีกัน)
  const gap = Math.round(W * 0.015);
  const tw = (W - gap * (cols + 1)) / cols;
  const th = Math.round(tw * 1.25);
  const H = th * rows + gap * (rows + 1);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('เบราว์เซอร์นี้วาดรูปไม่ได้');
  // พื้นทั้งแผ่น: ไล่สีเข้มเดียวกันทุกช่อง (รูปเดี่ยวของค่ายพื้นหลังคนละแบบ → ต้องมีพื้นกลางให้ดูเป็นชุดเดียว)
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1a1413'); bg.addColorStop(1, '#0b0809');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const imgs = await Promise.all(tiles.map((t) => (t.src ? load(t.src) : Promise.resolve(null))));
  const pins: CollageResult['pins'] = [];
  const r = Math.round(tw * 0.05); // มุมโค้งของช่อง
  const roundRect = (x: number, y: number, w: number, h: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  };
  const canBlur = 'filter' in ctx;
  tiles.forEach((t, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    // แถวสุดท้ายที่ไม่เต็ม → จัดกึ่งกลาง (ไม่ให้ช่องเดียวค้างซ้ายแล้วขวาว่าง)
    const inRow = row === rows - 1 ? tiles.length - row * cols : cols;
    const offset = ((cols - inRow) * (tw + gap)) / 2;
    const x = gap + offset + col * (tw + gap), y = gap + row * (th + gap);
    const img = imgs[i];
    ctx.save();
    roundRect(x, y, tw, th); ctx.clip();
    ctx.fillStyle = '#15100f'; ctx.fillRect(x, y, tw, th);
    if (img && img.naturalWidth > 0) {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      // ชั้นหลัง: รูปเดียวกันขยายเต็มช่อง เบลอ + ทึบลง (เติมที่ว่างให้ดูเนียน ไม่เป็นแถบดำ)
      if (canBlur) {
        const s = Math.max(tw / iw, th / ih) * 1.15;
        ctx.filter = 'blur(22px)';
        ctx.drawImage(img, x + (tw - iw * s) / 2, y + (th - ih * s) / 2, iw * s, ih * s);
        ctx.filter = 'none';
      }
      ctx.fillStyle = 'rgba(8,6,7,.62)'; ctx.fillRect(x, y, tw, th);
      // ชั้นหน้า: รูปเต็มตัวไม่ตัด (contain) เว้นขอบ 6% · ชิดบนเล็กน้อยเผื่อแถบชื่อด้านล่าง
      const pad = tw * 0.06;
      const s = Math.min((tw - pad * 2) / iw, (th - pad * 2 - th * 0.08) / ih);
      const dw = iw * s, dh = ih * s;
      ctx.drawImage(img, x + (tw - dw) / 2, y + pad + ((th - pad * 2 - th * 0.08) - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#9a9290';
      ctx.font = `bold ${Math.round(tw / 9)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(t.label.slice(0, 18), x + tw / 2, y + th / 2);
    }
    // แถบชื่อด้านล่างช่อง (ไล่สีดำ → โปร่ง) ให้ทุกช่องมีชื่อแบบเดียวกัน
    const cap = ctx.createLinearGradient(0, y + th * 0.72, 0, y + th);
    cap.addColorStop(0, 'rgba(0,0,0,0)'); cap.addColorStop(1, 'rgba(0,0,0,.85)');
    ctx.fillStyle = cap; ctx.fillRect(x, y + th * 0.72, tw, th * 0.28);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(tw / 11)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(t.label.slice(0, 22), x + tw / 2, y + th - th * 0.045);
    ctx.restore();
    // ขอบช่องบางๆ
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 2;
    roundRect(x, y, tw, th); ctx.stroke();
    // ตำแหน่งป้าย = กลางช่อง สูงจากขอบบนช่อง 12% (เหนือหัวฟิกเกอร์ที่ย่อให้เห็นเต็มตัว)
    pins.push({ id: t.id, x: Math.round(((x + tw / 2) / W) * 10000) / 100, y: Math.round(((y + th * 0.12) / H) * 10000) / 100 });
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('ส่งออกรูปไม่ได้ — รูปต้นทางไม่อนุญาตให้นำไปรวม (CORS)');
  return { blob, pins, width: W, height: H };
}
