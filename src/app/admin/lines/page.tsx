'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch, useReady } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { store } from '@/data/store';
import { supabase } from '@/data/supabaseClient';
import { persistFailText } from '@/data/persistErrors';
import { uploadImage } from '@/lib/upload';
import { readStore, writeStore, removeStore } from '@/lib/safeStorage';
import { genId, upsertProductLine, patchProductLine, patchLineMember, removeProductLine, setLinesPublic, logActivity } from '@/data/mutations';
import { linesPublicEnabled, lineOpenToCustomers, lineStates, memberProducts, memberThumb, hasPin, type LineMemberState } from '@/domain/services/lines';
import { availableFor } from '@/domain/services/reservations';
import type { Database, LineManualState, LineMember, Product, ProductLine, ProductStatus } from '@/domain/entities';
import { cx } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { LinePoster, type PosterPin } from '@/components/lines/LinePoster';
import { LineView } from '@/components/lines/LineView';
import { TONE_HEX } from '@/components/lines/lineUi';

/**
 * แอดมิน › ไลน์ (พรียกไลน์ · v81 · memory ryuma-line-spec) — เจ้าของ 2026-10-07: "อย่าเพิ่งให้ลูกค้าเห็น ให้แอดมินลองดูก่อน"
 *   สวิตช์ใหญ่ "ลูกค้าเห็นไลน์" ค่าเริ่ม = ปิด (ด่านจริงฝั่ง server: RLS product_lines_read) · แต่ละไลน์มี "ร่าง/แสดง" ของตัวเอง
 * สร้างไลน์: ค่าย + ชื่อ → รูปหมู่ → ติ๊กสินค้าจากระบบ / Add ตัวที่ยังไม่มีในระบบ (เลือกสถานะเอง) → แตะรูปวางป้าย → ดูแบบลูกค้า
 * ⚠ ทุกการแก้เขียนเข้า store ทันที (patch ตาม id ล่าสุด) — ไม่มีฟอร์มร่างที่หายได้ตอนหน้าแม่ re-render (DNA react-state)
 * ⚠ ก่อนรัน v81 ตารางยังไม่มี: ห้ามเขียน (เขียนแล้วเซฟค้าง → รีเฟรชอัตโนมัติของแท็บแอดมินหยุดทั้งแท็บ) → probe แล้วปิดปุ่ม
 * ⚠ คอมโพเนนต์ลูกทุกตัวอยู่ระดับไฟล์
 */
type Dispatch = ReturnType<typeof useDispatch>;
type Flash = (m: string) => void;
type Probe = 'checking' | 'ok' | 'missing' | 'offline' | 'error';
const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-sm text-ink outline-none focus:border-accent';
const EDIT_KEY = 'ryuma_lines_edit';
const STATUS_TH: Record<ProductStatus, string> = { open: 'เปิดพรี', production: 'ผลิต', shipping: 'เดินทาง', arrived: 'ถึงไทย', delivered: 'ส่งมอบ', closed: 'จบ' };
const MANUAL_OPTS: { v: '' | LineManualState; label: string }[] = [
  { v: '', label: 'ยังไม่ตั้ง (ลูกค้าไม่เห็นตัวนี้)' },
  { v: 'sourcing', label: 'ของออกมาแล้ว → หาของ' },
  { v: 'stock', label: 'มีสต๊อก → ทักร้าน' },
  { v: 'preorder', label: 'พรีออเดอร์ → ทักร้าน' },
];

const productStatusText = (db: Database, p: Product) => {
  const round = db.batches.some((b) => b.product_id === p.id && b.status === 'open' && b.published !== false) ? ' · รอบพิเศษเปิด' : '';
  return p.is_stock ? `พร้อมส่ง · เหลือ ${availableFor(db, p)}${round}` : `${STATUS_TH[p.status] ?? p.status}${round}`;
};
const productName = (p: Product) => p.character_name?.trim() || p.series_name;

export default function AdminLinesPage() {
  const db = useDatabase();
  const ready = useReady();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const uid = useCurrentUserId();
  const [probe, setProbe] = useState<Probe>('checking');
  const [probeMsg, setProbeMsg] = useState('');
  const [editId, setEditId] = useState<string | null>(null);

  // จำไลน์ที่เปิดแก้อยู่ (รีเฟรช/สลับแท็บกลับมาแล้วอยู่หน้าเดิม)
  useEffect(() => { setEditId(readStore('session', EDIT_KEY)); }, []);
  const openEditor = (id: string | null) => {
    setEditId(id);
    if (id) writeStore('session', EDIT_KEY, id); else removeStore('session', EDIT_KEY);
  };

  // ตาราง product_lines มีแล้วหรือยัง (v81) — เขียนได้เฉพาะตอน "ยืนยันแล้วว่ามี" เท่านั้น
  //   ยังไม่มี/เช็คไม่สำเร็จ (เน็ต) = ปิดทุกปุ่มที่เขียนลงตารางนี้ แล้วเช็คใหม่เองตอนกลับมาที่หน้าต่าง + มีปุ่มให้กดเช็คใหม่
  //   (review 2026-10-07: เดิม "เช็คไม่สำเร็จ" ยังให้เขียน → ก่อนรัน v81 เซฟค้างลองใหม่ทุก 30 วิ = รีเฟรชอัตโนมัติของแท็บแอดมินหยุด)
  const [probeTick, setProbeTick] = useState(0);
  useEffect(() => {
    if (!supabase) { setProbe('offline'); return; }
    let dead = false;
    setProbe((p) => (p === 'ok' ? p : 'checking'));
    Promise.resolve(supabase.from('product_lines').select('id').limit(1))
      .then(({ error }) => {
        if (dead) return;
        if (!error) { setProbe('ok'); return; }
        const text = `${error.code ?? ''} ${error.message ?? ''}`;
        setProbeMsg(error.message ?? '');
        setProbe(/product_lines|schema cache|does not exist|42P01|PGRST205/i.test(text) ? 'missing' : 'error');
      })
      .catch((e: unknown) => { if (!dead) { setProbe('error'); setProbeMsg(e instanceof Error ? e.message : String(e)); } });
    return () => { dead = true; };
  }, [probeTick]);
  useEffect(() => {
    if (probe !== 'missing' && probe !== 'error') return;
    const again = () => setProbeTick((t) => t + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [probe]);
  const canWrite = probe === 'ok' || probe === 'offline';
  const isPublic = linesPublicEnabled(db);

  const toggle = async () => {
    if (!isPublic) {
      const ok = window.confirm('เปิดให้ลูกค้าทุกคนเห็น "ไลน์" เลยไหม?\n\n• แถบไลน์ขึ้นบนหน้าช็อป + ปุ่ม "ดูทั้งไลน์" ในหน้าสินค้า\n• ลูกค้าเห็นเฉพาะไลน์ที่กด "แสดงให้ลูกค้า" แล้ว (ร่างยังซ่อน)\n\nลองดูผ่านบัญชีแอดมินครบแล้วค่อยเปิด');
      if (!ok) return;
    }
    dispatch(setLinesPublic(!isPublic));
    dispatch(logActivity(uid, 'lines_public', isPublic ? 'ปิดไลน์จากฝั่งลูกค้า' : 'เปิดไลน์ให้ลูกค้าเห็น'));
    const pf = await store.flush();
    if (pf) { flash(persistFailText(pf, 'บันทึกสวิตช์ไม่สำเร็จ — ระบบจะลองใหม่ให้')); return; }
    flash(isPublic ? 'ปิดไลน์จากฝั่งลูกค้าแล้ว' : 'เปิดไลน์ให้ลูกค้าเห็นแล้ว 🎉');
  };

  const editing = editId ? db.productLines.find((l) => l.id === editId) : undefined;

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[22px] font-extrabold">ไลน์ (พรียกไลน์)</div>
          <div className="text-[12.5px] text-ink-muted2">รูปหมู่ของค่าย + ป้ายสถานะบนหัวตัวละคร · ป้ายคำนวณสดจากสินค้า/สต๊อก/รอบพิเศษ — เปลี่ยนสถานะสินค้าที่หน้าไหน ป้ายเปลี่ยนตามเอง</div>
        </div>
        <button
          onClick={() => void toggle()}
          disabled={probe === 'missing' || probe === 'checking'}
          className={cx('flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-[13px] font-bold disabled:opacity-40', isPublic ? 'border-[#16a34a]/50 bg-[#16a34a]/15 text-[#4ade80]' : 'border-subtle bg-surface-3 text-ink-muted2')}
        >
          <span className={cx('relative h-5 w-9 rounded-full transition-colors', isPublic ? 'bg-[#16a34a]' : 'bg-white/15')}>
            <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', isPublic ? 'left-[18px]' : 'left-0.5')} />
          </span>
          {isPublic ? 'ลูกค้าเห็นไลน์แล้ว' : 'ลูกค้ายังไม่เห็น (แอดมินเห็นคนเดียว)'}
        </button>
      </div>

      {probe === 'missing' && (
        <div className="mb-4 rounded-xl border border-[#f59e0b]/50 bg-[#f59e0b]/10 p-4 text-[13px] leading-relaxed text-[#fbbf24]">
          <div className="font-extrabold">⚠ ยังไม่ได้รัน SQL ของระบบไลน์ (v81)</div>
          เปิดไฟล์ <span className="font-mono">supabase/migration_lines_v81.sql</span> → วางใน Supabase SQL Editor → Run แล้วกด &quot;เช็คใหม่&quot; · ระหว่างนี้ปุ่มสร้าง/แก้ไขถูกปิดไว้ (กันงานค้างเซฟไม่ขึ้น)
          <button onClick={() => setProbeTick((t) => t + 1)} className="ml-2 rounded-md border border-[#f59e0b]/50 px-2 py-0.5 text-[12px] font-bold">เช็คใหม่</button>
        </div>
      )}
      {probe === 'error' && (
        <div className="mb-4 rounded-xl border border-subtle bg-surface-2 p-3 text-[12px] text-ink-muted2">
          เช็คตารางไลน์ไม่สำเร็จ ({probeMsg || 'เน็ต/เซิร์ฟเวอร์'}) — ปิดปุ่มแก้ไขไว้ก่อนจนกว่าจะเช็คผ่าน
          <button onClick={() => setProbeTick((t) => t + 1)} className="ml-2 rounded-md border border-subtle px-2 py-0.5 font-bold text-ink">เช็คใหม่</button>
        </div>
      )}

      {!ready ? (
        <div className="py-16 text-center text-ink-faint">กำลังโหลด…</div>
      ) : editId && editing ? (
        <LineEditor key={editing.id} db={db} dispatch={dispatch} flash={flash} uid={uid} line={editing} canWrite={canWrite} onClose={() => openEditor(null)} />
      ) : (
        <>
          {editId && !editing && <div className="mb-3 rounded-xl border border-subtle bg-surface-2 p-3 text-[12.5px] text-ink-muted2">ไม่พบไลน์ที่เปิดแก้ค้างไว้ (อาจถูกลบแล้ว) <button className="ml-2 font-bold text-primary-soft" onClick={() => openEditor(null)}>ปิด</button></div>}
          <CreateLineForm db={db} dispatch={dispatch} flash={flash} uid={uid} canWrite={canWrite} onCreated={openEditor} />
          <LinesList db={db} onOpen={openEditor} isPublic={isPublic} />
        </>
      )}
    </div>
  );
}

// ── สร้างไลน์ ──────────────────────────────────────────────────────────────────────────

function CreateLineForm({ db, dispatch, flash, uid, canWrite, onCreated }: { db: Database; dispatch: Dispatch; flash: Flash; uid: string; canWrite: boolean; onCreated: (id: string) => void }) {
  const [makerId, setMakerId] = useState('');
  const [frId, setFrId] = useState('');
  const [name, setName] = useState('');
  const makers = useMemo(() => [...db.manufacturers].sort((a, b) => a.name.localeCompare(b.name)), [db.manufacturers]);
  const create = () => {
    if (!canWrite) return flash('ยังสร้างไม่ได้ — กำลังเช็คระบบ หรือยังไม่ได้รัน SQL v81');
    if (!makerId) return flash('เลือกค่ายก่อน (แยกค่าย = แยกไลน์)');
    if (!name.trim()) return flash('ตั้งชื่อไลน์ก่อน เช่น กองโจรเงามายา');
    const id = genId('ln');
    dispatch(upsertProductLine({ id, maker_id: makerId, franchise_id: frId || null, name: name.trim(), cover_url: null, note: null, members: [], active: false, created_at: new Date().toISOString() }));
    dispatch(logActivity(uid, 'line_create', `สร้างไลน์ ${name.trim()}`, { targetId: id, targetLabel: name.trim() }));
    setName('');
    flash('สร้างไลน์แล้ว — ใส่รูปหมู่ แล้วติ๊กตัวละครได้เลย');
    onCreated(id);
  };
  return (
    <div className="mb-5 rounded-2xl border border-subtle bg-surface-2 p-4">
      <div className="mb-2.5 text-[14px] font-extrabold">+ สร้างไลน์ใหม่</div>
      <div className="grid gap-2.5 md:grid-cols-[1fr_1fr_1.4fr_auto]">
        <select className={inputCls} value={makerId} onChange={(e) => setMakerId(e.target.value)}>
          <option value="">ค่าย (บังคับ)</option>
          {makers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select className={inputCls} value={frId} onChange={(e) => setFrId(e.target.value)}>
          <option value="">เรื่อง (ไม่บังคับ)</option>
          {db.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อไลน์ เช่น กองโจรเงามายา" onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        <button onClick={create} disabled={!canWrite} className="rounded-lg bg-cta px-5 py-2 text-[13px] font-bold text-white disabled:opacity-40">สร้างไลน์</button>
      </div>
    </div>
  );
}

// ── รายการไลน์ ─────────────────────────────────────────────────────────────────────────

function LinesList({ db, onOpen, isPublic }: { db: Database; onOpen: (id: string) => void; isPublic: boolean }) {
  const lines = [...db.productLines].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (lines.length === 0) return <div className="rounded-2xl border border-dashed border-subtle p-10 text-center text-[13px] text-ink-faint">ยังไม่มีไลน์ — สร้างไลน์แรกด้านบน</div>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {lines.map((l) => {
        const states = lineStates(db, l, { uid: '' });
        const visibleN = states.filter((s) => s.state.visible).length;
        const pinned = l.members.filter(hasPin).length;
        const maker = db.manufacturers.find((m) => m.id === l.maker_id)?.name ?? '— (ไม่พบค่าย)';
        // ป้ายบอกตรงกับกติกาเดียวกับฝั่งลูกค้า (lineOpenToCustomers) — ไม่ใช่แค่ดู active
        const open = lineOpenToCustomers(db, l);
        const badge = open ? 'ลูกค้าเห็น'
          : !l.active ? 'ร่าง'
            : !isPublic ? 'แสดง (รอเปิดสวิตช์)'
              : !l.cover_url ? 'แสดง (ขาดรูปหมู่)' : 'แสดง (ยังไม่มีตัวที่ลูกค้าเห็น)';
        return (
          <div key={l.id} className="overflow-hidden rounded-2xl border border-subtle bg-surface-2">
            <button onClick={() => onOpen(l.id)} className="block w-full text-left">
              <div className="relative aspect-[16/9] bg-stripe">
                {l.cover_url ? <img src={l.cover_url} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-[12px] text-ink-faint">ยังไม่มีรูปหมู่</div>}
                <span className={cx('absolute left-2 top-2 rounded-md px-2 py-0.5 text-[10.5px] font-extrabold', open ? 'bg-[#16a34a] text-white' : 'bg-black/70 text-[#fbbf24]')}>
                  {badge}
                </span>
              </div>
              <div className="p-3">
                <div className="truncate text-[14px] font-extrabold">{l.name.trim() || '(ยังไม่ตั้งชื่อ)'}</div>
                <div className="text-[11.5px] text-ink-muted2">{maker} · {visibleN}/{l.members.length} ตัวลูกค้าเห็น · ป้าย {pinned}/{l.members.length}</div>
                <div className="mt-1.5 flex gap-1">
                  {states.map((s) => <i key={s.member.id} title={`${s.no} ${s.member.name} · ${s.state.label}`} className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TONE_HEX[s.state.tone], opacity: s.state.visible ? 1 : 0.35 }} />)}
                </div>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── แก้ไขไลน์ ──────────────────────────────────────────────────────────────────────────

function LineEditor({ db, dispatch, flash, uid, line, canWrite, onClose }: { db: Database; dispatch: Dispatch; flash: Flash; uid: string; line: ProductLine; canWrite: boolean; onClose: () => void }) {
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 'cover' | member id ที่กำลังอัปรูป
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [phoneW, setPhoneW] = useState(true); // วางป้ายที่ความกว้างมือถือ (343 = 375 − ขอบ 16×2) = เห็นเหมือนลูกค้า
  const guard = () => { if (!canWrite) { flash('ยังแก้ไม่ได้ — กำลังเช็คระบบ หรือยังไม่ได้รัน SQL v81'); return false; } return true; };
  const patch = (fn: (l: ProductLine) => ProductLine) => { if (guard()) dispatch(patchProductLine(line.id, fn)); };
  const patchM = (mid: string, fn: (m: LineMember) => LineMember) => { if (guard()) dispatch(patchLineMember(line.id, mid, fn)); };
  const states = lineStates(db, line, { uid: '' });
  const makers = [...db.manufacturers].sort((a, b) => a.name.localeCompare(b.name));

  const setCover = async (file?: File) => {
    if (!file || !guard()) return;
    const hadPins = line.members.some(hasPin);
    setBusy('cover');
    try {
      const url = await uploadImage(file, 'line');
      const clear = hadPins && window.confirm('เปลี่ยนรูปหมู่แล้ว ป้ายที่วางไว้อาจไม่ตรงหัวตัวละคร — ล้างป้ายทั้งหมดเพื่อวางใหม่ไหม?\n\nตกลง = ล้างป้าย · ยกเลิก = เก็บตำแหน่งเดิม');
      patch((l) => ({ ...l, cover_url: url, members: clear ? l.members.map((m) => ({ ...m, pin_x: undefined, pin_y: undefined })) : l.members }));
      flash('ใส่รูปหมู่แล้ว — แตะหัวตัวละครบนรูปเพื่อวางป้าย');
    } catch (e) {
      flash(`อัปโหลดรูปไม่สำเร็จ — ${e instanceof Error ? e.message : 'ลองใหม่'}`);
    } finally { setBusy(null); }
  };
  const removeCover = () => {
    if (!line.cover_url || !window.confirm('ลบรูปหมู่?\n\n• ป้ายที่วางไว้จะถูกล้าง\n• ไลน์กลับเป็น "ร่าง" (ลูกค้าไม่เห็นไลน์ที่ไม่มีรูป) — ใส่รูปใหม่แล้วกดแสดงอีกครั้ง')) return;
    // ร่างด้วย (review 2026-10-07): เดิมลบรูปแล้ว active ค้าง → ลูกค้ายังเข้าทางชิปหน้าสินค้า/ลิงก์ตรงได้
    patch((l) => ({ ...l, cover_url: null, active: false, members: l.members.map((m) => ({ ...m, pin_x: undefined, pin_y: undefined })) }));
    flash('ลบรูปหมู่แล้ว — ไลน์กลับเป็นร่าง');
  };
  const setMemberImage = async (mid: string, file?: File) => {
    if (!file || !guard()) return;
    setBusy(mid);
    try { const url = await uploadImage(file, 'line-m'); patchM(mid, (m) => ({ ...m, image_url: url })); flash('ใส่รูปแล้ว'); }
    catch (e) { flash(`อัปโหลดรูปไม่สำเร็จ — ${e instanceof Error ? e.message : 'ลองใหม่'}`); }
    finally { setBusy(null); }
  };
  const placePin = (mid: string) => {
    if (!pending) return;
    const name = line.members.find((m) => m.id === mid)?.name ?? '';
    patchM(mid, (m) => ({ ...m, pin_x: pending.x, pin_y: pending.y }));
    setPending(null);
    flash(`วางป้าย "${name}" แล้ว`);
  };
  const move = (i: number, d: -1 | 1) => patch((l) => {
    const j = i + d;
    if (j < 0 || j >= l.members.length) return l;
    const ms = [...l.members];
    [ms[i], ms[j]] = [ms[j], ms[i]];
    return { ...l, members: ms };
  });
  const removeMember = (m: LineMember) => {
    if (!window.confirm(`เอา "${m.name || 'ตัวนี้'}" ออกจากไลน์? (สินค้าในระบบไม่ถูกแตะ)`)) return;
    patch((l) => ({ ...l, members: l.members.filter((x) => x.id !== m.id) }));
  };
  const toggleActive = () => {
    if (!guard()) return;
    if (!line.active && !line.cover_url) return flash('ใส่รูปหมู่ก่อน — ลูกค้าไม่เห็นไลน์ที่ไม่มีรูป');
    dispatch(patchProductLine(line.id, (l) => ({ ...l, active: !l.active })));
    dispatch(logActivity(uid, 'line_active', `${line.active ? 'ซ่อน' : 'แสดง'}ไลน์ ${line.name.trim()}`, { targetId: line.id, targetLabel: line.name.trim() }));
  };
  const deleteLine = () => {
    if (!guard()) return;
    if (!window.confirm(`ลบไลน์ "${line.name.trim() || 'ไม่มีชื่อ'}" ทั้งไลน์?\n(สินค้า/ตั๋วในระบบไม่ถูกแตะ — ลบแค่รูปหมู่กับป้าย)`)) return;
    dispatch(removeProductLine(line.id));
    dispatch(logActivity(uid, 'line_delete', `ลบไลน์ ${line.name.trim()}`, { targetId: line.id, targetLabel: line.name.trim() }));
    flash('ลบไลน์แล้ว');
    onClose();
  };

  // ป้ายในหน้าแก้ไข = ป้ายเดียวกับที่ลูกค้าเห็น (ข้อความสถานะ ไม่ใช่ชื่อ) — เจ้าของ 2026-10-08: "ไม่ต้องสลับโหมดไปมา"
  const posterPins: PosterPin[] = states.filter((s) => hasPin(s.member)).map((s) => ({ id: s.member.id, no: s.no, x: s.member.pin_x!, y: s.member.pin_y!, tone: s.state.tone, text: s.state.pinLabel }));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={onClose} className="flex items-center gap-1.5 rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-bold"><Icon name="arrowLeft" size={15} /> รายการไลน์</button>
        <div className="flex rounded-lg border border-subtle bg-surface-3 p-0.5 text-[12.5px] font-bold">
          <button onClick={() => setView('edit')} className={cx('rounded-md px-3 py-1.5', view === 'edit' ? 'bg-surface-4 text-ink' : 'text-ink-faint')}>แก้ไข + วางป้าย</button>
          <button onClick={() => setView('preview')} className={cx('rounded-md px-3 py-1.5', view === 'preview' ? 'bg-surface-4 text-ink' : 'text-ink-faint')}>📱 ดูแบบลูกค้า</button>
        </div>
        <Link href={`/line/${line.id}`} target="_blank" className="text-[12.5px] font-semibold text-primary-soft">เปิดหน้าจริง (แท็บใหม่) →</Link>
        <div className="flex-1" />
        <button onClick={toggleActive} className={cx('rounded-lg border px-3 py-2 text-[12.5px] font-bold', line.active ? 'border-[#16a34a]/50 bg-[#16a34a]/15 text-[#4ade80]' : 'border-subtle bg-surface-3 text-[#fbbf24]')}>
          {line.active ? '✓ แสดงให้ลูกค้า' : 'ร่าง — กดเพื่อแสดง'}
        </button>
        <button onClick={deleteLine} className="rounded-lg border border-subtle bg-surface-3 px-3 py-2 text-[12.5px] font-bold text-[#f87171]">ลบไลน์</button>
      </div>

      {view === 'preview' ? (
        <div>
          <div className="mb-2 text-center text-[12px] text-ink-faint">หน้าที่ลูกค้าเห็น (คอมโพเนนต์เดียวกับหน้าจริง · ป้ายคำนวณสดจากข้อมูลจริง · ปุ่มในพรีวิวกดไม่ได้)</div>
          <div className="mx-auto w-[375px] max-w-full overflow-hidden rounded-[28px] border-[6px] border-black/60 bg-base shadow-2xl">
            <div className="max-h-[720px] overflow-y-auto p-4"><LineView line={line} userId={uid} mode="preview" /></div>
          </div>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* ซ้าย: ข้อมูลไลน์ + รูปหมู่ + วางป้าย */}
          <div>
            <div className="mb-3 grid gap-2.5 sm:grid-cols-3">
              <label className="sm:col-span-3"><span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">ชื่อไลน์</span>
                <input className={inputCls} value={line.name} onChange={(e) => patch((l) => ({ ...l, name: e.target.value }))} placeholder="เช่น กองโจรเงามายา" />
              </label>
              <label><span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">ค่าย</span>
                <select className={inputCls} value={line.maker_id} onChange={(e) => patch((l) => ({ ...l, maker_id: e.target.value }))}>
                  {!db.manufacturers.some((m) => m.id === line.maker_id) && <option value={line.maker_id}>— ไม่พบค่าย —</option>}
                  {makers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
              <label className="sm:col-span-2"><span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">เรื่อง (ไม่บังคับ)</span>
                <select className={inputCls} value={line.franchise_id ?? ''} onChange={(e) => patch((l) => ({ ...l, franchise_id: e.target.value || null }))}>
                  <option value="">—</option>
                  {db.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
            </div>

            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[13px] font-extrabold">รูปหมู่ (ปก + พื้นที่วางป้าย)</span>
              {/* ความกว้างที่ใช้วาง: ป้ายจัดตัวเองตามความกว้างจอ — ลูกค้าส่วนใหญ่ใช้มือถือ จึงวางที่ 375px เป็นค่าเริ่มต้น
                  (เจ้าของ 2026-10-08: "ทำไมรูปแอดมินกับพรีวิวลูกค้าไม่เหมือนกัน" = รูปกว้างไม่เท่ากัน ป้ายเลยเรียงคนละแบบ) */}
              {line.cover_url && (
                <div className="flex rounded-lg border border-subtle bg-surface-3 p-0.5 text-[11.5px] font-bold">
                  <button onClick={() => setPhoneW(true)} className={cx('rounded-md px-2.5 py-1', phoneW ? 'bg-surface-4 text-ink' : 'text-ink-faint')}>📱 มือถือ</button>
                  <button onClick={() => setPhoneW(false)} className={cx('rounded-md px-2.5 py-1', !phoneW ? 'bg-surface-4 text-ink' : 'text-ink-faint')}>🖥️ จอกว้าง</button>
                </div>
              )}
              <div className="flex-1" />
              <label className={cx('cursor-pointer rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12px] font-bold', (!canWrite || busy === 'cover') && 'pointer-events-none opacity-50')}>
                {busy === 'cover' ? 'กำลังอัปโหลด…' : line.cover_url ? 'เปลี่ยนรูป' : '+ ใส่รูปหมู่'}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { void setCover(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {line.cover_url && <button onClick={removeCover} className="text-[12px] font-semibold text-ink-faint">ลบรูป</button>}
            </div>
            {line.cover_url ? (
              <>
                <div className={cx('relative', phoneW && 'mx-auto w-[343px] max-w-full')}>
                  <LinePoster src={line.cover_url} pins={posterPins} editing onPick={(x, y) => { if (guard()) setPending({ x, y }); }} pending={pending} />
                  {/* กล่องเลือกชื่อซ้อนบนรูปตรงจุดที่แตะ — เดิมอยู่ใต้รูปจนหลุดสายตา (เจ้าของ 2026-10-08: "ผูกหัวแล้วยังไงต่อ") */}
                  {pending && <PinPicker line={line} states={states} pending={pending} onPlace={placePin} onCancel={() => setPending(null)} />}
                </div>
                <PinProgress line={line} pending={!!pending} />
              </>
            ) : (
              <div className="grid aspect-[16/9] place-items-center rounded-card border border-dashed border-subtle bg-surface-2 text-center text-[12.5px] text-ink-faint">ใส่รูปหมู่ของค่าย (แบบที่ค่ายโพสต์) แล้วแตะหัวตัวละครเพื่อวางป้าย</div>
            )}
          </div>

          {/* ขวา: ตัวละครในไลน์ + ติ๊กจากระบบ + Add เอง */}
          <div>
            <div className="mb-1.5 text-[13px] font-extrabold">ตัวในไลน์ ({line.members.length}) <span className="font-normal text-ink-faint">· เลข = ลำดับบนรูปและในรายการ</span></div>
            <div className="mb-4 flex flex-col gap-2">
              {line.members.map((m, i) => (
                <MemberEditor
                  key={m.id} db={db} makerId={line.maker_id} member={m} no={i + 1} state={states[i]?.state} last={i === line.members.length - 1} busy={busy === m.id}
                  onPatch={(fn) => patchM(m.id, fn)} onMove={(d) => move(i, d)} onRemove={() => removeMember(m)} onImage={(f) => void setMemberImage(m.id, f)}
                />
              ))}
              {line.members.length === 0 && <div className="rounded-card border border-dashed border-subtle p-5 text-center text-[12.5px] text-ink-faint">ยังไม่มีตัวในไลน์ — ติ๊กจากในระบบด้านล่าง หรือ Add ตัวที่ยังไม่มีในระบบ</div>}
            </div>
            <AddCustomMember onAdd={(name, state) => patch((l) => ({ ...l, members: [...l.members, { id: genId('lm'), name, product_ids: [], manual_state: state || undefined }] }))} canWrite={canWrite} />
            <SystemPicker db={db} line={line} canWrite={canWrite} onPatch={patch} />
          </div>
        </div>
      )}
    </div>
  );
}

/** หลังแตะรูป: กล่อง "จุดนี้คือใคร?" ซ้อนบนรูป ใกล้จุดที่แตะ (เหนือจุดถ้ามีที่ ไม่งั้นใต้จุด) — เลือกชื่อ = ป้ายขึ้นทันที · วางซ้ำได้ (ย้ายป้าย) */
function PinPicker({ line, states, pending, onPlace, onCancel }: { line: ProductLine; states: { member: LineMember; no: number; state: LineMemberState }[]; pending: { x: number; y: number }; onPlace: (mid: string) => void; onCancel: () => void }) {
  const below = pending.y < 45;
  const unplaced = states.filter((s) => !hasPin(s.member));
  const ordered = [...unplaced, ...states.filter((s) => hasPin(s.member))];
  return (
    <div
      className="absolute z-10 w-[min(92%,420px)] rounded-xl border border-white/20 bg-[rgba(10,10,14,.92)] p-3 shadow-2xl backdrop-blur-md"
      style={{ left: `clamp(4%, ${pending.x}%, 96%)`, transform: 'translateX(-50%)', ...(below ? { top: `calc(${pending.y}% + 26px)` } : { bottom: `calc(${100 - pending.y}% + 26px)` }) }}
    >
      <div className="mb-2 flex items-center">
        <span className="text-[13px] font-extrabold text-white">ขั้นที่ 2 · จุดนี้คือใคร?</span>
        <div className="flex-1" />
        <button onClick={onCancel} className="text-[12px] font-semibold text-white/60">ยกเลิก</button>
      </div>
      {line.members.length === 0 ? <div className="text-[12px] text-white/70">ยังไม่มีตัวในไลน์ — เพิ่มทางขวาก่อน</div> : (
        <div className="flex flex-wrap gap-1.5">
          {ordered.map((s) => (
            <button key={s.member.id} onClick={() => onPlace(s.member.id)} className={cx('flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 text-[12px] font-semibold text-white', hasPin(s.member) ? 'border-white/10 bg-white/5 text-white/60' : 'border-white/30 bg-white/10')}>
              <span className="grid h-5 w-5 place-items-center rounded-full text-[10.5px] font-extrabold text-[#0b0b0e]" style={{ background: TONE_HEX[s.state.tone] }}>{s.no}</span>
              {s.member.name.trim() || `ตัวที่ ${s.no}`}{hasPin(s.member) && <span className="text-[10.5px]">(ย้าย)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** แถบบอกขั้นตอน + ความคืบหน้าใต้รูป — รู้ตลอดว่าวางแล้วกี่ตัว ขาดใคร */
function PinProgress({ line, pending }: { line: ProductLine; pending: boolean }) {
  const missing = line.members.filter((m) => !hasPin(m));
  const done = line.members.length - missing.length;
  return (
    <div className="mt-2 rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-[12px]">
      {pending
        ? <span className="font-bold text-[#fbbf24]">ขั้นที่ 2: เลือกชื่อในกล่องบนรูป → ป้ายจะขึ้นที่จุดนั้นทันที</span>
        : line.members.length === 0
          ? <span className="text-ink-faint">เพิ่มตัวในไลน์ทางขวาก่อน แล้วค่อยมาแตะหัวบนรูป</span>
          : missing.length === 0
            ? <span className="font-bold text-[#4ade80]">✓ วางป้ายครบ {done}/{line.members.length} ตัว · แตะหัวซ้ำ = ย้ายป้าย</span>
            : <span><b className="text-ink">ขั้นที่ 1:</b> แตะหัวตัวละครบนรูป <span className="text-ink-faint">· วางแล้ว {done}/{line.members.length} · ยังไม่วาง: {missing.map((m) => m.name.trim() || '(ไม่มีชื่อ)').join(', ')}</span></span>}
    </div>
  );
}

/** แถวแก้ไขตัวละคร: ชื่อ · สินค้าที่ผูก · ของคู่ (รวมอัตโนมัติ) · สถานะมือ (เฉพาะตอนไม่มีสินค้า) · รูป · ป้าย · ลำดับ */
function MemberEditor({ db, makerId, member: m, no, state, last, busy, onPatch, onMove, onRemove, onImage }: {
  db: Database; makerId: string; member: LineMember; no: number; state?: LineMemberState; last: boolean; busy: boolean;
  onPatch: (fn: (m: LineMember) => LineMember) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; onImage: (f?: File) => void;
}) {
  const mp = memberProducts(db, m);
  const thumb = memberThumb(db, m);
  const missing = m.product_ids.filter((id) => !db.products.some((p) => p.id === id));
  const tone = state?.tone ?? 'gray';
  return (
    <div className="rounded-card border border-subtle bg-surface-2 p-2.5">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-extrabold text-[#0b0b0e]" style={{ background: TONE_HEX[tone] }}>{no}</span>
        <label className={cx('relative h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-subtle bg-stripe', busy && 'animate-pulse')} title="ใส่/เปลี่ยนรูปย่อ (ไม่บังคับ)">
          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-ink-faint"><Icon name="camera" size={14} /></span>}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { onImage(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <input className={cx(inputCls, '!py-1.5')} value={m.name} onChange={(e) => onPatch((x) => ({ ...x, name: e.target.value }))} placeholder="ชื่อตัวละคร" />
        <div className="flex shrink-0 items-center">
          <button disabled={no === 1} onClick={() => onMove(-1)} className="px-1.5 text-ink-muted2 disabled:opacity-25" aria-label="เลื่อนขึ้น">▲</button>
          <button disabled={last} onClick={() => onMove(1)} className="px-1.5 text-ink-muted2 disabled:opacity-25" aria-label="เลื่อนลง">▼</button>
          <button onClick={onRemove} className="px-1.5 text-ink-faint" aria-label="เอาออก"><Icon name="x" size={14} /></button>
        </div>
      </div>
      <div className="mt-1.5 pl-8 text-[11.5px]">
        {state && (
          <div className={cx('mb-1 font-semibold', state.visible ? 'text-ink-muted2' : 'text-[#fbbf24]')}>
            <span style={{ color: TONE_HEX[state.tone] }}>● {state.label}</span> · {state.detail}{hasPin(m) ? ' · 📍 วางป้ายแล้ว' : ' · ยังไม่วางป้าย'}
            {hasPin(m) && <button onClick={() => onPatch((x) => ({ ...x, pin_x: undefined, pin_y: undefined }))} className="ml-1.5 font-bold text-ink-faint underline">ลบป้าย</button>}
          </div>
        )}
        {mp.linked.map((p) => (
          <span key={p.id} className="mb-1 mr-1 inline-flex items-center gap-1 rounded-full border border-subtle bg-surface-3 py-0.5 pl-2 pr-1 text-[11px]">
            {p.series_name}{p.manufacturer_id !== makerId && <span className="text-[#f87171]">(ค่ายอื่น)</span>} · <span className="text-ink-faint">{productStatusText(db, p)}</span>
            <button onClick={() => onPatch((x) => ({ ...x, product_ids: x.product_ids.filter((id) => id !== p.id) }))} className="grid h-4 w-4 place-items-center text-ink-faint" aria-label="เลิกผูก"><Icon name="x" size={11} /></button>
          </span>
        ))}
        {missing.map((id) => (
          <span key={id} className="mb-1 mr-1 inline-flex items-center gap-1 rounded-full border border-[#b91c1c]/40 bg-[#b91c1c]/10 py-0.5 pl-2 pr-1 text-[11px] text-[#f87171]">
            สินค้าที่ผูกถูกลบแล้ว
            <button onClick={() => onPatch((x) => ({ ...x, product_ids: x.product_ids.filter((y) => y !== id) }))} className="grid h-4 w-4 place-items-center" aria-label="เอาออก"><Icon name="x" size={11} /></button>
          </span>
        ))}
        {mp.twins.map((p) => (
          <div key={p.id} className="text-[11px] text-[#4ade80]">＋ รวมสต๊อกพร้อมส่งชื่อเดียวกันให้อัตโนมัติ: {p.series_name} · {productStatusText(db, p)}</div>
        ))}
        {mp.all.length === 0 ? (
          <label className="mt-1 flex items-center gap-2">
            <span className="shrink-0 text-ink-faint">สถานะ (ยังไม่มีสินค้าในระบบ):</span>
            <select className={cx(inputCls, '!py-1 text-[12px]')} value={m.manual_state ?? ''} onChange={(e) => onPatch((x) => ({ ...x, manual_state: (e.target.value || undefined) as LineManualState | undefined }))}>
              {MANUAL_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          </label>
        ) : m.manual_state ? (
          <div className="text-[11px] text-ink-faint">ผูกสินค้าแล้ว → สถานะคำนวณจากสินค้าเอง (ค่าที่ตั้งเองไม่ถูกใช้)</div>
        ) : null}
      </div>
    </div>
  );
}

/** + Add ตัวที่ยังไม่มีในระบบ พร้อมสถานะ (เจ้าของ 2026-10-07: ของออกมาแล้ว(หาของ) · มีสต๊อก · พรีออเดอร์) */
function AddCustomMember({ onAdd, canWrite }: { onAdd: (name: string, state: '' | LineManualState) => void; canWrite: boolean }) {
  const [name, setName] = useState('');
  const [state, setState] = useState<'' | LineManualState>('sourcing');
  const add = () => {
    if (!name.trim()) return;
    onAdd(name.trim(), state);
    setName('');
  };
  return (
    <div className="mb-4 rounded-xl border border-subtle bg-surface-2 p-3">
      <div className="mb-2 text-[12.5px] font-extrabold">+ Add ตัวที่ยังไม่มีในระบบ</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อตัวละคร เช่น Pakunoda" onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <select className={inputCls} value={state} onChange={(e) => setState(e.target.value as '' | LineManualState)}>
          {MANUAL_OPTS.filter((o) => o.v).map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
        <button onClick={add} disabled={!canWrite || !name.trim()} className="rounded-lg bg-cta px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-40">เพิ่มตัว</button>
      </div>
    </div>
  );
}

/** ติ๊กจากในระบบ: สินค้าของค่ายไลน์นี้ — ติ๊ก = เพิ่มเป็นตัวใหม่ · เอาติ๊กออก = เลิกผูก (ตัวที่ไม่เหลืออะไรถูกเอาออก) ·
 *  ของพร้อมส่งชื่อเดียวกับใบพรีที่ผูกแล้ว = รวมให้อัตโนมัติ (ติ๊กซ้ำไม่ได้ ไม่งั้นได้ตัวซ้ำ 2 แถว) */
function SystemPicker({ db, line, canWrite, onPatch }: { db: Database; line: ProductLine; canWrite: boolean; onPatch: (fn: (l: ProductLine) => ProductLine) => void }) {
  const [q, setQ] = useState('');
  const [onlyFr, setOnlyFr] = useState(true);
  const linkedIdx = new Map<string, number>();
  const twinIdx = new Map<string, number>();
  line.members.forEach((m, i) => {
    const mp = memberProducts(db, m);
    mp.linked.forEach((p) => { if (!linkedIdx.has(p.id)) linkedIdx.set(p.id, i); });
    mp.twins.forEach((p) => { if (!twinIdx.has(p.id)) twinIdx.set(p.id, i); });
  });
  const needle = q.trim().toLowerCase();
  const list = db.products
    .filter((p) => p.manufacturer_id === line.maker_id)
    .filter((p) => !onlyFr || !line.franchise_id || p.franchise_id === line.franchise_id)
    .filter((p) => !needle || `${p.series_name} ${p.character_name ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(linkedIdx.has(b.id)) - Number(linkedIdx.has(a.id)) || (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 80);

  const tick = (p: Product) => {
    if (!canWrite) return;
    const at = linkedIdx.get(p.id);
    if (at === undefined) {
      onPatch((l) => ({ ...l, members: [...l.members, { id: genId('lm'), name: productName(p), product_ids: [p.id] }] }));
      return;
    }
    const m = line.members[at];
    const willDrop = m.product_ids.filter((id) => id !== p.id).length === 0 && !m.manual_state;
    if (willDrop && hasPin(m) && !window.confirm(`เอา "${m.name}" ออกจากไลน์? (ป้ายที่วางไว้จะหายด้วย)`)) return;
    // คิดจากแถวล่าสุดใน store (ไม่ใช่สำเนาตอนวาดหน้า) — ตัวที่ไม่เหลือสินค้า + ไม่ได้ตั้งสถานะ = เอาออกทั้งตัว
    onPatch((l) => {
      const cur = l.members.find((x) => x.product_ids.includes(p.id));
      if (!cur) return l;
      const left = cur.product_ids.filter((id) => id !== p.id);
      const drop = left.length === 0 && !cur.manual_state;
      return { ...l, members: drop ? l.members.filter((x) => x.id !== cur.id) : l.members.map((x) => (x.id === cur.id ? { ...x, product_ids: left } : x)) };
    });
  };
  const attachTo = (p: Product, memberId: string) => {
    if (!canWrite || !memberId) return;
    onPatch((l) => ({ ...l, members: l.members.map((x) => (x.id === memberId ? { ...x, product_ids: [...x.product_ids, p.id] } : x)) }));
  };

  return (
    <div className="rounded-xl border border-subtle bg-surface-2 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-extrabold">ติ๊กจากในระบบ ({db.manufacturers.find((m) => m.id === line.maker_id)?.name ?? '—'})</span>
        <div className="flex-1" />
        {line.franchise_id && (
          <label className="flex items-center gap-1.5 text-[11.5px] text-ink-muted2"><input type="checkbox" checked={onlyFr} onChange={(e) => setOnlyFr(e.target.checked)} /> เฉพาะเรื่องของไลน์</label>
        )}
      </div>
      <input className={cx(inputCls, 'mb-2')} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อสินค้า…" />
      <div className="max-h-[420px] overflow-y-auto rounded-lg border border-hair">
        {list.length === 0 && <div className="p-4 text-center text-[12px] text-ink-faint">ไม่พบสินค้าของค่ายนี้{line.franchise_id && onlyFr ? ' ในเรื่องนี้' : ''}</div>}
        {list.map((p) => {
          const at = linkedIdx.get(p.id);
          const twinAt = twinIdx.get(p.id);
          const unlinkedMembers = line.members.filter((m) => !m.product_ids.includes(p.id));
          return (
            <div key={p.id} className="flex items-center gap-2.5 border-b border-hair px-2.5 py-2 last:border-0">
              <input type="checkbox" checked={at !== undefined} disabled={!canWrite || (at === undefined && twinAt !== undefined)} onChange={() => tick(p)} className="h-4 w-4 accent-[#dc2626]" />
              <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-subtle bg-stripe">{p.images[0] && <img src={p.images[0]} alt="" className="h-full w-full object-cover" />}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold">{p.series_name}</div>
                <div className="truncate text-[11px] text-ink-faint">
                  {productStatusText(db, p)}
                  {at !== undefined && <span className="text-[#4ade80]"> · ตัวที่ {at + 1}</span>}
                  {at === undefined && twinAt !== undefined && <span className="text-[#4ade80]"> · รวมกับตัวที่ {twinAt + 1} อัตโนมัติ</span>}
                </div>
              </div>
              {at === undefined && twinAt === undefined && unlinkedMembers.length > 0 && (
                <select className="max-w-[120px] rounded-md border border-subtle bg-surface-3 px-1.5 py-1 text-[11px] text-ink-muted2" value="" disabled={!canWrite} onChange={(e) => attachTo(p, e.target.value)} title="ผูกกับตัวที่มีอยู่แล้ว (เช่นตัวที่ Add เอง แล้วร้านเพิ่งลงสินค้า)">
                  <option value="">ผูกกับตัว…</option>
                  {line.members.map((m, i) => (m.product_ids.includes(p.id) ? null : <option key={m.id} value={m.id}>{i + 1}. {m.name || 'ไม่มีชื่อ'}</option>))}
                </select>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
