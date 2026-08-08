'use client';

import { useState } from 'react';
import { AdminTabs } from '@/components/AdminTabs';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { applyWatermark } from '@/lib/watermark';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { TicketPeek } from '@/components/TicketPeek';
import { franchiseOf, manufacturerOf, seriesForFranchise, stockRemaining, batchRemaining, batchSoldQty, batchBuyers, hasOpenBatch, productLabel } from '@/domain/services/catalog';
import { openSpecialRound, departSpecialRound, revertRoundStatus, createLegacyStockProduct, editBatch, removeBatch, closeBatch, uncloseBatch, restockSpecialRound, setProductSf, setSourcingSf, confirmWarehouse, setProductStatus, arriveSpecialRound, publishBatch, grantSpecialTicket, grantSpecialTickets, grantFromSurplus, setSpecialGate, logActivity } from '@/data/mutations';
import { useCurrentUserId } from '@/state/AuthProvider';
import { BulkNewSku } from './BulkNewSku';
import { reserveTicketNos } from '@/lib/ticketno';
import { ticketPrefixCounts, specialGateEnabled } from '@/domain/services/tickets';
import { ticketSourceOf, ticketOrigin } from '@/domain/services/ticketSource';
import { pendingHeld } from '@/domain/services/reservations';
import { store } from '@/data/store';
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
      <AdminTabs tabs={[{ href: '/admin/products', label: '📦 Pre-Order' }, { href: '/admin/instock', label: '🏪 In-Stock' }, { href: '/admin/stock', label: '⚡ สต๊อกใบพรี' }]} />
      <div className="mb-1 text-2xl font-extrabold">สต๊อกใบพรี</div>
      <div className="mb-3 text-[13px] text-ink-faint">เปิดขาย “พรีรอบพิเศษ” — ล็อตจำกัดจำนวนบน SKU เดิม/ของที่มีอยู่ · ราคา snapshot ไม่กระทบคนเดิม · ขายเป็นใบพรี · 1 SKU เปิดได้ทีละรอบ</div>

      <SpecialGateSwitch />

      <div className="mb-4 flex gap-2">
        <TabBtn active={tab === 'legacy'} onClick={() => setTab('legacy')}>สร้างเอง (ของที่มี)</TabBtn>
        <TabBtn active={tab === 'surplus'} onClick={() => setTab('surplus')}>จากปิดยอด (ส่วนเกิน)</TabBtn>
      </div>

      {tab === 'legacy' ? <LegacyCreate /> : <SurplusList />}

      <WarehouseConfirm />
      <OpenRounds />
      <History />
      <GrantLog />
      <RoundLog />
    </div>
  );
}

/** สวิตช์ gate รอบพิเศษ (เจ้าของ 2026-07-23): เปิด = ต้องมีใบพรีถึงซื้อรอบพิเศษได้ · ปิด = ใครก็ซื้อได้ (ช่วงโปร) */
function SpecialGateSwitch() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const on = specialGateEnabled(db);
  return (
    <div className={cx('mb-4 flex flex-wrap items-center gap-3 rounded-2xl border p-4', on ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.06]' : 'border-[#d97706]/40 bg-[#d97706]/[0.06]')}>
      <div className="min-w-0 flex-1">
        <div className={cx('text-[13.5px] font-bold', on ? 'text-[#4ade80]' : 'text-[#fbbf24]')}>
          🔒 Gate รอบพิเศษ: {on ? 'เปิดอยู่ — เฉพาะลูกค้าที่มีใบพรี' : 'ปิดอยู่ — ใครก็ซื้อรอบพิเศษได้'}
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-faint">
          {on ? 'ลูกค้าที่ไม่เคยพรีจะซื้อรอบพิเศษไม่ได้ (พ่วงพรีปกติในตะกร้า = ผ่าน) — กันคนมาเอาแต่ของพิเศษ' : 'ปิดชั่วคราวได้ เช่น ช่วงจัดโปรเปิดให้ทุกคน — เปิดกลับเมื่อไหร่ก็ได้'}
        </div>
      </div>
      <button
        onClick={() => { dispatch(setSpecialGate(!on)); flash(!on ? '🔒 เปิด Gate แล้ว — เฉพาะลูกค้ามีใบพรี' : '🔓 ปิด Gate แล้ว — ใครก็ซื้อรอบพิเศษได้'); }}
        className={cx('rounded-xl px-4 py-2.5 text-[13px] font-bold', on ? 'bg-cta text-white' : 'border border-[#16a34a]/50 bg-[#16a34a]/[0.14] text-[#4ade80]')}
      >
        {on ? 'ปิด Gate (เปิดให้ทุกคน)' : 'เปิด Gate'}
      </button>
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
  const [transport, setTransport] = useState<'truck' | 'ship' | ''>('');
  // ค่าที่แอดมินพิมพ์เองต้องชนะค่าที่ OCR อ่านมาเสมอ (ตัวอ่านหยิบวันแรกในแถว ซึ่งอาจเป็นวันออกไม่ใช่วันเข้า)
  // ว่าง = ใช้ค่าที่อ่านได้ (audit #14)
  const effDate = date || match?.date || '';
  const effTransport = transport || match?.transport || 'truck';

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
  const pushArrived = (owner_id: string, ticket_no: string) => {
    if (pushEnabled(db, 'warehouse'))
      sendPush(subsForUsers(db, [owner_id]), { title: '🚢 ของถึงโกดังจีนแล้ว!', body: `${product.series_name} · กำลังส่งมาไทย — แตะดูกำหนดถึง`, url: `/wallet/${encodeURIComponent(ticket_no)}` }, dispatch).catch(() => {});
  };
  const confirm = (t: PreorderTicket) => {
    if (!effDate) return flash('ยังไม่มีวันเข้าโกดัง — จับคู่ SF หรือใส่วันเอง');
    dispatch(confirmWarehouse(t.id, { date: effDate, transport: effTransport, slip }));
    pushArrived(t.owner_id, t.ticket_no);
    flash(`ยืนยันโกดัง · ${t.ticket_no} → กำลังส่งมาไทย ✓`);
  };
  const confirmAll = () => {
    if (!effDate) return flash('ยังไม่มีวันเข้าโกดัง');
    tickets.forEach((t) => dispatch(confirmWarehouse(t.id, { date: effDate, transport: effTransport, slip })));
    // push ONCE per owner — a customer who bought N units of the round shouldn't get N identical alerts
    const seen = new Set<string>();
    for (const t of tickets) { if (!seen.has(t.owner_id)) { seen.add(t.owner_id); pushArrived(t.owner_id, t.ticket_no); } }
    flash(`ยืนยันโกดัง ${tickets.length} ตั๋ว → กำลังส่งมาไทย ✓`);
  };

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
        {/* ⚠ ต้องแก้ทับค่าที่ OCR อ่านได้เสมอ — ตัวอ่านหยิบ "วันแรกที่เจอในแถว" ซึ่งบางตารางเป็นวันออกโกดัง
            ไม่ใช่วันเข้า ถ้าล็อกช่องไว้ แอดมินจะยืนยันวันผิดทั้งรอบ แล้ว ETA ที่ลูกค้าเห็นก็เพี้ยนตาม (audit #14) */}
        <label className="text-[11px] text-ink-faint">วันเข้าโกดัง <input type="date" className={cx(inputCls, 'mt-0.5 w-[150px] py-2')} value={effDate} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="text-[11px] text-ink-faint">ขนส่ง <select className={cx(inputCls, 'mt-0.5 w-auto py-2')} value={effTransport} onChange={(e) => setTransport(e.target.value as 'truck' | 'ship')}><option value="truck">🚚 รถ</option><option value="ship">🚢 เรือ</option></select></label>
        {match?.date && <span className="text-[10.5px] text-ink-faint">อ่านจากตาราง — แก้ทับได้ถ้าคอลัมน์ไม่ตรง</span>}
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
  const [bulk, setBulk] = useState(false); // สร้าง SKU ใหม่ทีละหลายรายการ (เจ้าของ 2026-07-26)
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
  // ผลิต(รอโกดัง)/เดินทาง — default ผลิต (เจ้าของ 2026-07-28: ของสั่งใหม่เริ่มที่ผลิตแทบทุกล็อต
  // และ default เดิม 'shipping' ทำให้ SKU ขึ้น "กำลังเดินทาง" เองโดยไม่ได้ตั้งใจ)
  const [startStatus, setStartStatus] = useState<'production' | 'shipping'>('production');
  // DEFAULT = ร่าง (เจ้าของ 2026-07-20: "กดสร้างแล้วยังไม่เปิดขาย — แอดมินมากดเองถึงจะเปิดขาย + push")
  // สลับเป็น 🚀 ได้ถ้าอยากเปิดขาย+แจ้งลูกค้าทันทีตอนสร้าง
  const [publish, setPublish] = useState(false);
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

  // push "เปิดพรีรอบพิเศษ" → ลูกค้าตามตัวกรองค่าย/เรื่อง. DNA: ห้ามใส่จำนวน/สต๊อกเด็ดขาด
  // (สร้าง urgency + ไม่เผยว่ามีของกี่ชิ้น — เหมือน restock). ปิด/เปิด toggle ที่ Push Control key 'restock'.
  const pushNewRound = (target: { manufacturer_id: string; franchise_id: string }, name: string, url: string, pr: number, dep: number, fp: boolean) => {
    if (!pushEnabled(db, 'restock')) return;
    sendPush(subsForNewProduct(db, target), { title: '🔥 เปิดพรีรอบพิเศษ!', body: `${name} · ${baht(pr)}${fp ? ' · พร้อมส่ง' : ` · มัดจำ ${baht(dep)}`}`, url }, dispatch).catch(() => {});
  };

  const openExisting = () => {
    const p = db.products.find((x) => x.id === pid);
    if (!p) return flash('เลือกสินค้า');
    if (hasOpenBatch(db, p.id)) return flash('SKU นี้มีรอบพิเศษเปิดอยู่แล้ว (ปิดรอบก่อน)');
    const q = Number(qty) || 0, pr = Number(price) || 0;
    if (q <= 0 || pr <= 0) return flash('กรอกจำนวน + ราคา');
    // startStatus เข้า mutation ตรงๆ — เซ็ตเฉพาะตัวสินค้า ไม่ cascade ตั๋วรอบเก่า (concept 2026-07-23:
    // รอบพิเศษเลือกจุดเริ่ม ผลิต/เดินทาง ได้แม้ SKU มีผู้พรีเดิม; full-pay = ของในมือ → arrived)
    dispatch(openSpecialRound(p.id, { qty: q, price: pr, fullPay, label: label.trim() || undefined, addSurplus: true, deposit: depNum > 0 ? depNum : undefined, published: publish, startStatus: fullPay ? 'arrived' : startStatus }));
    if (publish) pushNewRound(p, p.series_name, `/shop/${p.id}`, pr, fullPay ? pr : (depNum > 0 ? depNum : p.deposit_amount), fullPay);
    flash(`เปิดรอบพิเศษ ${p.series_name} · ${q} ตัว @ ${baht(pr)}${publish ? ' · แจ้งลูกค้าแล้ว' : ' · ร่างไว้ (ยังไม่ขึ้นหน้าร้าน)'}`);
    setQty(''); setPrice(''); setLabel(''); setDep('');
  };
  const createNew = () => {
    const q = Number(qty) || 0, pr = Number(price) || 0;
    if (!cname.trim()) return flash('กรอกชื่อตัวละคร');
    if (q <= 0 || pr <= 0) return flash('กรอกจำนวน + ราคา');
    if (!fullPay && depNum > 0 && depNum >= pr) return flash('มัดจำต้องน้อยกว่าราคาขาย (หรือสลับเป็นจ่ายเต็ม)');
    const sname = seriesOpts.find((s) => s.id === sid)?.name;
    const finalName = sname ? `${cname.trim()} - ${sname}` : cname.trim();
    dispatch(createLegacyStockProduct({ franchise_id: fr, manufacturer_id: mk, series_id: sid || undefined, character_name: cname.trim(), series_name: finalName, height_cm: height ? Number(height) : undefined, wcf_type: wcf, images, qty: q, price: pr, fullPay, label: label.trim() || undefined, deposit: depNum > 0 ? depNum : undefined, startStatus, published: publish }));
    // อ่าน id สินค้าที่เพิ่งสร้าง (no-op dispatch) เพื่อลิงก์ push ให้ตรงตัว
    let newPid = '';
    dispatch((d) => { newPid = d.products.find((x) => x.manufacturer_id === mk && x.franchise_id === fr && x.series_name === finalName)?.id ?? ''; return d; });
    if (publish) pushNewRound({ manufacturer_id: mk, franchise_id: fr }, finalName, newPid ? `/shop/${newPid}` : '/shop', pr, fullPay ? pr : (depNum > 0 ? depNum : rateDep), fullPay);
    flash(`สร้าง ${finalName} + เปิดรอบพิเศษ ${q} ตัว${publish ? ' · แจ้งลูกค้าแล้ว' : ' · ร่างไว้ (มอบตั๋ว/กดเปิดขายทีหลัง)'}`);
    setCname(''); setHeight(''); setQty(''); setPrice(''); setLabel(''); setDep(''); setImages([]);
  };

  // โหมดหลายรายการ = คนละฟอร์มไปเลย (ระบบเดียวกับ "เพิ่มสินค้าหลายรายการ" ของ Pre-Order)
  if (bulk) return <BulkNewSku onDone={() => setBulk(false)} />;

  return (
    <div className="mb-6 rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-3 flex flex-wrap gap-2">
        <SubBtn active={sub === 'existing'} onClick={() => setSub('existing')}>ผูก SKU เดิม</SubBtn>
        <SubBtn active={sub === 'new'} onClick={() => setSub('new')}>สร้าง SKU ใหม่</SubBtn>
        {sub === 'new' && (
          <button onClick={() => setBulk(true)} className="ml-auto rounded-lg border border-[#8b5cf6]/50 bg-[#8b5cf6]/[0.12] px-3 py-1.5 text-[12.5px] font-bold text-[#c4b5fd]">
            📸 สร้างหลายรายการ (เลือกรูปทีเดียว)
          </button>
        )}
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
        {/* ร่าง: ยังไม่ขึ้นหน้าร้าน — ไว้ไล่เก็บใบพรีเก่า (มอบตั๋วลูกค้าเดิมก่อน ค่อยกด 🚀 เปิดขาย) */}
        <button onClick={() => setPublish((v) => !v)} className={cx('rounded-lg border px-3 py-2 text-[12.5px] font-bold', publish ? 'border-[#16a34a]/50 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-[#d97706]/50 bg-[#d97706]/[0.14] text-[#fbbf24]')}>
          {publish ? '🚀 เปิดขายทันที + แจ้งลูกค้า' : '📝 ร่างไว้ก่อน (ยังไม่ขึ้นหน้าร้าน)'}
        </button>
        <button onClick={sub === 'existing' ? openExisting : createNew} className="ml-auto rounded-lg bg-cta px-5 py-2.5 text-sm font-bold text-white">{publish ? 'เปิดรอบพิเศษ' : 'สร้างรอบ (ร่าง)'}</button>
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
  const [grant, setGrant] = useState(false);
  const setQtyClamped = (v: string) => setQty(v === '' ? '' : String(Math.max(0, Math.min(Number(v) || 0, remaining))));
  const open = () => {
    const q = Math.min(Number(qty) || 0, remaining), pr = Number(price) || p.price_total;
    if (q <= 0) return flash('จำนวนต้อง > 0 และไม่เกินส่วนเกิน');
    dispatch(openSpecialRound(p.id, { qty: q, price: pr, fullPay, label: label.trim() || undefined, addSurplus: false }));
    // DNA: push ไม่บอกจำนวน/สต๊อก (key 'restock')
    if (pushEnabled(db, 'restock'))
      sendPush(subsForNewProduct(db, p), { title: '🔥 เปิดพรีรอบพิเศษ!', body: `${p.series_name} · ${baht(pr)}${fullPay ? ' · พร้อมส่ง' : ` · มัดจำ ${baht(p.deposit_amount)}`}`, url: `/shop/${p.id}` }, dispatch).catch(() => {});
    flash(`เปิดรอบพิเศษ ${p.series_name} · ${q} ตัว · แจ้งลูกค้าแล้ว`);
  };
  return (
    <div className="px-1 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-[140px] flex-1">
          <span className="block text-sm font-semibold">{p.series_name}</span>
          <span className="block font-mono text-[11px] text-ink-faint">{franchiseOf(db, p)?.abbr.toUpperCase()} · ส่วนเกินเหลือ {remaining}</span>
        </span>
        <input className="w-24 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-sm outline-none" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} placeholder="ราคา" />
        <input className="w-16 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-sm outline-none" inputMode="numeric" value={qty} onChange={(e) => setQtyClamped(e.target.value)} />
        <ModeToggle fullPay={fullPay} onToggle={() => setFullPay((v) => !v)} deposit={p.deposit_amount} />
        {/* มอบตั๋วได้เลยโดยไม่ต้องประกาศขายก่อน (เจ้าของ 2026-08-08) — ระบบเปิด "รอบร่าง" ให้เอง */}
        <button onClick={() => setGrant((v) => !v)} className={cx('rounded-lg border px-3 py-2 text-[12.5px] font-bold', grant ? 'border-[#8b5cf6] bg-[#8b5cf6] text-white' : 'border-[#8b5cf6]/50 bg-[#8b5cf6]/[0.12] text-[#c4b5fd]')}>🎁 มอบตั๋ว</button>
        <button onClick={open} className="rounded-lg bg-cta px-3.5 py-2 text-[12.5px] font-bold text-white">เปิดรอบ</button>
      </div>
      {grant && <SurplusGrant product={p} remaining={remaining} defaultPrice={Number(price) || p.price_total} onDone={() => setGrant(false)} />}
    </div>
  );
}

/**
 * มอบตั๋วจากแถวส่วนเกินโดยตรง (ยังไม่ได้เปิดรอบ) — ระบบเปิด "รอบร่าง" (ไม่ขึ้นหน้าร้าน) ให้เองแล้วออกตั๋ว
 * ในจังหวะเดียว. ใช้ตอนไล่เก็บใบพรีเก่า/ลูกค้าที่ตกลงราคากันไว้แล้ว — ยังไม่อยากประกาศขายให้คนอื่น
 * แยกเป็นคอมโพเนนต์ระดับบนสุด (DNA: ห้ามประกาศคอมโพเนนต์ลูกในฟังก์ชันหน้า — ฟอร์มจะถูกล้างทุก re-render)
 */
function SurplusGrant({ product: p, remaining, defaultPrice, onDone }: { product: Product; remaining: number; defaultPrice: number; onDone: () => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const adminId = useCurrentUserId();
  const [user, setUser] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState(String(defaultPrice || p.price_total));
  const [dep, setDep] = useState(String(p.deposit_amount));
  const [busy, setBusy] = useState(false);
  const buyers = db.users.filter((u) => u.approved !== false && !u.is_admin).sort((a, x) => a.display_name.localeCompare(x.display_name));

  const submit = async () => {
    const u = db.users.find((x) => x.id === user);
    const q = Number(qty) || 0;
    const priceEach = Number(price) || 0;
    const depEach = Math.max(0, Number(dep) || 0);
    if (!u) return flash('เลือกลูกค้าก่อน');
    if (q < 1 || q > remaining) return flash(`จำนวนต้อง 1–${remaining} (ส่วนเกินที่เหลือ)`);
    if (priceEach <= 0) return flash('ใส่ราคาขายก่อน');
    if (depEach > priceEach) return flash(`มัดจำต่อชิ้นเกินราคา (${baht(priceEach)})`);
    const due = Math.max(0, priceEach - depEach) * q;
    if (!confirm(`มอบตั๋ว ${p.series_name} ×${q} ให้ "${u.display_name}"\nราคา ${baht(priceEach)}/ชิ้น · มัดจำรับแล้ว ${baht(depEach)}/ชิ้น · ค้าง ${baht(due)}\n\nระบบจะเปิด "รอบร่าง" ให้อัตโนมัติ (ยังไม่ขึ้นหน้าร้าน) แล้วตัดส่วนเกิน ${q} ชิ้น\nเหลือ ${remaining - q} ชิ้น — กด 🚀 เปิดขาย ทีหลังถ้าจะขายต่อ`)) return;
    setBusy(true);
    try {
      const startNos = await reserveTicketNos(ticketPrefixCounts(db, [p.id]));
      // อ่านจำนวนตั๋ว "ตอนนี้" หลังรอ RPC — ห้ามใช้ db ที่ผูกไว้ตอน render (poll อาจดึงข้อมูลใหม่เข้ามาระหว่างรอ)
      let before = 0;
      dispatch((d) => { before = d.tickets.length; return d; });
      dispatch(grantFromSurplus(p.id, u.id, { qty: q, priceEach, depEach, label: 'ไล่เก็บใบพรี', startNos }));
      let made = 0;
      let no = '';
      dispatch((d) => {
        made = d.tickets.length - before;
        no = d.tickets.find((t) => t.owner_id === u.id && t.product_id === p.id)?.ticket_no ?? '';
        return d;
      });
      // grantFromSurplus คืน db เดิมเมื่อของไม่พอ/ค่าพัง — ห้ามขึ้น ✓ หรือยิง push ถ้าไม่มีตั๋วเกิดจริง
      if (made <= 0) return flash('มอบตั๋วไม่สำเร็จ — ของไม่พอ (อาจมีลูกค้าอื่นกันไว้อยู่) ลองรีเฟรชแล้วเช็คจำนวนอีกที');
      if (await store.flush()) return flash('บันทึกไม่สำเร็จ — ยังไม่ได้แจ้งลูกค้า ลองมอบใหม่อีกครั้ง');
      dispatch(logActivity(adminId, 'grant_ticket', `มอบตั๋ว ${p.series_name} ×${q} ให้ ${u.display_name} (จากส่วนเกิน · เปิดรอบร่างให้อัตโนมัติ)`, { targetId: p.id, targetLabel: no || p.series_name, amount: depEach * q }));
      // DNA: push ห้ามบอกจำนวนสต๊อก — บอกได้แค่ชื่อของและจำนวนตั๋วที่ "ลูกค้าคนนี้" ได้
      if (pushEnabled(db, 'order_approved'))
        sendPush(subsForUsers(db, [u.id]), { title: '🎫 ได้รับใบพรีแล้ว!', body: `${p.series_name} ×${q} — แตะดูตั๋วของคุณ`, url: no ? `/wallet/${encodeURIComponent(no)}` : '/wallet' }, dispatch).catch(() => {});
      flash(`มอบตั๋ว ${no || ''} ให้ ${u.display_name} แล้ว ✓ (ส่วนเกินเหลือ ${remaining - q})`);
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-2.5 rounded-xl border border-[#8b5cf6]/40 bg-[#8b5cf6]/[0.07] p-3">
      <div className="mb-2 text-[11.5px] font-bold text-[#c4b5fd]">🎁 มอบตั๋วเลย (ไม่ต้องเปิดขายหน้าร้าน) — ส่วนเกินเหลือ {remaining} ชิ้น</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[190px] flex-1 text-[10.5px] text-ink-faint">ลูกค้า
          <select className={cx(inputCls, 'mt-0.5 py-2 text-[12.5px]')} value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">— เลือกลูกค้า —</option>
            {buyers.map((u) => <option key={u.id} value={u.id}>{u.display_name}{u.member_code ? ` · ${u.member_code}` : ''}{u.phone ? ` · ${u.phone}` : ''}</option>)}
          </select>
        </label>
        <label className="text-[10.5px] text-ink-faint">จำนวน<input className={cx(inputCls, 'mt-0.5 w-14 py-2 text-center text-[12.5px]')} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} /></label>
        <label className="text-[10.5px] text-ink-faint">ราคา/ชิ้น<input className={cx(inputCls, 'mt-0.5 w-20 py-2 text-center text-[12.5px]')} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} /></label>
        <label className="text-[10.5px] text-ink-faint">มัดจำรับแล้ว/ชิ้น<input className={cx(inputCls, 'mt-0.5 w-24 py-2 text-center text-[12.5px]')} inputMode="numeric" value={dep} onChange={(e) => setDep(e.target.value.replace(/[^\d]/g, ''))} /></label>
        <span className="text-[10.5px] text-ink-faint">ค้างรวม<b className="mt-0.5 block text-center text-[12.5px] text-primary-soft">{baht(Math.max(0, (Number(price) || 0) - (Number(dep) || 0)) * (Number(qty) || 0))}</b></span>
        <button onClick={submit} disabled={busy || !user} className="rounded-lg bg-[#8b5cf6] px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-50">{busy ? 'กำลังออกตั๋ว…' : '✓ มอบตั๋ว'}</button>
      </div>
    </div>
  );
}

// ── มอบตั๋วหลายรายการทีเดียว (เจ้าของ 2026-07-20: เลือกลูกค้า 1 คน + หลายสินค้า → มอบครั้งเดียว) ──
function MultiGrant({ batches }: { batches: ProductBatch[] }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const adminId = useCurrentUserId();
  const [openPanel, setOpenPanel] = useState(false);
  const [userSel, setUserSel] = useState('');
  const [rows, setRows] = useState<Record<string, { on: boolean; qty: string; dep: string; price: string }>>({});
  const [busy, setBusy] = useState(false);
  const grantables = db.users.filter((u) => u.approved !== false && !u.is_admin).sort((a, x) => a.display_name.localeCompare(x.display_name));
  const eligible = batches.filter((b) => batchRemaining(db, b.id, b.stock_qty) > 0);
  // ราคา/มัดจำเริ่มต้น = ของรอบ แต่แอดมินพิมพ์ทับได้รายรายการ (snapshot ลงตั๋วใบนั้นใบเดียว)
  const row = (b: ProductBatch) => rows[b.id] ?? { on: false, qty: '1', dep: String(b.deposit_amount), price: String(b.price_total) };
  const setRow = (b: ProductBatch, patch: Partial<{ on: boolean; qty: string; dep: string; price: string }>) => setRows((r) => ({ ...r, [b.id]: { ...row(b), ...patch } }));
  const chosen = eligible.filter((b) => row(b).on);

  const doGrant = async () => {
    const u = db.users.find((x) => x.id === userSel);
    if (!u) return flash('เลือกลูกค้าก่อน');
    if (chosen.length === 0) return flash('ติ๊กเลือกอย่างน้อย 1 รายการ');
    for (const b of chosen) {
      const q = Number(row(b).qty) || 0;
      const rem = batchRemaining(db, b.id, b.stock_qty);
      const p = db.products.find((x) => x.id === b.product_id);
      if (q < 1 || q > rem) return flash(`${p?.series_name}: จำนวนต้อง 1–${rem}`);
      const pr = Number(row(b).price) || 0;
      if (pr <= 0) return flash(`${p?.series_name}: ใส่ราคาขายก่อน`);
      if ((Number(row(b).dep) || 0) > pr) return flash(`${p?.series_name}: มัดจำเกินราคาที่ตั้งไว้ (${baht(pr)})`);
    }
    const summary = chosen.map((b) => {
      const pr = Number(row(b).price) || 0, dp = Number(row(b).dep) || 0;
      const diff = pr !== b.price_total ? ` ⚠ ราคาเฉพาะใบนี้ (รอบ ${baht(b.price_total)})` : '';
      return `• ${db.products.find((x) => x.id === b.product_id)?.series_name} ×${row(b).qty} · ราคา ${baht(pr)} มัดจำ ${baht(dp)}/ชิ้น · ค้าง ${baht(Math.max(0, pr - dp))}/ชิ้น${diff}`;
    }).join('\n');
    if (!confirm(`มอบตั๋ว ${chosen.length} รายการ ให้ "${u.display_name}"\n${summary}`)) return;
    setBusy(true);
    try {
      // จองเลขตั๋วจาก server ทีเดียวทั้งชุด (นับต่อ prefix) — allocator ใน mutation แชร์ตัวนับ ไม่ชนกัน
      const startNos = await reserveTicketNos(ticketPrefixCounts(db, chosen.map((b) => b.product_id)));
      const want = chosen.reduce((s, b) => s + (Number(row(b).qty) || 1), 0);
      // อ่าน "จำนวนตอนนี้จริงๆ" หลังรอ RPC — ห้ามใช้ db ที่ผูกไว้ตอน render (poll อาจดึงตั๋วคนอื่นเข้ามา
      // ระหว่างรอ แล้วทำให้ read-back คิดว่าออกตั๋วสำเร็จทั้งที่ไม่มีอะไรเกิดเลย) audit regression #6
      let before = 0;
      dispatch((d) => { before = d.tickets.length; return d; });
      dispatch(grantSpecialTickets(u.id, chosen.map((b) => ({ batchId: b.id, qty: Number(row(b).qty) || 1, depEach: Math.max(0, Number(row(b).dep) || 0), priceEach: Number(row(b).price) || 0 })), startNos));
      // ⚠ grantSpecialTickets ข้ามรายการที่ของไม่พอแบบเงียบๆ (continue) และหน้าจอเช็คแค่ "ตั๋วที่ออกแล้ว"
      //   ไม่ได้หัก hold ที่ลูกค้าคนอื่นค้างอยู่ → เคยขึ้น "มอบตั๋วแล้ว ✓" + ยิง push ทั้งที่ไม่มีตั๋วเกิดเลย
      //   (เงินที่เก็บนอกระบบหายไปเฉยๆ) audit money #7
      let issued = 0;
      let issuedNos: string[] = [];
      dispatch((d) => {
        issued = d.tickets.length - before;
        // ตั๋วใหม่ถูกใส่หัวรายการ — เก็บเลขไว้ผูกกับ activity log (ประวัติการมอบตั๋วจะได้รู้ว่าใครมอบ)
        issuedNos = d.tickets.slice(0, Math.max(0, issued)).map((t) => t.ticket_no);
        return d;
      });
      if (issued === 0) { setBusy(false); return flash('มอบตั๋วไม่สำเร็จ — ของไม่พอ (มีลูกค้าอื่นกันไว้อยู่) ลองรีเฟรชแล้วเช็คจำนวนอีกที'); }
      if (await store.flush()) { setBusy(false); return flash('บันทึกไม่สำเร็จ — ยังไม่ได้แจ้งลูกค้า ลองมอบใหม่อีกครั้ง'); }
      // ร่องรอย: การมอบตั๋วคือ "เงินนอกระบบ" — ต้องรู้ว่าใครมอบ ให้ใคร เมื่อไหร่ รับมัดจำมาเท่าไหร่
      dispatch(logActivity(adminId, 'grant_ticket', `มอบตั๋ว ${issued} ใบ (${chosen.length} รายการ) ให้ ${u.display_name}`, {
        targetId: u.id,
        targetLabel: issuedNos.join(' '),
        amount: chosen.reduce((s, b) => s + Math.max(0, Number(row(b).dep) || 0) * (Number(row(b).qty) || 1), 0),
      }));
      if (issued < want) flash(`⚠ มอบได้ ${issued} จาก ${want} ใบ — บางรายการของไม่พอ`);
      // push ครั้งเดียว บอกว่าได้รายการไหนมาเพิ่ม (DNA: ไม่บอกจำนวนสต๊อก)
      if (pushEnabled(db, 'order_approved')) {
        const names = chosen.map((b) => db.products.find((x) => x.id === b.product_id)?.series_name ?? '').filter(Boolean);
        sendPush(subsForUsers(db, [u.id]), { title: `🎫 ได้รับใบพรีใหม่ ${chosen.length} รายการ!`, body: `${names.join(' · ').slice(0, 110)} — แตะดูตั๋วของคุณ`, url: '/wallet' }, dispatch).catch(() => {});
      }
      flash(`มอบตั๋ว ${issued} ใบ ให้ ${u.display_name} แล้ว ✓ แจ้งเตือนลูกค้าแล้ว`);
      setOpenPanel(false); setRows({}); setUserSel('');
    } finally { setBusy(false); }
  };

  return (
    <>
      <button onClick={() => setOpenPanel(true)} className="rounded-lg border border-[#8b5cf6]/50 bg-[#8b5cf6]/[0.12] px-3 py-1.5 text-[12px] font-bold text-[#c4b5fd]">🎁 มอบตั๋วหลายรายการ</button>
      {openPanel && (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-black/70 p-4" onClick={() => !busy && setOpenPanel(false)}>
          <div className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto rounded-2xl border border-[#8b5cf6]/40 bg-surface-2 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 text-base font-bold text-[#c4b5fd]">🎁 มอบตั๋วหลายรายการ</div>
            <div className="mb-3 text-[12px] text-ink-faint">เลือกลูกค้า 1 คน → ติ๊กสินค้า → มอบครั้งเดียว ตัดสต๊อกทุกรอบ + push แจ้งลูกค้า 1 ครั้ง</div>
            <label className="mb-3 block text-[11.5px] text-ink-faint">ลูกค้า
              <select className={cx(inputCls, 'mt-0.5')} value={userSel} onChange={(e) => setUserSel(e.target.value)}>
                <option value="">— เลือกลูกค้า —</option>
                {grantables.map((u) => <option key={u.id} value={u.id}>{u.display_name}{u.member_code ? ` · ${u.member_code}` : ''}{u.phone ? ` · ${u.phone}` : ''}</option>)}
              </select>
            </label>
            <div className="flex flex-col gap-1.5">
              {eligible.map((b) => {
                const p = db.products.find((x) => x.id === b.product_id);
                const r = row(b);
                const rem = batchRemaining(db, b.id, b.stock_qty);
                return (
                  <div key={b.id} className={cx('flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2', r.on ? 'border-[#8b5cf6]/50 bg-[#8b5cf6]/[0.07]' : 'border-subtle bg-surface-3')}>
                    <input type="checkbox" checked={r.on} onChange={(e) => setRow(b, { on: e.target.checked })} className="h-4 w-4 accent-[#8b5cf6]" />
                    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-subtle bg-stripe">
                      {p?.images[0] ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full w-full place-items-center"><Icon name="box" size={14} className="text-primary-soft/25" /></div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-semibold">{p?.series_name ?? '—'} <span className="font-normal text-ink-faint">· {b.label}</span>{b.published === false && <span className="ml-1 rounded bg-[#d97706]/20 px-1 py-0.5 text-[9px] font-bold text-[#fbbf24]">ร่าง</span>}</div>
                      <div className="font-mono text-[10.5px] text-ink-faint">{baht(b.price_total)} · เหลือ {rem}</div>
                    </div>
                    {r.on && (<>
                      <label className="text-[10.5px] text-ink-faint">จำนวน<input className={cx(inputCls, 'mt-0.5 w-14 py-1.5 text-center text-[12px]')} inputMode="numeric" value={r.qty} onChange={(e) => setRow(b, { qty: e.target.value.replace(/[^\d]/g, '') })} /></label>
                      {/* ราคา/มัดจำ ตั้งเองได้รายรายการ — ขอบเหลือง = ไม่เท่าราคารอบ (เตือนว่าเป็นดีลเฉพาะใบนี้) */}
                      <label className="text-[10.5px] text-ink-faint">ราคา/ชิ้น<input className={cx(inputCls, 'mt-0.5 w-20 py-1.5 text-center text-[12px]', (Number(r.price) || 0) !== b.price_total && 'border-[#fbbf24]')} inputMode="numeric" value={r.price} onChange={(e) => setRow(b, { price: e.target.value.replace(/[^\d]/g, '') })} /></label>
                      <label className="text-[10.5px] text-ink-faint">มัดจำ/ชิ้น<input className={cx(inputCls, 'mt-0.5 w-20 py-1.5 text-center text-[12px]')} inputMode="numeric" value={r.dep} onChange={(e) => setRow(b, { dep: e.target.value.replace(/[^\d]/g, '') })} /></label>
                      <span className="text-[10.5px] text-ink-faint">ค้าง/ชิ้น<b className="mt-0.5 block text-center text-[12px] text-primary-soft">{baht(Math.max(0, (Number(r.price) || 0) - (Number(r.dep) || 0)))}</b></span>
                    </>)}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-2.5">
              <button onClick={() => setOpenPanel(false)} className="rounded-lg border border-subtle bg-surface-3 px-4 py-2.5 text-[13px] font-semibold text-ink-muted2">ยกเลิก</button>
              <button onClick={doGrant} disabled={busy || chosen.length === 0 || !userSel} className="flex-1 rounded-lg bg-[#8b5cf6] py-2.5 text-[13.5px] font-bold text-white disabled:opacity-50">
                {busy ? 'กำลังออกตั๋ว…' : `✓ มอบตั๋ว ${chosen.length} รายการ + แจ้งลูกค้า`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Open rounds management + history ────────────────────────────────────────
// การ์ดรูปสไตล์ "หาของนอกระบบ" + group ตามค่าย (เจ้าของ 2026-07-20)
function OpenRounds() {
  const db = useDatabase();
  const open = db.batches.filter((b) => b.status === 'open').sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  // group ด้วยค่ายของสินค้า (คงลำดับใหม่→เก่าในกลุ่ม)
  const groups: { makerId: string; makerName: string; logo?: string; batches: ProductBatch[] }[] = [];
  for (const b of open) {
    const p = db.products.find((x) => x.id === b.product_id);
    const mk = p ? manufacturerOf(db, p) : undefined;
    const id = mk?.id ?? 'none';
    let g = groups.find((x) => x.makerId === id);
    if (!g) { g = { makerId: id, makerName: mk?.name ?? 'อื่นๆ', logo: mk?.logo_url, batches: [] }; groups.push(g); }
    g.batches.push(b);
  }
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center gap-2 text-[15px] font-bold">
        รอบที่เปิดอยู่ ({open.length})
        {open.length > 0 && <MultiGrant batches={open} />}
      </div>
      {open.length === 0 ? (
        <div className="rounded-2xl border border-subtle bg-surface-2 py-6 text-center text-[13px] text-ink-faint">ยังไม่มีรอบเปิดอยู่</div>
      ) : groups.map((g) => (
        <div key={g.makerId} className="mb-4">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] font-bold text-ink-muted">
            {g.logo ? <img src={g.logo} alt="" className="h-5 w-5 rounded-full object-cover" /> : <Icon name="store" size={15} className="text-primary-soft" />}
            {g.makerName}
            <span className="text-ink-faint">· {g.batches.length} รอบ</span>
          </div>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {g.batches.map((b) => <RoundRow key={b.id} batch={b} />)}
          </div>
        </div>
      ))}
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
      <div className="grid gap-2.5 lg:grid-cols-2">{closed.map((b) => <RoundRow key={b.id} batch={b} readOnly />)}</div>
    </div>
  );
}

/** ── ประวัติการมอบตั๋ว (เจ้าของ 2026-08-08) ────────────────────────────────
 *  ตั๋วที่ "แอดมินมอบให้" คือเส้นเงินนอกระบบ (ไม่มีออเดอร์/สลิปให้ย้อนดู) จึงต้องมีที่เดียวที่เห็นครบ:
 *  ใคร ได้อะไร วันไหน ราคาเท่าไหร่ รับมัดจำมาแล้วเท่าไหร่ ยังค้างเท่าไหร่ และ **ใครเป็นคนมอบ**.
 *  แหล่งความจริงคือตัวตั๋วเอง (ticketSourceOf = 'granted') ไม่ใช่ activity log — ใบที่มอบก่อนมีระบบ log
 *  จึงยังโผล่ครบ; ชื่อคนมอบเติมจาก activity log เมื่อจับคู่เลขตั๋วได้ */
function GrantLog() {
  const db = useDatabase();
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = db.tickets
    .filter((t) => ticketSourceOf(db, t) === 'granted')
    .map((t) => {
      const o = ticketOrigin(db, t);
      const u = db.users.find((x) => x.id === t.owner_id);
      const p = db.products.find((x) => x.id === t.product_id);
      // ใครมอบ: log ที่ target_label มีเลขตั๋วใบนี้อยู่ (ทั้งมอบใบเดียวและมอบหลายรายการ)
      const log = db.activityLogs.find((l) => l.action === 'grant_ticket' && !!t.ticket_no && (l.target_label ?? '').includes(t.ticket_no));
      return { t, o, name: u?.display_name ?? '(ผู้ใช้ถูกลบ)', product: p?.series_name ?? '(สินค้าถูกลบ)', img: p?.images?.[0], by: log?.actor_name };
    })
    .filter((r) => {
      const s = q.trim().toLowerCase();
      return !s || r.name.toLowerCase().includes(s) || r.product.toLowerCase().includes(s) || r.t.ticket_no.toLowerCase().includes(s);
    })
    .sort((a, b) => (a.o.at < b.o.at ? 1 : -1));

  const totalQty = rows.reduce((s, r) => s + r.t.qty, 0);
  const totalPaid = rows.reduce((s, r) => s + r.o.paid, 0);
  const totalDue = rows.reduce((s, r) => s + r.o.due, 0);

  return (
    <div className="mb-6 rounded-2xl border border-[#8b5cf6]/35 bg-[#8b5cf6]/[0.05] p-4">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-bold text-[#c4b5fd]">🎁 ประวัติการมอบตั๋ว</span>
        <span className="text-[11.5px] text-ink-faint">ตั๋วที่แอดมินมอบเอง (เก็บเงินนอกระบบ) — ไม่มีออเดอร์คู่</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา ชื่อลูกค้า / สินค้า / เลขตั๋ว"
          className="ml-auto w-full max-w-[240px] rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] outline-none placeholder:text-ink-faint" />
      </div>
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[13px] text-ink-faint">{q.trim() ? 'ไม่พบรายการ' : 'ยังไม่เคยมอบตั๋วให้ใคร'}</div>
      ) : (<>
        <div className="mb-2 flex flex-wrap gap-1.5 text-[11.5px]">
          <span className="rounded-md bg-[#8b5cf6]/[0.16] px-2 py-1 text-[#c4b5fd]">{rows.length} ใบ · {totalQty} ชิ้น</span>
          <span className="rounded-md bg-[#16a34a]/[0.14] px-2 py-1 text-[#4ade80]">รับมาแล้ว {baht(totalPaid)}</span>
          {totalDue > 0 && <span className="rounded-md bg-[#b91c1c]/[0.16] px-2 py-1 text-[#f87171]">ค้างเก็บ {baht(totalDue)}</span>}
        </div>
        <div className="flex flex-col divide-y divide-hair">
          {rows.map((r) => (
            <div key={r.t.id} className="py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                <span className="w-[92px] shrink-0 text-[11.5px] text-ink-faint">{fmtDate(r.o.at)}</span>
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-subtle bg-stripe">
                  {r.img && <img src={r.img} alt="" className="h-full w-full object-cover" />}
                </div>
                <span className="min-w-[140px] flex-1 truncate font-semibold">
                  {r.product}
                  {r.o.batchLabel && <span className="text-[11px] font-normal text-ink-faint"> · {r.o.batchLabel}</span>}
                </span>
                <span className="min-w-[100px] truncate text-ink-muted2">{r.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{r.t.ticket_no}</span>
                <span className="w-[38px] shrink-0 text-right text-ink-muted2">×{r.t.qty}</span>
                <span className="w-[86px] shrink-0 text-right font-bold text-primary-soft">{baht(r.o.paid)}</span>
                <span className={cx('w-[86px] shrink-0 text-right text-[11.5px]', r.o.due > 0 ? 'text-[#f87171]' : 'text-ink-faint')}>{r.o.due > 0 ? `ค้าง ${baht(r.o.due)}` : 'ครบแล้ว'}</span>
                <button onClick={() => setOpenId(openId === r.t.id ? null : r.t.id)} className="shrink-0 rounded-lg border border-subtle px-2 py-1 text-[11px] font-bold text-ink-muted2">
                  {openId === r.t.id ? 'ย่อ ▲' : 'ดู ▼'}
                </button>
              </div>
              {openId === r.t.id && (
                <div className="ml-[100px] mt-1.5 rounded-lg border border-subtle bg-surface-3/40 px-3 py-2 text-[11.5px] text-ink-muted2">
                  <div>ราคาเต็ม <b className="text-ink">{baht(r.o.price)}</b> · มัดจำที่รับมา <b className="text-ink">{baht(r.o.deposit)}</b>{r.o.paid > r.o.deposit && <> · จ่ายส่วนต่างเพิ่ม <b className="text-ink">{baht(r.o.paid - r.o.deposit)}</b></>}</div>
                  <div className="mt-0.5">คนมอบ <b className="text-ink">{r.by ?? '— (มอบก่อนมีระบบบันทึก)'}</b> · สถานะของ <b className="text-ink">{r.t.product_status}</b></div>
                </div>
              )}
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}

/** ── History Log (เจ้าของ 2026-07-26) ─────────────────────────────────────
 *  ตารางเดียวเห็นทุกรอบที่เคยเปิด: วันที่ · รายการ · จำนวน (ขาย/ทั้งหมด) · สถานะ
 *  + กางดูรายชื่อคนพรีของรอบนั้นได้เลย. ต่างจากการ์ดด้านบนตรงที่ "ไล่อ่านย้อนหลังได้เร็ว"
 *  ไม่ต้องเลื่อนหาการ์ด และเห็นรอบที่ยังเป็นร่างด้วย. */
function RoundLog() {
  const db = useDatabase();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'open' | 'closed'>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const nameOf = (b: ProductBatch) => db.products.find((p) => p.id === b.product_id)?.series_name ?? '(สินค้าถูกลบ)';
  const kindOf = (b: ProductBatch) => (b.status !== 'open' ? 'closed' : b.published === false ? 'draft' : 'open');
  const rows = db.batches
    .filter((b) => (filter === 'all' ? true : kindOf(b) === filter))
    .filter((b) => !q.trim() || nameOf(b).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const KIND: Record<string, { label: string; cls: string }> = {
    draft: { label: '📝 ร่าง', cls: 'bg-[#d97706]/20 text-[#fbbf24]' },
    open: { label: '🚀 เปิดขาย', cls: 'bg-[#16a34a]/20 text-[#4ade80]' },
    closed: { label: 'ปิดรอบ', cls: 'bg-white/[0.07] text-ink-muted2' },
  };
  const Tab = ({ v, children }: { v: typeof filter; children: React.ReactNode }) => (
    <button onClick={() => setFilter(v)} className={cx('rounded-lg border px-2.5 py-1 text-[12px] font-bold', filter === v ? 'border-primary bg-primary text-white' : 'border-subtle bg-surface-3 text-ink-muted2')}>{children}</button>
  );

  return (
    <div className="mb-6 rounded-2xl border border-subtle bg-surface-2 p-4">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-bold">📋 History Log · ทุกรอบที่เคยเปิด</span>
        <span className="text-[11.5px] text-ink-faint">วันที่ · รายการ · จำนวน · คนพรี</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาชื่อสินค้า"
          className="ml-auto w-full max-w-[220px] rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] outline-none placeholder:text-ink-faint" />
      </div>
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        <Tab v="all">ทั้งหมด ({db.batches.length})</Tab>
        <Tab v="draft">ร่าง ({db.batches.filter((b) => kindOf(b) === 'draft').length})</Tab>
        <Tab v="open">เปิดขาย ({db.batches.filter((b) => kindOf(b) === 'open').length})</Tab>
        <Tab v="closed">ปิดแล้ว ({db.batches.filter((b) => kindOf(b) === 'closed').length})</Tab>
      </div>

      {rows.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-ink-faint">ไม่พบรายการ</div>
      ) : (
        <div className="flex flex-col divide-y divide-hair">
          {rows.map((b) => {
            const p = db.products.find((x) => x.id === b.product_id);
            const buyers = batchBuyers(db, b.id);
            const sold = buyers.reduce((s, x) => s + x.qty, 0);
            const k = KIND[kindOf(b)];
            const isOpen = openId === b.id;
            const roundNo = db.batches.filter((x) => x.product_id === b.product_id).sort((x, y) => (x.created_at < y.created_at ? -1 : 1)).findIndex((x) => x.id === b.id) + 1;
            return (
              <div key={b.id} className="py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                  <span className="w-[92px] shrink-0 text-[11.5px] text-ink-faint">{new Date(b.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
                  <div className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-subtle bg-stripe">
                    {p?.images?.[0] && <img src={p.images[0]} alt="" className="h-full w-full object-cover" />}
                  </div>
                  <span className="min-w-[150px] flex-1 truncate font-semibold">{nameOf(b)} <span className="text-[11px] font-normal text-ink-faint">· รอบ {roundNo}{b.label ? ` · ${b.label}` : ''}</span></span>
                  <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold', k.cls)}>{k.label}</span>
                  <span className="w-[104px] shrink-0 text-right">
                    <b className={sold >= b.stock_qty ? 'text-[#f87171]' : 'text-ink'}>{sold}</b>
                    <span className="text-ink-faint">/{b.stock_qty} ชิ้น</span>
                  </span>
                  <button onClick={() => setOpenId(isOpen ? null : b.id)} disabled={buyers.length === 0}
                    className={cx('w-[104px] shrink-0 rounded-lg border px-2 py-1 text-[11.5px] font-bold',
                      buyers.length === 0 ? 'border-subtle text-ink-faint' : 'border-[#d4af37]/45 bg-[#d4af37]/[0.1] text-[#f1d27a]')}>
                    🎫 คนพรี ({buyers.length}) {buyers.length > 0 && (isOpen ? '▲' : '▼')}
                  </button>
                </div>
                {isOpen && buyers.length > 0 && (
                  <div className="ml-[100px] mt-1.5 flex flex-col divide-y divide-hair rounded-lg border border-subtle bg-surface-3/40 px-2.5">
                    {buyers.map((x) => (
                      <div key={x.ticket_no} className="flex flex-wrap items-center gap-x-3 py-1.5 text-[11.5px]">
                        <span className="min-w-[120px] flex-1 font-semibold">{x.name}</span>
                        <span className="font-mono text-[10.5px] text-ink-faint">{x.ticket_no}</span>
                        <span className="text-ink-muted2">×{x.qty}</span>
                        <span className="w-[76px] text-right font-bold text-primary-soft">{baht(x.paid)}</span>
                        <span className="w-[74px] text-right text-[10.5px] text-ink-faint">{new Date(x.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** ลำดับสถานะการเดินทาง — ใช้เทียบว่าใบไหน "หน้า/หลัง" เป้าหมายที่จะย้อนกลับ */
const FLOW: Record<string, number> = { open: 0, production: 1, shipping: 2, arrived: 3, delivered: 4, closed: 5 };

/** ปุ่มขั้นสถานะในแถบ "สถานะรอบ" — ขั้นที่กำลังเป็นอยู่จะทึบ, ขั้นอื่นกดเพื่อย้าย (เดินหน้า/ถอยหลัง) */
function Step({ on, tone, onClick, children }: { on: boolean; tone: 'amber' | 'blue' | 'green'; onClick: () => void; children: React.ReactNode }) {
  const active = tone === 'amber' ? 'bg-[#d97706] text-white' : tone === 'blue' ? 'bg-[#2563eb] text-white' : 'bg-success text-white';
  const idle = tone === 'amber' ? 'text-[#fbbf24] hover:bg-[#d97706]/15' : tone === 'blue' ? 'text-[#60a5fa] hover:bg-[#2563eb]/15' : 'text-[#4ade80] hover:bg-[#16a34a]/15';
  return (
    <button onClick={onClick} disabled={on} aria-current={on} className={cx('rounded px-2 py-1 text-[11.5px] font-bold transition-colors', on ? active : cx('bg-transparent', idle))}>
      {children}
    </button>
  );
}

function RoundRow({ batch: b, readOnly }: { batch: ProductBatch; readOnly?: boolean }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const adminId = useCurrentUserId();
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

  // ── สถานะการเดินทางของรอบนี้ (นับจากตั๋วในรอบ ไม่ใช่ตัว SKU — กันข้ามรอบ) ──
  const moving = tickets.filter((t) => ['production', 'shipping'].includes(t.product_status));
  // รอบไม่มีลูกค้า: ของ (ตัว SKU) ยังเดินทางอยู่เอง — ต้องกดขยับสถานะได้เหมือนกัน (เฉพาะรอบล่าสุดของ SKU
  // กันการ์ดรอบเก่าในประวัติไปอ่านสถานะของรอบใหม่) → ถึงแล้วของเหลือกลายเป็น In-Stock มือ 1
  const totalRounds = db.batches.filter((x) => x.product_id === b.product_id).length;
  const nProd = tickets.filter((t) => t.product_status === 'production').length;
  const nShip = tickets.filter((t) => t.product_status === 'shipping').length;
  const nArr = tickets.filter((t) => ['arrived', 'delivered'].includes(t.product_status) || t.status === 'shipped').length;
  // SF ค่าย→โกดังจีน (ใช้เทียบกับตารางโกดังใน section ยืนยันโกดังด้านบน)
  const [sf, setSf] = useState(p?.sf_code ?? '');
  const saveSf = () => {
    if (!p || !sf.trim()) return flash('ใส่รหัสชิปปิ้งก่อน');
    dispatch(setProductSf(p.id, sf.trim()));
    flash('บันทึกรหัสชิปปิ้งแล้ว — รอเทียบตารางโกดัง ✓');
  };
  // ── ผลิต → เดินทาง (แอดมินกดเอง ไม่ต้องผ่านคิวโกดัง) ──
  const [depTr, setDepTr] = useState<'truck' | 'ship'>('truck');
  const doDepart = () => {
    const label = depTr === 'ship' ? 'เรือ 🚢' : 'รถ 🚚';
    if (!confirm(`ของรอบนี้ออกจากจีนแล้ว? (${label})\n${nProd > 0 ? `ตั๋ว ${nProd} ใบจะเป็น "กำลังเดินทางมาไทย" + เริ่มนับ ETA` : 'ยังไม่มีลูกค้า — ตัวสินค้าจะเป็น "กำลังเดินทาง"'}\nลูกค้าจะเริ่มจ่ายส่วนต่างได้`)) return;
    const before = nProd;
    dispatch(departSpecialRound(b.id, { transport: depTr }));
    let moved = 0;
    dispatch((d) => { moved = before - d.tickets.filter((t) => t.batch_id === b.id && t.product_status === 'production').length; return d; });
    if (before > 0 && moved <= 0) return flash('เปลี่ยนสถานะไม่สำเร็จ — ลองรีเฟรชแล้วกดใหม่');
    if (p && pushEnabled(db, 'lot_shipping')) {
      const seen = new Set<string>();
      for (const t of tickets.filter((x) => x.product_status === 'production')) {
        if (seen.has(t.owner_id)) continue;
        seen.add(t.owner_id);
        sendPush(subsForUsers(db, [t.owner_id]), { title: '🚚 ของกำลังเดินทางมาไทย', body: `${productLabel(db, p.id)} ออกจากจีนแล้ว — เริ่มชำระส่วนต่างได้เลย`, url: `/wallet/${encodeURIComponent(t.ticket_no)}` }, dispatch).catch(() => {});
      }
    }
    flash(before > 0 ? `กำลังเดินทางมาไทย ${label} · ${moved} ตั๋ว ✓ แจ้งลูกค้าแล้ว` : `ตั้งเป็นกำลังเดินทางมาไทย ${label} แล้ว ✓`);
  };

  // ── สถานะ "ตอนนี้" ของรอบ (ใช้วาดแถบสถานะ) ──
  // ตั๋วมาก่อนเสมอ (ใบที่ตามหลังสุดคือสถานะจริงของรอบ); รอบที่ยังไม่มีลูกค้าอ่านจากตัว SKU
  // เฉพาะรอบล่าสุด — การ์ดรอบเก่าในประวัติต้องไม่ไปคุมสถานะของรอบใหม่
  const phase: 'production' | 'shipping' | 'arrived' | null =
    nProd > 0 ? 'production'
    : nShip > 0 ? 'shipping'
    : nArr > 0 ? 'arrived'
    : tickets.length === 0 && p && !p.is_stock && roundNo === totalRounds
      && (p.status === 'production' || p.status === 'shipping' || p.status === 'arrived') ? p.status
    : null;

  // ── ย้อนสถานะกลับ (แก้ตอนตั้งผิด/กดพลาด) — ไม่แจ้งเตือนลูกค้า ──
  const doRevert = (target: 'production' | 'shipping') => {
    if (phase === target) return;
    if (p?.is_stock) return flash('SKU นี้กลายเป็น In-Stock ไปแล้ว — ย้อนสถานะรอบไม่ได้ (แก้ที่แท็บ In-Stock)');
    const locked = tickets.filter((t) => t.status === 'shipped' || t.delivery);
    if (locked.length > 0) return flash(`ย้อนไม่ได้ — มีตั๋ว ${locked.length} ใบที่ส่งของ/ลูกค้าเลือกวิธีรับของแล้ว`);
    const backN = tickets.filter((t) => FLOW[t.product_status] > FLOW[target]).length;
    const label = target === 'production' ? 'กำลังผลิต (รอเข้าโกดัง)' : 'กำลังเดินทางมาไทย';
    if (!confirm(`ย้อนสถานะรอบนี้กลับเป็น "${label}"?\n`
      + (backN > 0 ? `ตั๋ว ${backN} ใบจะถอยกลับตามด้วย\n` : 'รอบนี้ยังไม่มีลูกค้า — เปลี่ยนเฉพาะตัวสินค้า\n')
      + (target === 'production' ? 'วันเข้าโกดัง/ETA จะถูกล้าง (เริ่มนับใหม่ตอนกดออกเดินทาง)\n' : '')
      + '\n⚠ ไม่มีการแจ้งเตือนลูกค้า')) return;
    dispatch(revertRoundStatus(b.id, target));
    let ok = false;
    dispatch((d) => {
      const pp = d.products.find((x) => x.id === b.product_id);
      const ts = d.tickets.filter((t) => t.batch_id === b.id);
      ok = ts.length > 0 ? !ts.some((t) => FLOW[t.product_status] > FLOW[target]) : pp?.status === target;
      return d;
    });
    flash(ok ? `ย้อนกลับเป็น "${label}" แล้ว ✓` : 'ย้อนสถานะไม่สำเร็จ — ลองรีเฟรชแล้วกดใหม่');
  };

  // ถึงไทยแล้ว (เฉพาะตั๋วรอบนี้) + push ลูกค้าที่พรีรายการนี้.
  // รอบไม่มีลูกค้า/จบยอดแล้ว: ของเหลือกลายเป็น In-Stock มือ 1 อัตโนมัติ (เจ้าของ 2026-07-22)
  const doArrive = () => {
    const owners = [...new Set(moving.map((t) => t.owner_id))];
    const msg = moving.length === 0
      ? `ของรอบนี้ถึงไทยแล้ว? ไม่มีลูกค้าค้าง — สต๊อกที่เหลือ ${remaining} ชิ้นจะกลายเป็นสินค้า In-Stock (มือ 1) ทันที`
      : `ของรอบนี้ถึงไทยแล้ว? ตั๋ว ${moving.length} ใบจะเป็น "ถึงไทย" + แจ้งเตือนลูกค้า ${owners.length} คน`;
    if (!confirm(msg)) return;
    dispatch(arriveSpecialRound(b.id));
    if (p && pushEnabled(db, 'lot_arrived')) {
      const seen = new Set<string>();
      for (const t of moving) {
        if (seen.has(t.owner_id)) continue;
        seen.add(t.owner_id);
        sendPush(subsForUsers(db, [t.owner_id]), { title: '🇹🇭 ของถึงไทยแล้ว!', body: `${productLabel(db, p.id)} — ${t.remaining_amount > t.remaining_paid ? 'ชำระส่วนต่างเพื่อรับของได้เลย' : 'เลือกวิธีรับของได้เลย'}`, url: `/wallet/${encodeURIComponent(t.ticket_no)}` }, dispatch).catch(() => {});
      }
    }
    // เช็คผล: ถ้า SKU แปลงเป็น in-stock แล้ว (จบยอด+มีของเหลือ) บอกแอดมินชัดๆ
    let becameStock = false, stockNow = 0;
    dispatch((d) => { const pp = d.products.find((x) => x.id === b.product_id); becameStock = !!pp?.is_stock; stockNow = pp?.stock_qty ?? 0; return d; });
    flash(becameStock
      ? `ถึงไทยแล้ว ✓ ของเหลือกลายเป็น In-Stock มือ 1 · สต๊อก ${stockNow} ชิ้น (ปรับราคาต่อได้ที่ In-Stock)`
      : `ถึงไทยแล้ว · ${moving.length} ตั๋ว ✓ แจ้งลูกค้า ${owners.length} คน`);
  };

  // ── ร่าง → เปิดขาย (publish): ตั้งราคา/มัดจำ/จำนวนของล็อตนี้ก่อน แล้วค่อยขึ้นหน้าร้าน + push ──
  // (เจ้าของ 2026-07-28: มอบตั๋วลูกค้าเก่าราคาที่ตกลงไว้ → ตอนเปิดขายจริงค่อยตั้งราคาหน้าร้าน
  //  ตั๋วที่ออกไปแล้ว snapshot ราคาใครราคามัน ไม่ถูกแตะ · DNA push: ไม่บอกจำนวน)
  const isDraft = b.status === 'open' && b.published === false;
  const [pubOpen, setPubOpen] = useState(false);
  const [pubPrice, setPubPrice] = useState(String(b.price_total));
  const [pubDep, setPubDep] = useState(fullPay ? '' : String(b.deposit_amount));
  // ช่องจำนวน = "เปิดขายหน้าร้านกี่ชิ้น" ไม่รวมที่มอบไปแล้ว (บั๊ก Orochimaru 2026-07-30:
  // เดิมช่องนี้คือ "ทั้งรอบ" — แอดมินใส่ 5 ตั้งใจขาย 5 แต่ 5 ที่มอบแล้วกินโควตาหมด → ขึ้นสินค้าหมดทันที)
  const [pubQty, setPubQty] = useState(String(Math.max(0, b.stock_qty - sold)));
  const doPublish = () => {
    const pr = Number(pubPrice) || 0;
    const dp = Number(pubDep) || 0;
    const sell = Number(pubQty) || 0; // ขายหน้าร้าน (ชิ้น)
    if (pr <= 0) return flash('ใส่ราคาขายก่อน');
    if (!fullPay && dp > 0 && dp >= pr) return flash('มัดจำต้องน้อยกว่าราคาขาย');
    if (sell < 1) return flash('ใส่จำนวนที่จะเปิดขายอย่างน้อย 1 ชิ้น');
    const q = sold + sell; // ทั้งรอบ = มอบแล้ว + เปิดขาย
    const effDep = fullPay ? pr : (dp > 0 ? dp : Math.min(b.deposit_amount, pr));
    if (!confirm(`เปิดขาย "${p?.series_name}" · ${baht(pr)}${fullPay ? ' (จ่ายเต็ม)' : ` · มัดจำ ${baht(effDep)}`}\nเปิดให้กดหน้าร้าน ${sell} ชิ้น${sold > 0 ? ` (รวมทั้งรอบ ${q}: มอบแล้ว ${sold} + ขาย ${sell})` : ''}\nขึ้นหน้าร้าน + แจ้งลูกค้าทันที${tickets.length > 0 ? `\nตั๋วที่มอบแล้ว ${tickets.length} ใบ ราคาเดิมไม่เปลี่ยน (snapshot)` : ''}`)) return;
    dispatch(publishBatch(b.id, { price: pr, deposit: fullPay ? undefined : (dp > 0 ? dp : undefined), qty: q }));
    // อ่านกลับ — จำนวนต่ำกว่าที่มอบ+จองค้าง (hold ที่มองไม่เห็นบนหน้า) จะถูก mutation ปัดตก
    let live: ProductBatch | undefined;
    dispatch((d) => { live = d.batches.find((x) => x.id === b.id); return d; });
    if (!live || live.published === false) return flash('เปิดขายไม่สำเร็จ — จำนวนอาจต่ำกว่าที่จองค้างอยู่ ลองเพิ่มจำนวนแล้วกดใหม่');
    if (p && pushEnabled(db, 'restock'))
      sendPush(subsForNewProduct(db, p), { title: '🔥 เปิดพรีรอบพิเศษ!', body: `${p.series_name} · ${baht(live.price_total)}${live.deposit_amount >= live.price_total ? ' · พร้อมส่ง' : ` · มัดจำ ${baht(live.deposit_amount)}`}`, url: `/shop/${b.product_id}?batch=${b.id}` }, dispatch).catch(() => {});
    setPubOpen(false);
    flash(`🚀 เปิดขายแล้ว ${baht(live.price_total)} · เปิดให้กด ${live.stock_qty - sold} ชิ้น · ขึ้นหน้าร้าน + แจ้งลูกค้า`);
  };

  // ── มอบตั๋วให้ลูกค้าโดยตรง (ไล่เก็บใบพรีเก่า) — ตัดสต๊อกรอบอัตโนมัติ ──
  const [granting, setGranting] = useState(false);
  const [gUser, setGUser] = useState('');
  const [gQty, setGQty] = useState('1');
  const [gDep, setGDep] = useState(String(b.deposit_amount));
  const [gPrice, setGPrice] = useState(String(b.price_total)); // ราคาเฉพาะตั๋วใบนี้ (ไม่แตะราคารอบ)
  const [gBusy, setGBusy] = useState(false);
  const grantables = db.users.filter((u) => u.approved !== false && !u.is_admin).sort((a, x) => a.display_name.localeCompare(x.display_name));
  const doGrant = async () => {
    const u = db.users.find((x) => x.id === gUser);
    const q = Number(gQty) || 0;
    const depEach = Math.max(0, Number(gDep) || 0);
    const priceEach = Number(gPrice) || 0;
    if (!u) return flash('เลือกลูกค้าก่อน');
    if (q < 1 || q > remaining) return flash(`จำนวนต้อง 1–${remaining} (สต๊อกรอบนี้)`);
    if (priceEach <= 0) return flash('ใส่ราคาขายก่อน');
    if (depEach > priceEach) return flash(`มัดจำต่อชิ้นเกินราคาที่ตั้งไว้ (${baht(priceEach)})`);
    const diffNote = priceEach !== b.price_total ? `\n⚠ ราคานี้ใช้เฉพาะตั๋วใบนี้ (ราคารอบคือ ${baht(b.price_total)} — ไม่ถูกแก้)` : '';
    if (!confirm(`มอบตั๋ว ${p?.series_name} ×${q} ให้ "${u.display_name}"\nราคา ${baht(priceEach)}/ชิ้น · มัดจำรับแล้ว ${baht(depEach)}/ชิ้น · ค้าง ${baht(Math.max(0, priceEach - depEach) * q)}\nสต๊อกรอบจะเหลือ ${remaining - q}${diffNote}`)) return;
    setGBusy(true);
    try {
      // เลขตั๋วต้องจองจาก server ก่อนเสมอ (migration v47 — กันเลขชน)
      const startNos = await reserveTicketNos(ticketPrefixCounts(db, [b.product_id]));
      // ⚠ ต้องอ่านจำนวนตั๋ว "ตอนนี้" ก่อน dispatch แล้วเทียบหลัง — grantSpecialTickets ข้ามเงียบ
      //   เมื่อของไม่พอ (มี hold ค้างของลูกค้าคนอื่น) เดิมอ่านแค่ "ตั๋วใบล่าสุดของคน+รอบนี้"
      //   ซึ่งใบเก่าก็เข้าเงื่อนไข → ขึ้น ✓ + ยิง push ทั้งที่ไม่มีตั๋วใหม่เกิด (audit regression #3)
      let before = 0;
      dispatch((d) => { before = d.tickets.length; return d; });
      dispatch(grantSpecialTicket(b.id, u.id, q, depEach, startNos, priceEach));
      let no = '';
      let made = 0;
      dispatch((d) => {
        made = d.tickets.length - before;
        no = d.tickets.filter((t) => t.batch_id === b.id && t.owner_id === u.id).sort((a, x) => (a.created_at < x.created_at ? 1 : -1))[0]?.ticket_no ?? '';
        return d;
      });
      if (made <= 0) { setGBusy(false); return flash('มอบตั๋วไม่สำเร็จ — ของไม่พอ (อาจมีลูกค้าอื่นกันไว้อยู่) ลองรีเฟรชแล้วเช็คจำนวนอีกที'); }
      if (await store.flush()) { setGBusy(false); return flash('บันทึกไม่สำเร็จ — ยังไม่ได้แจ้งลูกค้า ลองมอบใหม่อีกครั้ง'); }
      // ร่องรอย: การมอบตั๋วคือ "เงินนอกระบบ" — ต้องรู้ว่าใครมอบ ให้ใคร เมื่อไหร่ รับมัดจำมาเท่าไหร่
      dispatch(logActivity(adminId, 'grant_ticket', `มอบตั๋ว ${p?.series_name ?? ''} ×${q} ให้ ${u.display_name} (รอบ ${b.label})`, { targetId: b.id, targetLabel: no || p?.series_name, amount: depEach * q }));
      if (pushEnabled(db, 'order_approved'))
        sendPush(subsForUsers(db, [u.id]), { title: '🎫 ได้รับใบพรีแล้ว!', body: `${p?.series_name ?? ''} ×${q} — แตะดูตั๋วของคุณ`, url: no ? `/wallet/${encodeURIComponent(no)}` : '/wallet' }, dispatch).catch(() => {});
      flash(`มอบตั๋ว ${no || ''} ให้ ${u.display_name} แล้ว ✓ (สต๊อกรอบเหลือ ${remaining - q})`);
      setGranting(false); setGUser(''); setGQty('1'); setGDep(String(b.deposit_amount)); setGPrice(String(b.price_total));
    } finally { setGBusy(false); }
  };

  // มีของเพิ่ม → เปิดรอบใหม่ (แสดงเมื่อรอบนี้ขายหมด หรือเป็นรอบที่ปิดไปแล้ว)
  const [restock, setRestock] = useState(false);
  const [rq, setRq] = useState('');
  const [rp, setRp] = useState(String(b.price_total));
  const [rd, setRd] = useState(String(b.deposit_amount));
  // จุดเริ่มรอบใหม่ (concept 2026-07-23): ผลิต (default, ผ่านโกดัง) / ของออกเดินทางแล้ว
  const [rStart, setRStart] = useState<'production' | 'shipping'>('production');
  // ของที่ยัง "ไม่ถูกขาย" ในคลัง SKU — คือของที่ปิดรอบทิ้งไว้แล้วยังเอามาขายต่อได้
  const poolLeft = p && !p.is_stock ? Math.max(0, stockRemaining(db, p) - (b.status === 'open' ? remaining : 0)) : 0;
  // แหล่งของรอบใหม่: 'pool' = ขายของที่เหลือในคลัง (ไม่บวกคลังซ้ำ) · 'new' = ของมาเพิ่มจากจีน
  const [rSrc, setRSrc] = useState<'pool' | 'new'>('pool');
  const doRestock = () => {
    const q = Number(rq) || 0;
    if (q <= 0) return flash(rSrc === 'pool' ? 'กรอกจำนวนที่จะเอามาขาย' : 'กรอกจำนวนที่มาเพิ่ม');
    if (rSrc === 'pool' && q > poolLeft) return flash(`คลังเหลือ ${poolLeft} ชิ้น — ถ้าของมาเพิ่มจากจีน ให้สลับเป็น "ของมาเพิ่ม"`);
    dispatch(restockSpecialRound(b.product_id, { qty: q, price: Number(rp) || undefined, deposit: Number(rd) || undefined, startStatus: rStart, fromPool: rSrc === 'pool' }));
    // อ่านรอบใหม่ที่เพิ่งเปิด (no-op dispatch) เพื่อลิงก์ push ให้ตรงรอบ
    let newBatchId = '';
    dispatch((d) => { newBatchId = d.batches.find((x) => x.product_id === b.product_id && x.status === 'open')?.id ?? ''; return d; });
    if (p && pushEnabled(db, 'restock'))
      // ส่งแค่ชื่อ + ราคา — ไม่บอกจำนวนที่มาเพิ่ม (สร้างความเร่งด่วน + ไม่เผยสต๊อก)
      sendPush(subsForNewProduct(db, p), { title: '🔥 มาเพิ่มแล้ว!', body: `${p.series_name} · เปิดรอบใหม่ ${baht(Number(rp) || b.price_total)}`, url: `/shop/${b.product_id}${newBatchId ? `?batch=${newBatchId}` : ''}` }, dispatch).catch(() => {});
    flash(rSrc === 'pool'
      ? `เปิดรอบใหม่ขายของที่เหลือ ${q} ชิ้นแล้ว 🔥 (คลังเท่าเดิม ไม่ได้เพิ่มของ)`
      : `เปิดรอบใหม่ +${q} ชิ้นแล้ว 🔥 (รอบเก่าเก็บเข้าประวัติ)`);
    setRestock(false); setRq('');
  };

  // เผลอกดปิดรอบ → กดกลับได้ (เจ้าของ 2026-07-30) — ปิดรอบเป็นแค่การเก็บเข้าประวัติ ไม่ได้ทำลายอะไร
  const canReopen = b.status === 'closed' && !!p && !p.is_stock
    && !db.batches.some((x) => x.product_id === b.product_id && x.status === 'open');
  const doReopen = () => {
    if (!confirm(`เปิดรอบนี้กลับมาขายต่อ?\n"${p?.series_name} · ${b.label}" · ${baht(b.price_total)} · ขายไปแล้ว ${sold}/${b.stock_qty}\n\nของที่เหลือในรอบจะกลับมาให้ลูกค้ากดได้เหมือนเดิม`)) return;
    dispatch(uncloseBatch(b.id));
    let ok = false;
    dispatch((d) => { ok = d.batches.find((x) => x.id === b.id)?.status === 'open'; return d; });
    flash(ok ? 'เปิดรอบกลับมาแล้ว ✓' : 'เปิดกลับไม่ได้ — SKU นี้มีรอบอื่นเปิดอยู่ (ปิดรอบนั้นก่อน)');
  };

  return (
    <div className={cx('rounded-xl border border-subtle bg-surface-2 p-3.5', readOnly && moving.length === 0 && 'opacity-75')}>
      {/* การ์ดรูปสไตล์ "หาของนอกระบบ": รูป + ชื่อ + ราคา + chips สถานะรอบ */}
      <div className="flex items-start gap-3">
        <div className="h-[64px] w-[64px] shrink-0 overflow-hidden rounded-[10px] border border-subtle bg-stripe">
          {p?.images[0]
            ? <img src={p.images[0]} alt="" className="h-full w-full object-cover" />
            : <div className="grid h-full w-full place-items-center"><Icon name="box" size={24} className="text-primary-soft/25" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{p?.series_name ?? '—'} <span className="font-normal text-ink-faint">· {b.label}</span> <span className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-bold text-ink-muted2">รอบ {roundNo}</span> {isDraft && <span className="rounded bg-[#d97706]/20 px-1.5 py-0.5 text-[10px] font-bold text-[#fbbf24]">📝 ร่าง · ยังไม่ขึ้นหน้าร้าน</span>}</div>
          {/* ตัวเลขให้อ่านแบบเดียวกับที่เจ้าของคิด (เคส Orochimaru "ไม่ 14 หรอ"): ขาย/เปิดกด/ติดจอง/เก็บ
              ⏳ ติดจอง = คนกำลังจ่าย/สลิปรอตรวจ — ฝั่งลูกค้าเห็น "หมดชั่วคราว" ตอนเลขนี้กินของเหลือหมด */}
          <div className="mt-0.5 font-mono text-[11px] text-ink-faint">
            เปิด {fmtDate(b.created_at)} · {baht(b.price_total)} · {fullPay ? 'จ่ายเต็ม' : `มัดจำ ${baht(b.deposit_amount)}`} · เหลือ {remaining}/{b.stock_qty} · ขาย {sold}
            {(() => { const held = pendingHeld(db, b.product_id, b.id); return held > 0 ? <span className="animate-blink font-bold text-[#fbbf24]"> · ⏳ ติดจอง {held} (ลูกค้าเห็นเหลือ {Math.max(0, remaining - held)})</span> : null; })()}
            {p && !p.is_stock ? ` · 🔒 เก็บหลังรอบนี้ ${Math.max(0, stockRemaining(db, p) - remaining)}` : ''}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10.5px] font-bold">
            {fullPay ? <span className="rounded-md bg-[#16a34a]/15 px-1.5 py-0.5 text-[#4ade80]">ของอยู่ไทย · พร้อมส่ง</span> : (<>
              {nProd > 0 && <span className="rounded-md bg-[#d97706]/15 px-1.5 py-0.5 text-[#fbbf24]">ผลิต/รอโกดัง {nProd}</span>}
              {nShip > 0 && <span className="rounded-md bg-[#2563eb]/15 px-1.5 py-0.5 text-[#60a5fa]">เดินทาง {nShip}</span>}
              {nArr > 0 && <span className="rounded-md bg-[#16a34a]/15 px-1.5 py-0.5 text-[#4ade80]">ถึงไทย {nArr}</span>}
              {p?.sf_code && <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-ink-muted2">SF {p.sf_code.slice(0, 14)}</span>}
            </>)}
          </div>
        </div>
      </div>

      {/* ปุ่มแอ็กชันแถวเดียว (สไตล์การ์ด memo) */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button onClick={() => setOpen((v) => !v)} className="rounded-lg border border-[#d4af37]/45 bg-[#d4af37]/[0.1] px-3 py-1.5 text-[12px] font-bold text-[#f1d27a]">🎫 ลูกค้า ({tickets.length}) {open ? '▲' : '▼'}</button>
        {isDraft && !readOnly && (
          <button onClick={() => setPubOpen((v) => {
            const next = !v;
            if (next) {
              // ค่าตั้งต้นต้องอ่าน "ตอนเปิดแผง" ไม่ใช่ตอนการ์ด mount — ไม่งั้นมอบตั๋วไปแล้ว
              // แผงยังโชว์เลขเก่า (เคส Orochimaru: ควรขึ้น 9 ที่เหลือ ไม่ใช่ 14 ทั้งรอบ)
              setPubPrice(String(b.price_total));
              setPubDep(fullPay ? '' : String(b.deposit_amount));
              setPubQty(String(Math.max(0, b.stock_qty - sold)));
            }
            return next;
          })} className={cx('rounded-lg px-3 py-1.5 text-[12px] font-bold text-white', pubOpen ? 'bg-surface-4' : 'bg-cta')}>🚀 เปิดขาย + แจ้งลูกค้า {pubOpen ? '▲' : ''}</button>
        )}
        {!readOnly && b.status === 'open' && remaining > 0 && (
          <button onClick={() => setGranting((v) => !v)} className="rounded-lg border border-[#8b5cf6]/50 bg-[#8b5cf6]/[0.12] px-3 py-1.5 text-[12px] font-bold text-[#c4b5fd]">🎁 มอบตั๋ว</button>
        )}
        {/* แถบสถานะรอบ — กดสลับได้ทั้งเดินหน้าและ "ย้อนกลับ" (เจ้าของ 2026-07-28)
            ผลิต → เดินทาง: ไม่ต้องรอคิวยืนยันโกดัง (ใช้ได้เฉพาะล็อตที่มี SF + ตารางโกดัง)
            ย้อนกลับ: ไว้แก้ตอนตั้งจุดเริ่มผิด/กดพลาด — ไม่ยิงแจ้งเตือนลูกค้า */}
        {!fullPay && phase && (
          <span className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-subtle bg-surface-3/60 px-1.5 py-1">
            <span className="pr-0.5 text-[10.5px] font-bold text-ink-faint">สถานะรอบ</span>
            <Step on={phase === 'production'} tone="amber" onClick={() => doRevert('production')}>🏭 ผลิต{nProd > 0 ? ` ${nProd}` : ''}</Step>
            <span className="text-[10px] text-ink-faint">›</span>
            {phase === 'production' && (
              <select value={depTr} onChange={(e) => setDepTr(e.target.value as 'truck' | 'ship')} aria-label="ขนส่ง" className="rounded bg-transparent text-[11.5px] font-bold text-[#60a5fa] outline-none">
                <option value="truck">🚚 รถ</option>
                <option value="ship">🚢 เรือ</option>
              </select>
            )}
            <Step on={phase === 'shipping'} tone="blue" onClick={() => (phase === 'production' ? doDepart() : doRevert('shipping'))}>
              🚚 เดินทาง{nShip > 0 ? ` ${nShip}` : ''}
            </Step>
            <span className="text-[10px] text-ink-faint">›</span>
            <Step on={phase === 'arrived'} tone="green" onClick={doArrive}>
              🇹🇭 ถึงไทย{nArr > 0 ? ` ${nArr}` : tickets.length === 0 && phase !== 'arrived' ? ' → In-Stock' : ''}
            </Step>
          </span>
        )}
        {/* เผลอกดปิดรอบ → กดกลับได้เลย (ไม่ต้องสร้างรอบใหม่ให้ข้อมูลเละ) */}
        {canReopen && <button onClick={doReopen} className="rounded-lg border border-[#2563eb]/50 bg-[#2563eb]/[0.14] px-2.5 py-1.5 text-[12px] font-bold text-[#60a5fa]">↩ เปิดรอบนี้กลับ</button>}
        {(soldOut || readOnly) && !restock && (
          <button onClick={() => { setRp(String(b.price_total)); setRd(String(b.deposit_amount)); setRSrc(poolLeft > 0 ? 'pool' : 'new'); setRq(poolLeft > 0 ? String(poolLeft) : ''); setRestock(true); }}
            className="rounded-lg border border-[#16a34a]/45 bg-[#16a34a]/[0.12] px-2.5 py-1.5 text-[12px] font-bold text-[#4ade80]">
            {poolLeft > 0 ? `📦 ขายของที่เหลือ (${poolLeft})` : '➕ มีของเพิ่ม'}
          </button>
        )}
        {!readOnly && noBuyers && !edit && <button onClick={() => { setEp(String(b.price_total)); setEq(String(b.stock_qty)); setEl(b.label); setEdit(true); }} className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted2">แก้ไข</button>}
        {!readOnly && noBuyers && <button onClick={() => { if (confirm('ยกเลิกรอบนี้? (ยังไม่มีคนซื้อ)')) { dispatch(removeBatch(b.id)); flash('ยกเลิกรอบแล้ว'); } }} className="rounded-lg border border-[#b91c1c]/40 bg-[#b91c1c]/[0.12] px-2.5 py-1.5 text-[12px] font-semibold text-primary-soft">ยกเลิก</button>}
        {!readOnly && <button onClick={() => { dispatch(closeBatch(b.id)); flash('ปิดรอบ · เก็บเข้าประวัติแล้ว'); }} className="rounded-lg border border-subtle bg-surface-3 px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted2">ปิดรอบ</button>}
      </div>

      {/* ตั้งราคา/มัดจำ/จำนวน "ของล็อตนี้" ก่อนเปิดขายจริง — ตั๋วที่ออกแล้วไม่ถูกแตะ (snapshot) */}
      {pubOpen && isDraft && !readOnly && (
        <div className="mt-2 rounded-lg border border-[#d4af37]/50 bg-[#d4af37]/[0.06] p-2.5">
          <div className="mb-2 text-[11.5px] font-bold text-[#f1d27a]">🚀 ตั้งราคาล็อตนี้ก่อนเปิดขาย — ยืนยันแล้วขึ้นหน้าร้าน + แจ้งลูกค้าทันที</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] text-ink-faint">ราคาขาย/ชิ้น
              <input value={pubPrice} onChange={(e) => setPubPrice(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" className="mt-0.5 block w-24 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-[13px] text-ink outline-none focus:border-accent" />
            </label>
            {!fullPay && (
              <label className="text-[11px] text-ink-faint">มัดจำ/ชิ้น
                <input value={pubDep} onChange={(e) => setPubDep(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder={String(b.deposit_amount)} className="mt-0.5 block w-24 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-[13px] text-ink outline-none focus:border-accent" />
              </label>
            )}
            <label className="text-[11px] text-ink-faint">เปิดขายหน้าร้าน (ชิ้น)
              <input value={pubQty} onChange={(e) => setPubQty(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" className="mt-0.5 block w-20 rounded-lg border border-subtle bg-surface-3 px-2 py-1.5 text-center text-[13px] text-ink outline-none focus:border-accent" />
            </label>
            <button onClick={doPublish} className="rounded-lg bg-cta px-4 py-2 text-[12.5px] font-bold text-white">ยืนยันเปิดขาย + แจ้งลูกค้า</button>
          </div>
          {/* สรุปเลขให้เห็นก่อนกด — กันตีความช่องจำนวนผิด (เคส Orochimaru: ใส่ 5 = ขาย 5 ไม่ใช่ทั้งรอบ 5) */}
          <div className="mt-1.5 text-[11px] text-ink-faint">
            {(() => {
              const sell = Number(pubQty) || 0;
              const pool = p && !p.is_stock ? stockRemaining(db, p) : null; // ของในคลังที่ยังไม่ถูกขาย
              return (
                <>
                  {sold > 0 && <>🔒 มอบไปแล้ว {sold} ชิ้น (ราคาเดิมบนตั๋ว) · </>}
                  เปิดให้กดหน้าร้าน {sell} ชิ้น{sold > 0 && <> = รวมทั้งรอบ {sold + sell}</>}
                  {pool != null && <> · คลังยังไม่ขาย {pool} ชิ้น → {sell <= pool
                    ? `ขายหมดแล้วจะเหลือเก็บ ${pool - sell}`
                    : `⚠ เกินคลัง ${sell - pool} ชิ้น (ระบบจะบวกคลังเพิ่มให้)`}</>}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* มอบตั๋วให้ลูกค้าโดยตรง — ตัดสต๊อกรอบทันที · เลขตั๋วจองจาก server · มัดจำที่รับมาแล้วปรับได้ */}
      {granting && (
        <div className="mt-2 rounded-lg border border-[#8b5cf6]/40 bg-[#8b5cf6]/[0.06] p-2.5">
          <div className="mb-2 text-[11.5px] font-bold text-[#c4b5fd]">🎁 มอบตั๋วรอบนี้ (สต๊อกเหลือ {remaining}) — ราคา {baht(b.price_total)}/ชิ้น</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[180px] flex-1 text-[11px] text-ink-faint">ลูกค้า
              <select className={cx(inputCls, 'mt-0.5 py-2')} value={gUser} onChange={(e) => setGUser(e.target.value)}>
                <option value="">— เลือกลูกค้า —</option>
                {grantables.map((u) => <option key={u.id} value={u.id}>{u.display_name}{u.member_code ? ` · ${u.member_code}` : ''}{u.phone ? ` · ${u.phone}` : ''}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-ink-faint">จำนวน
              <input className={cx(inputCls, 'mt-0.5 w-16 py-2 text-center')} inputMode="numeric" value={gQty} onChange={(e) => setGQty(e.target.value.replace(/[^\d]/g, ''))} />
            </label>
            {/* ราคา/ชิ้น ตั้งเองได้ — ขอบเหลือง = ไม่เท่าราคารอบ (ดีลเฉพาะใบนี้) */}
            <label className="text-[11px] text-ink-faint">ราคา/ชิ้น
              <input className={cx(inputCls, 'mt-0.5 w-24 py-2 text-center', (Number(gPrice) || 0) !== b.price_total && 'border-[#fbbf24]')} inputMode="numeric" value={gPrice} onChange={(e) => setGPrice(e.target.value.replace(/[^\d]/g, ''))} />
            </label>
            <label className="text-[11px] text-ink-faint">มัดจำรับแล้ว/ชิ้น
              <input className={cx(inputCls, 'mt-0.5 w-24 py-2 text-center')} inputMode="numeric" value={gDep} onChange={(e) => setGDep(e.target.value.replace(/[^\d]/g, ''))} />
            </label>
            <span className="text-[11px] text-ink-faint">ค้าง/ชิ้น<b className="mt-0.5 block text-center text-[13px] text-primary-soft">{baht(Math.max(0, (Number(gPrice) || 0) - (Number(gDep) || 0)))}</b></span>
            <button onClick={doGrant} disabled={gBusy} className="rounded-lg bg-[#8b5cf6] px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-50">{gBusy ? 'กำลังออกตั๋ว…' : '✓ มอบตั๋ว'}</button>
            <button onClick={() => setGranting(false)} className="py-2 text-[12px] text-ink-faint">ยกเลิก</button>
          </div>
          <div className="mt-1.5 text-[10.5px] text-ink-faint">ราคา/มัดจำที่ใส่ = snapshot ลงตั๋วใบนี้ใบเดียว (ราคารอบและลูกค้าคนอื่นไม่กระทบ) · มัดจำเต็มราคา = จ่ายครบทันที · ตัดสต๊อกทันทีที่มอบ</div>
        </div>
      )}

      {/* รหัสชิปปิ้งค่าย→โกดังจีน (ไว้เทียบตารางโกดังใน "ยืนยันเข้าโกดังจีน" ด้านบน) — โชว์ตราบใดที่ยังมีของ
          ไม่ถึงไทย (รวมรอบที่ปิดขายไปแล้วแต่ของยังเดินทาง); รอบเปิดที่ยังไม่มีคนซื้อก็ใส่ล่วงหน้าได้ */}
      {!fullPay && (nArr < tickets.length || (tickets.length === 0 && !readOnly)) && (
        <div className="mt-2 flex items-end gap-2">
          <label className="flex-1 text-[11px] text-ink-faint">รหัสชิปปิ้ง ค่าย→โกดังจีน (SF)
            <input className={cx(inputCls, 'mt-0.5 py-2 font-mono text-[12px]')} value={sf} onChange={(e) => setSf(e.target.value)} placeholder="เช่น SF5194798275423" />
          </label>
          <button onClick={saveSf} className="rounded-lg border border-[#2563eb]/45 bg-[#2563eb]/[0.1] px-3 py-2 text-[12px] font-bold text-[#60a5fa]">บันทึก SF</button>
        </div>
      )}

      {restock && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-[#16a34a]/35 bg-[#16a34a]/[0.06] p-2.5">
          {/* แหล่งของ: ของที่เหลือในคลัง (ไม่ทำให้คลังบวม) vs ของมาเพิ่มจากจีน — เจ้าของ 2026-07-30 */}
          {poolLeft > 0 && (
            <div className="inline-flex w-full overflow-hidden rounded-lg border border-subtle">
              {([['pool', `📦 ขายของที่เหลือในคลัง (${poolLeft})`], ['new', '➕ ของมาเพิ่มจากจีน']] as const).map(([k, label]) => (
                <button key={k} onClick={() => { setRSrc(k); setRq(k === 'pool' ? String(poolLeft) : ''); }}
                  className={cx('flex-1 px-2.5 py-1.5 text-[11.5px] font-bold', rSrc === k ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted2')}>{label}</button>
              ))}
            </div>
          )}
          <label className="text-[12px] text-ink-muted">{rSrc === 'pool' ? 'ขาย (ชิ้น)' : 'มาเพิ่ม (ชิ้น)'}<input autoFocus className="ml-1 w-16 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-center text-sm outline-none" inputMode="numeric" value={rq} onChange={(e) => setRq(e.target.value.replace(/[^\d]/g, ''))} placeholder="5" /></label>
          <label className="text-[12px] text-ink-muted">ราคา<input className="ml-1 w-24 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-sm outline-none" inputMode="numeric" value={rp} onChange={(e) => setRp(e.target.value.replace(/[^\d]/g, ''))} /></label>
          <label className="text-[12px] text-ink-muted">มัดจำ<input className="ml-1 w-24 rounded-lg border border-subtle bg-surface-2 px-2 py-1.5 text-sm outline-none" inputMode="numeric" value={rd} onChange={(e) => setRd(e.target.value.replace(/[^\d]/g, ''))} /></label>
          {/* จุดเริ่มรอบใหม่ — เฉพาะรอบมัดจำ (มัดจำ >= ราคา = ของในมือ → arrived อัตโนมัติ) */}
          {(Number(rd) || 0) < (Number(rp) || b.price_total) && (
            <div className="inline-flex overflow-hidden rounded-lg border border-subtle">
              {(['production', 'shipping'] as const).map((s) => (
                <button key={s} onClick={() => setRStart(s)} className={cx('px-2.5 py-1.5 text-[11.5px] font-bold', rStart === s ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted2')}>{s === 'production' ? '🏭 เริ่ม: ผลิต' : '🚚 เริ่ม: เดินทางแล้ว'}</button>
              ))}
            </div>
          )}
          <button onClick={doRestock} className="rounded-lg bg-cta px-4 py-2 text-[12.5px] font-bold text-white">🔥 เปิดรอบใหม่ + แจ้งลูกค้า</button>
          <button onClick={() => setRestock(false)} className="py-2 text-[12px] text-ink-faint">ยกเลิก</button>
          <span className="w-full text-[11px] text-ink-faint">
            {rSrc === 'pool'
              ? `ขายของที่มีอยู่แล้วในคลัง — คลังไม่เพิ่ม (เหลือหลังเปิดรอบนี้ ${Math.max(0, poolLeft - (Number(rq) || 0))} ชิ้น) · `
              : 'ของมาเพิ่มจากจีน — คลังจะเพิ่มตามจำนวนที่ใส่ · '}
            รอบเก่าเก็บเข้าประวัติ (log คนซื้อแยกรอบ) · push "🔥 มาเพิ่มแล้ว!" ถึงลูกค้าที่เปิดแจ้งเตือน
          </span>
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

      {open && (() => {
        // ── ประวัติตั๋วทั้ง SKU จัดกลุ่มใหม่ (เจ้าของ 2026-07-30: เดิมกองรวมกันอ่านงง) ──
        // สรุปหัว: มีทั้งหมด N = มอบตั๋ว x ราคา x / รอบ 1 x ราคา x / รอบ 2 ... / เก็บ
        // กลุ่ม: 🎁 มอบตั๋ว (เรียงวันที่เก่า→ใหม่) แล้วค่อย 🛒 ซื้อรอบ X ทีละรอบ
        const roundsAll = db.batches.filter((x) => x.product_id === b.product_id).sort((x, y) => (x.created_at < y.created_at ? -1 : 1));
        const noOf = (bid: string) => roundsAll.findIndex((x) => x.id === bid) + 1;
        const skuTickets = db.tickets.filter((t) => t.product_id === b.product_id && t.batch_id);
        const byDate = (x: PreorderTicket, y: PreorderTicket) => (x.created_at < y.created_at ? -1 : 1);
        const grantedRows = skuTickets.filter((t) => ticketSourceOf(db, t) === 'granted').sort(byDate);
        const buyGroups = roundsAll
          .map((r) => ({ no: noOf(r.id), rows: skuTickets.filter((t) => t.batch_id === r.id && ticketSourceOf(db, t) !== 'granted').sort(byDate) }))
          .filter((g) => g.rows.length > 0);
        const qtyOf = (rows: PreorderTicket[]) => rows.reduce((s, t) => s + t.qty, 0);
        const unitOf = (t: PreorderTicket) => Math.round((t.deposit_paid + t.remaining_amount) / Math.max(1, t.qty));
        // ราคาในกลุ่ม: ราคาเดียว → "฿1,640" · หลายราคา → "฿1,640×5 · ฿2,040×2"
        const priceMix = (rows: PreorderTicket[]) => {
          const m = new Map<number, number>();
          rows.forEach((t) => m.set(unitOf(t), (m.get(unitOf(t)) ?? 0) + t.qty));
          const es = [...m.entries()].sort((x, y) => x[0] - y[0]);
          return es.length === 1 ? `ราคา ${baht(es[0][0])}` : es.map(([u, n]) => `${baht(u)}×${n}`).join(' · ');
        };
        const pool = p && !p.is_stock ? (p.surplus_qty ?? 0) : null;
        const keep = p && !p.is_stock ? Math.max(0, stockRemaining(db, p) - (b.status === 'open' ? remaining : 0)) : null;
        const Row = ({ t, tag }: { t: PreorderTicket; tag?: string }) => (
          <button key={t.id} onClick={() => setPeek(t)} className="flex flex-wrap items-center justify-between gap-1 rounded-lg px-1 py-1 text-left text-[13px] hover:bg-white/[0.04]">
            <span className="flex items-center gap-2">
              <Icon name="user" size={13} className="text-primary-soft" /> {userName(t.owner_id)}
              {tag && <span className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-bold text-ink-muted2">{tag}</span>}
            </span>
            <span className="text-ink-muted">×{t.qty} · <b className="text-ink">{baht(unitOf(t))}</b> · มัดจำ {t.deposit_paid > 0 ? <b className="text-[#4ade80]">{baht(t.deposit_paid)}</b> : <b className="text-[#f87171]">฿0 ยังไม่จ่าย</b>} · <span className="font-mono text-[11px] text-ink-faint">{t.ticket_no}</span> · {fmtDate(t.created_at)}</span>
          </button>
        );
        return (
          <div className="mt-2 rounded-xl border border-subtle bg-surface-3 p-3">
            <div className="mb-1.5 text-[12px] font-semibold text-ink-muted">📋 ประวัติตั๋ว {p?.series_name} · แตะรายชื่อดูตั๋ว/สลิป</div>
            {/* สรุปยอดแบบอ่านรวดเดียวจบ */}
            <div className="mb-2.5 flex flex-wrap gap-1.5 text-[11px] font-bold">
              {pool != null && <span className="rounded-md bg-white/[0.08] px-2 py-1 text-ink">มีทั้งหมด {pool} ชิ้น</span>}
              {grantedRows.length > 0 && <span className="rounded-md bg-[#8b5cf6]/[0.16] px-2 py-1 text-[#c4b5fd]">🎁 มอบตั๋ว {qtyOf(grantedRows)} · {priceMix(grantedRows)}</span>}
              {buyGroups.map((g) => <span key={g.no} className="rounded-md bg-[#d4af37]/15 px-2 py-1 text-[#f1d27a]">🛒 รอบ {g.no} ขาย {qtyOf(g.rows)} · {priceMix(g.rows)}</span>)}
              {b.status === 'open' && remaining > 0 && <span className="rounded-md bg-[#16a34a]/15 px-2 py-1 text-[#4ade80]">เปิดขายเหลือ {remaining}</span>}
              {keep != null && keep > 0 && <span className="rounded-md bg-white/[0.08] px-2 py-1 text-ink-muted2">🔒 เก็บในคลัง {keep}</span>}
            </div>
            {skuTickets.length === 0 ? <div className="text-[12.5px] text-ink-faint">ยังไม่มีตั๋วเลย</div> : (
              <div className="flex flex-col gap-2.5">
                {grantedRows.length > 0 && (
                  <div>
                    <div className="mb-1 text-[11px] font-bold text-[#c4b5fd]">🎁 มอบตั๋ว ({grantedRows.length} ใบ · เรียงตามวันที่)</div>
                    <div className="flex flex-col gap-1">{grantedRows.map((t) => <Row key={t.id} t={t} tag={roundsAll.length > 1 ? `รอบ ${noOf(t.batch_id!)}` : undefined} />)}</div>
                  </div>
                )}
                {buyGroups.map((g) => (
                  <div key={g.no}>
                    <div className="mb-1 text-[11px] font-bold text-[#f1d27a]">🛒 ซื้อหน้าร้าน รอบ {g.no} ({g.rows.length} ใบ · เรียงตามวันที่)</div>
                    <div className="flex flex-col gap-1">{g.rows.map((t) => <Row key={t.id} t={t} />)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {peek && <TicketPeek ticket={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}
