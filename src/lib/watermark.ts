/**
 * Bake a "◯R RyumaToy" watermark into the bottom-right corner of an image (style A).
 * Colour auto-adapts to the corner's brightness (white on dark photos, dark on light),
 * so the mark is always legible. Runs client-side via canvas; returns a new PNG File.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function applyWatermark(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);

    // sample bottom-right brightness → choose light/dark mark
    let avg = 200;
    try {
      const rx = Math.floor(w * 0.6), ry = Math.floor(h * 0.78);
      const rw = Math.max(1, w - rx), rh = Math.max(1, h - ry);
      const d = ctx.getImageData(rx, ry, rw, rh).data;
      let sum = 0; for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      avg = sum / (d.length / 4);
    } catch { /* tainted canvas → keep default */ }
    const dark = avg < 128;
    const ink = dark ? 'rgba(255,255,255,0.95)' : 'rgba(18,18,18,0.9)';
    const s = Math.max(w, h);
    const fs = Math.max(12, Math.round(s * 0.03));
    const pad = Math.round(s * 0.022);

    // load the real Ryuma logo and KEY OUT its black background (alpha = brightness)
    let logoCanvas: HTMLCanvasElement | null = null;
    try {
      const logo = await loadImage('/ryuma-logo.png');
      const lw = logo.naturalWidth || logo.width, lh = logo.naturalHeight || logo.height;
      const lc = document.createElement('canvas'); lc.width = lw; lc.height = lh;
      const lx = lc.getContext('2d');
      if (lx) {
        lx.drawImage(logo, 0, 0);
        const ld = lx.getImageData(0, 0, lw, lh); const d = ld.data;
        for (let i = 0; i < d.length; i += 4) d[i + 3] = Math.max(d[i], d[i + 1], d[i + 2]); // black→transparent, red stays
        lx.putImageData(ld, 0, 0);
        logoCanvas = lc;
      }
    } catch { /* logo missing → text only */ }

    const text = 'RyumaToy';
    // elegant serif wordmark with letter-spacing for a premium look
    ctx.font = `600 ${fs}px Georgia, "Times New Roman", "Noto Serif", serif`;
    try { (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(fs * 0.07)}px`; } catch { /* older browsers */ }
    const textW = ctx.measureText(text).width;
    const rightX = w - pad;
    const textY = h - pad;                       // text baseline (bottom)
    const centerX = rightX - textW / 2;          // stack centred over the word

    // wordmark
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.shadowColor = dark ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.65)';
    ctx.shadowBlur = fs * 0.45;
    ctx.fillStyle = ink;
    ctx.fillText(text, rightX, textY);

    // logo above the word (keyed, brand red, soft shadow for contrast)
    if (logoCanvas) {
      const logoSize = Math.round(fs * 2.9);
      const gap = Math.round(fs * 0.2);
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = fs * 0.5;
      ctx.drawImage(logoCanvas, centerX - logoSize / 2, textY - fs - gap - logoSize, logoSize, logoSize);
    }

    const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), 'image/png', 0.92));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '-wm.png', { type: 'image/png' });
  } catch {
    return file; // any failure → upload original untouched
  } finally {
    URL.revokeObjectURL(url);
  }
}
