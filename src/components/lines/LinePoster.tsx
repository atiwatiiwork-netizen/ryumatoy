'use client';

import { useEffect, useRef, useState } from 'react';
import { layoutPins, pinLabelWidth, PIN_EDGE_INSET, type LineTone, type PinPlacement } from '@/domain/services/lines';
import { cx } from '@/components/ui';
import { TONE_HEX } from './lineUi';

/**
 * รูปหมู่ของไลน์ + ป้ายสถานะวางทับหัวตัวละคร — ใช้ร่วมกันทั้งหน้าลูกค้า (LineView) และหน้าแอดมินวางป้าย
 *
 * ⚠ พิกัดป้ายเก็บเป็น % ของ "ตัวรูป" → รูปต้องโชว์สัดส่วนจริงเสมอ (w-full h-auto) ห้าม object-cover/ล็อกความสูง
 *   ไม่งั้นป้ายทุกอันเลื่อนออกจากหัวตัวละคร · ตำแหน่งที่แตะคิดจาก getBoundingClientRect ของ <img> เอง
 * ดีไซน์ป้าย v2.1 (เจ้าของ 2026-10-07): กระจกเข้มโปร่ง + ขอบสีบาง + วงเลขสี + เส้นชี้ลงจุดขาวที่หัว — สีอยู่แค่วงเลข/ขอบ
 */
export interface PosterPin { id: string; no: number; x: number; y: number; tone: LineTone; text: string }

export function LinePoster({
  src, pins, onPinTap, onPick, pending, editing, highlightId, numbersOnly,
}: {
  src: string;
  pins: PosterPin[];
  onPinTap?: (id: string) => void;
  /** โหมดวางป้าย: แตะรูป → พิกัด % (0–100) */
  onPick?: (x: number, y: number) => void;
  pending?: { x: number; y: number } | null;
  /** โหมดแก้ไข: ป้ายไม่รับการแตะ (แตะทะลุไปที่รูปเพื่อวางใหม่ได้) */
  editing?: boolean;
  highlightId?: string | null;
  /** โชว์แค่วงเลขเสมอ (หน้าแอดมินวางป้าย — ชื่อเต็มยาว ซ้อนกันเละ · ชื่ออยู่ในรายการข้างๆ อยู่แล้ว) */
  numbersOnly?: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // ขนาดจริงบนจอ → ป้ายใกล้ขอบบนของรูปเตี้ยๆ กลับหัวลงล่าง · ป้ายชื่อยาวที่อยู่ใกล้กันสลับเส้นสั้น/ยาวตามพิกเซลจริง
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [src]);

  const placed = layoutPins(pins.map((p) => ({ id: p.id, x: p.x, y: p.y, w: pinLabelWidth(p.text) })), size.h || undefined, size.w || undefined)
    .map((pl) => (numbersOnly ? { ...pl, compact: true } : pl));
  const byId = new Map(pins.map((p) => [p.id, p]));
  const pick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!onPick) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    onPick(Math.min(100, Math.max(0, x)), Math.min(100, Math.max(0, y)));
  };

  return (
    <div className="relative select-none overflow-hidden rounded-card border border-subtle bg-black">
      <img
        ref={imgRef}
        src={src}
        alt=""
        draggable={false}
        onLoad={() => { const el = imgRef.current; if (el) setSize({ w: el.clientWidth, h: el.clientHeight }); }}
        onClick={onPick ? pick : undefined}
        className={cx('block h-auto w-full', onPick && 'cursor-crosshair')}
      />
      {/* เงาบางๆ ด้านบนให้ป้ายอ่านง่าย — pointer-events-none ไม่งั้นบังการแตะรูปตอนวางป้าย */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-transparent" />
      {placed.map((pl) => {
        const p = byId.get(pl.id);
        return p ? <Pin key={pl.id} p={p} pl={pl} onTap={onPinTap} editing={editing} hi={highlightId === pl.id} /> : null;
      })}
      {pending && (
        <div className="pointer-events-none absolute h-0 w-0" style={{ left: `${pending.x}%`, top: `${pending.y}%` }}>
          <span className="absolute h-12 w-px -translate-x-1/2 -translate-y-1/2 bg-white/90" />
          <span className="absolute h-px w-12 -translate-x-1/2 -translate-y-1/2 bg-white/90" />
          <span className="absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full border-2 border-white" style={{ boxShadow: '0 0 0 2px rgba(0,0,0,.5)' }} />
        </div>
      )}
    </div>
  );
}

function Pin({ p, pl, onTap, editing, hi }: { p: PosterPin; pl: PinPlacement; onTap?: (id: string) => void; editing?: boolean; hi?: boolean }) {
  const color = TONE_HEX[p.tone];
  const tap = onTap && !editing ? () => onTap(p.id) : undefined;
  if (pl.compact) {
    // ป้ายเยอะเกินจะซ้อนกัน → วงเลขอย่างเดียว ชื่อ+สถานะอยู่ในรายการใต้รูป
    return (
      <div className="absolute h-0 w-0" style={{ left: `${pl.x}%`, top: `${pl.y}%` }}>
        <button
          type="button"
          onClick={tap}
          aria-label={`${p.no} ${p.text}`}
          className={cx('absolute grid h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 text-[11px] font-extrabold', editing && 'pointer-events-none', hi && 'ring-2 ring-white')}
          style={{ background: 'rgba(10,10,14,.85)', borderColor: color, color }}
        >
          {p.no}
        </button>
      </div>
    );
  }
  const shift = pl.align === 'center' ? '-50%' : pl.align === 'left' ? `-${PIN_EDGE_INSET}px` : `calc(-100% + ${PIN_EDGE_INSET}px)`;
  return (
    <div className="absolute h-0 w-0" style={{ left: `${pl.x}%`, top: `${pl.y}%` }}>
      {/* จุดกับเส้นไม่รับการแตะเลย — ตอนวางป้าย แตะซ้ำตรงหัวที่มีป้ายแล้วต้องทะลุถึงรูป (review 2026-10-07) */}
      <span className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" style={{ boxShadow: '0 0 0 3px rgba(255,255,255,.25)' }} />
      <span className="pointer-events-none absolute w-px -translate-x-1/2 bg-white/70" style={pl.below ? { top: 3, height: pl.stem } : { bottom: 3, height: pl.stem }} />
      <button
        type="button"
        onClick={tap}
        className={cx(
          'absolute left-0 flex items-center gap-1.5 whitespace-nowrap rounded-full border py-[3px] pl-1 pr-2.5 text-[11px] font-semibold text-white backdrop-blur-md',
          editing && 'pointer-events-none',
          hi && 'ring-2 ring-white',
        )}
        style={{
          ...(pl.below ? { top: pl.stem + 4 } : { bottom: pl.stem + 4 }),
          transform: `translateX(${shift})`,
          background: 'rgba(10,10,14,.80)',
          borderColor: `${color}8c`,
          boxShadow: '0 4px 14px rgba(0,0,0,.55)',
        }}
      >
        <span className="grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full text-[10.5px] font-extrabold text-[#0b0b0e]" style={{ background: color }}>{p.no}</span>
        {p.text}
      </button>
    </div>
  );
}
