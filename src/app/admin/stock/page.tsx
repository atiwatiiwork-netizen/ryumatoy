'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { applyWatermark } from '@/lib/watermark';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { TicketPeek } from '@/components/TicketPeek';
import { franchiseOf, seriesForFranchise, stockRemaining, batchRemaining, batchSoldQty, batchBuyers, hasOpenBatch } from '@/domain/services/catalog';
import { openSpecialRound, createLegacyStockProduct, editBatch, removeBatch, closeBatch, restockSpecialRound, setProductSf, setSourcingSf, confirmWarehouse, setProductStatus } from '@/data/mutations';
import { sendPush, subsForNewProduct, subsForUsers, pushEnabled } from '@/lib/push';
import { warehouseQueue, parseWarehouseText, matchWarehouseRow } from '@/domain/services/warehouse';
import { ocrImage } from '@/lib/ocr';
import type { PreorderTicket, Product, ProductBatch, WcfType } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const labelCls = 'mb-1 block text-[12px] font-semibold text-ink-muted';
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

export default function StockPage() {
  const [tab, setTab] = useState<'legacy' | 'surplus'>('legacy');
  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">สต๊อกใบพรี</div>
      <div className="mb-5 text-[13px] text-ink-faint">เปิดขาย “พรีรอบพิเศษ” — ล็อตจำกัดจำนวนบน SKU เดิม/ของที่มีอยู่ · ราคา snapshot ไม่กระทบคนเดิม · ขายเป็นใบพรี · 1 SKU เปิดได้ทีละรอบ</div>

      <div className="mb-4 flex gap-2">
        <TabBtn active={tab === 'legacy'} onClick={() => setTab('legacy')}>สร้างเอง (ของที่มี)</TabBtn>
        <TabBtn active={tab === 'surplus'} onClick={() => setTab('surplus')}>จากปิดยอด (ส่วนเกิน)</TabBtn>
      </div>

      {tab === 'legacy' ? <LegacyCreate /> : <SurplusList />}

      <WarehouseConfirm />
      <OpenRounds />
      <History />
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cx('rounded-lg border px-4 py-2 text-[13px] font-bold', active ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{children}</button>;
}
function SubBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cx('rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold', active ? 'border-accent bg-surface-3 text-ink' : 'border-subtle bg-surface-2 text-ink-faint')}>{children}</button>;
}
function ModeToggle({ fullPay, onToggle, deposit }: { fullPay: boolean; onToggle: () => void; deposit: number }) {
  return <button onClick={onToggle} className={cx('rounded-lg border px-3 py-2 text-[12.5px] font-bold', fullPay ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted2')}>{fullPay ? 'พร้อมส่ง · จ่ายเต็ม' : `เก็บมัดจำ ${baht(deposit)}`}</button>;
}

// ── ยืนยันเข้าโกดังจีน (gate ผลิต → เดินทางมาไทย) — per-ticket ────────────────
function WarehouseConfirm() {
  const db = useDatabase();
  const queue = warehouseQueue(db);
  if (queue.length === 0) return null;
  const total = queue.reduce((s, g) => s + g.tickets.length, 0);
  return (
    <div className="mb-6 rounded-2xl border border-[#2563eb]/40 bg-[#2563eb]/[0.06] p-5">
      <div className="mb-1 font-bold text-[#bcd3f5]">📦 ยืนยันเข้าโกดังจีน ({total} ตั๋ว · {queue.length} รายการ)</div>
      <div className="mb-3 text-[12px] text-ink-faint">ของถึงโกดังจีนแล้ว → ใส่เลข SF ของค่าย → วาง/อัปโหลดตารางโกดัง → จับคู่วันเข้าโกดัง → ยืนยัน = สถานะ “กำลังส่งมาไทย” + เริ่มนับ ETA</div>
      <div className="flex flex-col gap-3">
        {queue.map((g) => <WarehouseCard key={g.product.id} product={g.product} tickets={g.tickets} sf={g.sf} />)}
      </div>
    </div>
  );
}

function WarehouseCard({ product, tickets, sf }: { product: Product; tickets: PreorderTicket[]; sf?: string }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';
  const sourcingReq = db.sourcingRequests.find((r) => r.product_id === product.id);
  const [sfInput, setSfInput] = useState(sf ?? '');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ReturnType<typeof parseWarehouseText>>([]);
  const [slip, setSlip] = useState<string | undefined>();
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrPct, setOcrPct] = useState(0);
  // manual override (used if SF not found in the table)
  const match = matchWarehouseRow(rows, sfInput);
  const [date, setDate] = useState('');
  const [transport, setTransport] = useState<'truck' | 'ship'>('truck');
  const effDate = match?.date || date;
  const effTransport = match?.transport ?? transport;

  const saveSf = () => {
    if (!sfInput.trim()) return flash('ใส่เลข SF ก่อน');
    dispatch(sourcingReq ? setSourcingSf(sourcingReq.id, sfInput.trim()) : setProductSf(product.id, sfInput.trim()));
    flash('บันทึกเลข SF แล้ว');
  };
  const parse = (raw: string) => { setText(raw); setRows(parseWarehouseText(raw)); };
  const onImage = async (file?: File) => {
    if (!file) return;
    setOcrBusy(true); setOcrPct(0);
    try {
      const url = await uploadImage(file, 'warehouse'); setSlip(url); // keep the screenshot as evidence
      const t = await ocrImage(file, setOcrPct);
      parse(t);
      flash('อ่านรูปเสร็จ — ตรวจ/แก้ก่อนยืนยัน');
    } catch { flash('อ่านรูปไม่สำเร็จ — ลองวางข้อความแทน'); }
    finally { setOcrBusy(false); }
  };
  const confirm = (t: PreorderTicket) => {
    if (!effDate) return flash('ยังไม่มีวันเข้าโกดัง — จับคู่ SF หรือใส่วันเอง');
    dispatch(confirmWarehouse(t.id, { date: effDate, transport: effTransport, slip }));
    if (pushEnabled(db, 'warehouse'))
      sendPush(subsForUsers(db, [t.owner_id]), { title: '🚢 ของถึงโกดังจีนแล้ว!', body: `${product.series_name} · กำลังส่งมาไทย — แตะดูกำหนดถึง`, url: `/wallet/${encodeURIComponent(t.ticket_no)}` }, dispatch).catch(() => {});
    flash(`ยืนยันโกดัง · ${t.ticket_no} → กำลังส่งมาไทย ✓`);
  };
  const confirmAll = () => { if (!effDate) return flash('ยังไม่มีวันเข้าโกดัง'); tickets.forEach(confirm); };

  return (
    <div className="rounded-xl border border-subtle bg-surface-2 p-3.5">
      <div className="mb-2 flex items-center gap-2">
        {product.images[0] && <img src={product.images[0]} alt="" className="h-12 w-12 rounded-lg object-cover" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-bold">{product.series_name} {sourcingReq && <span className="rounded bg-[#8b5cf6]/[0.16] px-1.5 py-0.5 text-[10px] font-bold text-[#c4b5fd]">หาของ</span>}</div>
          <div className="text-[11.5px] text-ink-faint">รอเข้าโกดัง {tickets.length} ตั๋ว · {[...new Set(tickets.map((t) => userName(t.owner_id)))].join(', ').slice(0, 60)}</div>
        </div>
      </div>

      {/* 1) เลข SF ของค่าย */}
      <div className="mb-2 flex items-end gap-2">
        <label className="flex-1 text-[11px] text-ink-faint">เลข SF ค่าย (ดูภายใน) <input className={cx(inputCls, 'mt-0.5 py-2 font-mono')} value={sfInput} onChange={(e) => setSfInput(e.target.value)} placeholder="เช่น SF5194798275423" /></label>
        <button onClick={saveSf} className="rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12px] font-bold text-ink-muted2">บันทึก SF</button>
      </div>

      {/* 2) ตารางโกดัง: อัปโหลดรูป (OCR) หรือ วางข้อความ */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#2563eb]/40 bg-[#2563eb]/[0.1] px-3 py-2 text-[12.5px] font-bold text-[#60a5fa]">
          <Icon name="camera" size={15} /> {ocrBusy ? `อ่านรูป… ${ocrPct}%` : '📷 อัปโหลดตารางโกดัง (OCR)'}
          <input type="file" accept="image/*" className="hidden" disabled={ocrBusy} onChange={(e) => onImage(e.target.files?.[0])} />
        </label>
        <span className="text-[11px] text-ink-faint">หรือวางข้อความจากเว็บโกดังด้านล่าง</span>
      </div>
      <textarea value={text} onChange={(e) => parse(e.target.value)} placeholder={'วางแถวจากตารางโกดัง เช่น:\nเรือ 5249 SF5194798275423 ... 26/06/2026 26/06/2026'} className={cx(inputCls, 'min-h-[52px] font-mono text-[11px]')} />

      {/* 3) ผลจับคู่ */}
      {rows.length > 0 && (
        <div className="mt-2 rounded-lg bg-surface-3/60 px-3 py-2 text-[12px]">
          {match ? (
            <div className="font-semibold text-[#4ade80]">✓ พบ SF ในตาราง · เข้าโกดัง <b className="text-ink">{match.date ? new Date(match.date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '— (แก้วันด้านล่าง)'}</b>{match.transport && <> · {match.transport === 'ship' ? '🚢 เรือ' : '🚚 รถ'}</>}</div>
          ) : (
            <div className="text-[#fbbf24]">อ่านได้ {rows.length} แถว แต่ไม่พบเลข SF “{sfInput || '—'}” — ตรวจเลข SF หรือใส่วันเข้าโกดังเอง</div>
          )}
        </div>
      )}

      {/* 4) วัน/ขนส่ง (เติมเองถ้าไม่พบ) + ยืนยัน */}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-ink-faint">วันเข้าโกดัง <input type="date" className={cx(inputCls, 'mt-0.5 w-[150px] py-2')} value={effDate} onChange={(e) => setDate(e.target.value)} disabled={!!match?.date} /></label>
        <label className="text-[11px] text-ink-faint">ขนส่ง <select className={cx(inputCls, 'mt-0.5 w-auto py-2')} value={effTransport} onChange={(e) => setTransport(e.target.value as 'truck' | 'ship')} disabled={!!match?.transport}><option value="truck">🚚 รถ</option><option value="ship">🚢 เรือ</option></select></label>
        <button onClick={confirmAll} disabled={!effDate} className="rounded-lg bg-cta px-4 py-2.5 text-[12.5px] font-bold text-white disabled:opacity-50">✅ ยืนยันทั้งหมด {tickets.length} ตั๋ว</button>
      </div>

      {/* per-ticket (ของมาไม่พร้อมกัน) */}
      {tickets.length > 1 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11.5px] font-semibold text-primary-soft">ยืนยันทีละตั๋ว ({tickets.length}) ▾</summary>
          <div className="mt-1.5 flex flex-col divide-y divide-hair">
            {tickets.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 py-1.5 text-[12.5px]">
                <span>{userName(t.owner_id)} · <span className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</span></span>
                <button onClick={() => confirm(t)} disabled={!effDate} className="rounded-lg bg-cta px-3 py-1.5 text-[11.5px] font-bold text-white disabled:opacity-50">ยืนยัน →</button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Tab A: legacy create (existing SKU or new SKU) ───────────────────────────
function LegacyCreate() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const st = db.settings;
  const [sub, setSub] = useState<'existing' | 'new'>('existing');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [fullPay, setFullPay] = useState(false);
  const [label, setLabel] = useState('');
  const [pid, setPid] = useState('');
  const [fr, setFr] = useState(db.franchises[0]?.id ?? '');
  const [mk, setMk] = useState(db.manufacturers[0]?.id ?? '');
  const [sid, setSid] = useState('');
  const [cname, setCname] = useState('');
  const [height, setHeight] = useState('');
  const [wcf, setWcf] = useState<WcfType>('wcf');
  const [dep, setDep] = useState(''); // custom มัดจำ — blank = ใช้เรทตามชนิด (finished goods มักใช้ 1000)
  const [startStatus, setStartStatus] = useState<'production' | 'shipping'>('shipping'); // ผลิต(รอโกดัง)/เดินทาง
  const [images, setImages] = useState<string[]>([]);
  const [imgBusy, setImgBusy] = useState(false);

  const seriesOpts = seriesForFranchise(db, fr, mk);
  const eligible = db.products.filter((p) => !p.is_stock && !hasOpenBatch(db, p.id)); // pre-order SKUs without an open round
  const rateDep = wcf === 'mega_wcf' ? st.deposit_mega : st.deposit_wcf;
  const depNum = Number(dep) || 0; // 0 = fall back to the type rate / SKU snapshot

  const addImage = async (file?: File) => {
    if (!file) return;
    setImgBusy(true);
    try { const url = await uploadImage(await applyWatermark(file), 'product'); setImages((a) => [...a, url]); flash('เพิ่มรูป + ลายน้ำแล้ว'); }
    catch { flash('อัปโหลดรูปไม่สำเร็จ'); }
    finally { setImgBusy(false); }
  };

  const openExisting = () => {
    const p = db.products.find((x) => x.id === pid);
    if (!p) return flash('เลือกสินค้า');
    if (hasOpenBatch(db, p.id)) return flash('SKU นี้มีรอบพิเศษเปิดอยู่แล้ว (ปิดรอบก่อน)');
    const q = Number(qty) || 0, pr = Number(price) || 0;
    if (q <= 0 || pr <= 0) return flash('กรอกจำนวน + ราคา');
    dispatch(openSpecialRound(p.id, { qty: q, price: pr, fullPay, label: label.trim() || undefined, addSurplus: true, deposit: depNum > 0 ? depNum : undefined }));
    if (!fullPay) dispatch(setProductStatus(p.id, startStatus)); // ผลิต(รอโกดัง) / เดินทาง
    flash(`เปิดรอบพิเศษ ${p.series_name} · ${q} ตัว @ ${baht(pr)}`);
    setQty(''); setPrice(''); setLabel(''); setDep('');
  };
  const createNew = () => {
    const q = Number(qty) || 0, pr = Number(price) || 0;
    if (!cname.trim()) return flash('กรอกชื่อตัวละคร');
    if (q <= 0 || pr <= 0) return flash('กรอกจำนวน + ราคา');
    if (!fullPay && depNum > 0 && depNum >= pr) return flash('มัดจำต้องน้อยกว่าราคาขาย (หรือสลับเป็นจ่ายเต็ม)');
    const sname = seriesOpts.find((s) => s.id === sid)?.name;
    const finalName = sname ? `${cname.trim()} - ${sname}` : cname.trim();
    dispatch(createLegacyStockProduct({ franchise_id: fr, manufacturer_id: mk, series_id: sid || undefined, character_name: cname.trim(), series_name: finalName, height_cm: height ? Number(height) : undefined, wcf_type: wcf, images, qty: q, price: pr, fullPay, label: label.trim() || undefined, deposit: depNum > 0 ? depNum : undefined, startStatus }));
    flash(`สร้าง ${finalName} + เปิดรอบพิเศษ ${q} ตัว`);
    setCname(''); setHeight(''); setQty(''); setPrice(''); setLabel(''); setDep(''); setImages([]);
  };

  return (
    <div className="mb-6 rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-3 flex gap-2">
        <SubBtn active={sub === 'existing'} onClick={() => setSub('existing')}>ผูก SKU เดิม</SubBtn>
        <SubBtn active={sub === 'new'} onClick={() => setSub('new')}>สร้าง SKU ใหม่</SubBtn>
      </div>

      {sub === 'existing' ? (
        <label className="block">
          <span className={labelCls}>เลือกสินค้า (SKU เดิมที่ยังไม่มีรอบเปิด)</span>
          <select className={inputCls} value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="">— เลือก —</option>
            {eligible.map((p) => <option key={p.id} value={p.id}>{p.series_name}</option>)}
          </select>
        </label>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="block"><span className={labelCls}>เรื่อง</span><select className={inputCls} value={fr} onChange={(e) => { setFr(e.target.value); setSid(''); }}>{db.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
          <label className="block"><span className={labelCls}>ค่าย</span><select className={inputCls} value={mk} onChange={(e) => { setMk(e.target.value); setSid(''); }}>{db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label className="block"><span className={labelCls}>ชื่อตัวละคร</span><input className={inputCls} value={cname} onChange={(e) => setCname(e.target.value)} placeholder="เช่น Luffy" /></label>
          <label className="block"><span className={labelCls}>ซีรีย์ (ไม่บังคับ)</span><select className={inputCls} value={sid} onChange={(e) => setSid(e.target.value)}><option value="">— ไม่มี —</option>{seriesOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="block"><span className={labelCls}>ชนิด</span><select className={inputCls} value={wcf} onChange={(e) => setWcf(e.target.value as WcfType)}><option value="wcf">WCF (มัดจำ {baht(st.deposit_wcf)})</option><option value="mega_wcf">Mega (มัดจำ {baht(st.deposit_mega)})</option></select></label>
          <label className="block"><span className={labelCls}>สูง (ซม.)</span><input className={inputCls} inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value.replace(/[^\d.]/g, ''))} placeholder="เช่น 8" /></label>
          <div className="sm:col-span-2">
            <span className={labelCls}>รูปสินค้า</span>
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div key={i} className="relative h-16 w-16 overflow-hidden rounded-lg border border-subtle">
                  <img src={img} alt="" className="h-full w-full object-cover" />
                  <button onClick={() => setImages((a) => a.filter((_, j) => j !== i))} className="absolute right-0 top-0 grid h-5 w-5 place-items-center bg-black/60 text-white"><Icon name="x" size={12} /></button>
                </div>
              ))}
              <label className="grid h-16 w-16 cursor-pointer place-items-center rounded-lg border border-dashed border-accent bg-surface-3 text-ink-faint">
                {imgBusy ? <Icon name="box" size={18} className="animate-pulse" /> : <Icon name="camera" size={18} />}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => addImage(e.target.files?.[0])} />
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 grid gap-2.5 sm:grid-cols-4">
        <label className="block"><span className={labelCls}>ราคาขาย (บาท)</span><input className={inputCls} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} placeholder="เช่น 1600" /></label>
        <label className="block">
          <span className={labelCls}>มัดจำ (บาท)</span>
          <input className={inputCls} inputMode="numeric" value={dep} onChange={(e) => setDep(e.target.value.replace(/[^\d]/g, ''))} disabled={fullPay}
            placeholder={fullPay ? 'จ่ายเต็ม' : sub === 'existing' ? `เดิม ${baht(db.products.find((x) => x.id === pid)?.deposit_amount ?? rateDep)}` : `เรท ${baht(rateDep)}`} />
          <span className="mt-1 block text-[10.5px] text-ink-faint">{fullPay ? '—' : 'เว้นว่าง = ใช้เรทชนิด · ของเสร็จแล้วมักใช้ 1000'}</span>
        </label>
        <label className="block"><span className={labelCls}>จำนวน</span><input className={inputCls} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} placeholder="เช่น 5" /></label>
        <label className="block"><span className={labelCls}>ชื่อล็อต (ไม่บังคับ)</span><input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="รอบพิเศษ" /></label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <ModeToggle fullPay={fullPay} onToggle={() => setFullPay((v) => !v)} deposit={depNum > 0 ? depNum : (sub === 'existing' ? (db.products.find((x) => x.id === pid)?.deposit_amount ?? rateDep) : rateDep)} />
        {!fullPay && (
          <div className="inline-flex overflow-hidden rounded-lg border border-subtle">
            {(['production', 'shipping'] as const).map((s) => (
              <button key={s} onClick={() => setStartStatus(s)} className={cx('px-3 py-2 text-[12px] font-bold', startStatus === s ? 'bg-primary text-white' : 'bg-surface-3 text-ink-muted2')}>{s === 'production' ? 'เริ่ม: ผลิต (รอโกดัง)' : 'เริ่ม: เดินทางแล้ว'}</button>
            ))}
          </div>
        )}
        <span className="text-[11.5px] text-ink-faint">{fullPay ? 'ลูกค้าจ่ายเต็มตอนสั่ง (ของอยู่ในมือ)' : startStatus === 'production' ? 'ของยังผลิต → ยืนยันโกดังก่อนเปลี่ยนเป็นเดินทาง' : 'ของออกจากจีนแล้ว'}</span>
        <button onClick={sub === 'existing' ? openExisting : createNew} className="ml-auto rounded-lg bg-cta px-5 py-2.5 text-sm font-bold text-white">เปิดรอบพิเศษ</button>
      </div>
    </div>
  );
}

// ── Tab B: open a round from a production-close surplus ──────────────────────
function SurplusList() {
  const db = useDatabase();
  const avail = db.products.filter((p) => stockRemaining(db, p) > 0 && !hasOpenBatch(db, p.id));
  const busy = db.products.filter((p) => stockRemaining(db, p) > 0 && hasOpenBatch(db, p.id));
  return (
    <div className="mb-6 rounded-2xl border border-subtle bg-surface-2 p-4">
      <div className="mb-2 text-[13px] text-ink-faint">ส่วนเกินจากการปิดยอด — เปิดรอบพิเศษได้ (ทีละรอบต่อ SKU)</div>
      {avail.length === 0 && busy.length === 0 ? <div className="py-6 text-center text-[13px] text-ink-faint">ไม่มีส่วนเกินให้ขาย</div> : (
        <div className="flex flex-col divide-y divide-hair">
          {avail.map((p) => <SurplusRow key={p.id} product={p} />)}
          {busy.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-1 py-3 text-[13px]">
              <span className="font-semibold">{p.series_name}</span>
              <span className="text-[12px] text-[#fbbf24]">กำลังเปิดรอบอยู่ · จัดการด้านล่าง</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SurplusRow({ product: p }: { product: Product }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const remaining = stockRemaining(db, p);
  const [price, setPrice] = useState(String(p.price_total));
  const [qty, setQty] = useState(String(remaining));
  const [fullPay, setFullPay] = useState(false);
  const [label, setLabel] = useState('รอบพิเศษ');
  const setQtyClamped = (v: string) => setQty(v === '' ? '' : String(Math.max(0, Math.min(Number(v) || 0, remaining))));
  const open = () => {
    const q = Math.min(Number(qty) || 0, remaining), pr = Number(price) || p.price_total;
    if (q <= 0) return flash('จำนวนต้อง > 0 และไม่เกินส่วนเกิน');
    dispatch(openSpecialRound(p.id, { qty: q, price: pr, fullPay, label: label.trim() || undefined, addSurplus: false }));
    flash(`เปิดรอบพิเศษ ${p.series_name} · ${q} ตัว`);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 py-3">
      <span className="min-w-[140px] flex-1">
        <span className="block text-sm font-semibold">{p.series_name}</span>
        <span className="block font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · ส่วนเกินเหลือ {remaining}</span>
      </span>
      <input className="w-24 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-sm outline-none" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} placeholder="ราคา" />
      <input className="w-16 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-sm outline-none" inputMode="numeric" value={qty} onChange={(e) => setQtyClamped(e.target.value)} />
      <ModeToggle fullPay={fullPay} onToggle={() => setFullPay((v) => !v)} deposit={p.deposit_amount} />
      <button onClick={open} className="rounded-lg bg-cta px-3.5 py-2 text-[12.5px] font-bold text-white">เปิดรอบ</button>
    </div>
  );
}

// ── Open rounds management + history ────────────────────────────────────────
function OpenRounds() {
  const db = useDatabase();
  const open = db.batches.filter((b) => b.status === 'open').sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return (
    <div className="mb-6">
      <div className="mb-2 text-[15px] font-bold">รอบที่เปิดอยู่ ({open.length})</div>
      <div className="rounded-2xl border border-subtle bg-surface-2 p-2 lg:p-4">
        {open.length === 0 ? <div className="py-6 text-center text-[13px] text-ink-faint">ยังไม่มีรอบเปิดอยู่</div> : (
          <div className="flex flex-col divide-y divide-hair">{open.map((b) => <RoundRow key={b.id} batch={b} />)}</div>
        )}
      </div>
    </div>
  );
}

function History() {
  const db = useDatabase();
  const closed = db.batches.filter((b) => b.status !== 'open').sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (closed.length === 0) return null;
  return (
    <div className="mb-6">
      <div className="mb-2 text-[15px] font-bold text-ink-muted">ประวัติรอบที่ปิดแล้ว ({closed.length})</div>
      <div className="rounded-2xl border border-subtle bg-surface-2 p-2 lg:p-4">
        <div className="flex flex-col divide-y divide-hair">{closed.map((b) => <RoundRow key={b.id} batch={b} readOnly />)}</div>
      </div>
    </div>
  );
}

function RoundRow({ batch: b, readOnly }: { batch: ProductBatch; readOnly?: boolean }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const p = db.products.find((x) => x.id === b.product_id);
  const sold = batchSoldQty(db, b.id);
  const remaining = batchRemaining(db, b.id, b.stock_qty);
  const buyers = batchBuyers(db, b.id);
  const tickets = db.tickets.filter((t) => t.batch_id === b.id); // full ticket rows → มัดจำ + popup
  const userName = (uid: string) => db.users.find((u) => u.id === uid)?.display_name ?? '—';
  const noBuyers = sold === 0;
  const fullPay = b.deposit_amount >= b.price_total;
  // เลขรอบของ SKU นี้ (นับตามเวลาเปิด) — ให้ log แต่ละรอบอ่านแยกกันชัดๆ
  const roundNo = db.batches.filter((x) => x.product_id === b.product_id).sort((x, y) => (x.created_at < y.created_at ? -1 : 1)).findIndex((x) => x.id === b.id) + 1;
  const soldOut = remaining <= 0;
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState<PreorderTicket | null>(null); // ตั๋วที่กดดูรายละเอียด
  const [edit, setEdit] = useState(false);
  const [ep, setEp] = useState(String(b.price_total));
  const [eq, setEq] = useState(String(b.stock_qty));
  const [el, setEl] = useState(b.label);
  const saveEdit = () => { dispatch(editBatch(b.id, { price: Number(ep) || undefined, qty: Number(eq) || undefined, label: el })); flash('แก้ไขรอบแล้ว'); setEdit(false); };

  // มีของเพิ่ม → เปิดรอบใหม่ (แสดงเมื่อรอบนี้ขายหมด หรือเป็นรอบที่ปิดไปแล้ว)
  const [restock, setRestock] = useState(false);
  const [rq, setRq] = useState('');
  const [rp, setRp] = useState(String(b.price_total));
  const [rd, setRd] = useState(String(b.deposit_amount));
  const doRestock = () => {
    const q = Number(rq) || 0;
    if (q <= 0) return flash('กรอกจำนวนที่มาเพิ่ม');
    dispatch(restockSpecialRound(b.product_id, { qty: q, price: Number(rp) || undefined, deposit: Number(rd) || undefined }));
    // อ่านรอบใหม่ที่เพิ่งเปิด (no-op dispatch) เพื่อลิงก์ push ให้ตรงรอบ
    let newBatchId = '';
    dispatch((d) => { newBatchId = d.batches.find((x) => x.product_id === b.product_id && x.status === 'open')?.id ?? ''; return d; });
    if (p && pushEnabled(db, 'restock'))
      // ส่งแค่ชื่อ + ราคา — ไม่บอกจำนวนที่มาเพิ่ม (สร้างความเร่งด่วน + ไม่เผยสต๊อก)
      sendPush(subsForNewProduct(db, p), { title: '🔥 มาเพิ่มแล้ว!', body: `${p.series_name} · เปิดรอบใหม่ ${baht(Number(rp) || b.price_total)}`, url: `/shop/${b.product_id}${newBatchId ? `?batch=${newBatchId}` : ''}` }, dispatch).catch(() => {});
    flash(`เปิดรอบใหม่ +${q} ชิ้นแล้ว 🔥 (รอบเก่าเก็บเข้าประวัติ)`);
    setRestock(false); setRq('');
  };

  return (
    <div className={cx('px-2 py-3', readOnly && 'opacity-75')}>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-[150px] flex-1 items-center gap-2 text-left">
          <Icon name="chevronRight" size={15} className={cx('text-ink-faint transition-transform', open && 'rotate-90')} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{p?.series_name ?? '—'} <span className="font-normal text-ink-faint">· {b.label}</span> <span className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-bold text-ink-muted2">รอบ {roundNo}</span></span>
            <span className="block font-mono text-[11px] text-ink-faint">เปิด {fmtDate(b.created_at)} · {baht(b.price_total)} · {fullPay ? 'จ่ายเต็ม' : `มัดจำ ${baht(b.deposit_amount)}`} · เหลือ {remaining}/{b.stock_qty} · ขาย {sold}</span>
          </span>
        </button>
        {(soldOut || readOnly) && !restock && <button onClick={() => { setRp(String(b.price_total)); setRd(String(b.deposit_amount)); setRestock(true); }} className="rounded-lg border border-[#16a34a]/45 bg-[#16a34a]/[0.12] px-2.5 py-1.5 text-[12px] font-bold text-[#4ade80]">➕ มีของเพิ่ม</button>}
        {!readOnly && noBuyers && !edit && <button onClick={() => { setEp(String(b.price_total)); setEq(String(b.stock_qty)); setEl(b.label); setEdit(true); }} className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted2">แก้ไข</button>}
        {!readOnly && noBuyers && <button onClick={() => { if (confirm('ยกเลิกรอบนี้? (ยังไม่มีคนซื้อ)')) { dispatch(removeBatch(b.id)); flash('ยกเลิกรอบแล้ว'); } }} className="rounded-lg border border-[#b91c1c]/40 bg-[#b91c1c]/[0.12] px-2.5 py-1.5 text-[12px] font-semibold text-primary-soft">ยกเลิก</button>}
        {!readOnly && <button onClick={() => { dispatch(closeBatch(b.id)); flash('ปิดรอบ · เก็บเข้าประวัติแล้ว'); }} className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted2">ปิดรอบ</button>}
      </div>

      {restock && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-[#16a34a]/35 bg-[#16a34a]/[0.06] p-2.5">
          <label className="text-[12px] text-ink-muted">มาเพิ่ม (ชิ้น)<input autoFocus className="ml-1 w-16 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-center text-sm outline-none" inputMode="numeric" value={rq} onChange={(e) => setRq(e.target.value.replace(/[^\d]/g, ''))} placeholder="5" /></label>
          <label className="text-[12px] text-ink-muted">ราคา<input className="ml-1 w-24 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-sm outline-none" inputMode="numeric" value={rp} onChange={(e) => setRp(e.target.value.replace(/[^\d]/g, ''))} /></label>
          <label className="text-[12px] text-ink-muted">มัดจำ<input className="ml-1 w-24 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-sm outline-none" inputMode="numeric" value={rd} onChange={(e) => setRd(e.target.value.replace(/[^\d]/g, ''))} /></label>
          <button onClick={doRestock} className="rounded-lg bg-cta px-4 py-2 text-[12.5px] font-bold text-white">🔥 เปิดรอบใหม่ + แจ้งลูกค้า</button>
          <button onClick={() => setRestock(false)} className="py-2 text-[12px] text-ink-faint">ยกเลิก</button>
          <span className="w-full text-[11px] text-ink-faint">รอบเก่าจะถูกเก็บเข้าประวัติ (log คนซื้อแยกรอบ) · push "🔥 มาเพิ่มแล้ว!" ถึงลูกค้าที่เปิดแจ้งเตือน</span>
        </div>
      )}

      {edit && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-surface-3 p-2">
          <label className="text-[12px] text-ink-muted">ราคา <input className="ml-1 w-24 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-sm outline-none" value={ep} onChange={(e) => setEp(e.target.value.replace(/[^\d]/g, ''))} /></label>
          <label className="text-[12px] text-ink-muted">จำนวน <input className="ml-1 w-16 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-center text-sm outline-none" value={eq} onChange={(e) => setEq(e.target.value.replace(/[^\d]/g, ''))} /></label>
          <label className="text-[12px] text-ink-muted">ชื่อ <input className="ml-1 w-28 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-sm outline-none" value={el} onChange={(e) => setEl(e.target.value)} /></label>
          <button onClick={saveEdit} className="rounded-lg bg-cta px-3 py-1.5 text-[12px] font-bold text-white">บันทึก</button>
          <button onClick={() => setEdit(false)} className="text-[12px] text-ink-faint">ยกเลิก</button>
        </div>
      )}

      {open && (
        <div className="mt-2 rounded-xl border border-subtle bg-surface-3 p-3">
          <div className="mb-2 text-[12px] font-semibold text-ink-muted">รอบ {roundNo} · เปิด {fmtDate(b.created_at)} · คนซื้อ {buyers.reduce((s, x) => s + x.qty, 0)} ตัว · แตะรายชื่อดูตั๋ว/สลิป</div>
          {tickets.length === 0 ? <div className="text-[12.5px] text-ink-faint">ยังไม่มีคนซื้อ</div> : (
            <div className="flex flex-col gap-1.5">
              {tickets.map((t) => (
                <button key={t.id} onClick={() => setPeek(t)} className="flex flex-wrap items-center justify-between gap-1 rounded-lg px-1 py-1 text-left text-[13px] hover:bg-white/[0.04]">
                  <span className="flex items-center gap-2"><Icon name="user" size={13} className="text-primary-soft" /> {userName(t.owner_id)}</span>
                  <span className="text-ink-muted">×{t.qty} · มัดจำ <b className="text-[#4ade80]">{baht(t.deposit_paid)}</b> · รวม <b className="text-ink">{baht(t.deposit_paid + t.remaining_amount)}</b> · <span className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</span> · {fmtDate(t.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {peek && <TicketPeek ticket={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}
