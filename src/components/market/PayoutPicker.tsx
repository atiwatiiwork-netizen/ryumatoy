'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { store } from '@/data/store';
import { setPayoutAccounts, payoutInfoOf, samePayout } from '@/data/mutations';
import { persistFailText } from '@/data/persistErrors';
import { promptPayTarget, formatPromptPay } from '@/lib/promptpay';
import { THAI_BANKS, bankOf, maskAccount, bankDisplayName, accountNoError } from '@/lib/thaiBanks';
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

/** บัญชีที่ลงทะเบียนของ user — รวม payout_info รุ่นเก่า (v71 บัญชีเดียว) ให้เห็นเป็นรายการแรกถ้ายังไม่มีลิสต์
 *  ชื่อธนาคารที่เคยพิมพ์เป็นข้อความ (ไม่ใช่รหัส) เก็บไว้ใน bank_name ไม่ถูกทับเป็น "ธนาคารอื่น" (audit รอบ C R1-14) */
export function payoutAccountsOf(u?: User): PayoutAccount[] {
  if (u?.payout_accounts?.length) return u.payout_accounts;
  const p = u?.payout_info;
  if (!p?.account_name || (!p.promptpay && !p.account_no)) return [];
  if (!p.account_no) return [{ id: 'legacy', bank: 'promptpay', promptpay: p.promptpay, account_name: p.account_name }];
  const isCode = !!p.bank && THAI_BANKS.some((b) => b.code === p.bank);
  return [{ id: 'legacy', bank: isCode ? p.bank! : 'other', ...(!isCode && p.bank ? { bank_name: p.bank } : {}), account_no: p.account_no, promptpay: p.promptpay, account_name: p.account_name }];
}

/** บัญชีหลักตอนนี้ = ตัวที่ตรงกับ payout_info (เลือกล่าสุด) */
export function primaryPayoutId(u?: User): string | undefined {
  const p = u?.payout_info;
  const list = payoutAccountsOf(u);
  return (p ? list.find((a) => samePayout(payoutInfoOf(a), p)) : undefined)?.id;
}

/** คำอธิบายบัญชีชุดเดียว ใช้ทุกหน้าจอ (audit รอบ C R2B-08: เดิมแต่ละจอเขียนต่างกัน)
 *  รับได้ทั้งบัญชีที่ลงทะเบียน (bank = รหัส + bank_name) และบัญชีที่ล็อกกับดีล (bank = รหัส หรือชื่อที่พิมพ์) */
type PayoutLike = { bank?: string | null; bank_name?: string | null; account_no?: string | null; promptpay?: string | null; account_name?: string | null };
export function payoutLines(a: PayoutLike, full = false): { logo: string; title: string; sub: string } {
  const pp = a.promptpay ? formatPromptPay(a.promptpay) : '';
  if (!a.account_no) return { logo: 'promptpay', title: `พร้อมเพย์ ${pp}`, sub: a.account_name ?? '' };
  const isCode = !!a.bank && THAI_BANKS.some((b) => b.code === a.bank);
  const name = a.bank_name || bankDisplayName(a.bank) || 'ธนาคาร';
  return {
    logo: isCode ? a.bank! : 'other',
    title: `${name} ${full ? a.account_no : maskAccount(a.account_no)}`,
    sub: `${a.account_name ?? ''}${pp ? ` · พร้อมเพย์ ${pp}` : ''}`,
  };
}

/** ข้อความสั้นของบัญชี: "กสิกรไทย 123•••890 · สมชาย" */
export function payoutLabel(a: PayoutLike): string {
  const l = payoutLines(a);
  return `${l.title} · ${l.sub}`;
}

/** แถวบัญชี (โลโก้ + ชื่อธนาคาร/เลข + ชื่อบัญชี) — full = โชว์เลขเต็ม (แอดมิน/เจ้าของบัญชี) */
export function PayoutLine({ info, full, size = 28 }: { info: PayoutLike; full?: boolean; size?: number }) {
  const l = payoutLines(info, full);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <BankLogo code={l.logo} size={size} />
      <span className="min-w-0 truncate"><b className="font-bold">{l.title}</b>{l.sub ? <span className="text-ink-faint"> · {l.sub}</span> : null}</span>
    </span>
  );
}

const blankForm = (name = '') => ({ bank: 'promptpay', account_no: '', promptpay: '', bank_name: '', account_name: name });

/**
 * เลือก/เพิ่มบัญชีรับเงิน (เจ้าของ 2026-10-02 ข้อ 3: เลือกบัญชีที่ลงทะเบียน · ไม่มี → สร้าง (เลือกธนาคาร+ใส่เลข) ·
 * ใช้ร่วมกับลงขายกระดาน) — บัญชีที่เลือกถูกก๊อปปี้ลง users.payout_info ("บัญชีหลัก" ที่กระดานล็อกตอนลงประกาศ)
 * ⚠ คอมโพเนนต์ระดับไฟล์ + ร่างฟอร์มอยู่ใน state ของตัวเอง (DNA react-state)
 */
export function PayoutPicker({ selectedId, onSelect }: { selectedId?: string; onSelect: (a: PayoutAccount | null) => void }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const me = db.users.find((u) => u.id === uid);
  const accounts = payoutAccountsOf(me);
  const primaryId = primaryPayoutId(me);
  const [adding, setAdding] = useState(accounts.length === 0);
  const [form, setForm] = useState(() => blankForm(me?.payout_info?.account_name ?? ''));
  const [busy, setBusy] = useState(false);

  /** คืนข้อความผิดพลาด (null = สำเร็จ) */
  const persist = async (list: PayoutAccount[], selectId: string | undefined): Promise<string | null> => {
    setBusy(true);
    dispatch(setPayoutAccounts(uid, list, selectId));
    const failed = await store.flush();
    setBusy(false);
    return failed;
  };

  const choose = async (a: PayoutAccount) => {
    onSelect(a);
    // บันทึก "บัญชีหลัก" ไว้ด้วย (payout_info) — ล้มก็ไม่กั้นการเลือกในหน้านี้ (ดีลตรงล็อกบัญชีที่ส่งไปกับข้อเสนอเอง)
    if (a.id !== primaryId) void persist(accounts, a.id);
  };

  const save = async () => {
    const name = form.account_name.trim();
    const pp = form.promptpay.replace(/\D/g, '');
    const isPP = form.bank === 'promptpay';
    // พร้อมเพย์ล้วน: เลขบัญชีที่อาจพิมพ์ค้างไว้ก่อนสลับธนาคาร ไม่นับ (R1-19)
    const no = isPP ? '' : form.account_no.replace(/\D/g, '');
    if (!name) return flash('ใส่ชื่อบัญชี (ตามแอปธนาคาร)');
    if (isPP) {
      if (!pp || !promptPayTarget(pp)) return flash('พร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก');
    } else {
      const e = accountNoError(form.bank, no);
      if (e) return flash(e);
      if (form.bank === 'other' && !form.bank_name.trim()) return flash('ใส่ชื่อธนาคาร');
      if (pp && !promptPayTarget(pp)) return flash('พร้อมเพย์ (ถ้าใส่) ต้องเป็นเบอร์ 10 หลัก หรือเลขบัตร 13 หลัก');
    }
    if (accounts.some((a) => (no && a.account_no === no) || (isPP && !a.account_no && a.promptpay === pp))) return flash('มีบัญชีนี้อยู่แล้ว');
    const acc: PayoutAccount = {
      id: `pa-${Date.now().toString(36)}`, bank: form.bank, account_name: name,
      ...(form.bank === 'other' ? { bank_name: form.bank_name.trim() } : {}),
      ...(pp ? { promptpay: pp } : {}), ...(no ? { account_no: no } : {}), created_at: new Date().toISOString(),
    };
    // เก็บบัญชีเดิมทุกตัว รวมบัญชีรุ่นเก่า (R1-30: เดิมบัญชีรุ่นเก่าหายเงียบเมื่อเพิ่มบัญชีที่สอง)
    const failed = await persist([...accounts, acc], acc.id);
    if (failed) return flash(persistFailText(failed, 'บันทึกบัญชีไม่สำเร็จ — เช็คเน็ตแล้วลองใหม่'));
    setAdding(false);
    setForm(blankForm(name));
    onSelect(acc);
    flash('บันทึกบัญชีรับเงินแล้ว ✓');
  };

  const remove = async (a: PayoutAccount) => {
    if (!window.confirm(`ลบบัญชี ${payoutLabel(a)}?`)) return;
    const list = accounts.filter((x) => x.id !== a.id);
    // ลบบัญชีหลัก → ตัวแรกที่เหลือเป็นบัญชีหลักแทน · ลบตัวอื่น → บัญชีหลักคงเดิม (R1-05)
    const nextPrimary = a.id === primaryId ? list[0]?.id : primaryId;
    const failed = await persist(list, nextPrimary);
    if (failed) return flash(persistFailText(failed, 'ลบไม่สำเร็จ — ลองใหม่'));
    if (selectedId === a.id) onSelect(list.find((x) => x.id === nextPrimary) ?? list[0] ?? null);
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
            const l = payoutLines(a);
            return (
              <div key={a.id} className={cx('flex items-center gap-2.5 rounded-xl border px-2.5 py-2', on ? 'border-accent bg-[#b91c1c]/[0.08]' : 'border-subtle bg-surface-2')}>
                <button type="button" onClick={() => void choose(a)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                  <BankLogo code={l.logo} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold">{l.title}</span>
                    <span className="block truncate text-[11.5px] text-ink-faint">{l.sub}{a.promptpay ? ' · QR ใส่ยอดได้' : ' · ผู้รับก๊อปเลขไปโอน'}</span>
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
                {form.bank === 'other' && <input id="pa-bank" value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} placeholder="ชื่อธนาคาร" className={inputCls} />}
                <input id="pa-no" inputMode="numeric" value={form.account_no} onChange={(e) => setForm({ ...form, account_no: e.target.value })} placeholder={`เลขบัญชี ${form.bank === 'other' ? '' : bankOf(form.bank).name}`.trim()} className={inputCls} />
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
