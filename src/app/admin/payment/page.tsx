'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { uploadImage } from '@/lib/upload';
import { Icon } from '@/components/Icon';
import { Button, cx } from '@/components/ui';
import { genId, upsertPaymentAccount, removePaymentAccount } from '@/data/mutations';

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
      <div className="mb-2 text-2xl font-extrabold">ตั้งค่าการเงิน</div>
      <div className="mb-6 text-[13px] text-ink-faint">บัญชี/QR ที่ “เปิด” จะถูกใช้แสดงให้ลูกค้าตอนชำระเงิน (ใช้ตัวแรกที่เปิดอยู่)</div>

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
