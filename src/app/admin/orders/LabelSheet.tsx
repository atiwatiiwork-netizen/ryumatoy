'use client';

import { useMemo, useState } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { labelSlots, SENDER_NAME, SENDER_PHONE, type LabelSlot } from '@/domain/services/delivery';
import type { PreorderTicket } from '@/domain/entities';

/**
 * ใบปะหน้าพัสดุ A4 — 8 ช่อง (2×4) ต่อแผ่น (ryuma delivery spec ข้อ 1–5).
 * ช่องละ: ผู้ส่ง (ริวมะ 0853475681) → เว้น 2 บรรทัด → ที่อยู่ลูกค้า → บรรทัดสุดท้าย ชื่อสินค้า+ค่าย+จำนวน.
 * รวมพรีออเดอร์ + in-stock ในรอบเดียว; ลูกค้าเดียวกัน+ที่อยู่เดียวกัน = ช่องเดียว หลายบรรทัดสินค้า.
 * ออกเป็นรูป PNG (A4 200dpi) ไว้ปริ้นแล้วตัดตามเส้นประ.
 */

// A4 @ ~200dpi
const W = 1654;
const H = 2339;
const MARGIN = 40;
const COLS = 2;
const ROWS = 4;
const PER_PAGE = COLS * ROWS;

/** ตัดข้อความให้พอดีความกว้าง (ไทยไม่มีช่องว่าง → ไล่ทีละตัวอักษร). */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text.replace(/\s+/g, ' ').trim()) {
    if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch === ' ' ? '' : ch; }
    else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawSlot(ctx: CanvasRenderingContext2D, slot: LabelSlot, x: number, y: number, w: number, h: number) {
  const PAD = 30;
  const innerW = w - PAD * 2;

  // เส้นประรอบช่อง (ไว้ตัด)
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  ctx.fillStyle = '#111';
  ctx.textBaseline = 'top';
  let cy = y + PAD;

  // ผู้ส่ง — คงที่ทุกช่อง (spec ข้อ 2)
  ctx.font = "bold 30px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
  ctx.fillText(`ผู้ส่ง ${SENDER_NAME} ${SENDER_PHONE}`, x + PAD, cy);
  cy += 40;

  // เว้น 2 บรรทัด (spec ข้อ 3 — ที่ว่างสำหรับแปะ/เขียนเพิ่ม)
  cy += 80;

  // ผู้รับ (ที่อยู่ลูกค้าที่สมัครมาในระบบ / ที่อยู่ใหม่ที่กรอก)
  ctx.font = "bold 34px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
  const headLines = wrapText(ctx, `ผู้รับ ${slot.to.name}${slot.to.phone ? ` โทร. ${slot.to.phone}` : ''}`, innerW);
  for (const l of headLines.slice(0, 2)) { ctx.fillText(l, x + PAD, cy); cy += 44; }
  ctx.font = "30px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
  const addrLines = wrapText(ctx, slot.to.address || '— ไม่มีที่อยู่ในระบบ —', innerW);
  for (const l of addrLines.slice(0, 4)) { ctx.fillText(l, x + PAD, cy); cy += 38; }
  if (addrLines.length > 4) { ctx.fillText('…', x + PAD, cy); }

  // บรรทัดสุดท้าย: ชื่อสินค้า + ค่าย + จำนวน (วาดจากล่างขึ้น กันชนที่อยู่)
  ctx.font = "24px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
  ctx.fillStyle = '#374151';
  const MAX_PRODUCT_LINES = 3;
  const shown = slot.lines.slice(0, MAX_PRODUCT_LINES);
  const extra = slot.lines.length - shown.length;
  const texts = shown.map((l) => `• ${l.label} ×${l.qty}`);
  if (extra > 0) texts.push(`  …และอีก ${extra} รายการ`);
  let py = y + h - PAD - texts.length * 30;
  // เส้นคั่นบางๆ เหนือรายการสินค้า
  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x + PAD, py - 10); ctx.lineTo(x + w - PAD, py - 10); ctx.stroke();
  for (const tline of texts) {
    const fit = wrapText(ctx, tline, innerW)[0] ?? tline; // สินค้ายาวเกิน = ตัดบรรทัดเดียว
    ctx.fillText(fit, x + PAD, py);
    py += 30;
  }
}

function renderPage(slots: LabelSlot[]): string {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const cellW = (W - MARGIN * 2) / COLS;
  const cellH = (H - MARGIN * 2) / ROWS;
  slots.forEach((slot, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    drawSlot(ctx, slot, MARGIN + col * cellW, MARGIN + row * cellH, cellW, cellH);
  });
  return canvas.toDataURL('image/png');
}

export function LabelSheet({ tickets }: { tickets: PreorderTicket[] }) {
  const db = useDatabase();
  const { flash } = useToast();
  const slots = useMemo(() => labelSlots(db, tickets), [db, tickets]);
  // เก็บ "ช่องที่เอาออก" แทนช่องที่เลือก → ช่องใหม่ที่โผล่มาถูกติ๊กให้อัตโนมัติ
  const [off, setOff] = useState<Set<string>>(new Set());
  const [pages, setPages] = useState<string[]>([]);
  const chosen = slots.filter((s) => !off.has(s.key));

  const toggle = (key: string) => {
    setOff((old) => { const n = new Set(old); if (n.has(key)) n.delete(key); else n.add(key); return n; });
    setPages([]); // เลือกใหม่ = พรีวิวเดิมใช้ไม่ได้แล้ว
  };
  const generate = () => {
    if (!chosen.length) return flash('เลือกอย่างน้อย 1 ช่องก่อน');
    const out: string[] = [];
    for (let i = 0; i < chosen.length; i += PER_PAGE) out.push(renderPage(chosen.slice(i, i + PER_PAGE)));
    setPages(out);
    flash(`สร้างใบปะหน้าแล้ว · ${chosen.length} ช่อง / ${out.length} แผ่น`);
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex items-center gap-2 text-base font-bold text-ink">
        <Icon name="copy" size={18} className="text-[#c4b5fd]" /> <span>ใบปะหน้าพัสดุ A4 · 8 ช่อง</span>
        <span className="ml-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] text-ink-muted2">{slots.length}</span>
      </div>
      <div className="mb-3 text-[11.5px] text-ink-faint">รวมพรี + In Stock รอบเดียวกัน · ลูกค้าเดียวกัน = ช่องเดียว (หลายสินค้าหลายบรรทัด) · ปริ้นแล้วตัดตามเส้นประ</div>

      {slots.length === 0 ? <div className="py-2 text-[13px] text-ink-faint">ไม่มีรายการพร้อมพิมพ์ (ต้องจ่ายครบ + ยืนยันวิธีรับของแบบส่งพัสดุ)</div> : (
        <>
          <div className="mb-3 flex flex-col gap-1.5">
            {slots.map((s) => (
              <label key={s.key} className={cx('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5', off.has(s.key) ? 'border-subtle bg-surface-3 opacity-50' : 'border-[#7c3aed]/40 bg-[#7c3aed]/[0.07]')}>
                <input type="checkbox" checked={!off.has(s.key)} onChange={() => toggle(s.key)} className="mt-1 h-4 w-4 accent-[#7c3aed]" />
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold">{s.to.name} <span className="text-[11.5px] font-normal text-ink-faint">{s.to.phone}</span></div>
                  <div className="line-clamp-1 text-[11.5px] text-ink-faint">{s.to.address || '— ไม่มีที่อยู่'}</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-muted2">{s.lines.map((l) => `${l.label} ×${l.qty}`).join(' · ')}</div>
                </div>
              </label>
            ))}
          </div>
          <button onClick={generate} className="w-full rounded-xl bg-[#7c3aed] py-2.5 text-[13.5px] font-bold text-white">
            🖨️ สร้างใบปะหน้า ({chosen.length} ช่อง · {Math.max(1, Math.ceil(chosen.length / PER_PAGE))} แผ่น)
          </button>

          {pages.length > 0 && (
            <div className="mt-3.5 flex flex-col gap-3">
              {pages.map((src, i) => (
                <div key={i} className="rounded-xl border border-subtle bg-surface-3 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-[12.5px] font-bold text-ink-muted">แผ่นที่ {i + 1} / {pages.length}</div>
                    <a href={src} download={`labels-${today}-p${i + 1}.png`} className="rounded-lg bg-cta px-3.5 py-1.5 text-[12.5px] font-bold text-white">⬇ ดาวน์โหลดรูป</a>
                  </div>
                  <img src={src} alt={`ใบปะหน้าแผ่นที่ ${i + 1}`} className="w-full rounded-lg border border-subtle bg-white" />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
