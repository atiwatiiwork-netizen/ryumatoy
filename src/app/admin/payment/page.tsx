'use client';

import { useState, useEffect } from 'react';
import { AdminTabs } from '@/components/AdminTabs';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { Icon } from '@/components/Icon';
import { Button, cx } from '@/components/ui';
import { genId, upsertPaymentAccount, removePaymentAccount, updateSettings, repriceOpenPreorders } from '@/data/mutations';
import { priceFromYuan, repriceTargets } from '@/domain/services/pricing';
import { baht } from '@/lib/theme';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block"><span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">{label}</span>{children}</label>
);

export default function AdminPaymentPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [qr, setQr] = useState<string | undefined>();
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  const reset = () => { setId(null); setName(''); setNumber(''); setQr(undefined); setActive(true); };
  const save = () => {
    if (!name.trim() || !number.trim()) return flash('กรอกชื่อบัญชี + เลข');
    dispatch(upsertPaymentAccount({ id: id ?? genId('pay'), name: name.trim(), number: number.trim(), qr_url: qr, active }));
    flash(id ? 'บันทึกบัญชีแล้ว' : 'เพิ่มบัญชีแล้ว'); reset();
  };
  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setQr(await uploadImage(file, 'qr')); flash('อัปโหลด QR แล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const toggle = (aid: string) => {
    const a = db.paymentAccounts.find((x) => x.id === aid);
    if (a) dispatch(upsertPaymentAccount({ ...a, active: !a.active }));
  };

  return (
    <div>
      <AdminTabs tabs={[{ href: '/admin/payment', label: '💳 บัญชีรับเงิน' }, { href: '/admin/push', label: '🔔 แจ้งเตือน (Push)' }]} />
      <div className="mb-2 text-2xl font-extrabold">ตั้งค่าการเงิน</div>
      <div className="mb-6 text-[13px] text-ink-faint">บัญชี/QR ที่ “เปิด” จะถูกใช้แสดงให้ลูกค้าตอนชำระเงิน (ใช้ตัวแรกที่เปิดอยู่)</div>

      <PricingConfig />

      <div className="mb-3 mt-6 text-lg font-extrabold">บัญชีรับเงิน / QR</div>
      <div className="grid gap-5 lg:grid-cols-[360px_1fr] lg:items-start">
        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-3 flex items-center justify-between"><span className="font-bold">{id ? 'แก้ไขบัญชี' : 'เพิ่มบัญชีใหม่'}</span>{id && <button onClick={reset} className="text-xs text-primary-soft">+ เพิ่มใหม่</button>}</div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <label className="grid h-20 w-20 flex-shrink-0 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-accent bg-white text-ink-faint">
                {busy ? <Icon name="box" size={22} className="animate-pulse text-ink-faint" /> : qr ? <img src={qr} alt="" className="h-full w-full object-contain" /> : <Icon name="qr" size={26} className="text-[#0a0809]" />}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              <div className="text-[12px] text-ink-faint">รูป QR PromptPay<br />แตะเพื่ออัปโหลด</div>
            </div>
            <Field label="ชื่อบัญชี / พร้อมเพย์"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น Ryuma Toy Shop" /></Field>
            <Field label="เลขบัญชี / เบอร์พร้อมเพย์"><input className={inputCls} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="เช่น 081-234-5678" /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> เปิดใช้ (โชว์ให้ลูกค้า)</label>
            <Button onClick={save} icon={id ? 'check' : 'plus'} disabled={busy}>{id ? 'บันทึก' : 'เพิ่มบัญชี'}</Button>
          </div>
        </div>

        <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
          <div className="mb-3 font-bold">บัญชีทั้งหมด ({db.paymentAccounts.length})</div>
          <div className="flex flex-col divide-y divide-hair">
            {db.paymentAccounts.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-3">
                <div className="grid h-12 w-12 flex-shrink-0 place-items-center overflow-hidden rounded-lg border border-subtle bg-white">
                  {a.qr_url ? <img src={a.qr_url} alt="" className="h-full w-full object-contain" /> : <Icon name="qr" size={20} className="text-[#0a0809]" />}
                </div>
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{a.name}</div><div className="font-mono text-[11.5px] text-ink-faint">{a.number}</div></div>
                <button onClick={() => toggle(a.id)} className={cx('rounded-full border px-3 py-1 text-[12px] font-semibold', a.active ? 'border-[#16a34a]/40 bg-[#16a34a]/[0.14] text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-faint')}>{a.active ? 'เปิด' : 'ปิด'}</button>
                <button onClick={() => { setId(a.id); setName(a.name); setNumber(a.number); setQr(a.qr_url); setActive(a.active); }} className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">แก้</button>
                <button onClick={() => { dispatch(removePaymentAccount(a.id)); flash('ลบบัญชีแล้ว'); if (id === a.id) reset(); }} className="grid h-8 w-8 place-items-center rounded-lg border border-subtle bg-surface-3 text-ink-faint"><Icon name="x" size={15} /></button>
              </div>
            ))}
            {db.paymentAccounts.length === 0 && <div className="py-8 text-center text-ink-faint">ยังไม่มีบัญชี</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function PricingConfig() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const s = db.settings;
  const [yuanBase, setYuanBase] = useState(String(s.yuan_base));
  const [bahtBase, setBahtBase] = useState(String(s.baht_base));
  const [perYuan, setPerYuan] = useState(String(s.baht_per_yuan));
  const [depWcf, setDepWcf] = useState(String(s.deposit_wcf));
  const [depMega, setDepMega] = useState(String(s.deposit_mega));
  // ค่าส่งเพิ่มตามช่วงต้นทุน (v87 · เปลี่ยนมาส่งรถ): ตั้งแต่ X¥ ขึ้นไป +A · ตั้งแต่ Y¥ ขึ้นไป +B (แทนขั้นแรก)
  const [sY1, setSY1] = useState(String(s.surcharge_from_yuan_1));
  const [sB1, setSB1] = useState(String(s.surcharge_baht_1));
  const [sY2, setSY2] = useState(String(s.surcharge_from_yuan_2));
  const [sB2, setSB2] = useState(String(s.surcharge_baht_2));
  const [showList, setShowList] = useState(false);

  // keep the form in sync with the real settings once they load from the DB (was showing stale seed)
  useEffect(() => {
    setYuanBase(String(s.yuan_base)); setBahtBase(String(s.baht_base)); setPerYuan(String(s.baht_per_yuan));
    setDepWcf(String(s.deposit_wcf)); setDepMega(String(s.deposit_mega));
    setSY1(String(s.surcharge_from_yuan_1)); setSB1(String(s.surcharge_baht_1)); setSY2(String(s.surcharge_from_yuan_2)); setSB2(String(s.surcharge_baht_2));
  }, [s.yuan_base, s.baht_base, s.baht_per_yuan, s.deposit_wcf, s.deposit_mega, s.surcharge_from_yuan_1, s.surcharge_baht_1, s.surcharge_from_yuan_2, s.surcharge_baht_2]);

  const preview = {
    ...s, yuan_base: Number(yuanBase) || 0, baht_base: Number(bahtBase) || 0, baht_per_yuan: Number(perYuan) || 0,
    surcharge_from_yuan_1: Number(sY1) || 0, surcharge_baht_1: Number(sB1) || 0, surcharge_from_yuan_2: Number(sY2) || 0, surcharge_baht_2: Number(sB2) || 0,
  };

  // สินค้าพรีที่เปิดรับและ "ยังไม่มีคนพรี" ซึ่งราคา/มัดจำไม่ตรงสูตรที่บันทึกไว้ → ปุ่ม "อัปเดตราคา" จะแก้เฉพาะชุดนี้
  // ชุดที่มีคนพรีแล้ว (ตั๋ว/ออเดอร์รอตรวจ/hold) ถูกกันไว้ทั้งก้อน ตามกฎเจ้าของ 2026-10-13 — ตัวจำแนกเดียวกับ mutation (repriceTargets)
  const { changed, protectedCount } = repriceTargets(db, s);

  const save = () => {
    dispatch(updateSettings({
      yuan_base: Number(yuanBase) || 0, baht_base: Number(bahtBase) || 0, baht_per_yuan: Number(perYuan) || 0,
      surcharge_from_yuan_1: Number(sY1) || 0, surcharge_baht_1: Number(sB1) || 0, surcharge_from_yuan_2: Number(sY2) || 0, surcharge_baht_2: Number(sB2) || 0,
      deposit_wcf: Number(depWcf) || 0, deposit_mega: Number(depMega) || 0,
    }));
    flash('บันทึกสูตรราคาแล้ว');
  };

  const cell = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
  const samples = [288, 328, 400, 500];
  return (
    <div className="rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-1 font-bold">สูตรราคา &amp; มัดจำ</div>
      <div className="mb-4 text-[12.5px] text-ink-faint">ราคา(฿) = ฐานบาท + (หยวน − ฐานหยวน) × บาทต่อหยวน + ค่าส่งเพิ่มตามช่วงต้นทุน · ปรับได้เมื่อเรทหยวน/วิธีส่งเปลี่ยน</div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">ฐานหยวน</span><input className={cell} inputMode="numeric" value={yuanBase} onChange={(e) => setYuanBase(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">= ฐานบาท</span><input className={cell} inputMode="numeric" value={bahtBase} onChange={(e) => setBahtBase(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">บาท/หยวน</span><input className={cell} inputMode="numeric" value={perYuan} onChange={(e) => setPerYuan(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">มัดจำ WCF</span><input className={cell} inputMode="numeric" value={depWcf} onChange={(e) => setDepWcf(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">มัดจำ Mega</span><input className={cell} inputMode="numeric" value={depMega} onChange={(e) => setDepMega(e.target.value)} /></label>
      </div>
      <div className="mt-4 mb-1 text-[12.5px] font-semibold text-ink-muted">ค่าส่งเพิ่มตามช่วงต้นทุน (ส่งรถ)</div>
      <div className="mb-2 text-[12px] text-ink-faint">ต่ำกว่าขั้น 1 = ราคาเดิม · ตั้งแต่ขั้น 1 ขึ้นไปบวกก้อนที่ 1 · ตั้งแต่ขั้น 2 ขึ้นไปบวกก้อนที่ 2 แทน (ไม่บวกซ้อน)</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">ขั้น 1 ตั้งแต่ (¥)</span><input className={cell} inputMode="numeric" value={sY1} onChange={(e) => setSY1(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">บวก (฿)</span><input className={cell} inputMode="numeric" value={sB1} onChange={(e) => setSB1(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">ขั้น 2 ตั้งแต่ (¥)</span><input className={cell} inputMode="numeric" value={sY2} onChange={(e) => setSY2(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[12px] text-ink-muted">บวก (฿)</span><input className={cell} inputMode="numeric" value={sB2} onChange={(e) => setSB2(e.target.value)} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] text-ink-muted">ตัวอย่าง: {samples.map((y, i) => <span key={y}>{i ? ' · ' : ''}{y}¥ = {baht(priceFromYuan(preview, y))}</span>)}</span>
        <button onClick={() => { dispatch(repriceOpenPreorders()); flash(`อัปเดตราคาพรีที่ยังไม่มีคนพรีตามสูตรแล้ว`); }} className="ml-auto rounded-btn border border-subtle bg-surface-3 px-4 py-2.5 text-[13px] font-bold text-ink-muted2">อัปเดตราคาพรี (เฉพาะที่ยังไม่มีคนพรี){changed.length ? ` (${changed.length})` : ''}</button>
        <button onClick={save} className="rounded-btn bg-cta px-5 py-2.5 text-sm font-bold text-white">บันทึกสูตร</button>
      </div>
      <div className="mt-2 text-[12px] text-ink-faint">
        พรีที่เปิดรับอยู่: จะเปลี่ยน {changed.length} รายการ · กันไว้เพราะมีคนพรีแล้ว {protectedCount} รายการ (ไม่แตะ) · ใบที่ปิดรอบ/ตั๋วที่ออกแล้วไม่กระทบ
      </div>
      {changed.length > 0 && (
        <div className="mt-2 rounded-lg border border-[#d97706]/40 bg-[#d97706]/[0.1] px-3 py-2 text-[12px] text-[#fbbf24]">
          <div className="flex items-center justify-between gap-2">
            <span>มี {changed.length} รายการพรีที่ยังไม่มีคนพรี ราคา/มัดจำยังไม่ตรงสูตรปัจจุบัน — กด “อัปเดตราคาพรี” เพื่อปรับ (ตรวจรายการก่อนกด: ราคาที่ตั้งเองทับไว้จะถูกแทนด้วยสูตร)</span>
            <button type="button" onClick={() => setShowList((v) => !v)} className="shrink-0 rounded-md border border-[#d97706]/50 px-2 py-1 text-[11.5px] font-bold">{showList ? 'ซ่อน' : 'ดูรายการ'}</button>
          </div>
          {showList && (
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto text-[12px] text-ink">
              {changed.map(({ product: p, next }) => (
                <li key={p.id} className="flex flex-wrap items-baseline gap-x-2 border-t border-[#d97706]/20 pt-1">
                  <span className="min-w-0 flex-1 truncate">{p.series_name}{p.cost_yuan != null ? ` · ${p.cost_yuan}¥` : ''}</span>
                  <span className="tabular-nums text-ink-muted">{baht(p.price_total)} → <b className="text-ink">{baht(next.price_total)}</b></span>
                  {next.deposit_amount !== p.deposit_amount && <span className="tabular-nums text-ink-faint">มัดจำ {baht(p.deposit_amount)} → {baht(next.deposit_amount)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
