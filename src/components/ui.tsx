import type { ReactNode, ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon';
import { STATUS, RANK, type StatusKey, type RankKey } from '@/lib/theme';

/** Join class names, dropping falsy values. */
export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

/** Dark surface card. */
export function Card({ children, className, accent, onClick }: { children: ReactNode; className?: string; accent?: boolean; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cx(
        'rounded-card border bg-surface-2 p-4',
        accent ? 'border-accent-soft' : 'border-subtle',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      {children}
    </div>
  );
}

type Variant = 'primary' | 'outline' | 'success' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-cta text-white shadow-cta',
  success: 'bg-success text-white',
  outline: 'bg-transparent text-primary-soft border-[1.5px] border-accent',
  ghost: 'bg-surface-3 text-ink-muted2 border border-subtle',
};

/** Primary CTA with crimson gradient + glow. */
export function Button({
  children,
  variant = 'primary',
  icon,
  className,
  ...rest
}: { children: ReactNode; variant?: Variant; icon?: IconName } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex w-full items-center justify-center gap-2 rounded-btn px-5 py-[14px] text-[15px] font-bold',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        className,
      )}
    >
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}

/** Product / ticket status pill. */
export function StatusBadge({ status, className }: { status: StatusKey; className?: string }) {
  const s = STATUS[status];
  return (
    <span className={cx('inline-flex items-center whitespace-nowrap rounded-[7px] border px-[9px] py-[3px] text-[11px] font-semibold', s.cls, className)}>
      {s.label}
    </span>
  );
}

/** Rank tier badge with gradient bg. */
export function RankBadge({ rank, large }: { rank: RankKey; large?: boolean }) {
  const r = RANK[rank];
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 rounded-full border font-bold', r.cls, large ? 'px-3 py-1.5 text-sm' : 'px-[9px] py-[3px] text-[11px]')}
      style={{ background: r.grad }}
    >
      <span>{r.emoji}</span>
      {r.label}
    </span>
  );
}

/** Filter / category chip. */
export function Chip({ children, active, onClick }: { children: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] border px-[13px] py-[7px] text-[12.5px] font-semibold',
        active ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2',
      )}
    >
      {children}
    </button>
  );
}

/** Thin progress bar with a (dynamic) status-tinted fill. */
export function ProgressBar({ pct, fill = '#dc2626' }: { pct: number; fill?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: fill }} />
    </div>
  );
}

/** Product image — real photo when `src` is set, else striped placeholder. Keeps the ribbon. */
export function ProductThumb({ isStock, size, radius = 'rounded-xl', showRibbon = true, src }: { isStock: boolean; size?: number; radius?: string; showRibbon?: boolean; src?: string }) {
  return (
    <div
      className={cx('relative flex items-center justify-center overflow-hidden border border-subtle', src ? 'bg-surface-3' : 'bg-stripe', radius, !size && 'aspect-square w-full')}
      style={size ? { width: size, height: size } : undefined}
    >
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover" />
        : <Icon name="box" size={size ? Math.min(46, size * 0.42) : 44} strokeWidth={1.4} className="text-primary-soft/25" />}
      {showRibbon && (
        <div className={cx('absolute -left-[34px] top-3 -rotate-45 px-10 py-[3px] text-[9px] font-extrabold tracking-wide text-white', isStock ? 'bg-success' : 'bg-cta')}>
          {isStock ? 'STOCK' : 'PRE-ORDER'}
        </div>
      )}
    </div>
  );
}

/** White QR panel placeholder (checkout + ticket). */
export function QrPanel({ size = 160 }: { size?: number }) {
  return (
    <div className="grid grid-cols-7 grid-rows-7 gap-[2px] rounded-2xl bg-white p-3" style={{ width: size, height: size }}>
      {Array.from({ length: 49 }).map((_, i) => {
        const r = Math.floor(i / 7);
        const c = i % 7;
        const finder = (r < 2 && c < 2) || (r < 2 && c > 4) || (r > 4 && c < 2);
        const on = finder || (i * 7 + 3) % 5 < 2;
        return <div key={i} className="rounded-[1px]" style={{ background: on ? '#0a0809' : 'transparent' }} />;
      })}
    </div>
  );
}

/** Back-arrow header row used across customer detail screens. */
export function BackBar({ title, onBack, right }: { title: string; onBack: () => void; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 pb-3.5 pt-1">
      <button onClick={onBack} className="grid h-[38px] w-[38px] place-items-center rounded-full border border-subtle bg-surface-3 text-ink">
        <Icon name="arrowLeft" size={19} />
      </button>
      <div className="flex-1 text-[17px] font-bold">{title}</div>
      {right}
    </div>
  );
}

export { STATUS, RANK };
export type { StatusKey, RankKey };
