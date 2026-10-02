'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { store } from '@/data/store';
import { setPayoutAccounts } from '@/data/mutations';
import { promptPayTarget, formatPromptPay } from '@/lib/promptpay';
import { THAI_BANKS, bankOf, maskAccount } from '@/lib/thaiBanks';
import type { PayoutAccount, User } from '@/domain/entities';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';

const inputCls = 'w-full rounded-xl border border-subtle bg-surface-3 px-3 py-2.5 text-[14px] text-ink outline-none focus:border-accent';

/** โลโก้ธนาคาร = วงกลมสีประจำธนาคาร + ตัวย่อ (ไม่โหลดไฟล์นอก · เฟส 3 สลับเป็น SVG ได้ที่นี่ที่เดียว) */
export function BankLogo({ code, size = 36, className }: { code?: string | null; size?: number; className?: string }) {
  const b = bankOf(code);
  const fs = b.short.length >= 5 ? size * 0.26 : b.short.length === 4 ? size * 0.3 : size * 0.36;
  return (
    <span aria-label={b.name} title={b.name} className={cx('grid shrink-0 place-items-center rounded-full font-extrabold leading-none tracking-tight shadow-[inset_0_-2px_0_rgba(0,0,0,.18)]', className)}
      style={{ width: size, height: size, background: b.color, color: b.ink ?? '#fff', fontSize: fs }}>
      {b.short}
    </span>
  );
}

/** บัญชีที่ลงทะเบียนของ user — รวม payout_info รุ่นเก่า (v71 บัญชีเดียว) ให้เห็นเป็นรายการแรกถ้ายังไม่มีลิสต์ */
export function payoutAccountsOf(u?: User): PayoutAccount[] {
  if (u?.payout_accounts?.length) return u.payout_accounts;
  const p = u?.payout_info;
  if (!p?.account_name || (!p.promptpay && !p.account_no)) return [];
  return [{ id: 'legacy', bank: p.account_no ? (p.bank && THAI_BANKS.some((b) => b.code === p.bank) ? p.bank : 'other') : 'promptpay', account_no: p.account_no, promptpay: p.promptpay, account_name: p.account_name }];
}

/** ข้อความสั้นของบัญชี: "กสิกรไทย 123•••890 · สมชาย" */
export function payoutLabel(a: PayoutAccount): string {
  const b = bankOf(a.bank);
  const no = a.bank === 'promptpay' || (!a.account_no && a.promptpay) ? `พร้อมเพย์ ${formatPromptPay(a.promptpay ?? '')}` : `${b.name} ${maskAccount(a.account_no)}`;
  return `${no} · ${a.account_name}`;
}

/**
 * เลือก/เพิ่มบัญชีรับเงิน (เจ้าของ 2026-10-02 ข้อ 3: เลือกบัญชีที่ลงทะเบียน · ไม่มี → สร้าง (เลือกธนาคาร+ใส่เลข) ·
 * ใช้ร่วมกับลงขายกระดาน) — บัญชีที่เลือกถูกก๊อปปี้ลง users.payout_info ให้ RPC เดิมอ่านได้ทันที
 * ⚠ คอมโพเนนต์ระดับไฟล์ + ร่างฟอร์มอยู่ใน state ของตัวเอง (DNA react-state)
 */
export function PayoutPicker({ selectedId, onSelect }: { selectedId?: string; onSelect: (a: PayoutAccount | null) => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const me = db.users.find((u) => u.id === uid);
  const accounts = payoutAccountsOf(me);
  const [adding, setAdding] = useState(accounts.length === 0);
  const [form, setForm] = useState({ bank: 'promptpay', account_no: '', promptpay: '', account_name: me?.payout_info?.account_name ?? '' });
  const [busy, setBusy] = useState(false);

  const persist = async (list: PayoutAccount[], selectId: string) => {
    setBusy(true);
    dispatch(setPayoutAccounts(uid, list, selectId));
    const failed = await store.flush();
    setBusy(false);
    return !failed;
  };

  const choose = async (a: PayoutAccount) => {
    onSelect(a);
    // บันทึก "บัญชีหลัก" ไว้ด้วย (payout_info) — ล้มก็ไม่กั้นการเลือกในหน้านี้ (ดีลล็อก snapshot เอง)
    if (me?.payout_info?.account_name !== a.account_name || (me?.payout_info?.promptpay ?? '') !== (a.promptpay ?? '') || (me?.payout_info?.account_no ?? '') !== (a.account_no ?? '')) {
      void persist(accounts, a.id);
    }
  };

  const save = async () => {
    const name = form.account_name.trim();
    const pp = form.promptpay.replace(/\D/g, '');
    const no = form.account_no.replace(/\D/g, '');
    if (!name) return flash('ใส่ชื่อบัญชี (ตามแอปธนาคาร)');
    if (form.bank === 'promptpay') {
      if (!pp || !promptPayTarget(pp)) return flash('พร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก');
    } else {
      if (no.length < 10) return flash('ใส่เลขบัญชีให้ครบ (10 หลักขึ้นไป)');
      if (pp && !promptPayTarget(pp)) return flash('พร้อมเพย์ (ถ้าใส่) ต้องเป็นเบอร์ 10 หลัก หรือเลขบัตร 13 หลัก');
    }
    if (accounts.some((a) => (a.account_no && a.account_no === no) || (a.promptpay && a.promptpay === pp && form.bank === 'promptpay'))) return flash('มีบัญชีนี้อยู่แล้ว');
    const acc: PayoutAccount = { id: `pa-${Date.now().toString(36)}`, bank: form.bank, account_name: name, ...(pp ? { promptpay: pp } : {}), ...(no ? { account_no: no } : {}), created_at: new Date().toISOString() };
    const list = [...accounts.filter((a) => a.id !== 'legacy' || accounts.length > 1), acc];
    if (!(await persist(list, acc.id))) return flash('บันทึกบัญชีไม่สำเร็จ — เช็คเน็ตแล้วลองใหม่');
    setAdding(false);
    setForm({ bank: 'promptpay', account_no: '', promptpay: '', account_name: name });
    onSelect(acc);
    flash('บันทึกบัญชีรับเงินแล้ว ✓');
  };

  const remove = async (a: PayoutAccount) => {
    if (!window.confirm(`ลบบัญชี ${payoutLabel(a)}?`)) return;
    const list = accounts.filter((x) => x.id !== a.id);
    if (!(await persist(list, list[0]?.id ?? ''))) return flash('ลบไม่สำเร็จ — ลองใหม่');
    if (selectedId === a.id) onSelect(list[0] ?? null);
    if (list.length === 0) setAdding(true);
  };

  return (
    <div className="rounded-2xl border border-subtle bg-surface-3 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13.5px] font-bold">บัญชีรับเงิน <span className="font-normal text-ink-faint">· ผู้รับจะโอนเข้าบัญชีนี้</span></div>
        {!adding && accounts.length < 6 && <button type="button" onClick={() => setAdding(true)} className="text-[12px] font-bold text-primary-soft underline">+ เพิ่มบัญชี</button>}
      </div>
      {accounts.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {accounts.map((a) => {
            const on = a.id === selectedId;
            return (
              <div key={a.id} className={cx('flex items-center gap-2.5 rounded-xl border px-2.5 py-2', on ? 'border-accent bg-[#b91c1c]/[0.08]' : 'border-subtle bg-surface-2')}>
                <button type="button" onClick={() => void choose(a)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                  <BankLogo code={a.bank} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold">{a.bank === 'promptpay' || (!a.account_no && a.promptpay) ? `พร้อมเพย์ ${formatPromptPay(a.promptpay ?? '')}` : `${bankOf(a.bank).name} ${maskAccount(a.account_no)}`}</span>
                    <span className="block truncate text-[11.5px] text-ink-faint">{a.account_name}{a.account_no && a.promptpay ? ` · พร้อมเพย์ ${formatPromptPay(a.promptpay)}` : ''}{a.promptpay ? ' · QR ใส่ยอดได้' : ' · ผู้รับก๊อปเลขไปโอน'}</span>
                  </span>
                  <span className={cx('grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 text-[11px] font-extrabold', on ? 'border-[#dc2626] bg-[#dc2626] text-white' : 'border-white/20 text-transparent')}>✓</span>
                </button>
                <button type="button" onClick={() => void remove(a)} disabled={busy} aria-label="ลบบัญชี" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-subtle text-ink-faint"><Icon name="x" size={13} /></button>
              </div>
            );
          })}
        </div>
      )}
      {adding && (
        <div className="mt-3 rounded-xl border border-dashed border-accent/60 p-3">
          <div className="text-[12.5px] font-bold">เพิ่มบัญชีใหม่</div>
          <div className="mt-2 grid grid-cols-4 gap-1.5 sm:grid-cols-6">
            {THAI_BANKS.map((b) => (
              <button type="button" key={b.code} onClick={() => setForm({ ...form, bank: b.code })} title={b.name}
                className={cx('flex flex-col items-center gap-1 rounded-xl border px-1 py-1.5', form.bank === b.code ? 'border-accent bg-[#b91c1c]/[0.1]' : 'border-subtle bg-surface-2')}>
                <BankLogo code={b.code} size={30} />
                <span className="w-full truncate text-center text-[9.5px] leading-tight text-ink-muted2">{b.code === 'promptpay' ? 'พร้อมเพย์' : b.name}</span>
              </button>
            ))}
          </div>
          <div className="mt-2.5 grid gap-2">
            {form.bank === 'promptpay' ? (
              <input id="pa-pp" inputMode="numeric" value={form.promptpay} onChange={(e) => setForm({ ...form, promptpay: e.target.value })} placeholder="เบอร์พร้อมเพย์ / เลขบัตรประชาชน" className={inputCls} />
            ) : (
              <>
                <input id="pa-no" inputMode="numeric" value={form.account_no} onChange={(e) => setForm({ ...form, account_no: e.target.value })} placeholder={`เลขบัญชี ${bankOf(form.bank).name}`} className={inputCls} />
                <input id="pa-pp2" inputMode="numeric" value={form.promptpay} onChange={(e) => setForm({ ...form, promptpay: e.target.value })} placeholder="พร้อมเพย์ของบัญชีนี้ (ถ้ามี · ทำ QR ใส่ยอดให้ผู้รับ)" className={inputCls} />
              </>
            )}
            <input id="pa-name" value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} placeholder="ชื่อบัญชี (ตามแอปธนาคาร)" className={inputCls} />
          </div>
          <div className="mt-2.5 flex gap-2">
            {accounts.length > 0 && <button type="button" onClick={() => setAdding(false)} className="flex-1 rounded-btn border border-subtle py-2.5 text-[13px] font-bold text-ink-muted2">ยกเลิก</button>}
            <button type="button" disabled={busy} onClick={() => void save()} className="flex-1 rounded-btn border-[1.5px] border-accent py-2.5 text-[13.5px] font-bold text-primary-soft disabled:opacity-50">{busy ? 'กำลังบันทึก…' : 'บันทึกบัญชี'}</button>
          </div>
          <div className="mt-2 text-[11px] text-ink-faint">ผู้รับเห็นบัญชีนี้เฉพาะตอนมีข้อเสนอ/ดีลค้างกับคุณ · พร้อมเพย์แนะนำ เพราะระบบทำ QR ใส่ยอดให้ โอนผิดยอดยาก</div>
        </div>
      )}
    </div>
  );
}
