'use client';

import { useEffect, useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { store } from '@/data/store';
import { persistFailText } from '@/data/persistErrors';
import { setMarketPublic, setMarketDirect } from '@/data/mutations';
import { baht } from '@/lib/theme';
import * as mk from '@/lib/market';
import { productLabel } from '@/domain/services/catalog';
import { marketPublicEnabled, directEnabled, marketQueue, effectiveStatus, isDirect, dealStatusLabel, TRANSFER_STATUS_LABEL } from '@/domain/services/market';
import type { Database, TicketTransfer } from '@/domain/entities';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { MarketBoard } from '@/components/market/MarketBoard';
import { MyDeals } from '@/components/market/MyDeals';
import { MarketDeal } from '@/components/market/MarketDeal';
import { WalletCodeChip } from '@/components/market/WalletCodeChip';
import { SandboxPanel } from '@/components/market/sandbox/SandboxPanel';
import { QueueTab, fmt, who } from '@/components/market/AdminQueue';

/**
 * แอดมิน › ตลาดใบพรี (เฟส 1 · 2026-09-23) + "เปลี่ยนใบพรี" โอนตรง (v73 · 2026-10-02)
 * เจ้าของสั่ง: "อย่าเพิ่งให้ลูกค้าเห็น รอทุกอย่างพร้อมก่อน" → สวิตช์ 2 ตัวแยกกัน (ค่าเริ่ม = ปิดทั้งคู่)
 *   market_public = กระดาน · market_direct = เปลี่ยนใบด้วยเลขกระเป๋า — ปิดอยู่: ลูกค้าไม่เห็น และ server ไม่ให้ใช้
 *   แอดมินลองได้ครบทุกขั้นด้วย 2 บัญชีแอดมิน
 * คิวงาน: 💰 เติมมัดจำ แยกหัวข้อ (เจ้าของ 2026-10-02 ข้อ 2.2) · 📨 ข้อเสนอรอผู้รับ (ดูเฉยๆ) · ✅ พร้อมโอนสิทธิ์ · 🔎 ตรวจสอบ
 * แท็บ "ดูแบบลูกค้า" เรนเดอร์คอมโพเนนต์ตัวเดียวกับหน้าลูกค้า (DNA shared preview)
 * ⚠ คอมโพเนนต์ลูกทุกตัวอยู่ระดับไฟล์ (DNA react-state)
 */
type Tab = 'queue' | 'all' | 'preview' | 'sandbox';
type Flash = (m: string) => void;

export default function AdminMarketPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [tab, setTab] = useState<Tab>('queue');
  const [probe, setProbe] = useState<'ok' | 'no_v72' | 'no_rpc' | 'no_server' | null>(null);
  const [probe73, setProbe73] = useState<'ok' | 'no_v73' | null>(null);
  // ตัวตรวจ migration ตลาดทุกเวอร์ชัน (v85) — ไม่ครบ = ห้ามเปิดสวิตช์ (audit 2026-10-12: v74 หายจาก production 9 วันโดยไม่มีใครเห็น)
  const [schema, setSchema] = useState<{ state: 'loading' | 'ok' | 'missing' | 'bad' | 'error' | 'preview'; bad: mk.SchemaRow[]; msg?: string }>({ state: 'loading', bad: [] });
  useEffect(() => {
    void mk.marketFeed().then((r) => setProbe(r.error === 'no_server' ? 'no_server' : mk.isMissingRpc(r) ? 'no_rpc' : r.ok && r.closed === undefined ? 'no_v72' : 'ok'));
    void mk.walletCode().then((r) => setProbe73(r.error === 'no_server' ? null : mk.isMissingRpc(r) ? 'no_v73' : 'ok'));
    void mk.schemaCheck().then((r) => {
      if (!r) return setSchema({ state: 'preview', bad: [] });
      if (r.error) return setSchema({ state: r.error === 'no_rpc' ? 'missing' : 'error', bad: [], msg: r.error });
      const rows = r.rows ?? [];
      const bad = rows.filter((x) => !x.ok);
      setSchema(rows.length === 0 ? { state: 'error', bad: [], msg: 'ไม่ได้ผลตรวจ — บัญชีนี้ไม่ใช่แอดมิน?' } : { state: bad.length ? 'bad' : 'ok', bad });
    });
  }, []);
  const isPublic = marketPublicEnabled(db);
  const isDirectOn = directEnabled(db);
  const q = marketQueue(db);
  /** เปิดสวิตช์ได้เมื่อฐานข้อมูลครบเท่านั้น (ปิดได้เสมอ) · พรีวิวที่ไม่ได้ต่อฐานข้อมูล = ไม่บล็อก */
  const schemaBlock = schema.state === 'ok' || schema.state === 'preview' ? null
    : schema.state === 'loading' ? 'กำลังตรวจฐานข้อมูล — รอสักครู่แล้วกดใหม่'
    : schema.state === 'missing' ? 'ยังไม่ได้รัน migration_deploy_v85.sql — ตรวจไม่ได้ว่าฐานข้อมูลพร้อม'
    : schema.state === 'bad' ? `ฐานข้อมูลยังไม่ครบ (${[...new Set(schema.bad.map((x) => x.version))].join(', ')}) — ห้ามเปิดจนกว่าจะรันครบ`
    : `ตรวจฐานข้อมูลไม่สำเร็จ (${schema.msg ?? 'error'}) — รีเฟรชหน้าแล้วลองใหม่`;

  const toggle = async () => {
    if (!isPublic && schemaBlock) { flash(`ยังเปิดกระดานไม่ได้ — ${schemaBlock}`); return; }
    if (!isPublic) {
      const ok = window.confirm('เปิดตลาดใบพรี (กระดาน) ให้ลูกค้าทุกคนเห็นเลยไหม?\n\n• แท็บ "ตลาด" ขึ้นที่เมนูล่างของทุกคน\n• ลูกค้าลงขาย/จองได้ทันที\n• มีคนลงขาย = push หาทุกคน (ยกเว้นคนที่ปิดค่าย/เรื่องนั้น)\n\nลองครบทุกขั้นกับบัญชีแอดมินแล้วค่อยเปิด');
      if (!ok) return;
    }
    dispatch(setMarketPublic(!isPublic));
    { const pf = await store.flush(); if (pf) { flash(persistFailText(pf, 'บันทึกสวิตช์ไม่สำเร็จ — ลองใหม่')); return; } }
    flash(isPublic ? 'ปิดกระดานจากฝั่งลูกค้าแล้ว' : 'เปิดกระดานให้ลูกค้าเห็นแล้ว 🎉');
  };
  const toggleDirect = async () => {
    if (!isDirectOn && schemaBlock) { flash(`ยังเปิด "เปลี่ยนใบพรี" ไม่ได้ — ${schemaBlock}`); return; }
    if (!isDirectOn) {
      const ok = window.confirm('เปิด "เปลี่ยนใบพรี" ให้ลูกค้าทุกคนเลยไหม?\n\n• ทุกคนเห็นเลขกระเป๋า 4 หลักที่หัวหน้ากระเป๋าพรี\n• ปุ่ม "เปลี่ยนใบพรี" ขึ้นในหน้าใบพรีทุกใบที่เข้าเกณฑ์\n• ส่งข้อเสนอ = push ถึงผู้รับทันที\n\nเช็คลิสต์ก่อนเปิด: ซ้อมดีลจริงด้วยบัญชีแอดมิน 2 บัญชีครบทุกแบบ (ขาย/ยกให้/เติมมัดจำ) แล้วหรือยัง?');
      if (!ok) return;
    }
    dispatch(setMarketDirect(!isDirectOn));
    { const pf = await store.flush(); if (pf) { flash(persistFailText(pf, 'บันทึกสวิตช์ไม่สำเร็จ — ลองใหม่')); return; } }
    flash(isDirectOn ? 'ปิด "เปลี่ยนใบพรี" จากฝั่งลูกค้าแล้ว' : 'เปิด "เปลี่ยนใบพรี" ให้ลูกค้าแล้ว 🎉');
  };

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: 'queue', label: 'งานรอ', badge: q.jobs },
    { key: 'all', label: `ดีลทั้งหมด (${db.transfers.length})` },
    { key: 'preview', label: '👀 ดูแบบลูกค้า' },
    { key: 'sandbox', label: '🎮 ทดลองเล่น' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold">ตลาดใบพรี · เปลี่ยนใบพรี</h1>
          <p className="text-[12.5px] text-ink-muted">ผู้ซื้อ/ผู้รับโอนตรงถึงคนขาย → คนขายยืนยัน → ร้านกดค้างโอนสิทธิ์ · ย้ายเจ้าของตั๋วเดิม (เงินร้านไม่ขยับ)</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void toggleDirect()}
            className={cx('rounded-lg border px-3.5 py-2 text-[12.5px] font-bold', isDirectOn ? 'border-[#16a34a]/50 bg-[#16a34a]/15 text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted')}>
            🔁 เปลี่ยนใบพรี: {isDirectOn ? 'ลูกค้าใช้ได้ · กดเพื่อปิด' : '🔒 ยังปิด (แอดมินลองได้) · กดเพื่อเปิด'}
          </button>
          <button type="button" onClick={() => void toggle()}
            className={cx('rounded-lg border px-3.5 py-2 text-[12.5px] font-bold', isPublic ? 'border-[#16a34a]/50 bg-[#16a34a]/15 text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted')}>
            🏷️ กระดาน: {isPublic ? 'ลูกค้าเห็นแล้ว · กดเพื่อปิด' : '🔒 ยังปิด · กดเพื่อเปิด'}
          </button>
        </div>
      </div>

      {(schema.state === 'missing' || schema.state === 'bad' || schema.state === 'error') && (
        <div className="rounded-xl border border-[#dc2626]/50 bg-[#dc2626]/[0.12] px-4 py-3 text-[12.5px] leading-relaxed text-[#fca5a5]">
          <b>⛔ ห้ามเปิดสวิตช์ตลาด — {schemaBlock}</b>
          {schema.state === 'bad' && (
            <ul className="mt-1.5 list-disc pl-5">
              {schema.bad.map((x) => <li key={x.step}><b>{x.version}</b> · {x.item}</li>)}
            </ul>
          )}
          {schema.state === 'missing' && <div className="mt-1">รันไฟล์ <code>supabase/migration_deploy_v85.sql</code> ใน SQL Editor (ไฟล์เดียว · ห้ามรัน v74 ซ้ำ) แล้วรีเฟรชหน้านี้</div>}
        </div>
      )}
      {schema.state === 'ok' && (
        <div className="text-[11.5px] text-ink-faint">✓ ฐานข้อมูลตลาดครบทุกเวอร์ชัน (ตรวจด้วย ryuma_schema_check)</div>
      )}
      {probe && probe !== 'ok' && (
        <div className="rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-3 text-[12.5px] leading-relaxed text-[#fbbf24]">
          {probe === 'no_rpc' && <><b>ยังไม่ได้รัน migration ตลาด (v71/v72)</b> — หน้าจอดูได้ แต่ลงขาย/จองจริงไม่ได้</>}
          {probe === 'no_v72' && <><b>ยังไม่ได้รัน <code>migration_market_gate_v72.sql</code></b> — ตอนนี้ด่าน "ลูกค้าห้ามใช้" มีแค่การซ่อนหน้าจอ ยังไม่มีที่ฐานข้อมูล · push ยังส่งไม่ได้</>}
          {probe === 'no_server' && <>โหมดพรีวิว (ไม่ได้ต่อฐานข้อมูล) — กระดานว่างเสมอ ลองจริงต้องใช้เว็บจริง</>}
        </div>
      )}
      {probe73 === 'no_v73' && (
        <div className="rounded-xl border border-[#d97706]/40 bg-[#d97706]/[0.12] px-4 py-3 text-[12.5px] leading-relaxed text-[#fbbf24]">
          <b>ยังไม่ได้รัน <code>migration_direct_v73.sql</code></b> — "เปลี่ยนใบพรี" ยังใช้ไม่ได้: เลขกระเป๋าไม่ออก · ส่งข้อเสนอไม่ได้ · กระดานเดิมใช้ได้ตามปกติ
        </div>
      )}
      {!isDirectOn && (
        <div className="rounded-xl border border-subtle bg-surface-2 px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted2">
          <b className="text-ink">วิธีลอง "เปลี่ยนใบพรี" ก่อนเปิด (บัญชีแอดมิน 2 บัญชี):</b> ① บัญชี B เปิดกระเป๋าพรี → จดเลขกระเป๋า 4 หลัก (กล่องเหลืองบนสุด) ②
          บัญชี A เปิดใบพรีของตัวเอง → “เปลี่ยนใบพรี” → เลือก/เพิ่มบัญชีรับเงิน → ใส่ยอด → ใส่เลขของ B → ค้นหา → ส่งข้อเสนอ ③ B ได้ push → เปิดดีล → โอน + แนบสลิป (หรือกดรับถ้ายอด 0)
          ④ A กด “ได้รับเงินแล้ว” ⑤ กลับมาหน้านี้ กดค้าง “โอนสิทธิ์” → ใบย้ายไปกระเป๋า B พร้อมเลข -T1 · ใบที่มัดจำไม่เต็มจะให้เติมก่อน แล้วสลิปมาเข้าหัวข้อ 💰 ข้างล่าง
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-b border-subtle pb-3">
        {TABS.map((t) => (
          <button type="button" key={t.key} onClick={() => setTab(t.key)}
            className={cx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-bold', tab === t.key ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2 hover:text-ink')}>
            {t.label}
            {!!t.badge && <span className={cx('rounded-full px-[7px] text-[11px] font-extrabold', tab === t.key ? 'bg-white/25 text-white' : 'bg-primary-bright text-white')}>{t.badge}</span>}
          </button>
        ))}
      </div>

      {tab === 'queue' && <QueueTab db={db} flash={flash} />}
      {tab === 'all' && <AllTab db={db} />}
      {tab === 'preview' && <PreviewTab />}
      {tab === 'sandbox' && <SandboxPanel />}
    </div>
  );
}

// ── ดีลทั้งหมด ─────────────────────────────────────────────────────────────────
function AllTab({ db }: { db: Database }) {
  const [f, setF] = useState<string>('');
  // ป้ายกลางที่ใช้ได้ทั้งกระดานและเปลี่ยนใบ (audit รอบ E R1-35)
  const ALL_CHIP: Record<string, string> = { listed: 'ลงขาย (กระดาน)', reserved: 'จอง / ข้อเสนอรอผู้รับ', paid: 'โอน/กดรับแล้ว', seller_ok: 'คนส่ง/คนขายยืนยันแล้ว', cancelled: 'ยกเลิก/ถอน', expired: 'หมดเวลา' };
  const rows = db.transfers.map((tr) => ({ tr, st: effectiveStatus(tr) }))
    .filter((x) => !f || x.st === f || (f === 'direct' && isDirect(x.tr)))
    .sort((a, b) => (b.tr.updated_at ?? b.tr.listed_at).localeCompare(a.tr.updated_at ?? a.tr.listed_at));
  const counts = new Map<string, number>();
  for (const tr of db.transfers) { const s = effectiveStatus(tr); counts.set(s, (counts.get(s) ?? 0) + 1); }
  const directCount = db.transfers.filter(isDirect).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setF('')} className={cx('rounded-full border px-3 py-1 text-[12px] font-bold', !f ? 'border-accent bg-[#b91c1c]/15 text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2')}>ทั้งหมด {db.transfers.length}</button>
        {directCount > 0 && <button type="button" onClick={() => setF('direct')} className={cx('rounded-full border px-3 py-1 text-[12px] font-bold', f === 'direct' ? 'border-accent bg-[#b91c1c]/15 text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2')}>🔁 เปลี่ยนใบ {directCount}</button>}
        {[...counts.entries()].map(([s, n]) => (
          <button type="button" key={s} onClick={() => setF(s)} className={cx('rounded-full border px-3 py-1 text-[12px] font-bold', f === s ? 'border-accent bg-[#b91c1c]/15 text-primary-soft' : 'border-subtle bg-surface-3 text-ink-muted2')}>{ALL_CHIP[s] ?? TRANSFER_STATUS_LABEL[s as TicketTransfer['status']] ?? s} {n}</button>
        ))}
      </div>
      {rows.length === 0 && <div className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center text-[13px] text-ink-muted2">ยังไม่มีดีล</div>}
      <div className="overflow-x-auto rounded-2xl border border-subtle">
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead className="bg-surface-3 text-left text-[11.5px] text-ink-faint">
            <tr><th className="px-3 py-2">สินค้า</th><th className="px-3 py-2">คนขาย → ผู้ซื้อ/ผู้รับ</th><th className="px-3 py-2 text-right">ราคา</th><th className="px-3 py-2">สถานะ</th><th className="px-3 py-2">อัปเดต</th></tr>
          </thead>
          <tbody>
            {rows.map(({ tr, st }) => (
              <tr key={tr.id} className="border-t border-hair">
                <td className="max-w-[220px] truncate px-3 py-2">{isDirect(tr) && <span className="mr-1 rounded bg-[#f1d27a]/15 px-1 text-[10px] font-bold text-[#f1d27a]">🔁</span>}{tr.product_id ? productLabel(db, tr.product_id, tr.variant_id) : '—'}{(tr.qty ?? 1) > 1 ? ` ×${tr.qty}` : ''}<div className="font-mono text-[10.5px] text-ink-faint">{tr.new_ticket_no ?? tr.prev_ticket_no ?? ''}</div></td>
                <td className="px-3 py-2">{who(db, tr.from_user_id)} <span className="text-ink-faint">→</span> {tr.to_user_id ? who(db, tr.to_user_id) : '—'}</td>
                <td className="px-3 py-2 text-right font-mono">{isDirect(tr) && (tr.asking_price ?? 0) <= 0 ? 'ฟรี' : baht(tr.asking_price)}</td>
                <td className="px-3 py-2">{dealStatusLabel(tr, st)}{tr.cancel_reason && !['seller', 'buyer_declined'].includes(tr.cancel_reason) ? <div className="text-[10.5px] text-ink-faint">{tr.cancel_reason}</div> : null}{tr.cancel_reason === 'seller' && tr.cancel_note ? <div className="text-[10.5px] text-ink-faint">เหตุผล: {tr.cancel_note}</div> : null}</td>
                <td className="px-3 py-2 text-ink-faint">{fmt(tr.updated_at ?? tr.listed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── ดูแบบลูกค้า (คอมโพเนนต์เดียวกับหน้าจริง ในกรอบมือถือ) ─────────────────────────────
function PreviewTab() {
  const [view, setView] = useState<'board' | 'mine' | 'code'>('mine');
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex gap-1.5">
        {(['mine', 'code', 'board'] as const).map((v) => (
          <button type="button" key={v} onClick={() => { setView(v); setOpenId(null); }} className={cx('rounded-lg px-3 py-1.5 text-[12.5px] font-bold', view === v ? 'bg-primary text-white' : 'border border-subtle bg-surface-3 text-ink-muted2')}>
            {v === 'board' ? 'กระดาน' : v === 'code' ? 'เลขกระเป๋าของฉัน' : 'ซื้อขาย / เปลี่ยนใบของฉัน'}
          </button>
        ))}
      </div>
      <div className="w-full max-w-[390px] overflow-hidden rounded-[32px] border border-subtle bg-base p-4 shadow-frame">
        <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] text-ink-faint"><Icon name="verified" size={12} />หน้าเดียวกับที่ลูกค้าเห็น (บัญชีแอดมินของคุณ)</div>
        {view === 'board'
          ? <MarketBoard mode="preview" />
          : view === 'code'
            ? <div className="flex flex-col gap-3"><WalletCodeChip /><div className="text-[12px] leading-relaxed text-ink-muted2">กล่องนี้อยู่บนสุดของ “กระเป๋าพรี” ของทุกคนเมื่อเปิดสวิตช์ · ให้บัญชีอีกเครื่องใส่เลขนี้ตอนกด “เปลี่ยนใบพรี” เพื่อส่งข้อเสนอมาหาบัญชีนี้</div></div>
            : openId ? <MarketDeal id={openId} mode="preview" onBack={() => setOpenId(null)} /> : <MyDeals onOpen={setOpenId} />}
      </div>
    </div>
  );
}
