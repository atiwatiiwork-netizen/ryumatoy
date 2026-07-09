'use client';

import Link from 'next/link';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { activeCampaign, qualifyingCount, topThreshold, nextTierProgress } from '@/domain/services/campaigns';
import { baht } from '@/lib/theme';
import { Icon } from './Icon';

/** The live event, or null. Thin wrapper so callers don't import the service directly. */
export function useActiveCampaign() {
  const db = useDatabase();
  return activeCampaign(db);
}

/**
 * A customer's personal progress toward the next event reward — count so far, a bar within the
 * current loop cycle, and "อีก N ใบรับคูปอง Y". Renders nothing when there is no live event.
 * `variant`: 'card' (home/profile) or 'inline' (product page).
 */
export function EventProgress({ variant = 'card' }: { variant?: 'card' | 'inline' }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const c = activeCampaign(db);
  if (!c || !uid) return null;

  const count = qualifyingCount(db, c, uid);
  const top = topThreshold(c);
  const next = nextTierProgress(db, c, uid);
  const segStart = top > 0 ? Math.floor(count / top) * top : 0;
  const pct = next ? Math.min(100, Math.max(4, ((count - segStart) / (next.nextRequired - segStart)) * 100)) : 100;

  const line = next
    ? <>พรีอีก <b className="text-primary-soft">{next.need}</b> รายการ รับคูปอง <b className="text-primary-soft">{baht(next.value)}</b></>
    : <>เก็บครบทุกชั้นแล้ว 🎉</>;

  if (variant === 'inline') {
    return (
      <Link href={`/events/${c.id}`} className="mt-2 block rounded-xl border border-[#b91c1c]/40 bg-[#b91c1c]/[0.08] px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12.5px] font-bold text-primary-soft">
          <Icon name="tag" size={14} /> {c.name}
        </div>
        <div className="mt-1 text-[12px] text-ink-muted2">{line}</div>
        <Bar pct={pct} />
      </Link>
    );
  }

  return (
    <Link href={`/events/${c.id}`} className="block rounded-2xl border border-[#b91c1c]/40 bg-gradient-to-br from-[#b91c1c]/[0.14] to-transparent p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13.5px] font-extrabold text-ink"><Icon name="tag" size={16} className="text-primary-soft" /> {c.name}</div>
        <Icon name="chevronRight" size={16} className="text-ink-faint" />
      </div>
      <div className="mt-1.5 text-[12.5px] text-ink-muted2">พรีแล้ว <b className="text-ink">{count}</b> รายการ · {line}</div>
      <Bar pct={pct} />
    </Link>
  );
}

/** Home hero for the live event: full-width banner (→ detail page) + the customer's progress card.
 *  Renders nothing when there is no live event. */
export function EventBanner() {
  const db = useDatabase();
  const c = activeCampaign(db);
  if (!c) return null;
  return (
    <div className="mb-4 flex flex-col gap-3 lg:mb-7">
      {c.banner_url && (
        <Link href={`/events/${c.id}`} className="block overflow-hidden rounded-2xl border border-[#b91c1c]/40">
          <img src={c.banner_url} alt={c.name} className="block h-auto w-full" />
        </Link>
      )}
      <EventProgress variant="card" />
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.08]">
      <div className="h-full rounded-full bg-primary-bright transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}
