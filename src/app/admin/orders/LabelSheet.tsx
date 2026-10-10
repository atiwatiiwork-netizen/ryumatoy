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

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
const fmtTime = (iso: string) => new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** วันตามปฏิทินเครื่อง (เวลาไทย ไม่ใช่ UTC) ไว้จัดกลุ่มหัววัน */
const dayKey = (iso?: string) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayLabel = (key: string, today: string, yesterday: string) => key === '' ? 'ตั๋วเก่า (ไม่มีเวลารับเรื่อง)' : key === today ? 'วันนี้' : key === yesterday ? 'เมื่อวาน' : new Date(key + 'T12:00:00').toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
const daysWaiting = (iso: string, now: number) => Math.floor((now - new Date(iso).getTime()) / 86400000);

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
  // เลขคิว + วันเข้าคิว มุมขวาบน (เจ้าของ 2026-10-10: ของเข้าหลายช่วง ปริ้นแล้วต้องรู้ว่าใบไหนมาก่อน)
  ctx.font = "24px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
  ctx.fillStyle = '#6b7280';
  ctx.textAlign = 'right';
  ctx.fillText(`คิว #${slot.queueNo}${slot.since ? ' · ' + shortDate(slot.since) : ''}`, x + w - PAD, cy + 4);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#111';
  cy += 40;

  // เว้นที่ว่างสำหรับแปะ/เขียนเพิ่ม (spec ข้อ 3) — ลดลงนิดเพื่อรับบรรทัดเบอร์โทรที่แยกออกมา
  cy += 54;

  // ผู้รับ — ชื่อ (บรรทัดบน)
  ctx.font = "bold 34px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
  const nameLines = wrapText(ctx, `ผู้รับ ${slot.to.name}`, innerW);
  for (const l of nameLines.slice(0, 2)) { ctx.fillText(l, x + PAD, cy); cy += 44; }
  // เบอร์โทร — บรรทัดถัดลงมาใต้ชื่อ (เจ้าของ 2026-08-16: แยกออกจากชื่อ ให้อ่านง่ายตอนโทรหาลูกค้า)
  if (slot.to.phone) {
    ctx.font = "bold 36px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
    ctx.fillText(`โทร. ${slot.to.phone}`, x + PAD, cy);
    cy += 48;
  }
  cy += 4;
  ctx.font = "30px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
  const addrLines = wrapText(ctx, slot.to.address || '— ไม่มีที่อยู่ในระบบ —', innerW);
  for (const l of addrLines.slice(0, 4)) { ctx.fillText(l, x + PAD, cy); cy += 38; }
  if (addrLines.length > 4) { ctx.fillText('…', x + PAD, cy); }

  // บรรทัดสุดท้าย: ชื่อสินค้า + ค่าย + จำนวน (วาดจากล่างขึ้น กันชนที่อยู่)
  // เจ้าของ 2026-08-16: ให้เด่นขึ้น — ตัวหนา ใหญ่ขึ้น สีเข้ม (เดิม 24px บาง สีเทา อ่านยากตอนแพ็ค)
  ctx.font = "bold 30px 'Noto Sans Thai','Sarabun',Tahoma,sans-serif";
  ctx.fillStyle = '#111';
  const LINE_H = 38;
  const MAX_PRODUCT_LINES = 3;
  const shown = slot.lines.slice(0, MAX_PRODUCT_LINES);
  const extra = slot.lines.length - shown.length;
  const texts = shown.map((l) => `• ${l.label} ×${l.qty}`);
  if (extra > 0) texts.push(`  …และอีก ${extra} รายการ`);
  let py = y + h - PAD - texts.length * LINE_H;
  // เส้นคั่นเหนือรายการสินค้า (เข้มขึ้นให้เห็นกรอบชัด)
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + PAD, py - 14); ctx.lineTo(x + w - PAD, py - 14); ctx.stroke();
  for (const tline of texts) {
    const fit = wrapText(ctx, tline, innerW)[0] ?? tline; // สินค้ายาวเกิน = ตัดบรรทัดเดียว
    ctx.fillText(fit, x + PAD, py);
    py += LINE_H;
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

  const now = Date.now();
  const today = dayKey(new Date(now).toISOString());
  const yesterday = dayKey(new Date(now - 86400000).toISOString());
  // จัดกลุ่มตามวันที่รับเรื่อง (labelSlots เรียงเก่าสุดก่อนมาแล้ว → กลุ่มเก่าอยู่บน)
  const groups: { key: string; slots: LabelSlot[] }[] = [];
  for (const s of slots) {
    const k = dayKey(s.since);
    const g = groups[groups.length - 1];
    if (g && g.key === k) g.slots.push(s); else groups.push({ key: k, slots: [s] });
  }
  const toggleGroup = (g: { slots: LabelSlot[] }) => {
    const allOn = g.slots.every((s) => !off.has(s.key));
    setOff((old) => { const n = new Set(old); for (const s of g.slots) { if (allOn) n.add(s.key); else n.delete(s.key); } return n; });
    setPages([]);
  };

  return (
    <div className="mb-[18px] rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 flex items-center gap-2 text-base font-bold text-ink">
        <Icon name="copy" size={18} className="text-[#c4b5fd]" /> <span>ใบปะหน้าพัสดุ A4 · 8 ช่อง</span>
        {/* นับเป็น "ช่อง" (ลูกค้า+ที่อยู่) ไม่เท่าจำนวนตั๋ว — บอกคู่กันกันงงกับเลขคิวเลขพัสดุ */}
        <span className="ml-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] text-ink-muted2">{tickets.length} ใบ / {slots.length} ช่อง</span>
      </div>
      <div className="mb-3 text-[11.5px] text-ink-faint">รวมพรี + In Stock รอบเดียวกัน · ลูกค้าเดียวกัน = ช่องเดียว (หลายสินค้าหลายบรรทัด) · <b className="text-ink-muted2">เรียงตามเวลารับเรื่อง เก่าสุดอยู่บน (คิว #1)</b> เลขคิวพิมพ์ลงใบด้วย · ปริ้นแล้วตัดตามเส้นประ</div>

      {slots.length === 0 ? <div className="py-2 text-[13px] text-ink-faint">ไม่มีรายการพร้อมพิมพ์ (ต้องจ่ายครบ + ยืนยันวิธีรับของแบบส่งพัสดุ)</div> : (
        <>
          <div className="mb-3 flex flex-col gap-2">
            {groups.map((g) => {
              const onCount = g.slots.filter((s) => !off.has(s.key)).length;
              return (
                <div key={g.key || 'legacy'} className="min-w-0">
                  {/* หัววัน: ติ๊ก/เอาออกทั้งวันได้ — ปริ้นเฉพาะของที่เข้ามาวันนี้ หรือเคลียร์ของค้างข้ามวันก่อน */}
                  <button type="button" onClick={() => toggleGroup(g)} className="mb-1.5 flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-[12px] font-bold text-ink-muted2 hover:bg-white/[0.04]">
                    <span className={cx('grid h-4 w-4 place-items-center rounded border text-[10px]', onCount === g.slots.length ? 'border-[#7c3aed] bg-[#7c3aed] text-white' : onCount ? 'border-[#7c3aed] text-[#c4b5fd]' : 'border-subtle text-transparent')}>{onCount === g.slots.length ? '✓' : onCount ? '–' : ''}</span>
                    📅 {dayLabel(g.key, today, yesterday)}
                    <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-ink-faint">{g.slots.length} ช่อง · เลือก {onCount}</span>
                  </button>
                  <div className="flex flex-col gap-1.5">
                    {g.slots.map((s) => {
                      const wait = s.since ? daysWaiting(s.since, now) : null;
                      return (
                        <label key={s.key} className={cx('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5', off.has(s.key) ? 'border-subtle bg-surface-3 opacity-50' : 'border-[#7c3aed]/40 bg-[#7c3aed]/[0.07]')}>
                          <input type="checkbox" checked={!off.has(s.key)} onChange={() => toggle(s.key)} className="mt-1 h-4 w-4 accent-[#7c3aed]" />
                          <span className="mt-0.5 grid h-6 min-w-[30px] shrink-0 place-items-center rounded-md bg-white/[0.08] px-1 font-mono text-[11.5px] font-bold text-ink-muted">#{s.queueNo}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="text-[13px] font-semibold">{s.to.name}</span>
                              <span className="text-[11.5px] text-ink-faint">{s.to.phone}</span>
                              {s.since
                                ? <span className="text-[11px] text-ink-faint">⏱ รับเรื่อง {fmtTime(s.since)}{s.requestedAt && s.requestedAt !== s.since ? ` · ลูกค้าขอ ${fmtTime(s.requestedAt)}` : ''}</span>
                                : <span className="text-[11px] text-ink-faint">ตั๋วเก่า ไม่มีเวลารับเรื่อง</span>}
                              {wait !== null && wait >= 1 && <span className={cx('rounded px-1.5 py-0.5 text-[10.5px] font-bold', wait >= 3 ? 'animate-blink bg-[#b91c1c]/25 text-[#f87171]' : 'bg-[#d97706]/20 text-[#fbbf24]')}>รอมา {wait} วัน</span>}
                            </div>
                            <div className="line-clamp-1 text-[11.5px] text-ink-faint">{s.to.address || '— ไม่มีที่อยู่'}</div>
                            <div className="mt-0.5 text-[11.5px] text-ink-muted2">{s.lines.map((l) => `${l.label} ×${l.qty}`).join(' · ')}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
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
