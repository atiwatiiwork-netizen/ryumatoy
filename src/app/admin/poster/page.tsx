'use client';

import { useEffect, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useDatabase } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import type { Product } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const MAX_ITEMS = 12; // 4×3 grid max — more than this gets unreadable at 1080px
const LINE_KEY = 'ryuma_line_group_url';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // missing image → placeholder cell, never break the poster
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** สร้างรูปโปรโมท — pick products from the system → compose a 1080×1080 branded grid poster
 *  (logo + title + LINE-group QR + name/height/price/deposit per cell) → download PNG for LINE/FB. */
export default function PosterPage() {
  const db = useDatabase();
  const { flash } = useToast();

  const [title, setTitle] = useState('Pre-Order');
  const [subtitle, setSubtitle] = useState('ทุกรายการมัดจำ ฿300 · ปิดรอบเร็วๆ นี้');
  const [lineUrl, setLineUrl] = useState('');
  const [cat, setCat] = useState<'' | 'preorder' | 'instock'>('preorder');
  const [makerId, setMakerId] = useState('');
  const [showHeight, setShowHeight] = useState(true);
  const [showDeposit, setShowDeposit] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rendering, setRendering] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { setLineUrl(localStorage.getItem(LINE_KEY) ?? ''); } catch { /* */ } }, []);
  const saveLineUrl = (v: string) => { setLineUrl(v); try { localStorage.setItem(LINE_KEY, v); } catch { /* */ } };

  const eligible = db.products.filter((p) => {
    if (cat === 'preorder' && (p.is_stock || p.status !== 'open')) return false;
    if (cat === 'instock' && !p.is_stock) return false;
    if (makerId && p.manufacturer_id !== makerId) return false;
    return true;
  });

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else { if (n.size >= MAX_ITEMS) { flash(`ใส่ได้สูงสุด ${MAX_ITEMS} ตัวต่อรูป`); return s; } n.add(id); }
    return n;
  });
  const selectAll = () => setSelected(new Set(eligible.slice(0, MAX_ITEMS).map((p) => p.id)));

  const picked = db.products.filter((p) => selected.has(p.id));

  // ── canvas compose ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      setRendering(true);
      const W = 1080, H = 1080;
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const [logo, ...imgs] = await Promise.all([
        loadImage('/ryuma-logo.png'),
        ...picked.map((p) => (p.images[0] ? loadImage(p.images[0]) : Promise.resolve<HTMLImageElement | null>(null))),
      ]);
      if (cancelled) return;

      // bg + soft brand glow
      ctx.fillStyle = '#0d0a0b'; ctx.fillRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(140, 90, 0, 140, 90, 720);
      glow.addColorStop(0, 'rgba(185,28,28,0.28)'); glow.addColorStop(1, 'rgba(185,28,28,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

      // header — logo + title/subtitle left, LINE-group QR right
      const HEADER = 212;
      if (logo) {
        ctx.save(); roundRect(ctx, 36, 40, 96, 96, 20); ctx.clip();
        ctx.drawImage(logo, 36, 40, 96, 96); ctx.restore();
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff'; ctx.font = '900 54px system-ui, sans-serif';
      const qrOn = !!lineUrl.trim();
      const titleMax = qrOn ? 690 - 152 : 690;
      ctx.fillText(ellipsize(ctx, title || 'Ryuma', titleMax), 152, 92);
      ctx.fillStyle = '#f0a8a8'; ctx.font = '600 30px system-ui, sans-serif';
      ctx.fillText(ellipsize(ctx, subtitle, titleMax), 152, 138);

      if (qrOn) {
        const qrCanvas = qrRef.current?.querySelector('canvas');
        const bx = W - 36 - 152, by = 22;
        ctx.fillStyle = '#ffffff'; roundRect(ctx, bx, by, 152, 152, 14); ctx.fill();
        if (qrCanvas) ctx.drawImage(qrCanvas, bx + 10, by + 10, 132, 132);
        ctx.fillStyle = '#f0a8a8'; ctx.font = '700 22px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('สแกนเข้ากลุ่มไลน์', bx + 76, by + 182);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(36, HEADER); ctx.lineTo(W - 36, HEADER); ctx.stroke();

      // footer
      const FOOTER_Y = H - 62;
      ctx.beginPath(); ctx.moveTo(36, FOOTER_Y); ctx.lineTo(W - 36, FOOTER_Y); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = '#b9b1af'; ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText('📲 สั่งจองผ่านแอป Ryuma · สะสมแต้ม รับสิทธิพิเศษ', 36, H - 22);
      ctx.textAlign = 'right'; ctx.fillStyle = '#f0a8a8'; ctx.font = '800 26px Georgia, serif';
      ctx.fillText('RyumaToy', W - 36, H - 22);

      // grid
      const n = picked.length;
      if (n === 0) {
        ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.font = '600 34px system-ui, sans-serif';
        ctx.fillText('เลือกสินค้าทางซ้ายเพื่อใส่ในรูป', W / 2, H / 2);
      } else {
        const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
        const rows = Math.ceil(n / cols);
        const gap = 16, top = HEADER + 14, availH = FOOTER_Y - 14 - top, availW = W - 72;
        const cellW = (availW - gap * (cols - 1)) / cols;
        const cellH = (availH - gap * (rows - 1)) / rows;
        const nameFs = Math.min(30, Math.max(19, cellW * 0.085));
        const textH = nameFs + 14 + (showHeight ? nameFs * 0.75 + 6 : 0) + nameFs * 1.12 + 8 + (showDeposit ? nameFs * 0.75 + 6 : 0);

        picked.forEach((p, i) => {
          const col = i % cols, row = Math.floor(i / cols);
          const x = 36 + col * (cellW + gap), y = top + row * (cellH + gap);
          ctx.fillStyle = '#1a1312'; roundRect(ctx, x, y, cellW, cellH, 18); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.09)'; roundRect(ctx, x, y, cellW, cellH, 18); ctx.stroke();

          // image (object-contain) — white pad behind so dark product shots pop
          const iw = cellW - 24, ih = cellH - 24 - textH;
          const img = imgs[i];
          ctx.save(); roundRect(ctx, x + 12, y + 12, iw, ih, 12); ctx.clip();
          ctx.fillStyle = '#fbf7f5'; ctx.fillRect(x + 12, y + 12, iw, ih);
          if (img) {
            const sc = Math.min(iw / img.width, ih / img.height);
            const dw = img.width * sc, dh = img.height * sc;
            ctx.drawImage(img, x + 12 + (iw - dw) / 2, y + 12 + (ih - dh) / 2, dw, dh);
          } else {
            ctx.fillStyle = '#d9cfcb'; ctx.font = `600 ${Math.round(ih * 0.3)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('🧸', x + 12 + iw / 2, y + 12 + ih / 2);
            ctx.textBaseline = 'alphabetic';
          }
          ctx.restore();

          // texts
          const cxm = x + cellW / 2;
          let ty = y + 12 + ih + nameFs + 8;
          ctx.textAlign = 'center';
          ctx.fillStyle = '#ffffff'; ctx.font = `700 ${nameFs}px system-ui, sans-serif`;
          ctx.fillText(ellipsize(ctx, p.series_name, cellW - 24), cxm, ty);
          if (showHeight && p.height_cm != null) {
            ty += nameFs * 0.75 + 6;
            ctx.fillStyle = '#9a9290'; ctx.font = `500 ${nameFs * 0.68}px system-ui, sans-serif`;
            ctx.fillText(`สูง ${p.height_cm} ซม.`, cxm, ty);
          }
          ty += nameFs * 1.12 + 6;
          ctx.fillStyle = '#ff9d9d'; ctx.font = `900 ${nameFs * 1.12}px system-ui, sans-serif`;
          ctx.fillText(baht(p.price_total), cxm, ty);
          if (showDeposit && !p.is_stock && p.deposit_amount < p.price_total) {
            ty += nameFs * 0.75 + 8;
            ctx.fillStyle = '#4ade80'; ctx.font = `600 ${nameFs * 0.7}px system-ui, sans-serif`;
            ctx.fillText(`มัดจำ ${baht(p.deposit_amount)}`, cxm, ty);
          }
        });
      }
      if (!cancelled) setRendering(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, title, subtitle, lineUrl, showHeight, showDeposit, db.products]);

  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas || picked.length === 0) return flash('เลือกสินค้าก่อน');
    canvas.toBlob((blob) => {
      if (!blob) return flash('สร้างรูปไม่สำเร็จ');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ryuma-promo-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash('ดาวน์โหลดรูปแล้ว 🎉');
    }, 'image/png', 0.95);
  };

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">สร้างรูปโปรโมท</div>
      <div className="mb-5 text-[13px] text-ink-faint">เลือกสินค้า → ได้รูป grid 1080×1080 พร้อมโลโก้ + QR เข้ากลุ่มไลน์ → โหลดไปลง LINE / Facebook</div>

      {/* hidden QR source (drawn onto the canvas) */}
      {lineUrl.trim() && <div ref={qrRef} className="pointer-events-none fixed -left-[9999px] top-0"><QRCodeCanvas value={lineUrl.trim()} size={264} level="M" /></div>}

      <div className="grid gap-4 lg:grid-cols-[380px_1fr] lg:items-start">
        {/* left: controls */}
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
            <label className="mb-2 block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">หัวข้อ</span><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น Pre-Order : Power" /></label>
            <label className="mb-2 block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">บรรทัดรอง</span><input className={inputCls} value={subtitle} onChange={(e) => setSubtitle(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">ลิงก์เข้ากลุ่มไลน์ (ทำเป็น QR มุมขวาบน)</span><input className={inputCls} value={lineUrl} onChange={(e) => saveLineUrl(e.target.value)} placeholder="https://line.me/ti/g/..." /></label>
            <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
              <button onClick={() => setShowHeight((v) => !v)} className={cx('rounded-full border px-3 py-1.5 font-semibold', showHeight ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>ส่วนสูง {showHeight ? '✓' : ''}</button>
              <button onClick={() => setShowDeposit((v) => !v)} className={cx('rounded-full border px-3 py-1.5 font-semibold', showDeposit ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>มัดจำ {showDeposit ? '✓' : ''}</button>
            </div>
          </div>

          <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-bold">เลือกสินค้า ({selected.size}/{MAX_ITEMS})</span>
              <button onClick={selectAll} className="ml-auto text-[12px] font-semibold text-primary-soft">เลือก {Math.min(eligible.length, MAX_ITEMS)} ตัวแรก</button>
              <button onClick={() => setSelected(new Set())} className="text-[12px] text-ink-faint">ล้าง</button>
            </div>
            <div className="mb-2 flex gap-2">
              <select className={inputCls} value={cat} onChange={(e) => setCat(e.target.value as typeof cat)}>
                <option value="preorder">พรีเปิดจอง</option>
                <option value="instock">พร้อมส่ง</option>
                <option value="">ทั้งหมด</option>
              </select>
              <select className={inputCls} value={makerId} onChange={(e) => setMakerId(e.target.value)}>
                <option value="">ทุกค่าย</option>
                {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div className="flex max-h-[360px] flex-col divide-y divide-hair overflow-y-auto">
              {eligible.length === 0 ? <div className="py-6 text-center text-[12.5px] text-ink-faint">ไม่มีสินค้าตามตัวกรอง</div> : eligible.map((p: Product) => (
                <button key={p.id} onClick={() => toggle(p.id)} className="flex items-center gap-2.5 py-2 text-left">
                  <span className={cx('grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px]', selected.has(p.id) ? 'border-primary bg-primary' : 'border-subtle')}>{selected.has(p.id) && <Icon name="check" size={12} className="text-white" />}</span>
                  <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-stripe">{p.images[0] ? <img src={p.images[0]} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Icon name="box" size={15} className="text-primary-soft/25" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold">{p.series_name}</span>
                    <span className="block text-[11px] text-ink-faint">{baht(p.price_total)}{p.height_cm ? ` · สูง ${p.height_cm} ซม.` : ''}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* right: live preview + download */}
        <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
          <div className="mb-3 flex items-center gap-3">
            <span className="text-[13px] font-bold">ตัวอย่าง (1080×1080)</span>
            {rendering && <span className="text-[11.5px] text-ink-faint">กำลังวาด…</span>}
            <button onClick={download} disabled={picked.length === 0} className="ml-auto rounded-lg bg-cta px-5 py-2.5 text-[13px] font-bold text-white disabled:opacity-50">⬇ ดาวน์โหลด PNG</button>
          </div>
          <canvas ref={canvasRef} className="w-full max-w-[560px] rounded-xl border border-subtle" />
          <div className="mt-2 text-[11.5px] text-ink-faint">รูปจริงคมชัด 1080×1080 px — โพสต์ LINE / Facebook ได้โดยไม่แตก · QR สแกนได้จริง</div>
        </div>
      </div>
    </div>
  );
}
