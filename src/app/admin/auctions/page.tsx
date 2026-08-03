'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { pushEnabled, sendPush, subsAll, subsForUsers } from '@/lib/push';
import { readStore, writeStore, removeStore } from '@/lib/safeStorage';
import { baht } from '@/lib/theme';
import * as rpc from '@/lib/auction';
import {
  approveAuctionEntry, cancelAuction, closeAuctionLocal, createAuction, markAuctionPaid,
  openAuction, rejectAuctionEntry, removeAuction, setAuctionPublic, awardRunnerUp, voidAuctionBid,
} from '@/data/mutations';
import {
  AUCTION_STATUS_TH, auctionPublicEnabled, isLive, needsClose, payOverdue, sortedAuctions, timeLeftLabel,
} from '@/domain/services/auctions';
import { AuctionRoom, reloadDb } from '@/components/AuctionRoom';
import { AuctionCondPicker } from '@/components/AuctionCond';
import { Button, cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { Auction, AuctionCond, Database } from '@/domain/entities';
import { NEW_AUCTION_COND } from '@/domain/entities';

/**
 * แอดมิน › ประมูล (v60).
 * เจ้าของ 2026-07-31: "ทำ Tab ประมูลขึ้นมา โดยเห็นหน้าตาเดียวกับฝั่งผู้ใช้เลย เพื่อลองเล่นดูก่อน"
 * → แท็บ "ดูแบบลูกค้า" เรนเดอร์ `AuctionRoom` **ตัวเดียวกับหน้าลูกค้า** ในกรอบมือถือ
 *   (ถ้าทำ UI แยกสองชุด สิ่งที่ทดลองจะไม่ใช่สิ่งที่ลูกค้าเจอจริง)
 *
 * ⚠ กฎที่ทำพังมาแล้ว (bug 2026-07-31 "กรอกฟอร์มแล้วใส่รูป ทุกอย่างหาย"):
 *   **ห้ามประกาศคอมโพเนนต์ลูกไว้ข้างในฟังก์ชันหน้า** — ทุกครั้งที่หน้าแม่ re-render
 *   (เช่น DataProvider โหลดข้อมูลใหม่ตอนสลับกลับมาที่แท็บเบราว์เซอร์หลังเลือกไฟล์รูป)
 *   ฟังก์ชันคอมโพเนนต์จะเป็น "ตัวใหม่" ทุกครั้ง React จึงถอดของเก่าทิ้งแล้วสร้างใหม่ =
 *   useState ในฟอร์มถูกล้างหมด ชื่อ/ราคา/รูปหายเกลี้ยง. ทุกตัวต้องอยู่ระดับไฟล์แบบข้างล่างนี้
 */
const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const btnCls = 'rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-bold text-ink-muted2 hover:text-ink';
const btnPrimary = 'rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-bold text-white';

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-[11.5px] text-ink-faint">{hint}</span>}
  </label>
);
const Panel = ({ children }: { children: React.ReactNode }) => <div className="rounded-2xl border border-subtle bg-surface-2 p-5">{children}</div>;

const todayAt21 = () => {
  const d = new Date();
  d.setHours(21, 0, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return { date: d.toISOString().slice(0, 10), time: '21:00' };
};
const fmt = (iso: string) => new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

type Tab = 'list' | 'new' | 'preview' | 'entries';
type Dispatch = ReturnType<typeof useDispatch>;
type Flash = ReturnType<typeof useToast>['flash'];

export default function AdminAuctionsPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [tab, setTab] = useState<Tab>('list');
  const [previewId, setPreviewId] = useState<string>('');
  // ยังไม่ได้รัน v60 = ไม่มีทั้งตารางและ RPC → ห้องที่สร้างจะเซฟขึ้นคลาวด์ไม่ได้
  // ต้องบอกตรงนี้ ไม่ใช่ปล่อยให้เจอ error "บันทึกไม่สำเร็จ" ตอนกดสร้างแล้วงงว่าอะไรพัง
  const [needMigration, setNeedMigration] = useState(false);
  useEffect(() => { void rpc.auctionState('probe').then((r) => setNeedMigration(rpc.isNoServer(r))); }, []);

  const now = new Date();
  const list = sortedAuctions(db, now);
  const pendingEntries = db.auctionEntries.filter((e) => e.status === 'pending');
  const toClose = list.filter((a) => needsClose(a, now)).length;
  const isPublic = auctionPublicEnabled(db);

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: 'list', label: `รายการประมูล (${list.length})`, badge: toClose },
    { key: 'new', label: '＋ สร้างห้อง' },
    { key: 'preview', label: '👀 ดูแบบลูกค้า' },
    { key: 'entries', label: 'ค่าเข้าสนาม ฿300', badge: pendingEntries.length },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold">ประมูล</h1>
          <p className="text-[12.5px] text-ink-muted">ของในมือ · เปิด ฿1,000 · บันไดขั้น 20/50/100/200 · ต่อเวลา 5 นาที (เพดาน 60)</p>
        </div>
        <button
          onClick={() => { dispatch(setAuctionPublic(!isPublic)); flash(isPublic ? 'ปิดห้องประมูลจากฝั่งลูกค้าแล้ว' : 'เปิดให้ลูกค้าเห็นห้องประมูลแล้ว'); }}
          className={cx('rounded-lg border px-4 py-2 text-[13px] font-bold',
            isPublic ? 'border-[#16a34a]/50 bg-[#16a34a]/15 text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted')}>
          {isPublic ? 'ลูกค้าเห็นแล้ว · กดเพื่อปิด' : 'ยังไม่เปิดให้ลูกค้าเห็น · กดเพื่อเปิด'}
        </button>
      </div>

      {needMigration && (
        <div className="rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-3 text-[12.5px] leading-relaxed text-[#fbbf24]">
          <b>ยังไม่ได้รัน <code>supabase/migration_auction_v60.sql</code></b> — ตอนนี้เป็น “โหมดทดลอง”:
          กดเล่นดูหน้าตาได้ทั้งหมด แต่ห้องที่สร้าง/ราคาที่บิด <b>ยังไม่ถูกบันทึกขึ้นคลาวด์</b>
          และลูกค้าคนอื่นจะไม่เห็น · รันไฟล์นี้ใน Supabase SQL Editor แล้วรีเฟรช
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-b border-subtle pb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-bold',
              tab === t.key ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2 hover:text-ink')}>
            {t.label}
            {!!t.badge && t.badge > 0 && (
              <span className={cx('rounded-full px-[7px] text-[11px] font-extrabold', tab === t.key ? 'bg-white/25 text-white' : 'bg-primary-bright text-white')}>{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'list' && (
        <AuctionList db={db} dispatch={dispatch} flash={flash} list={list} now={now}
          onPreview={(id) => { setPreviewId(id); setTab('preview'); }} />
      )}
      {tab === 'new' && <NewAuctionForm db={db} dispatch={dispatch} flash={flash} onDone={() => setTab('list')} />}
      {tab === 'preview' && <PreviewTab list={list} value={previewId} onChange={setPreviewId} />}
      {tab === 'entries' && <EntriesTab db={db} dispatch={dispatch} flash={flash} />}
    </div>
  );
}

// ── แท็บ: รายการ ────────────────────────────────────────────────────────────
function AuctionList({ db, dispatch, flash, list, now, onPreview }: {
  db: Database; dispatch: Dispatch; flash: Flash; list: Auction[]; now: Date; onPreview: (id: string) => void;
}) {
  /** คนที่ควรได้ยินข่าวห้องนี้: กดกระดิ่ง + เคยบิด (ไม่ซ้ำ) */
  const audienceOf = (a: Auction) => [...new Set([
    ...db.auctionWatch.filter((w) => w.auction_id === a.id).map((w) => w.user_id),
    ...db.auctionBids.filter((b) => b.auction_id === a.id && b.status === 'active').map((b) => b.user_id),
  ])];

  async function close(a: Auction) {
    const res = await rpc.closeAuction(a.id);
    const local = rpc.isNoServer(res);
    if (local) { dispatch(closeAuctionLocal(a.id)); flash('ปิด + สรุปผลแล้ว (โหมดทดลอง)'); }
    else if (res.ok) { flash(res.winner ? `ปิดแล้ว — ผู้ชนะที่ ${baht(res.amount ?? 0)}` : 'ปิดแล้ว — ไม่มีผู้บิด'); reloadDb(); }
    else { flash(`ปิดไม่สำเร็จ (${res.error})`); return; }

    // ประกาศผล: ผู้ชนะได้ข้อความส่วนตัว (มีกำหนดจ่าย) · คนที่ร่วมบิดได้ข้อความสั้นๆ
    if (!pushEnabled(db, 'auction_result')) return;
    const winnerId = local ? undefined : (res.winner ?? undefined);
    const amount = local ? undefined : res.amount;
    if (winnerId) {
      void sendPush(subsForUsers(db, [winnerId]),
        { title: '🏆 คุณชนะการประมูล!', body: `${a.title} — ${baht(amount ?? 0)} · ชำระภายใน 24 ชม.`, url: `/auctions/${a.id}` },
        dispatch).catch(() => {});
    }
    const others = audienceOf(a).filter((u) => u !== winnerId);
    if (others.length) {
      void sendPush(subsForUsers(db, others),
        { title: 'ปิดประมูลแล้ว', body: `${a.title} — จบที่ ${baht(amount ?? a.current_price)} บาท ไว้เจอกันรอบหน้าครับ`, url: `/auctions/${a.id}` },
        dispatch).catch(() => {});
    }
  }

  function announceOpen(a: Auction) {
    if (!pushEnabled(db, 'auction_open')) { flash('สวิตช์ push "เปิดประมูลรอบใหม่" ปิดอยู่'); return; }
    void sendPush(subsAll(db),
      { title: '🔨 เปิดประมูลแล้ว', body: `${a.title} — เริ่มที่ ${baht(a.start_price)} บาท ปิด ${fmt(a.ends_at)}`, url: `/auctions/${a.id}` },
      dispatch).then((r) => flash(`ส่งแจ้งเตือน ${r.sent} เครื่อง`)).catch(() => flash('ส่งแจ้งเตือนไม่สำเร็จ'));
  }

  function remindSoon(a: Auction) {
    if (!pushEnabled(db, 'auction_soon')) { flash('สวิตช์ push "ใกล้ปิดประมูล" ปิดอยู่'); return; }
    const ids = audienceOf(a);
    if (!ids.length) { flash('ยังไม่มีคนกดกระดิ่งหรือบิดในห้องนี้'); return; }
    void sendPush(subsForUsers(db, ids),
      { title: '⏰ ใกล้ปิดประมูลแล้ว', body: `${a.title} — ตอนนี้ ${baht(a.current_price || a.start_price)} บาท ปิด ${fmt(a.ends_at)}`, url: `/auctions/${a.id}` },
      dispatch).then((r) => flash(`เตือน ${r.sent} เครื่องแล้ว`)).catch(() => flash('ส่งแจ้งเตือนไม่สำเร็จ'));
  }

  if (list.length === 0) {
    return <Panel><div className="py-10 text-center text-[13px] text-ink-muted">ยังไม่มีห้องประมูล — กด “＋ สร้างห้อง”</div></Panel>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {list.map((a) => {
        const live = isLive(a, now);
        const winner = a.winner_user_id ? db.users.find((u) => u.id === a.winner_user_id) : undefined;
        const runner = a.runner_up_user_id ? db.users.find((u) => u.id === a.runner_up_user_id) : undefined;
        const img = a.images[0] ?? db.products.find((p) => p.id === a.product_id)?.images?.[0];
        const bids = db.auctionBids.filter((b) => b.auction_id === a.id);
        return (
          <div key={a.id} className="rounded-2xl border border-subtle bg-surface-2 p-4">
            <div className="flex gap-3.5">
              <div className="h-[74px] w-[74px] shrink-0 overflow-hidden rounded-xl bg-surface-3">
                {img && <img src={img} alt="" className="h-full w-full object-cover" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-extrabold">{a.title}</span>
                  <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-bold',
                    live ? 'bg-primary text-white' : needsClose(a, now) ? 'bg-[#fbbf24] text-black' : 'bg-surface-4 text-ink-muted')}>
                    {needsClose(a, now) ? 'หมดเวลา · รอสรุปผล' : AUCTION_STATUS_TH[a.status]}
                  </span>
                  {payOverdue(a, now) && <span className="rounded-full bg-[#dc2626] px-2 py-0.5 text-[11px] font-bold text-white">เลยกำหนดจ่าย</span>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-ink-muted">
                  <span>เปิด {baht(a.start_price)}{a.buy_now_price ? ` · ซื้อเลย ${baht(a.buy_now_price)}` : ''}</span>
                  <span>ราคาปัจจุบัน <b className="text-ink">{a.bid_count === 0 ? '—' : baht(a.current_price)}</b> · {a.bid_count} บิด</span>
                  <span>ปิด {fmt(a.ends_at)}{a.extend_count > 0 ? ` (ต่อแล้ว ${a.extend_count} รอบ)` : ''}</span>
                  {live && <span className="font-bold text-primary-bright">เหลือ {timeLeftLabel(new Date(a.ends_at).getTime() - now.getTime())}</span>}
                </div>
                {winner && (
                  <div className="mt-1.5 rounded-lg bg-surface-3 px-2.5 py-1.5 text-[12px]">
                    ผู้ชนะ <b>{winner.display_name}</b> {winner.member_code ? `(${winner.member_code})` : ''} ที่ {baht(a.winning_amount ?? 0)}
                    {a.pay_due_at && ` · ครบกำหนดจ่าย ${fmt(a.pay_due_at)}`}
                    {runner && <span className="text-ink-faint"> · อันดับ 2 {runner.display_name} ที่ {baht(a.runner_up_amount ?? 0)}</span>}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              <button onClick={() => onPreview(a.id)} className={btnCls}>👀 ดูห้อง</button>
              {a.status === 'draft' && <button onClick={() => { dispatch(openAuction(a.id)); flash('เปิดประมูลแล้ว'); }} className={btnPrimary}>เปิดประมูล</button>}
              {a.status === 'draft' && <button onClick={() => { if (confirm('ลบห้องนี้?')) dispatch(removeAuction(a.id)); }} className={btnCls}>ลบ</button>}
              {a.status === 'live' && <button onClick={() => announceOpen(a)} className={btnCls}>📣 ประกาศเปิดประมูล</button>}
              {a.status === 'live' && <button onClick={() => remindSoon(a)} className={btnCls}>⏰ เตือนใกล้ปิด</button>}
              {a.status === 'live' && <button onClick={() => void close(a)} className={btnPrimary}>ปิด + สรุปผล</button>}
              {a.status === 'live' && <button onClick={() => { if (confirm('ยกเลิกการประมูลนี้? บิดทั้งหมดจะเป็นโมฆะ')) { dispatch(cancelAuction(a.id, 'แอดมินยกเลิก')); flash('ยกเลิกแล้ว'); } }} className={btnCls}>ยกเลิก</button>}
              {a.status === 'ended' && a.winner_user_id && (
                <button onClick={() => { dispatch(markAuctionPaid(a.id)); flash('บันทึกว่าผู้ชนะจ่ายแล้ว'); }} className={btnCls}>ผู้ชนะจ่ายแล้ว</button>
              )}
              {a.status === 'ended' && a.runner_up_user_id && payOverdue(a, now) && (
                <button onClick={() => { if (confirm('ผู้ชนะไม่จ่ายตามกำหนด — ยกสิทธิ์ให้อันดับ 2 ที่ราคาที่เขาบิดไว้?')) { dispatch(awardRunnerUp(a.id)); flash('ยกสิทธิ์ให้อันดับ 2 แล้ว'); } }} className={btnCls}>
                  ยกให้อันดับ 2
                </button>
              )}
              <Link href={`/auctions/${a.id}`} className={btnCls}>เปิดหน้าลูกค้า</Link>
            </div>

            {bids.length > 0 && (
              <details className="mt-2.5">
                <summary className="cursor-pointer text-[12px] font-semibold text-ink-muted">ประวัติบิด (เห็นชื่อจริง) · {bids.length}</summary>
                <div className="mt-1.5 flex flex-col gap-1">
                  {[...bids].sort((x, y) => (x.created_at < y.created_at ? 1 : -1)).map((b) => {
                    const u = db.users.find((x) => x.id === b.user_id);
                    return (
                      <div key={b.id} className={cx('flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[12px]',
                        b.cancel_requested_at && b.status === 'active' ? 'bg-[#fbbf24]/[0.12]' : 'bg-surface-3',
                        b.status === 'void' && 'opacity-45 line-through')}>
                        <span>
                          {u?.display_name ?? b.user_id} {u?.member_code ? `(${u.member_code})` : ''}
                          {b.cancel_requested_at && b.status === 'active' && (
                            <span className="ml-2 rounded bg-[#fbbf24]/20 px-1.5 py-0.5 text-[11px] font-bold text-[#fbbf24]">
                              ขอยกเลิก{b.cancel_reason ? `: ${b.cancel_reason}` : ''}
                            </span>
                          )}
                          {b.status === 'void' && b.void_reason && <span className="ml-2 text-[11px] text-ink-faint">({b.void_reason})</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-2.5">
                          <b className="tabular-nums">{baht(b.amount)}</b>
                          <span className="text-ink-faint">{fmt(b.created_at)}</span>
                          {b.status === 'active' && (
                            <button onClick={() => {
                              const r = prompt('เหตุผลที่ยกเลิกบิดนี้', b.cancel_reason ?? 'ลูกค้าแจ้งว่าพิมพ์ยอดผิด');
                              if (r) { dispatch(voidAuctionBid(b.id, r)); flash('ยกเลิกบิดแล้ว — ราคากลับไปที่บิดก่อนหน้า'); }
                            }} className="rounded border border-subtle px-1.5 py-0.5 text-[11px] text-ink-muted">ยกเลิกบิด</button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── แท็บ: ดูแบบลูกค้า ───────────────────────────────────────────────────────
function PreviewTab({ list, value, onChange }: { list: Auction[]; value: string; onChange: (v: string) => void }) {
  const pick = value || list[0]?.id || '';
  if (!pick) return <Panel><div className="py-10 text-center text-[13px] text-ink-muted">ยังไม่มีห้องให้ดู — สร้างห้องก่อน</div></Panel>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-semibold text-ink-muted">เลือกห้อง</span>
        <select value={pick} onChange={(e) => onChange(e.target.value)} className={cx(inputCls, 'max-w-[340px]')}>
          {list.map((a) => <option key={a.id} value={a.id}>{a.title} — {AUCTION_STATUS_TH[a.status]}</option>)}
        </select>
      </div>
      <div className="rounded-xl border border-subtle bg-surface-3 px-3 py-2 text-[12px] text-ink-muted">
        นี่คือหน้าจอเดียวกับที่ลูกค้าเห็นเป๊ะๆ — กดบิด/กดกระดิ่ง/ซื้อเลยได้จริงในนามบัญชีคุณ (ใช้ทดลองก่อนเปิดให้ลูกค้า)
      </div>
      <div className="rounded-[26px] border border-subtle bg-base p-3">
        <AuctionRoom auctionId={pick} embedded />
      </div>
    </div>
  );
}

// ── แท็บ: ค่าเข้าสนาม ───────────────────────────────────────────────────────
function EntriesTab({ db, dispatch, flash }: { db: Database; dispatch: Dispatch; flash: Flash }) {
  const rows = [...db.auctionEntries].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="text-[13px] leading-relaxed text-ink-muted">
          คนที่ยังไม่มีใบพรีค้างอยู่ ต้องโอน ฿300 เพื่อเข้าประมูล — <b className="text-ink">ไม่ใช่ค่าธรรมเนียม</b>
          ลูกค้าเอาสลิปใบเดิมไปแปะเป็นมัดจำพรีรายการอื่นได้ (อนุมัติตามปกติในหน้าออเดอร์)
          <br />
          <span className="text-ink-faint">ยอดนี้จะยังไม่ถูกนับเป็นรายได้จนกว่าจะถูกใช้กับออเดอร์ — กัน “นับเงินซ้ำ”</span>
        </div>
      </Panel>
      {rows.length === 0 && <Panel><div className="py-8 text-center text-[13px] text-ink-muted">ยังไม่มีใครส่งค่าเข้าสนาม</div></Panel>}
      {rows.map((e) => {
        const u = db.users.find((x) => x.id === e.user_id);
        return (
          <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-subtle bg-surface-2 p-4">
            <div>
              <div className="text-[14px] font-bold">{u?.display_name ?? e.user_id} {u?.member_code ? `(${u.member_code})` : ''}</div>
              <div className="text-[12px] text-ink-muted">
                {e.kind === 'admin' ? 'แอดมินปลดล็อกให้' : `โอน ${baht(e.amount)}`} · {fmt(e.created_at)}
                {e.note ? ` · ${e.note}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {e.slip_url && <a href={e.slip_url} target="_blank" rel="noreferrer" className={btnCls}>ดูสลิป</a>}
              <span className={cx('rounded-full px-2.5 py-1 text-[11.5px] font-bold',
                e.status === 'approved' ? 'bg-[#16a34a]/15 text-[#4ade80]'
                  : e.status === 'used' ? 'bg-surface-4 text-ink-muted'
                  : e.status === 'rejected' ? 'bg-[#dc2626]/15 text-[#f87171]' : 'bg-[#fbbf24]/15 text-[#fbbf24]')}>
                {e.status === 'pending' ? 'รอตรวจ' : e.status === 'approved' ? 'อนุมัติแล้ว' : e.status === 'used' ? 'ใช้เป็นมัดจำแล้ว' : 'ปฏิเสธ'}
              </span>
              {e.status === 'pending' && (
                <>
                  <button onClick={() => { dispatch(approveAuctionEntry(e.id)); flash('อนุมัติแล้ว — ลูกค้าบิดได้ทันที'); }} className={btnPrimary}>อนุมัติ</button>
                  <button onClick={() => { dispatch(rejectAuctionEntry(e.id)); }} className={btnCls}>ปฏิเสธ</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── แท็บ: สร้างห้อง ─────────────────────────────────────────────────────────
const DRAFT_KEY = 'ryuma_auction_draft';
type Draft = { productId: string; title: string; detail: string; startPrice: string; buyNow: string; date: string; time: string; images: string[]; cond: AuctionCond };
const freshDraft = (): Draft => {
  const d = todayAt21();
  return { productId: '', title: '', detail: '', startPrice: '1000', buyNow: '', date: d.date, time: d.time, images: [], cond: { ...NEW_AUCTION_COND } };
};

function NewAuctionForm({ db, dispatch, flash, onDone }: { db: Database; dispatch: Dispatch; flash: Flash; onDone: () => void }) {
  // เก็บร่างไว้ใน sessionStorage ด้วย: รูปที่อัปแล้วเสียเวลาทำใหม่ ถ้าเผลอสลับแท็บ/กดพลาดจะได้ไม่หาย
  const [d, setD] = useState<Draft>(() => {
    const saved = readStore('session', DRAFT_KEY);
    if (saved) { try { return { ...freshDraft(), ...(JSON.parse(saved) as Draft) }; } catch { /* ร่างเสีย = เริ่มใหม่ */ } }
    return freshDraft();
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => { writeStore('session', DRAFT_KEY, JSON.stringify(d)); }, [d]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  // ประมูลได้เฉพาะ "ของในมือ" (เจ้าของเคาะ) — ของพร้อมส่ง หรือรอบที่ถึงไทยแล้ว
  const inHand = db.products.filter((p) => p.is_stock || p.status === 'arrived' || p.status === 'delivered');
  const picked = db.products.find((p) => p.id === d.productId);

  async function addImage(file: File) {
    setBusy(true);
    try {
      const url = await uploadImage(file, 'auction');
      setD((p) => ({ ...p, images: [...p.images, url] }));
    } catch (e) {
      // เดิมไม่ catch → อัปไม่ขึ้นแล้วเงียบสนิท ไม่รู้ว่าพลาดตรงไหน
      flash(`อัปโหลดรูปไม่สำเร็จ — ${(e as Error)?.message ?? 'ลองใหม่อีกครั้ง'}`);
    } finally { setBusy(false); }
  }

  function save() {
    const t = (d.title || picked?.series_name || '').trim();
    if (!t) { flash('ใส่ชื่อรายการก่อน'); return; }
    const ends = new Date(`${d.date}T${d.time}:00`);
    if (Number.isNaN(ends.getTime())) { flash('วัน/เวลาปิดไม่ถูกต้อง'); return; }
    if (ends.getTime() <= Date.now()) { flash('เวลาปิดต้องเป็นอนาคต'); return; }
    const sp = Number(d.startPrice) || 1000;
    if (sp % 10 !== 0) { flash('ราคาเปิดต้องลงท้ายด้วย 0'); return; }
    const bn = d.buyNow ? Number(d.buyNow) : undefined;
    if (bn != null && bn <= sp) { flash('ราคาซื้อเลยต้องมากกว่าราคาเปิด'); return; }
    // ติ๊กว่ามีตำหนิแล้วต้องบอกให้ครบ — ของประมูลคืนยาก ปล่อยผ่านไม่ได้
    if (d.cond.has_defect && !(d.cond.defect_note ?? '').trim()) { flash('ติ๊ก "มีตำหนิ" ไว้ — เขียนด้วยว่าตำหนิตรงไหน'); return; }
    if (d.cond.has_defect && d.images.length === 0) { flash('ติ๊ก "มีตำหนิ" ไว้ — แนบรูปตำหนิอย่างน้อย 1 รูป'); return; }
    dispatch(createAuction({
      title: t, product_id: d.productId || undefined, images: d.images, cond: d.cond,
      detail: d.detail.trim() || undefined, start_price: sp, buy_now_price: bn,
      ends_at: ends.toISOString(),
    }));
    removeStore('session', DRAFT_KEY);
    flash('สร้างห้องแล้ว (ยังเป็นร่าง — กด “เปิดประมูล” เมื่อพร้อม)');
    onDone();
  }

  return (
    <Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label="เลือกสินค้าในมือ (ใช้รูป/สภาพ/ค่าย จากสินค้าตัวนั้น)" hint="ไม่เลือกก็ได้ — แล้วอัปรูปเองด้านล่าง">
          <select value={d.productId} className={inputCls}
            onChange={(e) => setD((p) => {
              const prod = db.products.find((x) => x.id === e.target.value);
              // ถ้าสินค้าตัวนั้นเคยระบุสภาพไว้แล้ว (in-stock) ตั้งเช็คลิสต์ให้ตรงกันไว้ก่อน แอดมินแก้ต่อได้
              const sc = prod?.stock_cond;
              return {
                ...p, productId: e.target.value, title: p.title || prod?.series_name || '',
                cond: sc ? { hand: sc.hand, box_brown: sc.box_brown, box_brown_alt: false, box_color: sc.box_color, card: sc.card, has_defect: !sc.intact } : p.cond,
              };
            })}>
            <option value="">— ไม่ผูกกับสินค้า —</option>
            {inHand.map((p) => <option key={p.id} value={p.id}>{p.series_name}</option>)}
          </select>
        </Field>
        <Field label="ชื่อรายการ">
          <input value={d.title} onChange={(e) => set('title', e.target.value)} className={inputCls} placeholder="เช่น Roronoa Zoro — WCF มือ 1 กล่องสี" />
        </Field>

        <Field label="ราคาเปิด (บาท)" hint="ค่าเริ่มต้น 1,000 · ต้องลงท้ายด้วย 0">
          <input value={d.startPrice} onChange={(e) => set('startPrice', e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" className={inputCls} />
        </Field>
        <Field label="ราคาซื้อเลย (ไม่ใส่ = ไม่มีปุ่ม)" hint="กดแล้วปิดประมูลทันที">
          <input value={d.buyNow} onChange={(e) => set('buyNow', e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" className={inputCls} placeholder="—" />
        </Field>

        <Field label="วันปิด"><input type="date" value={d.date} onChange={(e) => set('date', e.target.value)} className={inputCls} /></Field>
        <Field label="เวลาปิด" hint="ค่าเริ่มต้น 3 ทุ่ม · ต่อเวลาอัตโนมัติ 5 นาที/บิด ในช่วง 30 นาทีสุดท้าย (ไม่เกิน 60 นาที)">
          <input type="time" value={d.time} onChange={(e) => set('time', e.target.value)} className={inputCls} />
        </Field>

        <div className="lg:col-span-2">
          <Field label="สภาพสินค้า (ติ๊กตามจริง)" hint="ลูกค้าเห็นเช็คลิสต์นี้ในห้องประมูล — ของประมูลคืนยาก ต้องบอกให้ครบก่อน">
            <AuctionCondPicker value={d.cond} onChange={(c) => set('cond', c)} />
          </Field>
        </div>

        <div className="lg:col-span-2">
          <Field label="หมายเหตุเพิ่มเติม (ไม่บังคับ)" hint="เช่น ของแถม / เงื่อนไขพิเศษของชิ้นนี้">
            <input value={d.detail} onChange={(e) => set('detail', e.target.value)} className={inputCls} placeholder="เช่น แถมฐานอะคริลิค" />
          </Field>
        </div>

        <div className="lg:col-span-2">
          <div className="mb-1 text-[12.5px] font-semibold text-ink-muted">
            {d.cond?.has_defect ? 'รูปตำหนิ (แนบให้ครบทุกจุด)' : 'รูปเพิ่ม (ของแถม/มุมอื่น)'}
            {busy && <span className="ml-2 text-[11.5px] font-normal text-ink-faint">กำลังอัปโหลด…</span>}
          </div>
          {d.cond?.has_defect && d.images.length === 0 && (
            <div className="mb-1.5 text-[11.5px] font-semibold text-[#fbbf24]">ติ๊ก “มีตำหนิ” ไว้แล้ว — แนบรูปตำหนิอย่างน้อย 1 รูปก่อนสร้างห้อง</div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {d.images.map((src) => (
              <div key={src} className="relative h-20 w-20 overflow-hidden rounded-lg border border-subtle">
                <img src={src} alt="" className="h-full w-full object-cover" />
                <button onClick={() => set('images', d.images.filter((x) => x !== src))} className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white">
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            <label className={cx('grid h-20 w-20 place-items-center rounded-lg border border-dashed border-subtle text-ink-faint', busy ? 'opacity-50' : 'cursor-pointer')}>
              <Icon name="plus" size={20} />
              <input type="file" accept="image/*" className="hidden" disabled={busy}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void addImage(f); e.target.value = ''; }} />
            </label>
          </div>
          {picked && d.images.length === 0 && (
            <div className="mt-1.5 text-[11.5px] text-ink-faint">ไม่อัปรูป = ใช้รูปของสินค้าที่เลือกไว้ ({picked.images?.length ?? 0} รูป)</div>
          )}
        </div>
      </div>

      <div className="mt-5 flex gap-2">
        <Button className="max-w-[220px]" disabled={busy} onClick={save}>สร้างห้อง (เป็นร่าง)</Button>
        <button onClick={() => { removeStore('session', DRAFT_KEY); setD(freshDraft()); onDone(); }} className={btnCls}>ยกเลิก</button>
      </div>
    </Panel>
  );
}
