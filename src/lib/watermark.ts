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
    const ink = dark ? 'rgba(255,255,255,0.9)' : 'rgba(18,18,18,0.82)';

    const s = Math.max(w, h);
    const fs = Math.max(11, Math.round(s * 0.026));
    const pad = Math.round(s * 0.022);
    const r = fs * 0.72;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
    ctx.shadowBlur = fs * 0.35;

    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    const text = 'RyumaToy';
    const textW = ctx.measureText(text).width;
    const cy = h - pad - r;
    const startX = w - pad - textW - r * 2 - fs * 0.35;

    // circle "R" badge
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, fs * 0.1);
    ctx.beginPath(); ctx.arc(startX + r, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ink; ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(fs * 0.86)}px system-ui, sans-serif`;
    ctx.fillText('R', startX + r, cy + fs * 0.02);

    // wordmark
    ctx.textAlign = 'left';
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.fillText(text, startX + r * 2 + fs * 0.35, cy);

    const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), 'image/png', 0.92));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '-wm.png', { type: 'image/png' });
  } catch {
    return file; // any failure → upload original untouched
  } finally {
    URL.revokeObjectURL(url);
  }
}
