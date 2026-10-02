'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDatabase } from '@/state/DataProvider';
import { useToast } from '@/state/ToastProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { copyText } from '@/lib/clipboard';
import { directVisibleTo } from '@/domain/services/market';
import * as mk from '@/lib/market';
import { Icon } from '@/components/Icon';
import { cx } from '@/components/ui';

/**
 * เลขกระเป๋า 4 หลักของวันนี้ (v73) — ให้เพื่อนใส่เลขนี้เพื่อ "เปลี่ยนใบพรี" ให้คุณ · รีเซ็ตเที่ยงคืนไทย
 * ตัวเลขออกจาก server เท่านั้น (ryuma_wallet_code) · ยังปิดสวิตช์ = ลูกค้าไม่เห็นกล่องนี้เลย
 */
export function WalletCodeChip({ className }: { className?: string }) {
  const db = useDatabase();
  const uid = useCurrentUserId();
  const { flash } = useToast();
  const visible = directVisibleTo(db, uid);
  const [res, setRes] = useState<mk.WalletCodeRes | null>(null);
  const load = useCallback(async () => { setRes(await mk.walletCode()); }, []);
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  // ข้ามเที่ยงคืน → เลขใหม่ (ตั้งเวลาเองจาก resets_at ของ server)
  useEffect(() => {
    if (!res?.ok || !res.resets_at) return;
    const ms = new Date(res.resets_at).getTime() - Date.now() + 1500;
    if (ms <= 0 || ms > 86_400_000 * 2) return;
    const t = setTimeout(() => void load(), ms);
    return () => clearTimeout(t);
  }, [res, load]);
  if (!visible || res?.error === 'closed') return null;

  const code = res?.ok ? res.code ?? '' : '';
  const copy = async () => flash((await copyText(code)) ? 'คัดลอกเลขกระเป๋าแล้ว ✓' : 'คัดลอกไม่สำเร็จ');
  return (
    <div className={cx('flex items-center gap-3 rounded-2xl border border-[#f1d27a]/30 bg-gradient-to-r from-[#f1d27a]/[0.1] to-transparent px-3.5 py-2.5', className)}>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold uppercase tracking-wider text-[#f1d27a]">เลขกระเป๋าวันนี้</div>
        {code ? (
          <button type="button" onClick={() => void copy()} className="mt-0.5 flex items-center gap-2 font-mono text-[26px] font-extrabold tracking-[0.35em] text-ink" aria-label="คัดลอกเลขกระเป๋า">
            {code}<Icon name="copy" size={15} className="text-ink-faint" />
          </button>
        ) : (
          <div className="mt-0.5 text-[12.5px] text-ink-faint">{!res ? 'กำลังขอเลข…' : res.error === 'no_rpc' ? 'ยังไม่ได้รัน migration v73' : res.error === 'no_server' ? 'โหมดพรีวิว (ไม่มีฐานข้อมูล)' : mk.marketErrText(res)}</div>
        )}
        <div className="text-[11px] leading-snug text-ink-faint">ให้เพื่อนใส่เลขนี้เพื่อ “เปลี่ยนใบพรี” ให้คุณ · เปลี่ยนใหม่ทุกเที่ยงคืน</div>
      </div>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#f1d27a]/15 text-[#f1d27a]"><Icon name="swap" size={20} /></span>
    </div>
  );
}
