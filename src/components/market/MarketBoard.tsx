'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDatabase } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { productLabel } from '@/domain/services/catalog';
import { myDeals, soldOutInShop, marketPublicEnabled } from '@/domain/services/market';
import { MARKET_ERR_TH, type MarketRow } from '@/lib/market';
import type { Database, PreorderTicket } from '@/domain/entities';
import { Chip } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { MarketCard, useMarketFeed, useNow } from './MarketUi';
import { MarketDeal } from './MarketDeal';
import { TicketPicker } from './TicketPicker';
import { SellSheet } from './SellSheet';

type Sort = 'new' | 'cheap' | 'total';
const NO_MAKER = '_other';

/** ค่าย/เรื่องของประกาศ — จากสินค้า (ค่าย = manufacturer_id · ไม่มี = "อื่นๆ") */
function rowMeta(db: Database, r: MarketRow) {
  const p = db.products.find((x) => x.id === r.product_id);
  return { maker: p?.manufacturer_id || NO_MAKER, franchise: p?.franchise_id || '' };
}

/**
 * กระดานตลาดใบพรี — คอมโพเนนต์เดียวใช้ทั้ง /market (mode live) และกรอบพรีวิว/ทดลองเล่นของแอดมิน (mode preview)
 * (DNA shared preview: แก้ที่นี่ที่เดียว ลูกค้ากับแอดมินเห็นเหมือนกันเสมอ)
 * preview = เปิดดีลในกรอบเดิม (ไม่เปลี่ยนหน้า) เพื่อให้แอดมินลองเล่นได้ทั้งเส้น
 * ตัวกรองหลัก = ค่าย (เจ้าของ 2026-09-24: "Filter สถานะไม่ตอบโจทย์ เน้นเป็นค่ายแทน") · เลือกค่ายแล้วถ้ามีหลายเรื่องค่อยโผล่แถวเรื่อง
 */
export function MarketBoard({ mode = 'live' }: { mode?: 'live' | 'preview' }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const router = useRouter();
  const { rows, error, closed, refresh } = useMarketFeed(true, db);
  const now = useNow(1000);
  const [q, setQ] = useState('');
  const [maker, setMaker] = useState<string>('');
  const [fr, setFr] = useState<string>('');
  const [sort, setSort] = useState<Sort>('new');
  const [openId, setOpenId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [selling, setSelling] = useState<PreorderTicket | null>(null);

  const deals = myDeals(db, uid);
  const todo = deals.todo.length;

  // ชิปค่าย: เฉพาะค่ายที่มีประกาศจริง เรียงตามจำนวนประกาศ (มากไปน้อย) · "อื่นๆ" ไว้ท้าย
  const makers = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) { const k = rowMeta(db, r).maker; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()]
      .map(([id, n]) => {
        const mk = db.manufacturers.find((x) => x.id === id);
        return { id, n, name: mk?.name ?? 'อื่นๆ', logo: mk?.logo_url };
      })
      .sort((a, b) => Number(a.id === NO_MAKER) - Number(b.id === NO_MAKER) || b.n - a.n || a.name.localeCompare(b.name));
  }, [rows, db]);
  // แถวเรื่อง: โผล่หลังเลือกค่าย และค่ายนั้นมีมากกว่า 1 เรื่อง
  const franchises = useMemo(() => {
    if (!maker) return [];
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      const meta = rowMeta(db, r);
      if (meta.maker === maker && meta.franchise) m.set(meta.franchise, (m.get(meta.franchise) ?? 0) + 1);
    }
    return [...m.entries()].map(([id, n]) => ({ id, n, name: db.franchises.find((f) => f.id === id)?.name ?? id }));
  }, [rows, db, maker]);

  const list = useMemo(() => {
    let out = (rows ?? []).slice();
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((r) => productLabel(db, r.product_id, r.variant_id ?? undefined).toLowerCase().includes(needle));
    if (maker) out = out.filter((r) => rowMeta(db, r).maker === maker);
    if (fr) out = out.filter((r) => rowMeta(db, r).franchise === fr);
    if (sort === 'cheap') out.sort((a, b) => a.asking_price - b.asking_price);
    else if (sort === 'total') out.sort((a, b) => (a.asking_price + a.due) - (b.asking_price + b.due));
    // ใหม่ล่าสุด = ลำดับจาก server อยู่แล้ว · ใบที่มีคนจองอยู่ไปท้าย (ยังโชว์ ให้รู้ว่าของมี)
    out.sort((a, b) => Number(a.status === 'reserved' && !a.reserved_by_me) - Number(b.status === 'reserved' && !b.reserved_by_me));
    return out;
  }, [rows, q, maker, fr, sort, db]);

  if (openId) return <MarketDeal id={openId} mode={mode} onBack={() => { setOpenId(null); void refresh(); }} />;
  const open = (id: string) => (mode === 'preview' ? setOpenId(id) : router.push(`/market/${id}`));
  const pickMaker = (id: string) => { setMaker(maker === id ? '' : id); setFr(''); };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[22px] font-extrabold leading-tight">ตลาดใบพรี</div>
          <div className="text-[12px] text-ink-faint">ซื้อต่อใบพรีจากสมาชิก · ร้านเป็นคนโอนสิทธิ์ให้</div>
        </div>
        {mode === 'live' && (
          <Link href="/market/mine" aria-label="ซื้อขายของฉัน" className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-subtle bg-surface-3">
            <Icon name="swap" size={18} className="text-primary-soft" />
            {todo > 0 && <span className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary-bright px-1 text-[10px] font-bold text-white">{todo}</span>}
          </Link>
        )}
        <button type="button" onClick={() => setPicking(true)}
          className="flex h-10 shrink-0 items-center gap-1 rounded-xl bg-cta px-3 text-[13px] font-bold text-white shadow-cta">
          <Icon name="plus" size={15} />ลงขายใบพรี
        </button>
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
      {makers.length > 0 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 no-scrollbar">
          <Chip active={!maker} onClick={() => pickMaker('')}>ทุกค่าย <span className="font-mono text-[11px] opacity-70">{rows?.length ?? 0}</span></Chip>
          {makers.map((m) => (
            <Chip key={m.id} active={maker === m.id} onClick={() => pickMaker(m.id)}>
              {m.logo && <img src={m.logo} alt="" className="h-4 w-4 rounded-sm bg-white object-contain" />}
              {m.name} <span className="font-mono text-[11px] opacity-70">{m.n}</span>
            </Chip>
          ))}
        </div>
      )}
      {franchises.length > 1 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 no-scrollbar">
          <button type="button" onClick={() => setFr('')} className={`shrink-0 rounded-full border px-3 py-1 text-[12px] font-bold ${!fr ? 'border-ink bg-ink text-[#0a0809]' : 'border-subtle bg-surface-3 text-ink-muted2'}`}>ทุกเรื่อง</button>
          {franchises.map((f) => (
            <button type="button" key={f.id} onClick={() => setFr(fr === f.id ? '' : f.id)} className={`shrink-0 rounded-full border px-3 py-1 text-[12px] font-bold ${fr === f.id ? 'border-ink bg-ink text-[#0a0809]' : 'border-subtle bg-surface-3 text-ink-muted2'}`}>{f.name} <span className="font-mono text-[10.5px] opacity-70">{f.n}</span></button>
          ))}
        </div>
      )}
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
          {error === 'no_rpc' ? 'ระบบตลาดในฐานข้อมูลยังไม่ครบ — แอดมินต้องรัน migration ตลาดก่อน' : MARKET_ERR_TH[error] ?? `โหลดกระดานไม่สำเร็จ (${error})`}
          <button type="button" onClick={() => void refresh()} className="ml-2 underline">ลองใหม่</button>
        </div>
      )}
      {rows && !error && list.length === 0 && (
        <div className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center">
          <div className="text-3xl">🎟️</div>
          <div className="mt-2 text-[14px] font-bold">ยังไม่มีใบพรีลงขาย{q || maker || fr ? 'ที่ตรงกับตัวกรอง' : ''}</div>
          <div className="mt-1 text-[12px] text-ink-faint">มีใบพรีที่ไปต่อไม่ไหว? กด “ลงขายใบพรี” ด้านบน</div>
        </div>
      )}
      <div className="flex flex-col gap-3">
        {list.map((r) => (
          <MarketCard key={r.id} db={db} row={r} hot={soldOutInShop(db, r.product_id)} now={now} onOpen={() => open(r.id)} />
        ))}
      </div>

      {picking && (
        <TicketPicker onClose={() => setPicking(false)}
          onPick={(t) => { setPicking(false); setSelling(t); }}
          onOpenDeal={(id) => { setPicking(false); open(id); }} />
      )}
      {selling && (
        <SellSheet ticket={selling} mode="market" onClose={() => setSelling(null)}
          onListed={mode === 'preview' ? (id) => { void refresh(); setOpenId(id); } : undefined} />
      )}
    </div>
  );
}
