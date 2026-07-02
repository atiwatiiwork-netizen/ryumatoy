'use client';

import { useState } from 'react';
import { useAuth } from '@/state/AuthProvider';
import { cx } from './ui';

const inputCls = 'w-full rounded-xl border border-subtle bg-surface-3 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent';
const ERR: Record<string, string> = {
  phone_taken: 'เบอร์นี้สมัครไว้แล้ว', fb_taken: 'ลิงก์ Facebook นี้ถูกใช้แล้ว', bad_pin: 'PIN ต้องมี 6 หลัก',
  not_found: 'ไม่พบเบอร์นี้ หรือ PIN ไม่ถูกต้อง', wrong_pin: 'PIN ไม่ถูกต้อง', locked: 'ใส่ PIN ผิดหลายครั้ง — ล็อก 15 นาที',
  not_allowed: 'ยังไม่ได้ขอรีเซ็ต PIN — ติดต่อแอดมินก่อน', no_server: 'ระบบยังไม่พร้อม',
};
const digits = (s: string) => s.replace(/\D/g, '');

type Mode = 'login' | 'signup' | 'forgot';

export function AuthScreen() {
  const { loginPhone, signupPhone, setNewPin, signInFacebook } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // fields
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [fb, setFb] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');

  const reset = (m: Mode) => { setMode(m); setMsg(null); setOk(null); setPin(''); setPin2(''); };
  const fail = (e?: string) => setMsg(ERR[e ?? ''] ?? 'เกิดข้อผิดพลาด ลองใหม่');

  const doLogin = async () => {
    if (phone.length < 9 || pin.length !== 6) return setMsg('กรอกเบอร์ + PIN 6 หลัก');
    setBusy(true); setMsg(null);
    const r = await loginPhone(phone, pin);
    setBusy(false);
    if (!r.ok) fail(r.error);
    // on success the app gates take over (approval / address)
  };

  const doSignup = async () => {
    if (!name.trim()) return setMsg('กรอกชื่อ');
    if (phone.length < 9) return setMsg('กรอกเบอร์ให้ถูกต้อง');
    if (pin.length !== 6) return setMsg('PIN ต้องมี 6 หลัก');
    if (pin !== pin2) return setMsg('PIN สองช่องไม่ตรงกัน');
    setBusy(true); setMsg(null);
    const r = await signupPhone(name.trim(), phone, fb.trim(), pin);
    setBusy(false);
    if (r.ok) { setOk('สมัครสำเร็จ! รอแอดมินอนุมัติ แล้วเข้าสู่ระบบด้วยเบอร์ + PIN'); reset('login'); setOk('สมัครสำเร็จ! รอแอดมินอนุมัติ แล้วเข้าสู่ระบบด้วยเบอร์ + PIN'); }
    else fail(r.error);
  };

  const doForgot = async () => {
    if (phone.length < 9 || pin.length !== 6) return setMsg('กรอกเบอร์ + PIN ใหม่ 6 หลัก');
    setBusy(true); setMsg(null);
    const r = await setNewPin(phone, pin);
    setBusy(false);
    if (r.ok) { reset('login'); setOk('ตั้ง PIN ใหม่แล้ว เข้าสู่ระบบได้เลย'); }
    else fail(r.error);
  };

  return (
    <div className="mx-auto max-w-[420px] px-4 py-10">
      <div className="mb-5 text-center">
        <img src="/ryuma-logo.png" alt="Ryuma" width={56} height={56} className="mx-auto mb-3 rounded-2xl" />
        <div className="text-xl font-extrabold text-ink">{mode === 'signup' ? 'สมัครสมาชิก Ryuma' : mode === 'forgot' ? 'ตั้ง PIN ใหม่' : 'เข้าสู่ระบบ Ryuma'}</div>
        <div className="mt-1 text-[12.5px] text-ink-faint">ดูสินค้าได้โดยไม่ต้องเข้าสู่ระบบ · เข้าสู่ระบบเมื่อต้องการสั่งซื้อ</div>
      </div>

      {mode !== 'forgot' && (
        <div className="mb-4 flex rounded-xl border border-subtle bg-surface-3 p-1">
          {(['login', 'signup'] as Mode[]).map((m) => (
            <button key={m} onClick={() => reset(m)} className={cx('flex-1 rounded-lg py-2 text-[13px] font-bold', mode === m ? 'bg-primary text-white' : 'text-ink-muted2')}>{m === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก'}</button>
          ))}
        </div>
      )}

      {ok && <div className="mb-3 rounded-xl border border-[#16a34a]/40 bg-[#16a34a]/[0.12] px-3.5 py-2.5 text-[13px] text-[#4ade80]">{ok}</div>}
      {msg && <div className="mb-3 rounded-xl border border-accent bg-[#b91c1c]/[0.12] px-3.5 py-2.5 text-[13px] text-primary-soft">{msg}</div>}

      <div className="flex flex-col gap-3">
        {mode === 'signup' && <Field label="ชื่อ-นามสกุล"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อจริงสำหรับจัดส่ง" /></Field>}
        <Field label="เบอร์โทรศัพท์"><input className={inputCls} inputMode="tel" value={phone} onChange={(e) => setPhone(digits(e.target.value))} maxLength={10} placeholder="08xxxxxxxx" /></Field>
        {mode === 'signup' && <Field label="ลิงก์ / ชื่อ Facebook (ให้แอดมินตรวจ)"><input className={inputCls} value={fb} onChange={(e) => setFb(e.target.value)} placeholder="facebook.com/yourname" /></Field>}
        <Field label={mode === 'signup' ? 'ตั้ง PIN 6 หลัก' : mode === 'forgot' ? 'PIN ใหม่ 6 หลัก' : 'PIN 6 หลัก'}>
          <input className={cx(inputCls, 'tracking-[0.4em]')} inputMode="numeric" type="password" value={pin} onChange={(e) => setPin(digits(e.target.value).slice(0, 6))} maxLength={6} placeholder="••••••" />
        </Field>
        {mode === 'signup' && <Field label="ยืนยัน PIN อีกครั้ง"><input className={cx(inputCls, 'tracking-[0.4em]')} inputMode="numeric" type="password" value={pin2} onChange={(e) => setPin2(digits(e.target.value).slice(0, 6))} maxLength={6} placeholder="••••••" /></Field>}

        <button
          onClick={mode === 'login' ? doLogin : mode === 'signup' ? doSignup : doForgot}
          disabled={busy}
          className="mt-1 w-full rounded-xl bg-cta py-3 text-sm font-bold text-white disabled:opacity-60"
        >{busy ? 'กำลังดำเนินการ…' : mode === 'login' ? 'เข้าสู่ระบบ' : mode === 'signup' ? 'สมัครสมาชิก' : 'ยืนยัน PIN ใหม่'}</button>
      </div>

      <div className="mt-4 flex items-center justify-between text-[12px] text-ink-faint">
        {mode === 'forgot'
          ? <button onClick={() => reset('login')} className="text-primary-soft">← กลับเข้าสู่ระบบ</button>
          : <button onClick={() => reset('forgot')} className="text-primary-soft">ลืม PIN?</button>}
        <button onClick={signInFacebook} className="text-ink-faint underline">แอดมิน: เข้าด้วย Facebook</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">{label}</span>{children}</label>;
}
