'use client';

import { useEffect, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useDatabase } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import type { Database, Product } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const MAX_ITEMS = 12; // 4×3 grid max — more than this gets unreadable at 1080px
const LINE_KEY = 'ryuma_line_group_url';
const QR_IMG_KEY = 'ryuma_line_qr_img';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // missing image → placeholder cell, never break the poster
    img.src = src;
  });
}

/** Poster images for a product: its own image, or (variant product) the first TWO variant
 *  images — drawn as the same diagonal split the shop card uses. */
function imagesFor(db: Database, p: Product): string[] {
  if (p.images[0]) return [p.images[0]];
  const vs = db.variants.filter((v) => v.product_id === p.id && v.image_url).map((v) => v.image_url!) ;
  return vs.slice(0, 2);
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

/** drawImage in COVER mode (fill the box, crop overflow) — posters read better than contain. */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const sc = Math.max(w / img.width, h / img.height);
  const sw = w / sc, sh = h / sc;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** สร้างรูปโปรโมท — pick products → compose a 1080×1080 branded grid poster → download PNG. */
export default function PosterPage() {
  const db = useDatabase();
  const { flash } = useToast();

  const [title, setTitle] = useState('Pre-Order');
  const [subtitle, setSubtitle] = useState('ทุกรายการมัดจำ ฿300 · ปิดรอบเร็วๆ นี้');
  const [lineUrl, setLineUrl] = useState('');
  const [qrImg, setQrImg] = useState(''); // uploaded QR image (dataURL) — wins over the generated one
  const [cat, setCat] = useState<'' | 'preorder' | 'instock'>('preorder');
  const [makerId, setMakerId] = useState('');
  const [seriesId, setSeriesId] = useState('');
  const [showHeight, setShowHeight] = useState(true);
  const [showDeposit, setShowDeposit] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rendering, setRendering] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setLineUrl(localStorage.getItem(LINE_KEY) ?? '');
      setQrImg(localStorage.getItem(QR_IMG_KEY) ?? '');
    } catch { /* */ }
  }, []);
  const saveLineUrl = (v: string) => { setLineUrl(v); try { localStorage.setItem(LINE_KEY, v); } catch { /* */ } };
  const onQrUpload = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      setQrImg(url);
      try { localStorage.setItem(QR_IMG_KEY, url); } catch { /* too big for localStorage → session only */ }
    };
    reader.readAsDataURL(file);
  };
  const clearQrImg = () => { setQrImg(''); try { localStorage.removeItem(QR_IMG_KEY); } catch { /* */ } };

  const eligible = db.products.filter((p) => {
    if (cat === 'preorder' && (p.is_stock || p.status !== 'open')) return false;
    if (cat === 'instock' && !p.is_stock) return false;
    if (makerId && p.manufacturer_id !== makerId) return false;
    if (seriesId && p.series_id !== seriesId) return false;
    return true;
  });
  // series choices narrow to the selected maker (a series lists which makers carry it)
  const seriesOpts = db.series.filter((s) => !makerId || s.maker_ids.includes(makerId));

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

      const qrOn = !!qrImg || !!lineUrl.trim();
      const srcs = picked.map((p) => imagesFor(db, p));
      const [logo, uploadedQr, ...flat] = await Promise.all([
        loadImage('/ryuma-logo.png'),
        qrImg ? loadImage(qrImg) : Promise.resolve<HTMLImageElement | null>(null),
        ...srcs.flat().map((s) => loadImage(s)),
      ]);
      if (cancelled) return;
      // re-nest the flat image list back per product
      const imgs: (HTMLImageElement | null)[][] = [];
      let k = 0;
      for (const s of srcs) { imgs.push(flat.slice(k, k + s.length)); k += s.length; }

      // bg + soft brand glow
      ctx.fillStyle = '#0d0a0b'; ctx.fillRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(140, 80, 0, 140, 80, 700);
      glow.addColorStop(0, 'rgba(185,28,28,0.28)'); glow.addColorStop(1, 'rgba(185,28,28,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

      // header — tighter (feedback: give the grid more room). taller only when a QR is shown.
      const HEADER = qrOn ? 190 : 136;
      if (logo) {
        ctx.save(); roundRect(ctx, 36, 26, 84, 84, 18); ctx.clip();
        ctx.drawImage(logo, 36, 26, 84, 84); ctx.restore();
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff'; ctx.font = '900 52px system-ui, sans-serif';
      const titleMax = qrOn ? 700 - 160 : 780;
      ctx.fillText(ellipsize(ctx, title || 'Ryuma', titleMax), 140, 72);
      ctx.fillStyle = '#f0a8a8'; ctx.font = '600 28px system-ui, sans-serif';
      ctx.fillText(ellipsize(ctx, subtitle, titleMax), 140, 112);

      if (qrOn) {
        const qrSrc = uploadedQr ?? qrRef.current?.querySelector('canvas') ?? null;
        const bx = W - 36 - 148, by = 16;
        ctx.fillStyle = '#ffffff'; roundRect(ctx, bx, by, 148, 148, 14); ctx.fill();
        if (qrSrc) {
          if (qrSrc instanceof HTMLImageElement) {
            // uploaded QR photo → contain inside the white box
            const iw = 132, sc = Math.min(iw / qrSrc.width, iw / qrSrc.height);
            const dw = qrSrc.width * sc, dh = qrSrc.height * sc;
            ctx.drawImage(qrSrc, bx + 8 + (iw - dw) / 2, by + 8 + (iw - dh) / 2, dw, dh);
          } else {
            ctx.drawImage(qrSrc, bx + 8, by + 8, 132, 132);
          }
        }
        ctx.fillStyle = '#f0a8a8'; ctx.font = '700 21px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('สแกนเข้ากลุ่มไลน์', bx + 74, by + 172);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(36, HEADER); ctx.lineTo(W - 36, HEADER); ctx.stroke();

      // footer
      const FOOTER_Y = H - 58;
      ctx.beginPath(); ctx.moveTo(36, FOOTER_Y); ctx.lineTo(W - 36, FOOTER_Y); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = '#b9b1af'; ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText('📲 สั่งจองผ่านแอป Ryuma · สะสมแต้ม รับสิทธิพิเศษ', 36, H - 20);
      ctx.textAlign = 'right'; ctx.fillStyle = '#f0a8a8'; ctx.font = '800 26px Georgia, serif';
      ctx.fillText('RyumaToy', W - 36, H - 20);

      // grid
      const n = picked.length;
      if (n === 0) {
        ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.font = '600 34px system-ui, sans-serif';
        ctx.fillText('เลือกสินค้าทางซ้ายเพื่อใส่ในรูป', W / 2, H / 2);
      } else {
        const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
        const rows = Math.ceil(n / cols);
        const gap = 14, top = HEADER + 12, availH = FOOTER_Y - 12 - top, availW = W - 72;
        const cellW = (availW - gap * (cols - 1)) / cols;
        const cellH = (availH - gap * (rows - 1)) / rows;
        const nameFs = Math.min(30, Math.max(19, cellW * 0.082));
        const priceFs = nameFs * 1.12;
        // COMPACT text block (feedback): name + ONE combined price line → the image gets the rest
        const textH = 8 + nameFs + 8 + priceFs + 10;

        picked.forEach((p, i) => {
          const col = i % cols, row = Math.floor(i / cols);
          const x = 36 + col * (cellW + gap), y = top + row * (cellH + gap);
          ctx.fillStyle = '#1a1312'; roundRect(ctx, x, y, cellW, cellH, 16); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.09)'; roundRect(ctx, x, y, cellW, cellH, 16); ctx.stroke();

          // image — COVER (fills the cell, reads big & clear); variant teaser = diagonal split
          const iw = cellW - 16, ih = cellH - 16 - textH;
          const ix = x + 8, iy = y + 8;
          const cellImgs = (imgs[i] ?? []).filter((m): m is HTMLImageElement => !!m);
          ctx.save(); roundRect(ctx, ix, iy, iw, ih, 12); ctx.clip();
          ctx.fillStyle = '#fbf7f5'; ctx.fillRect(ix, iy, iw, ih);
          if (cellImgs.length >= 2) {
            // diagonal split — same teaser as the shop card
            ctx.save(); ctx.beginPath(); ctx.moveTo(ix, iy); ctx.lineTo(ix + iw, iy); ctx.lineTo(ix, iy + ih); ctx.closePath(); ctx.clip();
            drawCover(ctx, cellImgs[0], ix, iy, iw, ih); ctx.restore();
            ctx.save(); ctx.beginPath(); ctx.moveTo(ix + iw, iy); ctx.lineTo(ix + iw, iy + ih); ctx.lineTo(ix, iy + ih); ctx.closePath(); ctx.clip();
            drawCover(ctx, cellImgs[1], ix, iy, iw, ih); ctx.restore();
            ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(ix + iw, iy); ctx.lineTo(ix, iy + ih); ctx.stroke();
          } else if (cellImgs.length === 1) {
            drawCover(ctx, cellImgs[0], ix, iy, iw, ih);
          } else {
            ctx.fillStyle = '#d9cfcb'; ctx.font = `600 ${Math.round(ih * 0.3)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('🧸', ix + iw / 2, iy + ih / 2);
            ctx.textBaseline = 'alphabetic';
          }
          ctx.restore();

          // texts — 2 rows only
          const cxm = x + cellW / 2;
          ctx.textAlign = 'center';
          ctx.fillStyle = '#ffffff'; ctx.font = `700 ${nameFs}px system-ui, sans-serif`;
          ctx.fillText(ellipsize(ctx, p.series_name, cellW - 20), cxm, iy + ih + nameFs + 6);

          // combined line: ฿PRICE [· มัดจำ ฿X] [· สูง Y ซม.] — auto-drops the height part if tight
          const segs: { text: string; font: string; color: string }[] = [
            { text: baht(p.price_total), font: `900 ${priceFs}px system-ui, sans-serif`, color: '#ff9d9d' },
          ];
          if (showDeposit && !p.is_stock && p.deposit_amount < p.price_total)
            segs.push({ text: `  มัดจำ ${baht(p.deposit_amount)}`, font: `700 ${priceFs * 0.62}px system-ui, sans-serif`, color: '#4ade80' });
          if (showHeight && p.height_cm != null)
            segs.push({ text: `  สูง ${p.height_cm} ซม.`, font: `500 ${priceFs * 0.58}px system-ui, sans-serif`, color: '#9a9290' });
          const widthOf = (list: typeof segs) => list.reduce((s, g) => { ctx.font = g.font; return s + ctx.measureText(g.text).width; }, 0);
          let line = segs;
          if (widthOf(line) > cellW - 18 && line.length > 2) line = line.slice(0, 2); // drop height first
          if (widthOf(line) > cellW - 18 && line.length > 1) line = line.slice(0, 1); // then deposit
          let sx = cxm - widthOf(line) / 2;
          const py = iy + ih + nameFs + 10 + priceFs;
          ctx.textAlign = 'left';
          for (const g of line) { ctx.font = g.font; ctx.fillStyle = g.color; ctx.fillText(g.text, sx, py); sx += ctx.measureText(g.text).width; }
        });
      }
      if (!cancelled) setRendering(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, title, subtitle, lineUrl, qrImg, showHeight, showDeposit, db.products, db.variants]);

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

      {/* hidden QR source (generated from the link; used when no image was uploaded) */}
      {!qrImg && lineUrl.trim() && <div ref={qrRef} className="pointer-events-none fixed -left-[9999px] top-0"><QRCodeCanvas value={lineUrl.trim()} size={264} level="M" /></div>}

      <div className="grid gap-4 lg:grid-cols-[380px_1fr] lg:items-start">
        {/* left: controls */}
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-subtle bg-surface-2 p-4">
            <label className="mb-2 block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">หัวข้อ</span><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น Pre-Order : Power" /></label>
            <label className="mb-3 block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">บรรทัดรอง</span><input className={inputCls} value={subtitle} onChange={(e) => setSubtitle(e.target.value)} /></label>

            <div className="mb-1 text-[12px] font-semibold text-ink-muted">QR เข้ากลุ่มไลน์ (มุมขวาบน)</div>
            <div className="mb-2 flex items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-bold text-ink">
                <Icon name="camera" size={15} /> อัปโหลดรูป QR
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onQrUpload(e.target.files?.[0] ?? undefined)} />
              </label>
              {qrImg && (
                <>
                  <img src={qrImg} alt="QR" className="h-10 w-10 rounded-lg border border-subtle bg-white object-contain" />
                  <button onClick={clearQrImg} className="text-[12px] text-primary-soft">ลบ</button>
                </>
              )}
            </div>
            <label className="block"><span className="mb-1 block text-[11.5px] text-ink-faint">หรือวางลิงก์กลุ่ม ให้ระบบสร้าง QR ให้ (ถ้าไม่ได้อัปโหลดรูป)</span><input className={inputCls} value={lineUrl} onChange={(e) => saveLineUrl(e.target.value)} placeholder="https://line.me/ti/g/..." /></label>

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
              <select className={inputCls} value={makerId} onChange={(e) => { setMakerId(e.target.value); setSeriesId(''); }}>
                <option value="">ทุกค่าย</option>
                {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div className="mb-2">
              <select className={inputCls} value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
                <option value="">ทุกซีรีย์</option>
                {seriesOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="flex max-h-[360px] flex-col divide-y divide-hair overflow-y-auto">
              {eligible.length === 0 ? <div className="py-6 text-center text-[12.5px] text-ink-faint">ไม่มีสินค้าตามตัวกรอง</div> : eligible.map((p: Product) => {
                const thumb = imagesFor(db, p)[0];
                return (
                  <button key={p.id} onClick={() => toggle(p.id)} className="flex items-center gap-2.5 py-2 text-left">
                    <span className={cx('grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px]', selected.has(p.id) ? 'border-primary bg-primary' : 'border-subtle')}>{selected.has(p.id) && <Icon name="check" size={12} className="text-white" />}</span>
                    <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-stripe">{thumb ? <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Icon name="box" size={15} className="text-primary-soft/25" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold">{p.series_name}</span>
                      <span className="block text-[11px] text-ink-faint">{baht(p.price_total)}{p.height_cm ? ` · สูง ${p.height_cm} ซม.` : ''}</span>
                    </span>
                  </button>
                );
              })}
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
