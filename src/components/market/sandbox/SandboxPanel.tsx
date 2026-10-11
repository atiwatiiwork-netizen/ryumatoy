'use client';

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useDatabase, StoreOverride } from '@/state/DataProvider';
import { AuthOverride } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { setMarketSandbox } from '@/lib/marketSandbox';
import { baht } from '@/lib/theme';
import { productLabel } from '@/domain/services/catalog';
import { activeListingOf, boughtFromMarket, dealRole, dealStatusLabel, effectiveStatus, listingPreview, myDeals } from '@/domain/services/market';
import type { Database, TicketTransfer } from '@/domain/entities';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { MarketBoard } from '../MarketBoard';
import { MyDeals } from '../MyDeals';
import { MarketDeal } from '../MarketDeal';
import { QueueTab } from '../AdminQueue';
import { StubArt, LotPill } from '../MarketUi';
import { MarketSandbox, SB_ME, type SbEvent } from './engine';

/**
 * แท็บ "🎮 ทดลองเล่น" ใน /admin/market (เจ้าของ 2026-09-24: "ทำมาให้ลองเล่นเล่นหน่อย")
 *   ซ้าย = จอลูกค้าตัวจริง (กระดาน/ซื้อขายของฉัน/ใบพรีของฉัน — คอมโพเนนต์เดียวกับหน้าลูกค้า · DNA shared preview)
 *   ขวา = สั่งคู่ค้าสมมุติ · ข้ามเวลา · คิวงานร้านตัวจริง (บนข้อมูลจำลอง) · บันทึกเหตุการณ์ (push/LINE ที่ "จะ" ถูกส่ง)
 * ทุกอย่างอยู่ในหน้าเว็บนี้: ไม่เขียนฐานข้อมูล ไม่ส่ง push/LINE ไม่อัปโหลดรูป · ออกจากแท็บ = หายหมด
 */
export function SandboxPanel() {
  const realDb = useDatabase();
  const [engine] = useState(() => new MarketSandbox(realDb));
  // ธงต้องตั้ง "ก่อน" effect ของจอลูก (effect ลูกรันก่อนพ่อ — กระดานโหลดตอน mount) → ตั้งตอน render (ซ้ำได้ ไม่มีผลข้างเคียง)
  setMarketSandbox(engine.hooks);
  useEffect(() => {
    setMarketSandbox(engine.hooks);
    // เครื่องมือทดสอบอัตโนมัติ (โหมด dev เท่านั้น — build จริงตัดทิ้ง): สั่งเครื่องจำลองตรงๆ ตอนหน้าต่างไม่ได้วาดจอ (ปุ่มกดค้างใช้ไม่ได้)
    const w = window as unknown as { __marketSandbox?: MarketSandbox };
    if (process.env.NODE_ENV !== 'production') w.__marketSandbox = engine;
    return () => { setMarketSandbox(null); engine.dispose(); if (w.__marketSandbox === engine) delete w.__marketSandbox; };
  }, [engine]);
  const sdb = useSyncExternalStore(engine.subscribe, () => engine.db, () => engine.db);
  const [, bump] = useState(0);
  useEffect(() => engine.subscribe(() => bump((n) => n + 1)), [engine]); // บันทึกเหตุการณ์เปลี่ยนโดยข้อมูลไม่เปลี่ยน

  return (
    <StoreOverride value={engine.store}>
      <AuthOverride userId={SB_ME}>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-[#8b5cf6]/40 bg-[#8b5cf6]/10 px-4 py-3 text-[12.5px] leading-relaxed text-[#ddd6fe]">
            🎮 <b className="text-white">โหมดทดลองเล่น</b> — กระดานเต็มไปด้วยประกาศสมมุติจากสินค้าจริงในร้าน (หลายค่าย หลายคนขาย) · คุณเล่นเป็นลูกค้า
            “ฉัน” ที่มีใบพรี 5 ใบ · ทุกอย่างอยู่ในหน้านี้ ไม่บันทึก ไม่ส่งแจ้งเตือนจริง ลูกค้าไม่เห็น
          </div>
          <div className="grid items-start gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
            <Phone db={sdb} />
            <Controls engine={engine} db={sdb} />
          </div>
        </div>
      </AuthOverride>
    </StoreOverride>
  );
}

// ── จอลูกค้า ───────────────────────────────────────────────────────────────────
type View = 'board' | 'mine' | 'wallet';
function Phone({ db }: { db: Database }) {
  const [view, setView] = useState<View>('board');
  const [openId, setOpenId] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(0); // กดแท็บซ้ำ = กลับหน้ารวม (กระดานจำดีลที่เปิดค้างไว้ข้างใน)
  const todo = myDeals(db, SB_ME).todo.length;
  const tabs: { k: View; label: string; badge?: number }[] = [
    { k: 'board', label: 'กระดาน' }, { k: 'mine', label: 'ซื้อขายของฉัน', badge: todo }, { k: 'wallet', label: 'ใบพรีของฉัน' },
  ];
  return (
    <div className="flex w-full flex-col items-center gap-2 lg:sticky lg:top-4">
      <div className="flex w-full max-w-[390px] gap-1">
        {tabs.map((t) => (
          <button type="button" key={t.k} onClick={() => { setView(t.k); setOpenId(null); setBoardKey((n) => n + 1); }}
            className={cx('relative flex-1 rounded-lg px-2 py-1.5 text-[12px] font-bold', view === t.k ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2')}>
            {t.label}
            {!!t.badge && <span className="absolute -right-1 -top-1.5 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-primary-bright px-1 text-[10px] text-white">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="w-full max-w-[390px] overflow-hidden rounded-[32px] border border-[#8b5cf6]/40 bg-base p-4 shadow-frame">
        <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] text-[#c4b5fd]"><Icon name="verified" size={12} />จอลูกค้าจริง · ข้อมูลสมมุติ</div>
        {view === 'board' ? <MarketBoard key={boardKey} mode="preview" />
          : view === 'wallet' ? <MyTickets db={db} />
            : openId ? <MarketDeal id={openId} mode="preview" onBack={() => setOpenId(null)} /> : <MyDeals onOpen={setOpenId} />}
      </div>
    </div>
  );
}

/** ใบพรีของ "ฉัน" ในโลกจำลอง — ดูผลหลังซื้อ/ขาย (ใบใหม่ -T1 · ป้ายได้มาจากตลาด · ใบที่ลงขายอยู่) */
function MyTickets({ db }: { db: Database }) {
  const mine = db.tickets.filter((t) => t.owner_id === SB_ME).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const sold = db.transfers.filter((tr) => tr.from_user_id === SB_ME && tr.status === 'done');
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[20px] font-extrabold">ใบพรีของฉัน</div>
      {mine.map((t) => {
        const pv = listingPreview(t, t.qty, 0);
        const got = boughtFromMarket(db, t, SB_ME);
        const listing = activeListingOf(db, t.id);
        return (
          <div key={t.id} className={cx('flex items-center gap-3 rounded-2xl border bg-surface-2 px-3 py-2.5', got ? 'border-[#c4b5fd]/40' : 'border-subtle')}>
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl"><StubArt db={db} productId={t.product_id} variantId={t.variant_id} /></div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-bold">{productLabel(db, t.product_id, t.variant_id)}{t.qty > 1 ? ` ×${t.qty}` : ''}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10.5px] text-primary-soft">{t.ticket_no}</span><LotPill status={t.product_status} />
                {got && <span className="rounded-full border border-[#c4b5fd]/40 bg-[#c4b5fd]/10 px-1.5 text-[10px] font-bold text-[#c4b5fd]">🔁 ได้มาจากตลาด</span>}
                {listing && <span className="rounded-full border border-[#f1d27a]/40 px-1.5 text-[10px] font-bold text-[#f1d27a]">🔒 {dealStatusLabel(listing)}</span>}
              </div>
              <div className="mt-0.5 text-[11px] text-ink-faint">จ่ายแล้ว {baht(pv.paid)} · ค้างร้าน {baht(pv.due)}</div>
            </div>
          </div>
        );
      })}
      {sold.length > 0 && (
        <div className="rounded-xl bg-surface-3 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-faint">
          ขายออกไปแล้ว {sold.length} รายการ: {sold.map((tr) => `${tr.prev_ticket_no} → ${tr.new_ticket_no}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

// ── แผงควบคุม ─────────────────────────────────────────────────────────────────
const TONE: Record<SbEvent['tone'], string> = {
  me: 'text-[#86c8ff]', bot: 'text-[#f1d27a]', shop: 'text-[#4ade80]', push: 'text-[#f0a8a8]', line: 'text-[#4ade80]', time: 'text-[#c4b5fd]', err: 'text-[#f87171]',
};
const ICON: Record<SbEvent['tone'], string> = { me: '👤', bot: '🤖', shop: '🛡️', push: '📣', line: '💬', time: '⏩', err: '⚠️' };

function Controls({ engine, db }: { engine: MarketSandbox; db: Database }) {
  const { flash } = useToast();
  const g = myDeals(db, SB_ME);
  const deals = [...g.todo, ...g.active, ...g.selling];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card title="🤖 คู่ค้าสมมุติ" right={
        <div className="flex gap-1.5">
          <button type="button" onClick={() => engine.setAuto(!engine.auto)}
            className={cx('rounded-lg border px-2.5 py-1 text-[11.5px] font-bold', engine.auto ? 'border-[#16a34a]/50 bg-[#16a34a]/15 text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted2')}>
            {engine.auto ? 'ตอบเอง: เปิด' : 'ตอบเอง: ปิด'}
          </button>
          <button type="button" onClick={() => { engine.reset(); flash('เริ่มใหม่แล้ว'); }} className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1 text-[11.5px] font-bold text-ink-muted2">↺ เริ่มใหม่</button>
        </div>}>
        <div className="text-[11.5px] leading-relaxed text-ink-faint">
          {engine.auto
            ? 'ลงขาย → อีกไม่กี่วินาทีจะมีคนจอง แล้วโอน+แนบสลิปให้ · ซื้อของคนอื่น → คนขายยืนยันรับเงินให้เอง · ขั้นโอนสิทธิ์เป็นของคุณที่ฝั่งร้านด้านล่าง'
            : 'ปิดตอบเองอยู่ — กดสั่งคู่ค้าทีละขั้นที่ปุ่มของแต่ละดีลด้านล่าง'}
        </div>
        {deals.length === 0 ? (
          <div className="mt-2 rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-[12px] text-ink-faint">
            ยังไม่มีดีล — ลอง “ลงขายใบพรี” หรือปัดจองใบบนกระดานในจอซ้าย
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">{deals.map((tr) => <DealRow key={tr.id} engine={engine} db={db} tr={tr} />)}</div>
        )}
      </Card>

      <Card title="⏩ ข้ามเวลา">
        <div className="flex flex-wrap gap-1.5">
          {([
            [15 * 60_000, '+15 นาที', 'หมดเวลาจอง'], [12 * 3_600_000, '+12 ชม.', 'คนขายเงียบ → ขอตรวจสอบได้'],
            [2 * 86_400_000, '+2 วัน', 'พ้นถือ 2 วัน → ขายต่อได้'], [14 * 86_400_000, '+14 วัน', 'ประกาศหมดอายุ'],
          ] as const).map(([d, l, hint]) => (
            <button type="button" key={l} onClick={() => engine.fastForward(d, `${l} (${hint})`)} title={hint}
              className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1.5 text-left text-[12px] font-bold text-ink-muted2">
              {l}<span className="block text-[10.5px] font-normal text-ink-faint">{hint}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card title="🛡️ ฝั่งร้าน — คิวงานตัวจริงบนข้อมูลสมมุติ">
        <QueueTab db={db} flash={flash} />
      </Card>

      <Card title="📜 บันทึกเหตุการณ์ (รวม push / LINE ที่จะถูกส่ง)">
        <div className="flex max-h-[360px] flex-col gap-1 overflow-y-auto">
          {engine.events.map((e) => (
            <div key={e.id} className="flex gap-2 text-[12px] leading-snug">
              <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{new Date(e.at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <span className="shrink-0">{ICON[e.tone]}</span>
              <span className={TONE[e.tone]}>{e.text}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-3.5">
      <div className="mb-2 flex items-center justify-between gap-2"><div className="text-[13.5px] font-bold">{title}</div>{right}</div>
      {children}
    </div>
  );
}

/** ดีลของ "ฉัน" + ปุ่มสั่งอีกฝั่ง ตามสถานะตอนนี้ */
function DealRow({ engine, db, tr }: { engine: MarketSandbox; db: Database; tr: TicketTransfer }) {
  const st = effectiveStatus(tr);
  const seller = dealRole(tr, SB_ME) === 'seller';
  const botBuyer = seller && !!tr.to_user_id && tr.to_user_id !== SB_ME;
  const btns: [string, () => void][] = [];
  let hint = '';
  if (seller && st === 'listed') btns.push(['🤖 ให้มีคนจอง', () => engine.botReserve(tr.id)]);
  if (seller && st === 'reserved' && botBuyer) { btns.push(['🤖 ผู้ซื้อโอน + แนบสลิป', () => engine.botPay(tr.id)], ['🤖 ผู้ซื้อปล่อยการจอง', () => engine.botRelease(tr.id)]); }
  if (seller && (st === 'paid' || st === 'reviewing')) hint = 'ถึงตาคุณ: เปิด “ซื้อขายของฉัน” ในจอซ้าย → เช็คสลิป → ยืนยันรับเงิน / แจ้งไม่ได้รับ';
  if (!seller && st === 'reserved') hint = 'ถึงตาคุณ: โอนตาม QR แล้วแนบรูปสลิป (รูปอะไรก็ได้ · ไม่ได้อัปโหลดจริง)';
  if (!seller && st === 'paid') btns.push(['🤖 คนขายยืนยันรับเงิน', () => engine.botConfirm(tr.id)], ['🤖 คนขายแจ้งไม่ได้รับเงิน', () => engine.botReject(tr.id)]);
  if (!seller && st === 'reviewing' && tr.from_user_id !== SB_ME) btns.push(['🤖 คนขายยืนยันรับเงิน', () => engine.botConfirm(tr.id)]);
  if (st === 'seller_ok') hint = 'ถึงตาร้าน: กดค้าง “โอนสิทธิ์” ในคิวงานร้านด้านล่าง';
  return (
    <div className="rounded-xl border border-subtle bg-surface-3 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className={cx('rounded-md px-1.5 text-[10px] font-bold', seller ? 'bg-[#f1d27a]/15 text-[#f1d27a]' : 'bg-[#86c8ff]/15 text-[#86c8ff]')}>{seller ? 'ขาย' : 'ซื้อ'}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold">{tr.product_id ? productLabel(db, tr.product_id, tr.variant_id) : 'ใบพรี'}</span>
        <span className="shrink-0 font-mono text-[12px]">{baht(tr.asking_price)}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-ink-faint">{dealStatusLabel(tr, st)}</div>
      {hint && <div className="mt-1 text-[11.5px] text-[#fbbf24]">{hint}</div>}
      {btns.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {btns.map(([l, fn]) => <button type="button" key={l} onClick={fn} className="rounded-lg border border-[#f1d27a]/40 bg-[#f1d27a]/10 px-2.5 py-1 text-[11.5px] font-bold text-[#f1d27a]">{l}</button>)}
        </div>
      )}
    </div>
  );
}
