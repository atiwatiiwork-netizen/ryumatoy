'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { productLabel, franchiseOf } from '@/domain/services/catalog';
import { myDeals, soldOutInShop, marketPublicEnabled } from '@/domain/services/market';
import { MARKET_ERR_TH } from '@/lib/market';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { MarketCard, useMarketFeed, useNow } from './MarketUi';
import { MarketDeal } from './MarketDeal';

type Sort = 'new' | 'cheap' | 'total';
const STATUS_CHIPS: { key: string; label: string }[] = [
  { key: 'production', label: '🏭 ผลิต' },
  { key: 'shipping', label: '🚚 เดินทาง' },
  { key: 'arrived', label: '🇹🇭 ถึงไทย' },
  { key: 'soldout', label: '🔥 หมดในร้าน' },
];

/**
 * กระดานตลาดใบพรี — คอมโพเนนต์เดียวใช้ทั้ง /market (mode live) และแท็บ "👀 ดูแบบลูกค้า" ของแอดมิน (mode preview)
 * (DNA shared preview: แก้ที่นี่ที่เดียว ลูกค้ากับแอดมินเห็นเหมือนกันเสมอ)
 * preview = เปิดดีลในกรอบเดิม (ไม่เปลี่ยนหน้า) เพื่อให้แอดมินลองเล่นได้ทั้งเส้น
 */
export function MarketBoard({ mode = 'live' }: { mode?: 'live' | 'preview' }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const router = useRouter();
  const { rows, error, closed, refresh } = useMarketFeed(true, db);
  const now = useNow(1000);
  const [q, setQ] = useState('');
  const [fr, setFr] = useState<string>('');
  const [chips, setChips] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>('new');
  const [openId, setOpenId] = useState<string | null>(null);

  const deals = myDeals(db, uid);
  const todo = deals.todo.length;
  const franchises = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) {
      const p = db.products.find((x) => x.id === r.product_id);
      const f = p ? franchiseOf(db, p) : undefined;
      if (f) m.set(f.id, f.name);
    }
    return [...m.entries()];
  }, [rows, db]);

  const list = useMemo(() => {
    let out = (rows ?? []).slice();
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((r) => productLabel(db, r.product_id, r.variant_id ?? undefined).toLowerCase().includes(needle));
    if (fr) out = out.filter((r) => db.products.find((p) => p.id === r.product_id)?.franchise_id === fr);
    const st = chips.filter((c) => c !== 'soldout');
    if (st.length) out = out.filter((r) => st.includes(r.product_status));
    if (chips.includes('soldout')) out = out.filter((r) => soldOutInShop(db, r.product_id));
    if (sort === 'cheap') out.sort((a, b) => a.asking_price - b.asking_price);
    else if (sort === 'total') out.sort((a, b) => (a.asking_price + a.due) - (b.asking_price + b.due));
    // ใหม่ล่าสุด = ลำดับจาก server อยู่แล้ว · ใบที่มีคนจองอยู่ไปท้าย (ยังโชว์ ให้รู้ว่าของมี)
    out.sort((a, b) => Number(a.status === 'reserved' && !a.reserved_by_me) - Number(b.status === 'reserved' && !b.reserved_by_me));
    return out;
  }, [rows, q, fr, chips, sort, db]);

  if (openId) return <MarketDeal id={openId} mode={mode} onBack={() => { setOpenId(null); void refresh(); }} />;
  const open = (id: string) => (mode === 'preview' ? setOpenId(id) : router.push(`/market/${id}`));
  const toggle = (k: string) => setChips((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="text-[22px] font-extrabold leading-tight">ตลาดใบพรี</div>
          <div className="text-[12px] text-ink-faint">ซื้อต่อใบพรีจากสมาชิก · ร้านเป็นคนโอนสิทธิ์ให้</div>
        </div>
        {mode === 'live' ? (
          <Link href="/market/mine" className="relative flex items-center gap-1.5 rounded-xl border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-bold">
            <Icon name="swap" size={16} className="text-primary-soft" />ซื้อขายของฉัน
            {todo > 0 && <span className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary-bright px-1 text-[10px] font-bold text-white">{todo}</span>}
          </Link>
        ) : null}
      </div>

      {/* ยังไม่เปิด: ลูกค้าไม่เห็นหน้านี้เลย (แท็บซ่อน + server คืนแถวว่าง) — แอดมินเห็นป้ายนี้ตอนลองเล่น */}
      {(closed || !marketPublicEnabled(db)) && (
        <div className="rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-3.5 py-2.5 text-[12px] leading-relaxed text-[#fbbf24]">
          🔒 <b>ตลาดยังปิดอยู่</b> — ลูกค้ามองไม่เห็นหน้านี้และลงขาย/จองไม่ได้ (กันที่ฐานข้อมูล) · แอดมินลองเล่นได้ครบทุกขั้น
        </div>
      )}

      {rows?.[0]?.id.startsWith('demo-') && (
        <div className="rounded-xl border border-dashed border-white/15 px-3.5 py-2 text-center text-[11.5px] text-ink-faint">ตัวอย่างกระดาน · โหมดพรีวิวที่ไม่ได้ต่อฐานข้อมูล (เว็บจริงไม่แสดงรายการนี้)</div>
      )}

      <label className="flex items-center gap-2 rounded-xl border border-subtle bg-surface-3 px-3 py-2.5">
        <Icon name="search" size={16} className="text-ink-faint" />
        <input id="market-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาชื่อตัวละคร / สินค้า"
          className="w-full bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-faint" />
      </label>
      {franchises.length > 1 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
          <button type="button" onClick={() => setFr('')} className={cx('shrink-0 rounded-full border px-3 py-1 text-[12px] font-bold', !fr ? 'border-ink bg-ink text-[#0a0809]' : 'border-subtle bg-surface-3 text-ink-muted2')}>ทั้งหมด</button>
          {franchises.map(([id, name]) => (
            <button type="button" key={id} onClick={() => setFr(fr === id ? '' : id)} className={cx('shrink-0 rounded-full border px-3 py-1 text-[12px] font-bold', fr === id ? 'border-ink bg-ink text-[#0a0809]' : 'border-subtle bg-surface-3 text-ink-muted2')}>{name}</button>
          ))}
        </div>
      )}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
        {STATUS_CHIPS.map((c) => (
          <button type="button" key={c.key} onClick={() => toggle(c.key)} className={cx('shrink-0 rounded-full border px-3 py-1 text-[12px] font-semibold', chips.includes(c.key) ? 'border-accent bg-[#b91c1c]/15 text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2')}>{c.label}</button>
        ))}
      </div>
      <div className="flex items-center justify-between text-[12px] text-ink-faint">
        <span>{rows ? `${list.length} ประกาศ` : 'กำลังโหลด…'}</span>
        <select id="market-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-lg border border-subtle bg-surface-3 px-2 py-1 text-[12px] text-ink-muted2 outline-none">
          <option value="new">ใหม่ล่าสุด</option>
          <option value="cheap">จ่ายคนขายน้อยสุด</option>
          <option value="total">ยอดรวมน้อยสุด</option>
        </select>
      </div>

      {error && (
        <div className="rounded-xl border border-subtle bg-surface-2 p-4 text-center text-[12.5px] text-ink-muted2">
          {error === 'no_rpc' ? 'ระบบตลาดในฐานข้อมูลยังไม่ครบ — แอดมินต้องรัน migration v71/v72' : MARKET_ERR_TH[error] ?? `โหลดกระดานไม่สำเร็จ (${error})`}
          <button type="button" onClick={() => void refresh()} className="ml-2 underline">ลองใหม่</button>
        </div>
      )}
      {rows && !error && list.length === 0 && (
        <div className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center">
          <div className="text-3xl">🎟️</div>
          <div className="mt-2 text-[14px] font-bold">ยังไม่มีใบพรีลงขาย{q || fr || chips.length ? 'ที่ตรงกับตัวกรอง' : ''}</div>
          <div className="mt-1 text-[12px] text-ink-faint">มีใบพรีที่ไปต่อไม่ไหว? กดลงขายได้จากหน้าใบพรีในกระเป๋า</div>
        </div>
      )}
      <div className="flex flex-col gap-3">
        {list.map((r) => (
          <MarketCard key={r.id} db={db} row={r} hot={soldOutInShop(db, r.product_id)} now={now} onOpen={() => open(r.id)} />
        ))}
      </div>
    </div>
  );
}
