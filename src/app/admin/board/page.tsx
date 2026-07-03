'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { baht } from '@/lib/theme';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';
import { franchiseOf } from '@/domain/services/catalog';
import { uploadImage } from '@/lib/upload';
import { createBoard, updateBoard, setBoardProducts, closeBoard, removeBoard } from '@/data/mutations';
import type { PreorderBoard } from '@/domain/entities';

const inputCls = 'w-full rounded-lg border border-subtle bg-surface-3 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';

export default function AdminBoardPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const open = db.boards.filter((b) => b.status === 'open');
  const closed = db.boards.filter((b) => b.status === 'closed');

  const [makerId, setMakerId] = useState(db.manufacturers[0]?.id ?? '');
  const [title, setTitle] = useState('');
  useEffect(() => { if (db.manufacturers.length && !db.manufacturers.some((m) => m.id === makerId)) setMakerId(db.manufacturers[0].id); }, [db.manufacturers, makerId]);

  const create = () => {
    if (!title.trim()) return flash('ใส่ชื่อกระดานก่อน');
    if (!makerId) return flash('เลือกค่าย');
    dispatch(createBoard(makerId, title.trim()));
    setTitle('');
    flash('สร้างกระดานแล้ว — เพิ่มสินค้าด้านล่าง');
  };

  return (
    <div>
      <div className="mb-1 text-2xl font-extrabold">กระดานปิดพรี</div>
      <div className="mb-5 text-[13px] text-ink-faint">1 กระดาน = 1 ค่าย · อัปโหลดโปสเตอร์ + เลือกสินค้าของค่ายนั้น · กด “ปิดกระดาน” เมื่อค่ายไม่รับแล้ว → ไปใส่จำนวนไฟนอลที่ “ปิดรอบสั่งผลิต”</div>

      {/* create */}
      <div className="mb-5 rounded-2xl border border-subtle bg-surface-2 p-5">
        <div className="mb-3 font-bold">+ สร้างกระดานใหม่</div>
        <div className="grid gap-3 sm:grid-cols-[220px_1fr_auto] sm:items-end">
          <label className="block"><span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">ค่าย</span>
            <select className={inputCls} value={makerId} onChange={(e) => setMakerId(e.target.value)}>{db.manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          </label>
          <label className="block"><span className="mb-1 block text-[12.5px] font-semibold text-ink-muted">ชื่อกระดาน</span>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น YZ Studio รอบเดือน ก.ค." />
          </label>
          <button onClick={create} className="rounded-lg bg-cta px-5 py-2.5 text-sm font-bold text-white">สร้าง</button>
        </div>
      </div>

      {/* open boards */}
      {open.length === 0 ? (
        <div className="mb-6 rounded-2xl border border-dashed border-subtle py-8 text-center text-[13px] text-ink-faint">ยังไม่มีกระดานที่เปิดอยู่</div>
      ) : open.map((b) => <BoardCard key={b.id} board={b} />)}

      {/* closed history */}
      {closed.length > 0 && (
        <div className="mt-8">
          <div className="mb-3 text-base font-bold text-ink-muted2">ประวัติกระดานที่ปิดแล้ว ({closed.length})</div>
          <div className="flex flex-col gap-2">
            {closed.map((b) => {
              const maker = db.manufacturers.find((m) => m.id === b.maker_id);
              const count = db.products.filter((p) => p.board_id === b.id).length;
              return (
                <div key={b.id} className="flex items-center gap-3 rounded-xl border border-subtle bg-surface-2 p-3 text-[13px]">
                  <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-muted2">ปิดแล้ว</span>
                  <span className="font-semibold">{b.title}</span>
                  <span className="text-ink-faint">{maker?.name} · {count} รายการ · ปิดเมื่อ {b.closed_at ? new Date(b.closed_at).toLocaleDateString('th-TH') : '—'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function BoardCard({ board }: { board: PreorderBoard }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const { flash } = useToast();
  const maker = db.manufacturers.find((m) => m.id === board.maker_id);
  const [busy, setBusy] = useState(false);

  // this maker's open pre-orders that are free (no board) or already in THIS board
  const eligible = db.products.filter((p) => p.manufacturer_id === board.maker_id && !p.is_stock && p.status === 'open' && (!p.board_id || p.board_id === board.id));
  const inBoard = new Set(db.products.filter((p) => p.board_id === board.id).map((p) => p.id));
  // group the picker by เรื่อง
  const groups = new Map<string, typeof eligible>();
  for (const p of eligible) { const f = franchiseOf(db, p)?.name ?? 'อื่นๆ'; if (!groups.has(f)) groups.set(f, []); groups.get(f)!.push(p); }

  const toggle = (pid: string) => {
    const next = new Set(inBoard);
    next.has(pid) ? next.delete(pid) : next.add(pid);
    dispatch(setBoardProducts(board.id, [...next]));
  };

  const onPoster = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { const url = await uploadImage(file, 'banner'); dispatch(updateBoard(board.id, { poster_url: url })); flash('อัปโหลดโปสเตอร์แล้ว'); }
    catch { flash('อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const close = () => {
    if (!confirm(`ปิดกระดาน “${board.title}” ?\nสินค้า ${inBoard.size} รายการจะหยุดรับจองใหม่ แล้วไปโผล่ที่ "ปิดรอบสั่งผลิต" ให้ใส่จำนวนไฟนอล (ออเดอร์ที่จองไว้ไม่กระทบ)`)) return;
    dispatch(closeBoard(board.id));
    flash('ปิดกระดานแล้ว → ไปตั้งจำนวนผลิตที่ “ปิดรอบสั่งผลิต”');
  };
  const del = () => {
    if (!confirm(`ลบกระดาน “${board.title}” ?\n(สินค้าจะถูกปลดออกจากกระดาน แต่ไม่ถูกลบ)`)) return;
    dispatch(removeBoard(board.id));
    flash('ลบกระดานแล้ว');
  };

  return (
    <div className="mb-4 rounded-2xl border border-subtle bg-surface-2 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="rounded-md bg-[#16a34a]/[0.15] px-2 py-0.5 text-[11px] font-bold text-[#4ade80]">กำลังปิดพรี</span>
        <div className="text-base font-bold">{board.title}</div>
        <div className="text-[12.5px] text-ink-faint">{maker?.name} · เลือกแล้ว {inBoard.size} รายการ</div>
        <div className="ml-auto flex items-center gap-2">
          <Link href={`/board/${board.id}`} target="_blank" className="rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted2">ดูหน้าลูกค้า →</Link>
          <button onClick={close} className="rounded-lg bg-cta px-3 py-1.5 text-[12.5px] font-bold text-white">ปิดกระดาน</button>
          <button onClick={del} className="grid h-8 w-8 place-items-center rounded-lg border border-[#f87171]/40 text-[#f87171]"><Icon name="x" size={15} /></button>
        </div>
      </div>

      {/* poster */}
      <div className="mb-4 flex items-center gap-3">
        <label className="grid h-20 w-40 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-accent bg-surface-3 text-ink-faint">
          {busy ? <Icon name="box" size={20} className="animate-pulse" /> : board.poster_url ? <img src={board.poster_url} alt="" className="h-full w-full object-cover" /> : <Icon name="camera" size={20} />}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onPoster(e.target.files?.[0])} />
        </label>
        <div className="text-[12px] text-ink-faint">โปสเตอร์กระดาน (รูปรวมจากค่าย) — โชว์บนแบนเนอร์หน้าแรก + บนสุดของหน้ากระดาน</div>
      </div>

      {/* product picker grouped by เรื่อง */}
      {eligible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-subtle py-5 text-center text-[12.5px] text-ink-faint">ค่ายนี้ยังไม่มีสินค้าพรีออเดอร์ (เปิดจอง) ให้เลือก — เพิ่มสินค้าที่ “จัดการสินค้า” ก่อน</div>
      ) : (
        <div className="flex flex-col gap-3">
          {[...groups.entries()].map(([fname, items]) => (
            <div key={fname}>
              <div className="mb-1.5 text-[12px] font-bold text-ink-muted2">{fname}</div>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((p) => {
                  const on = inBoard.has(p.id);
                  return (
                    <button key={p.id} onClick={() => toggle(p.id)} className={cx('flex items-center gap-2.5 rounded-lg border p-2 text-left', on ? 'border-primary bg-primary/[0.08]' : 'border-subtle bg-surface-3')}>
                      <span className={cx('grid h-5 w-5 shrink-0 place-items-center rounded-[5px] border-[1.5px]', on ? 'border-primary bg-primary' : 'border-subtle')}>{on && <Icon name="check" size={12} className="text-white" />}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold">{p.series_name}</span><span className="text-[11px] text-ink-faint">{baht(p.price_total)} · มัดจำ {baht(p.deposit_amount)}</span></span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
