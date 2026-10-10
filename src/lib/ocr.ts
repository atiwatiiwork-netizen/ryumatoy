/**
 * OCR a warehouse-table screenshot → raw text (ryuma-warehouse-spec). tesseract.js is loaded
 * DYNAMICALLY (only when the admin actually uploads an image) so it never touches the main bundle.
 * English only — the SF codes + dates are alphanumeric; we don't need the heavy Thai/Chinese data,
 * and the parser (parseWarehouseText) extracts SF + date + transport from whatever comes out.
 * The result ALWAYS lands in an editable review table before anything is confirmed.
 */
async function upscaleIfSmall(file: File, minWidth: number): Promise<Blob> {
  if (typeof document === 'undefined') return file;
  const bmp = await createImageBitmap(file);
  try {
    if (bmp.width >= minWidth) return file;
    const scale = Math.min(4, minWidth / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
  } finally { bmp.close(); }
}

/** langs: 'eng' (ตารางโกดัง) · 'eng+tha' (ใบเสร็จขนส่ง — ชื่อผู้รับไทยไว้โชว์/ก๊อป ส่วนการจับคู่ใช้ตัวเลข) */
export async function ocrImage(file: File, onProgress?: (pct: number) => void, langs: string = 'eng'): Promise<string> {
  const { default: Tesseract } = await import('tesseract.js');
  // รูปเล็ก (แคปจากแชท/ย่อแล้ว) tesseract อ่านตัวเลขหล่น → ขยายให้กว้างอย่างน้อย ~1800px ก่อน
  // (ทดสอบ 2026-10-10: ใบเสร็จ J&T กว้าง 470px อ่านได้ 1/18 ใบ) · ขยายไม่ได้ = ใช้ไฟล์เดิม
  const src = await upscaleIfSmall(file, 1800).catch(() => file);
  const url = URL.createObjectURL(src);
  try {
    const { data } = await Tesseract.recognize(url, langs, {
      logger: (m: { status?: string; progress?: number }) => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') onProgress?.(Math.round(m.progress * 100));
      },
    });
    return data.text ?? '';
  } finally {
    URL.revokeObjectURL(url);
  }
}
