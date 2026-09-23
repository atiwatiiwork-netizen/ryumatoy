'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Database } from '@/domain/entities';
import { productLabel, lineImage, franchiseOf } from '@/domain/services/catalog';
import { STATUS, baht } from '@/lib/theme';
import { promptPayPayload, formatPromptPay } from '@/lib/promptpay';
import { copyText, digitsOnly } from '@/lib/clipboard';
import { marketFeed, type MarketRow } from '@/lib/market';
import { cx } from '@/components/ui';

/**
 * ชิ้นส่วนหน้าจอตลาดใบพรี — ใช้ร่วมทั้งหน้าลูกค้าและแท็บ "ดูแบบลูกค้า" ของแอดมิน (DNA shared preview)
 * เอฟเฟกต์ตามต้นแบบที่เจ้าของเห็น: การ์ดทรงตั๋วฉีก · โฮโลเฉพาะของที่หมดในร้าน · ปัดเพื่อจอง · กดค้างเพื่อยืนยัน
 * ทุกแอนิเมชันปิดเองเมื่อเครื่องตั้ง "ลดการเคลื่อนไหว" (motion-reduce)
 */

/** ตัวอย่างกระดานสำหรับ "โหมดพรีวิวไม่มีฐานข้อมูล" (npm run dev:seed) เท่านั้น — เว็บจริงไม่เคยเข้าทางนี้
 *  (RPC คืน no_server เฉพาะตอนไม่ได้ตั้งค่า Supabase) · id ขึ้นต้น demo- กันสับสนกับดีลจริง */
export function demoMarketRows(db: Database): MarketRow[] {
  const lots = ['production', 'shipping', 'arrived', 'production'];
  return db.tickets.filter((t) => db.products.some((p) => p.id === t.product_id)).slice(0, 4).map((t, i) => {
    const due = Math.max(0, t.remaining_amount - t.remaining_paid);
    const paid = t.deposit_paid + t.remaining_paid;
    return {
      id: `demo-${t.id}`, product_id: t.product_id, variant_id: t.variant_id ?? null, batch_id: t.batch_id ?? null,
      product_status: lots[i], warehouse_at: null, qty: t.qty, ticket_qty: t.qty,
      asking_price: Math.round((paid + 350) / 10) * 10, paid, due, total: t.deposit_paid + t.remaining_amount,
      listed_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(), expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      status: i === 1 ? 'reserved' : 'listed', hold_until: i === 1 ? new Date(Date.now() + 11 * 60_000).toISOString() : null,
      reserved_by_me: false, mine: false, seller: `R•••${12 + i * 11}`, seller_rank: i % 2 ? 'silver' : 'gold', seller_sold: Math.max(0, 4 - i),
      ticket_hint: `${t.ticket_no.split('-').slice(0, 3).join('-')}-••••`,
    };
  });
}

// ── ข้อมูลกระดาน (poll ทุก 15 วิ ตอนหน้าเปิดอยู่ · เวลาอิง server กันนาฬิกาเครื่องเพี้ยน) ─────
export function useMarketFeed(enabled = true, demoDb?: Database) {
  const [rows, setRows] = useState<MarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const skew = useRef(0);
  const demo = useRef(demoDb);
  demo.current = demoDb;
  const refresh = useCallback(async () => {
    const r = await marketFeed();
    if (r.ok) {
      setRows(r.rows ?? []); setError(null); setClosed(!!r.closed);
      if (r.server_now) skew.current = new Date(r.server_now).getTime() - Date.now();
    } else if (r.error === 'no_server' && demo.current) { setRows(demoMarketRows(demo.current)); setError(null); setClosed(true); }
    else setError(r.error ?? 'error');
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15_000);
    return () => clearInterval(t);
  }, [enabled, refresh]);
  return { rows, error, closed, refresh, serverNow: () => Date.now() + skew.current };
}

/** นาฬิกาที่เดินเอง (สำหรับนับถอยหลัง) */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
export const mmss = (msLeft: number) => {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ── รูป/ป้าย ──────────────────────────────────────────────────────────────────
const GRADS = ['from-[#6d28d9] to-[#14532d]', 'from-[#991b1b] to-[#111]', 'from-[#1d4ed8] to-[#b45309]', 'from-[#dc2626] to-[#f59e0b]', 'from-[#0f766e] to-[#1e1b4b]'];
export function StubArt({ db, productId, variantId, className }: { db: Database; productId: string; variantId?: string | null; className?: string }) {
  const img = lineImage(db, productId, variantId ?? undefined);
  const name = productLabel(db, productId, variantId ?? undefined);
  const g = GRADS[(name.charCodeAt(0) || 0) % GRADS.length];
  return img
    ? <img src={img} alt="" className={cx('h-full w-full object-cover', className)} loading="lazy" />
    : <div className={cx('grid h-full w-full place-items-center bg-gradient-to-br text-[26px] font-extrabold text-white/90', g, className)}>{name.charAt(0)}</div>;
}

export function LotPill({ status }: { status?: string | null }) {
  const s = STATUS[(status ?? 'production') as keyof typeof STATUS] ?? STATUS.production;
  const short: Record<string, string> = { production: 'ผลิต', shipping: 'เดินทาง', arrived: 'ถึงไทยแล้ว', open: 'เปิดจอง', delivered: 'ส่งมอบแล้ว' };
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[10.5px] font-bold', s.cls)}>
      <i className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-breath" />{short[status ?? ''] ?? s.label}
    </span>
  );
}

export const productSub = (db: Database, productId: string) => {
  const p = db.products.find((x) => x.id === productId);
  const f = p ? franchiseOf(db, p)?.name : undefined;
  return [f, p?.wcf_type === 'mega_wcf' ? 'Mega WCF' : p?.wcf_type === 'wcf' ? 'WCF' : undefined].filter(Boolean).join(' · ');
};

// ── การ์ดทรงตั๋วฉีกบนกระดาน ────────────────────────────────────────────────────
export function MarketCard({ db, row, hot, onOpen, now }: { db: Database; row: MarketRow; hot: boolean; onOpen: () => void; now: number }) {
  const reserved = row.status === 'reserved' && !row.reserved_by_me;
  const left = row.hold_until ? new Date(row.hold_until).getTime() - now : 0;
  return (
    <button type="button" onClick={onOpen}
      className={cx('group relative grid w-full grid-cols-[84px_1fr] rounded-2xl border bg-surface-3 text-left transition-transform active:scale-[.985]',
        hot ? 'border-[#f1d27a]/45 shadow-[0_10px_30px_-18px_rgba(241,210,122,.6)]' : 'border-subtle')}>
      {/* รอยปรุ + รูเจาะบน/ล่าง = ตั๋ว */}
      <i className="absolute left-[75px] top-[-9px] z-[3] h-[18px] w-[18px] rounded-full border-b border-subtle bg-base" />
      <i className="absolute bottom-[-9px] left-[75px] z-[3] h-[18px] w-[18px] rounded-full border-t border-subtle bg-base" />
      {hot && (
        <>
          <span aria-hidden className="pointer-events-none absolute inset-0 z-[1] rounded-2xl bg-[linear-gradient(115deg,#ff8f8f,#ffd479,#8ff0b4,#86c8ff,#cdb0ff,#ff8f8f)] bg-[length:260%_260%] opacity-[.14] mix-blend-color-dodge motion-safe:animate-holoMove" />
          <span aria-hidden className="pointer-events-none absolute inset-0 z-[2] overflow-hidden rounded-2xl">
            <span className="absolute inset-y-0 w-[38%] bg-gradient-to-r from-transparent via-white/15 to-transparent motion-safe:animate-shineX" />
          </span>
        </>
      )}
      <div className="relative overflow-hidden rounded-l-2xl after:absolute after:bottom-3 after:right-0 after:top-3 after:border-r-2 after:border-dashed after:border-base/90">
        <StubArt db={db} productId={row.product_id} variantId={row.variant_id} />
      </div>
      <div className={cx('min-w-0 px-3.5 py-2.5', reserved && 'opacity-60')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <LotPill status={row.product_status} />
          {hot && <span className="rounded-md border border-[#f0a8a8]/40 px-1.5 text-[10px] font-bold text-primary-soft">หมดในร้าน</span>}
          {row.qty < row.ticket_qty && <span className="rounded-md border border-subtle px-1.5 text-[10px] font-bold text-ink-muted2">แบ่งขาย {row.qty} ชิ้น</span>}
          {row.mine && <span className="rounded-md bg-white/10 px-1.5 text-[10px] font-bold text-ink-muted2">ของฉัน</span>}
        </div>
        <div className="mt-1 truncate text-[14px] font-bold">{productLabel(db, row.product_id, row.variant_id ?? undefined)}</div>
        <div className="truncate text-[11px] text-ink-faint">{productSub(db, row.product_id)}</div>
        <div className="mt-1.5 flex gap-4">
          <div><div className="text-[10px] text-ink-faint">จ่ายคนขาย</div><div className="font-mono text-[15px] font-bold tabular-nums">{baht(row.asking_price)}</div></div>
          <div><div className="text-[10px] text-ink-faint">ค้างร้าน</div><div className="font-mono text-[13px] font-semibold tabular-nums text-ink-muted2">{baht(row.due)}</div></div>
        </div>
        {reserved ? (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-[#fbbf24]/35 bg-[#fbbf24]/10 px-2 py-1 text-[11px] text-[#fbbf24]">
            <HoldRing msLeft={left} total={15 * 60_000} size={20} stroke={3} />มีคนกำลังจอง <b className="font-mono">{mmss(left)}</b>
          </div>
        ) : (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-ink-faint">
            <span>{row.seller}</span><span className="rounded bg-white/[0.06] px-1 font-mono text-[9.5px] uppercase">{row.seller_rank}</span>
            <span>{row.seller_sold > 0 ? `ขายแล้ว ${row.seller_sold}` : 'ขายครั้งแรก'}</span>
          </div>
        )}
      </div>
    </button>
  );
}

// ── แยกเงิน 2 ก้อน (ข้อบังคับของตลาด: ผู้ซื้อต้องเห็นเสมอ) ─────────────────────────
export function MoneySplit({ price, due, total, shopPrice }: { price: number; due: number; total?: number; shopPrice?: number }) {
  const all = price + due;
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-3.5">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
        <i className="block h-full origin-left bg-gradient-to-r from-[#dc2626] to-[#f0a8a8] motion-safe:animate-riseIn" style={{ flex: Math.max(price, 1) }} />
        <i className="block h-full bg-[#2563eb]" style={{ flex: Math.max(due, 1) }} />
      </div>
      <div className="mt-2.5 flex justify-between text-[12.5px]"><span className="flex items-center gap-1.5 text-ink-muted2"><i className="h-2 w-2 rounded-full bg-[#f0a8a8]" />จ่ายคนขาย · ตอนนี้</span><b className="font-mono tabular-nums">{baht(price)}</b></div>
      <div className="mt-1.5 flex justify-between text-[12.5px]"><span className="flex items-center gap-1.5 text-ink-muted2"><i className="h-2 w-2 rounded-full bg-[#2563eb]" />จ่ายร้าน · ตอนของถึงไทย</span><b className="font-mono tabular-nums">{due > 0 ? baht(due) : 'จ่ายครบแล้ว'}</b></div>
      <div className="mt-2 flex justify-between border-t border-dashed border-white/10 pt-2 text-[13px]"><span>รวมทั้งหมด</span><b className="font-mono text-[15px] tabular-nums">{baht(all)}</b></div>
      {shopPrice != null && total != null && shopPrice > 0 && (
        <div className="mt-1.5 text-[11.5px] text-ink-faint">
          ราคาร้าน {baht(shopPrice)} — ใบนี้{all > shopPrice ? <> แพงกว่าร้าน <b className="font-mono text-primary-soft">+{baht(all - shopPrice)}</b></> : all < shopPrice ? <> ถูกกว่าร้าน <b className="font-mono text-[#4ade80]">−{baht(shopPrice - all)}</b></> : ' เท่าราคาร้าน'}
        </div>
      )}
    </div>
  );
}

// ── วงนับถอยหลัง ─────────────────────────────────────────────────────────────
export function HoldRing({ msLeft, total, size = 56, stroke = 5, children }: { msLeft: number; total: number; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, msLeft / total));
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(251,191,36,.2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#fbbf24" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ transition: 'stroke-dashoffset 1s linear' }} />
      </svg>
      {children && <span className="absolute inset-0 grid place-items-center font-mono text-[12px] font-bold">{children}</span>}
    </span>
  );
}

// ── ปัดเพื่อยืนยัน (กันกดพลาดตอนเลื่อนจอ) ───────────────────────────────────────
export function SlideToConfirm({ label, doneLabel, disabled, onConfirm }: { label: string; doneLabel: string; disabled?: boolean; onConfirm: () => void | Promise<void> }) {
  const track = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [drag, setDrag] = useState<{ start: number; moved: number } | null>(null);
  const [done, setDone] = useState(false);
  const max = () => Math.max(0, (track.current?.clientWidth ?? 0) - 54);
  const finish = async () => {
    if (done || disabled) return;
    setX(max()); setDone(true);
    try { await onConfirm(); } finally { setTimeout(() => { setDone(false); setX(0); }, 900); }
  };
  return (
    <div ref={track} role="button" tabIndex={0} aria-label={label} aria-disabled={disabled}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void finish(); } }}
      onClick={(e) => { if ((e.target as HTMLElement).dataset.knob || drag) return; void finish(); }}
      className={cx('relative h-[54px] select-none overflow-hidden rounded-full border bg-gradient-to-b from-[#1f1715] to-[#150f0e] touch-none',
        done ? 'border-[#16a34a]' : 'border-accent', disabled && 'pointer-events-none opacity-50')}>
      <div className={cx('absolute inset-y-0 left-0 rounded-full', done ? 'bg-gradient-to-r from-[#15803d] to-[#16a34a]' : 'bg-gradient-to-r from-[#b91c1c] to-[#dc2626]')}
        style={{ width: x + 54, transition: drag ? 'none' : 'width .25s' }} />
      <div className="absolute inset-0 grid place-items-center pl-11 text-[13.5px] font-bold text-white/90">{done ? doneLabel : label}</div>
      <div data-knob="1"
        onPointerDown={(e) => { if (done || disabled) return; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setDrag({ start: e.clientX - x, moved: 0 }); }}
        onPointerMove={(e) => { if (!drag) return; const nx = Math.max(0, Math.min(max(), e.clientX - drag.start)); setDrag({ ...drag, moved: Math.max(drag.moved, Math.abs(nx - x)) }); setX(nx); }}
        onPointerUp={() => { if (!drag) return; const tap = drag.moved < 4; setDrag(null); if (x > max() * 0.82 || tap) void finish(); else setX(0); }}
        onPointerCancel={() => { setDrag(null); setX(0); }}
        className="absolute left-1 top-1 z-[2] grid h-[46px] w-[46px] cursor-grab place-items-center rounded-full bg-white text-[20px] font-extrabold text-primary shadow-[0_6px_18px_-4px_rgba(220,38,38,.85)]"
        style={{ transform: `translateX(${x}px)`, transition: drag ? 'none' : 'transform .25s' }}>
        {done ? '✓' : '›'}
      </div>
    </div>
  );
}

// ── กดค้างเพื่อยืนยัน (แอดมินไฟนอล) ─────────────────────────────────────────────
export function HoldButton({ label, busyLabel, doneLabel, ms = 1200, disabled, onConfirm }: { label: string; busyLabel: string; doneLabel?: string; ms?: number; disabled?: boolean; onConfirm: () => void | Promise<void> }) {
  const [p, setP] = useState(0);
  const [state, setState] = useState<'idle' | 'holding' | 'busy' | 'done'>('idle');
  const raf = useRef(0), t0 = useRef(0);
  const stop = () => { cancelAnimationFrame(raf.current); if (state === 'holding') { setState('idle'); setP(0); } };
  const tick = (t: number) => {
    const k = Math.min(1, (t - t0.current) / ms);
    setP(k);
    if (k >= 1) { setState('busy'); void Promise.resolve(onConfirm()).finally(() => { setState(doneLabel ? 'done' : 'idle'); setP(doneLabel ? 1 : 0); }); return; }
    raf.current = requestAnimationFrame(tick);
  };
  const start = () => { if (disabled || state !== 'idle') return; setState('holding'); t0.current = performance.now(); raf.current = requestAnimationFrame(tick); };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return (
    <button type="button" disabled={disabled || state === 'busy'}
      onPointerDown={(e) => { e.preventDefault(); start(); }} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(); } }}
      onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') stop(); }}
      onContextMenu={(e) => e.preventDefault()}
      className={cx('relative h-[50px] w-full select-none overflow-hidden rounded-xl border font-bold text-white disabled:opacity-60 touch-none',
        state === 'done' ? 'border-[#16a34a]' : 'border-accent bg-surface-4')}>
      <span className={cx('absolute inset-y-0 left-0', state === 'done' ? 'bg-gradient-to-r from-[#15803d] to-[#16a34a]' : 'bg-gradient-to-r from-[#b91c1c] to-[#dc2626]')} style={{ width: `${p * 100}%` }} />
      <span className="relative">{state === 'busy' ? busyLabel : state === 'done' ? doneLabel : state === 'holding' ? 'ค้างไว้…' : label}</span>
    </button>
  );
}

// ── QR พร้อมเพย์ของคนขาย (ใส่ยอดให้แล้ว) ──────────────────────────────────────────
export function PromptPayCard({ amount, promptpay, accountNo, bank, accountName, flash }: {
  amount: number; promptpay?: string | null; accountNo?: string | null; bank?: string | null; accountName?: string | null; flash: (m: string) => void;
}) {
  const payload = promptpay ? promptPayPayload(promptpay, amount) : null;
  const copy = async (v: string, what: string) => flash((await copyText(digitsOnly(v))) ? `คัดลอก${what}แล้ว ✓` : 'คัดลอกไม่สำเร็จ');
  return (
    <div className="overflow-hidden rounded-2xl bg-white text-center text-[#141414]">
      <div className="bg-[#162b4d] py-2 text-[12px] font-bold tracking-wide text-white">{payload ? 'พร้อมเพย์ · สแกนจ่าย' : 'โอนเข้าบัญชีคนขาย'}</div>
      {payload && <div className="flex justify-center pt-3"><QRCodeSVG value={payload} size={168} level="M" marginSize={1} /></div>}
      <div className="pt-2 font-mono text-[22px] font-bold">{baht(amount)}.00</div>
      <div className="mt-0.5 px-3 text-[12px] text-[#555]">{accountName}</div>
      <div className="flex flex-wrap justify-center gap-1.5 px-3 pb-3 pt-2">
        {promptpay && <button type="button" onClick={() => copy(promptpay, 'เบอร์พร้อมเพย์')} className="rounded-lg border border-[#c9d3e3] px-2.5 py-1 text-[11.5px] font-bold text-[#162b4d]">พร้อมเพย์ {formatPromptPay(promptpay)} · คัดลอก</button>}
        {accountNo && <button type="button" onClick={() => copy(accountNo, 'เลขบัญชี')} className="rounded-lg border border-[#c9d3e3] px-2.5 py-1 text-[11.5px] font-bold text-[#162b4d]">{bank ? `${bank} ` : ''}{accountNo} · คัดลอก</button>}
      </div>
      {payload && <div className="pb-2.5 text-[10px] text-[#888]">ยอดถูกใส่ใน QR ให้แล้ว · เช็คชื่อบัญชีให้ตรงก่อนกดโอน</div>}
    </div>
  );
}

// ── ขั้นของดีล (ผู้ซื้อเห็น) ──────────────────────────────────────────────────────
export function DealSteps({ at }: { at: 0 | 1 | 2 | 3 | 4 }) {
  const steps = ['จอง', 'โอน + สลิป', 'คนขายเช็ค', 'ร้านโอนสิทธิ์'];
  return (
    <div className="relative flex justify-between px-1">
      <div className="absolute left-4 right-4 top-[10px] h-0.5 bg-white/10" />
      {steps.map((s, i) => {
        const done = i < at, cur = i === at;
        return (
          <div key={s} className="relative z-[1] flex flex-1 flex-col items-center gap-1 text-center">
            <span className={cx('grid h-[22px] w-[22px] place-items-center rounded-full border-2 text-[10px] font-bold text-white',
              done ? 'border-[#16a34a] bg-[#16a34a]' : cur ? 'border-[#dc2626] bg-[#dc2626] motion-safe:animate-pulseRed' : 'border-white/15 bg-surface-4')}>{done ? '✓' : i + 1}</span>
            <span className={cx('text-[10px]', cur ? 'font-bold text-ink' : 'text-ink-faint')}>{s}</span>
          </div>
        );
      })}
    </div>
  );
}
