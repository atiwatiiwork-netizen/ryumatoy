'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId, useAuth, canLogin } from '@/state/AuthProvider';
import { uploadImage } from '@/lib/upload';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { BackBar, cx } from '@/components/ui';
import { AuthScreen } from '@/components/AuthScreen';
import { submitSourcingRequest, resendSourcingRequest, paySourcing } from '@/data/mutations';
import { sendPush, subsForAdmins, pushEnabled } from '@/lib/push';
import { sourcingStatusOf, sourcingDaysLeft, sourcingEtaLabel, sourcingEtaConfig, transportLabel, openSourcingCount, MAX_OPEN_REQUESTS } from '@/domain/services/sourcing';
import { useSmartBack } from '@/lib/nav';
import type { SourcingRequest } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

/** ระบบหาของ — ส่งเรื่อง / ตั๋วหาของ / watchlist (ryuma-sourcing-spec). */
export default function SourcingPage() {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const { isLoggedIn } = useAuth();
  const goBack = useSmartBack('/profile');
  const [showForm, setShowForm] = useState(false);
  if (canLogin && !isLoggedIn) return <AuthScreen />;

  const mine = db.sourcingRequests.filter((r) => r.user_id === uid).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const st = (r: SourcingRequest) => sourcingStatusOf(r);
  const waiting = mine.filter((r) => st(r) === 'requested');
  const tickets = mine.filter((r) => st(r) === 'paid' || st(r) === 'working');
  const watchlist = mine.filter((r) => st(r) === 'quoted' || st(r) === 'unavailable');
  const history = mine.filter((r) => st(r) === 'expired');
  const open = openSourcingCount(db, uid);

  return (
    <div className="mx-auto max-w-[640px]">
      <BackBar title="หาของ" onBack={goBack} />
      <div className="mb-3 text-[12.5px] leading-relaxed text-ink-faint">อยากได้ตัวไหนที่ร้านยังไม่มี ส่งรูป+ชื่อมา เดี๋ยวเราหาให้ — ตอบกลับพร้อมราคา/มัดจำ แจ้งเตือนเด้งถึงมือถือ</div>

      <SourcingRules />

      {/* ① ส่งเรื่องหาของ */}
      {showForm ? (
        <RequestForm uid={uid} onDone={() => setShowForm(false)} />
      ) : (
        <button onClick={() => setShowForm(true)} disabled={open >= MAX_OPEN_REQUESTS}
          className="mb-5 flex w-full items-center justify-center gap-2 rounded-xl bg-cta py-3.5 text-sm font-bold text-white disabled:opacity-50">
          <Icon name="search" size={17} /> ส่งเรื่องหาของ {open >= MAX_OPEN_REQUESTS ? `(เต็ม ${MAX_OPEN_REQUESTS} เรื่อง — รอเรื่องเก่าจบก่อน)` : `(${open}/${MAX_OPEN_REQUESTS})`}
        </button>
      )}

      {/* ② รอร้านตอบ */}
      {waiting.length > 0 && (
        <Section title={`รอร้านตรวจสอบ (${waiting.length})`}>
          {waiting.map((r) => (
            <Card key={r.id} r={r}>
              <span className="rounded-full bg-[#d97706]/[0.15] px-2.5 py-1 text-[11px] font-bold text-[#fbbf24]">⏳ กำลังเช็คให้…</span>
            </Card>
          ))}
        </Section>
      )}

      {/* ③ ตั๋วหาของ */}
      <Section title={`ตั๋วหาของ (${tickets.length})`} empty={tickets.length === 0 ? 'ยังไม่มีตั๋วหาของ — เมื่อวางมัดจำแล้วจะแสดงที่นี่' : undefined}>
        {tickets.map((r) => <TicketCard key={r.id} r={r} />)}
      </Section>

      {/* ④ Watchlist */}
      <Section title={`Watchlist (${watchlist.length})`} empty={watchlist.length === 0 ? 'ว่าง — รายการที่รอตัดสินใจ/ยังหาไม่ได้จะอยู่ที่นี่ (มีอายุ 5 วัน)' : undefined}>
        {watchlist.map((r) => <WatchCard key={r.id} r={r} uid={uid} />)}
      </Section>

      {/* ⑤ ประวัติ */}
      {history.length > 0 && (
        <Section title={`หมดอายุ / ประวัติ (${history.length})`}>
          {history.map((r) => <HistoryCard key={r.id} r={r} open={open} />)}
        </Section>
      )}
    </div>
  );
}

/** กติกาการหาของ — ranges อ่านจาก config จริง (แอดมินแก้แล้วข้อความนี้ขยับตาม). */
function SourcingRules() {
  const db = useDatabase();
  const c = sourcingEtaConfig(db);
  const rules: { emoji: string; head: string; body: React.ReactNode }[] = [
    { emoji: '📦', head: 'สินค้าตีเป็นมือ 2 ทุกรายการ', body: 'กล่องน้ำตาลอาจเป็นกล่องอื่น ไม่ใช่กล่องของค่าย' },
    { emoji: '🚛', head: 'ราคาที่แจ้งกลับ = รวมส่งแล้ว', body: 'ไม่มีบวกเพิ่มภายหลัง' },
    { emoji: '🛡️', head: 'คืนมัดจำ 100% ทุกกรณี', body: 'หากผู้ขายไม่ส่งของ หรือรายการถูกยกเลิก' },
    { emoji: '⏱️', head: 'ระยะเวลาคร่าวๆ', body: <>🚚 รถ <b className="text-ink">{c.truck_min}-{c.truck_max} วัน</b> · 🚢 เรือ <b className="text-ink">{c.ship_min}-{c.ship_max} วัน</b><span className="block text-[11px] text-ink-faint">ปกติส่งรถ — บางช่วงด่านเข้ม รถเข้าไม่ได้ ต้องสลับเป็นเรือ</span></> },
  ];
  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-[#d4af37]/25 bg-gradient-to-br from-[#d4af37]/[0.07] to-transparent">
      <div className="border-b border-[#d4af37]/20 px-4 py-2.5 text-[13px] font-extrabold text-[#f1d27a]">📜 กติกาการหาของ</div>
      <div className="flex flex-col divide-y divide-hair">
        {rules.map((r) => (
          <div key={r.head} className="flex gap-3 px-4 py-2.5">
            <span className="text-[16px] leading-6">{r.emoji}</span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-bold text-ink">{r.head}</div>
              <div className="text-[12px] leading-relaxed text-ink-muted2">{r.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 text-[14px] font-extrabold">{title}</div>
      {empty ? <div className="rounded-xl border border-subtle bg-surface-2 p-4 text-center text-[12.5px] text-ink-faint">{empty}</div> : <div className="flex flex-col gap-2.5">{children}</div>}
    </div>
  );
}

function Card({ r, children, footer }: { r: SourcingRequest; children?: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-subtle bg-surface-2 p-3.5">
      <div className="flex gap-3">
        {r.images[0] ? <img src={r.images[0]} alt="" className="h-16 w-16 shrink-0 rounded-lg border border-subtle object-cover" /> : <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-stripe text-ink-faint"><Icon name="box" size={18} /></div>}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[13.5px] font-bold leading-tight">{r.character_name}{r.qty > 1 ? ` ×${r.qty}` : ''}</div>
            {children}
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-faint">{r.maker_name} · {r.franchise_name} · ส่งเมื่อ {fmtDate(r.created_at)}</div>
        </div>
      </div>
      {footer}
    </div>
  );
}

/** paid = รอร้านยืนยันเริ่มงาน; working = เริ่มงานแล้ว + ETA + ตามสถานะล็อตจริง */
function TicketCard({ r }: { r: SourcingRequest }) {
  const db = useDatabase();
  const product = r.product_id ? db.products.find((p) => p.id === r.product_id) : undefined;
  const ticket = r.product_id ? db.tickets.find((t) => t.product_id === r.product_id && t.owner_id === r.user_id) : undefined;
  const stLabel = product?.status === 'shipping' ? '🚚 กำลังเดินทางมาไทย' : product?.status === 'arrived' ? '📦 ถึงไทยแล้ว' : '🔧 เริ่มงานแล้ว';
  return (
    <Card r={r} children={
      r.status === 'paid'
        ? <span className="rounded-full bg-[#2563eb]/[0.15] px-2.5 py-1 text-[11px] font-bold text-[#60a5fa]">💸 รอร้านยืนยันสลิป</span>
        : <span className="rounded-full bg-[#16a34a]/[0.15] px-2.5 py-1 text-[11px] font-bold text-[#4ade80]">{stLabel}</span>
    } footer={
      <div className="mt-2.5 rounded-lg bg-surface-3/60 px-3 py-2 text-[12px] text-ink-muted2">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          <span>ราคา <b className="text-ink">{baht((r.price ?? 0) * r.qty)}</b></span>
          <span>มัดจำแล้ว <b className="text-[#4ade80]">{baht((r.deposit ?? 0) * r.qty)}</b></span>
          {r.transport && <span>{transportLabel(r.transport)}</span>}
        </div>
        {r.status === 'working' && <div className="mt-1 font-semibold text-[#bcd3f5]">{sourcingEtaLabel(db, r)}</div>}
        {ticket && <Link href={`/wallet/${encodeURIComponent(ticket.ticket_no)}`} className="mt-1 inline-block text-[12px] font-bold text-primary-soft">ดูตั๋วจริง {ticket.ticket_no} →</Link>}
      </div>
    } />
  );
}

/** quoted = ตัดสินใจก่อน (จ่ายได้เลย) / unavailable = ยังหาไม่ได้ — ทั้งคู่นับถอยหลัง 5 วัน */
function WatchCard({ r, uid }: { r: SourcingRequest; uid: string }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [paying, setPaying] = useState(false);
  const [slip, setSlip] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const days = sourcingDaysLeft(r) ?? 0;
  const account = db.paymentAccounts.find((a) => a.active);

  const onSlip = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSlip(await uploadImage(file, 'slip')); flash('แนบสลิปแล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const confirmPay = () => {
    if (!slip) return flash('แนบสลิปก่อน');
    dispatch(paySourcing(r.id, slip));
    if (pushEnabled(db, 'sourcing_paid'))
      sendPush(subsForAdmins(db), { title: '💸 มัดจำหาของเข้าแล้ว', body: `${r.character_name} · ${baht((r.deposit ?? 0) * r.qty)} — รอกดเริ่มงาน`, url: '/admin/sourcing' }, dispatch).catch(() => {});
    flash('ส่งสลิปแล้ว — รอร้านยืนยันเริ่มงาน 🎉');
  };

  return (
    <Card r={r} children={
      r.status === 'quoted'
        ? <span className={cx('rounded-full px-2.5 py-1 text-[11px] font-bold', days <= 1 ? 'animate-pulse bg-[#b91c1c]/[0.18] text-primary-soft' : 'bg-[#8b5cf6]/[0.15] text-[#c4b5fd]')}>💡 ตัดสินใจก่อน · เหลือ {days} วัน</span>
        : <span className={cx('rounded-full px-2.5 py-1 text-[11px] font-bold', days <= 1 ? 'animate-pulse bg-[#b91c1c]/[0.18] text-primary-soft' : 'bg-surface-3 text-ink-faint')}>🔍 ยังหาไม่ได้ · เหลือ {days} วัน</span>
    } footer={
      r.status === 'quoted' ? (
        <div className="mt-2.5 rounded-lg border border-[#8b5cf6]/30 bg-[#8b5cf6]/[0.06] px-3 py-2.5">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12.5px]">
            <span>ราคา <b className="text-ink">{baht((r.price ?? 0) * r.qty)}</b></span>
            <span>มัดจำ <b className="text-primary-soft">{baht((r.deposit ?? 0) * r.qty)}</b></span>
            {r.transport && <span className="text-ink-muted2">{transportLabel(r.transport)} · {sourcingEtaLabel(db, r)}</span>}
          </div>
          {!paying ? (
            <button onClick={() => setPaying(true)} className="mt-2 w-full rounded-lg bg-cta py-2.5 text-[13px] font-bold text-white">ชำระมัดจำ {baht((r.deposit ?? 0) * r.qty)}</button>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {account && <div className="rounded-lg bg-surface-3 px-3 py-2 text-[12.5px]"><span className="text-ink-faint">โอนเข้า:</span> <b>{account.name}</b> · <span className="font-mono">{account.number}</span></div>}
              <div className="flex gap-2">
                <label className={cx('flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border py-2.5 text-[12.5px] font-bold', slip ? 'border-[#16a34a]/50 text-[#4ade80]' : 'border-dashed border-accent text-ink-muted2')}>
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => onSlip(e.target.files?.[0])} />
                  {busy ? '…' : slip ? '✓ แนบสลิปแล้ว' : '📎 แนบสลิปโอน'}
                </label>
                <button onClick={confirmPay} disabled={!slip} className="rounded-lg bg-cta px-4 text-[13px] font-bold text-white disabled:opacity-50">ยืนยัน</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 text-[11.5px] text-ink-faint">หมดอายุแล้วกด "ส่งเช็คใหม่" ได้เลย — ร้านจะเช็คให้อีกรอบ</div>
      )
    } />
  );
}

function HistoryCard({ r, open }: { r: SourcingRequest; open: number }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const resend = () => {
    if (open >= MAX_OPEN_REQUESTS) return flash(`เรื่องค้างเต็ม ${MAX_OPEN_REQUESTS} — รอเรื่องเก่าจบก่อน`);
    dispatch(resendSourcingRequest(r.id));
    if (pushEnabled(db, 'sourcing_new'))
      sendPush(subsForAdmins(db), { title: '🔁 ขอเช็คของอีกครั้ง', body: `${r.character_name} · ${r.maker_name}`, url: '/admin/sourcing' }, dispatch).catch(() => {});
    flash('ส่งเรื่องเช็คใหม่แล้ว ✓');
  };
  return (
    <Card r={r} children={<span className="rounded-full bg-surface-3 px-2.5 py-1 text-[11px] font-bold text-ink-faint">หมดอายุ</span>}
      footer={<button onClick={resend} className="mt-2 rounded-lg border border-subtle bg-surface-3 px-3.5 py-2 text-[12.5px] font-bold text-ink-muted2">🔁 ส่งเช็คใหม่</button>} />
  );
}

/** ฟอร์มส่งเรื่อง — ค่าย/เรื่องเลือกจากระบบ หรือ "อื่นๆ" พิมพ์เอง · รูปบังคับ 1 (สูงสุด 3) */
function RequestForm({ uid, onDone }: { uid: string; onDone: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [makerId, setMakerId] = useState(db.manufacturers[0]?.id ?? '__other');
  const [makerName, setMakerName] = useState('');
  const [frId, setFrId] = useState(db.franchises[0]?.id ?? '__other');
  const [frName, setFrName] = useState('');
  const [cname, setCname] = useState('');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // เลือกจากสินค้าที่เคยมีในระบบ (concept 2026-07-23: พรีเก่า = ฐานข้อมูลหาของ) — เติมค่าให้อัตโนมัติ
  const [srcQ, setSrcQ] = useState('');
  const [srcId, setSrcId] = useState('');
  const srcMatches = srcQ.trim().length >= 2
    ? db.products.filter((p) => p.series_name.toLowerCase().includes(srcQ.trim().toLowerCase())).slice(0, 6)
    : [];
  const pickSource = (pid: string) => {
    const p = db.products.find((x) => x.id === pid);
    if (!p) return;
    setSrcId(pid); setSrcQ(p.series_name);
    setMakerId(p.manufacturer_id); setFrId(p.franchise_id);
    setCname(p.character_name ?? p.series_name);
    if (images.length === 0 && p.images.length) setImages(p.images.slice(0, 3)); // ใช้รูปในระบบ ไม่ต้องอัปเอง
  };

  const addImage = async (file?: File) => {
    if (!file || images.length >= 3) return;
    setBusy(true);
    try { const url = await uploadImage(file, 'sourcing'); setImages((a) => [...a, url].slice(0, 3)); flash('เพิ่มรูปแล้ว'); }
    catch { flash('อัปโหลดรูปไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const submit = () => {
    const mName = makerId === '__other' ? makerName.trim() : (db.manufacturers.find((m) => m.id === makerId)?.name ?? '');
    const fName = frId === '__other' ? frName.trim() : (db.franchises.find((f) => f.id === frId)?.name ?? '');
    if (!mName) return flash('เลือกหรือพิมพ์ชื่อค่าย');
    if (!fName) return flash('เลือกหรือพิมพ์ชื่อเรื่อง');
    if (!cname.trim()) return flash('กรอกชื่อตัวละคร');
    if (images.length === 0) return flash('แนบรูปสินค้าอย่างน้อย 1 รูป');
    dispatch(submitSourcingRequest({
      user_id: uid, maker_id: makerId === '__other' ? undefined : makerId, maker_name: mName,
      franchise_id: frId === '__other' ? undefined : frId, franchise_name: fName,
      character_name: cname.trim(), qty: Number(qty) || 1, images, note: note.trim() || undefined,
      source_product_id: srcId || undefined,
    }));
    if (pushEnabled(db, 'sourcing_new'))
      sendPush(subsForAdmins(db), { title: '🔎 มีเรื่องหาของใหม่!', body: `${cname.trim()} · ${mName} · ${fName}`, url: '/admin/sourcing' }, dispatch).catch(() => {});
    flash('ส่งเรื่องแล้ว — ร้านจะรีบเช็คให้ 🔎');
    onDone();
  };

  return (
    <div className="mb-5 rounded-2xl border border-accent-soft bg-surface-2 p-4">
      <div className="mb-3 flex items-center justify-between"><span className="font-bold">ส่งเรื่องหาของ</span><button onClick={onDone} className="text-ink-faint"><Icon name="x" size={17} /></button></div>
      <div className="flex flex-col gap-2.5">
        {/* ทางลัด: ตัวที่เคยเปิดพรีในร้าน — พิมพ์ค้นหาแล้วแตะเลือก ระบบเติมค่าย/เรื่อง/รูปให้เอง */}
        <div>
          <span className="mb-1 block text-[12px] font-semibold text-ink-muted">เคยเห็นในร้านเรา? ค้นหาจากสินค้าในระบบ (ไม่บังคับ)</span>
          <input className={inputCls} value={srcQ} onChange={(e) => { setSrcQ(e.target.value); setSrcId(''); }} placeholder="พิมพ์ชื่อ เช่น Zoro, Kaiba…" />
          {srcMatches.length > 0 && !srcId && (
            <div className="mt-1 overflow-hidden rounded-xl border border-subtle">
              {srcMatches.map((p) => (
                <button key={p.id} onClick={() => pickSource(p.id)} className="flex w-full items-center gap-2.5 border-b border-hair bg-surface-3 px-3 py-2 text-left last:border-0">
                  <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-subtle bg-stripe">
                    {p.images[0] && <img src={p.images[0]} alt="" className="h-full w-full object-cover" />}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{p.series_name}</span>
                  <span className="text-[11px] text-ink-faint">เลือก →</span>
                </button>
              ))}
            </div>
          )}
          {srcId && <div className="mt-1 text-[11.5px] font-bold text-[#4ade80]">✓ อ้างอิงสินค้าในระบบแล้ว — ค่าย/เรื่อง/รูป ถูกเติมให้อัตโนมัติ</div>}
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">ค่าย</span>
            <select className={inputCls} value={makerId} onChange={(e) => setMakerId(e.target.value)}>
              {db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              <option value="__other">อื่นๆ (พิมพ์เอง)</option>
            </select>
          </label>
          <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">เรื่อง</span>
            <select className={inputCls} value={frId} onChange={(e) => setFrId(e.target.value)}>
              {db.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              <option value="__other">อื่นๆ (พิมพ์เอง)</option>
            </select>
          </label>
        </div>
        {makerId === '__other' && <input className={inputCls} value={makerName} onChange={(e) => setMakerName(e.target.value)} placeholder="พิมพ์ชื่อค่าย เช่น LX Studio" />}
        {frId === '__other' && <input className={inputCls} value={frName} onChange={(e) => setFrName(e.target.value)} placeholder="พิมพ์ชื่อเรื่อง เช่น Slam Dunk" />}
        <div className="grid grid-cols-[1fr_92px] gap-2.5">
          <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">ชื่อตัวละคร / สินค้า</span><input className={inputCls} value={cname} onChange={(e) => setCname(e.target.value)} placeholder="เช่น Sakuragi" /></label>
          <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">จำนวน</span><input className={inputCls} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} /></label>
        </div>
        <div>
          <span className="mb-1 block text-[12px] font-semibold text-ink-muted">รูปสินค้า (บังคับ 1 · สูงสุด 3)</span>
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative h-16 w-16 overflow-hidden rounded-lg border border-subtle">
                <img src={img} alt="" className="h-full w-full object-cover" />
                <button onClick={() => setImages((a) => a.filter((_, j) => j !== i))} className="absolute right-0 top-0 grid h-5 w-5 place-items-center bg-black/60 text-white"><Icon name="x" size={12} /></button>
              </div>
            ))}
            {images.length < 3 && (
              <label className="grid h-16 w-16 cursor-pointer place-items-center rounded-lg border border-dashed border-accent bg-surface-3 text-ink-faint">
                {busy ? <Icon name="box" size={18} className="animate-pulse" /> : <Icon name="camera" size={18} />}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => addImage(e.target.files?.[0])} />
              </label>
            )}
          </div>
        </div>
        <label className="block"><span className="mb-1 block text-[12px] font-semibold text-ink-muted">โน้ตเพิ่มเติม (ไม่บังคับ)</span><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="ระบุ สี / เวอร์ชั่น ถ้ามี" /></label>
        <button onClick={submit} disabled={busy} className="rounded-xl bg-cta py-3 text-sm font-bold text-white disabled:opacity-50">🔎 ส่งเรื่องให้ร้านหา</button>
      </div>
    </div>
  );
}
