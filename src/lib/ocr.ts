/**
 * OCR a warehouse-table screenshot → raw text (ryuma-warehouse-spec). tesseract.js is loaded
 * DYNAMICALLY (only when the admin actually uploads an image) so it never touches the main bundle.
 * English only — the SF codes + dates are alphanumeric; we don't need the heavy Thai/Chinese data,
 * and the parser (parseWarehouseText) extracts SF + date + transport from whatever comes out.
 * The result ALWAYS lands in an editable review table before anything is confirmed.
 */
/** langs: 'eng' (ตารางโกดัง) · 'eng+tha' (ใบเสร็จขนส่ง — ชื่อผู้รับไทยไว้โชว์/ก๊อป ส่วนการจับคู่ใช้ตัวเลข) */
export async function ocrImage(file: File, onProgress?: (pct: number) => void, langs: string = 'eng'): Promise<string> {
  const { default: Tesseract } = await import('tesseract.js');
  const url = URL.createObjectURL(file);
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
