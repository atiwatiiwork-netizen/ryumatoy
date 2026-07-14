'use client';

import { Icon } from './Icon';
import { cx } from './ui';
import { baht } from '@/lib/theme';
import type { MissionConfig } from '@/domain/services/missions';
import type { MissionSubmission } from '@/domain/entities';

/**
 * เควสการ์ด Event ภารกิจ — game-like: progress bar + 3 quest steps + reward chest. PURE presentational
 * (all state via props) so the ADMIN PREVIEW on /admin/events renders the EXACT same card the customer
 * sees (DNA: admin ตรวจหน้า UI ของ Event จริงก่อนกดเปิด).
 */

export interface QuestFlags {
  hasTicket: boolean;
  installed: boolean;
  bellOn: boolean;
  submission?: Pick<MissionSubmission, 'status'>;
}

const fmtD = (iso: string) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

export function MissionQuestCard({ cfg, rewardValue, flags, proofUrl, busy, onProofFile, onEnableBell, onSubmit }: {
  cfg: MissionConfig;
  rewardValue: number;
  flags: QuestFlags;
  proofUrl?: string;
  busy?: boolean;
  onProofFile?: (f?: File) => void;
  onEnableBell?: () => void;
  onSubmit?: () => void;
}) {
  const { hasTicket, installed, bellOn, submission } = flags;
  const installOk = installed || !!proofUrl;
  const done = [hasTicket, installOk, bellOn].filter(Boolean).length;
  const pct = Math.round((done / 3) * 100);
  const pending = submission?.status === 'pending';
  const approved = submission?.status === 'approved';
  const rejected = submission?.status === 'rejected';
  const canSubmit = !pending && !approved && done === 3;

  return (
    <div className="overflow-hidden rounded-3xl border border-[#d4af37]/35 bg-surface-2">
      {/* header: title + window + reward chest */}
      <div className="p-5 pb-4" style={{ background: 'linear-gradient(160deg, rgba(212,175,55,.14), rgba(185,28,28,.10))' }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[17px] font-extrabold leading-tight">{cfg.title}</div>
            {cfg.blurb && <div className="mt-1 text-[12px] leading-relaxed text-ink-muted2">{cfg.blurb}</div>}
            <div className="mt-1.5 text-[11px] text-ink-faint">📅 {fmtD(cfg.starts_at)} – {fmtD(cfg.ends_at)}</div>
          </div>
          <div className="flex shrink-0 flex-col items-center rounded-2xl border border-[#d4af37]/50 bg-[#d4af37]/[0.12] px-3 py-2">
            <span className="text-xl">🎁</span>
            <span className="text-[13px] font-extrabold text-[#f1d27a]">คูปอง {baht(rewardValue)}</span>
          </div>
        </div>
        {/* progress */}
        <div className="mt-3.5">
          <div className="mb-1 flex items-center justify-between text-[11px] font-bold">
            <span className="text-ink-muted">ความคืบหน้า</span>
            <span className={done === 3 ? 'text-[#4ade80]' : 'text-[#f1d27a]'}>{done}/3 ภารกิจ</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full border border-white/[0.06] bg-black/40">
            <div className={cx('h-full rounded-full transition-all duration-700', done === 3 ? 'bg-gradient-to-r from-[#16a34a] to-[#4ade80]' : 'bg-gradient-to-r from-[#b45309] to-[#f1d27a]')} style={{ width: `${Math.max(pct, 4)}%` }} />
          </div>
        </div>
      </div>

      {/* quests */}
      <div className="flex flex-col gap-2.5 p-4">
        <Quest n={1} done={hasTicket} emoji="🎫" title="พรีของขั้นต่ำ 1 ใบ" sub={hasTicket ? 'มีใบพรีแล้ว — ผ่าน!' : 'พรีอะไรก็ได้ 1 รายการ (รวมรอบพิเศษ)'} />
        <Quest n={2} done={installOk} emoji="📲" title="ติดตั้งแอปลงหน้าจอโทรศัพท์" sub={
          installed ? 'ระบบตรวจพบแล้ว — ผ่าน!'
          : proofUrl ? 'แนบรูปหลักฐานแล้ว — รอแอดมินตรวจ'
          : 'ติดตั้งแล้วเปิดแอปจากไอคอน 1 ครั้ง ระบบจะตรวจให้เอง'
        }>
          {!installed && !approved && !pending && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {proofUrl && <img src={proofUrl} alt="หลักฐาน" className="h-12 w-12 rounded-lg border border-subtle object-cover" />}
              {onProofFile && (
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-subtle bg-surface-3 px-3 py-1.5 text-[11.5px] font-bold text-ink-muted2">
                  <Icon name="camera" size={13} /> {proofUrl ? 'เปลี่ยนรูป' : 'หรือแนบรูปแคปหน้าจอ (มีไอคอน Ryuma)'}
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => onProofFile(e.target.files?.[0])} />
                </label>
              )}
            </div>
          )}
        </Quest>
        <Quest n={3} done={bellOn} emoji="🔔" title="เปิดกระดิ่งแจ้งเตือน" sub={bellOn ? 'เปิดอยู่ — ผ่าน!' : 'รับข่าวรอบพรี/ของถึงก่อนใคร'}>
          {!bellOn && onEnableBell && !approved && !pending && (
            <button onClick={onEnableBell} className="mt-2 rounded-lg bg-[#16a34a] px-3.5 py-1.5 text-[12px] font-bold text-white">เปิดกระดิ่งเลย</button>
          )}
        </Quest>

        {/* state / submit */}
        {approved ? (
          <div className="mt-1 rounded-2xl border border-[#16a34a]/45 bg-[#16a34a]/[0.12] p-4 text-center">
            <div className="text-2xl">🏆</div>
            <div className="text-[15px] font-extrabold text-[#4ade80]">ได้รับของรางวัลแล้ว!</div>
            <div className="mt-0.5 text-[12px] text-ink-muted2">คูปอง {baht(rewardValue)} อยู่ใน “คูปองของฉัน” แล้ว</div>
          </div>
        ) : pending ? (
          <div className="mt-1 rounded-2xl border border-[#d97706]/45 bg-[#d97706]/[0.10] p-4 text-center">
            <div className="text-2xl">⏳</div>
            <div className="text-[14px] font-extrabold text-[#fbbf24]">ส่งแล้ว · รอแอดมินตรวจสอบ</div>
            <div className="mt-0.5 text-[12px] text-ink-muted2">อนุมัติแล้วจะแจ้งเตือน + คูปองเข้าอัตโนมัติ</div>
          </div>
        ) : (
          <>
            {rejected && <div className="mt-1 rounded-xl border border-[#b91c1c]/45 bg-[#b91c1c]/[0.10] px-3.5 py-2.5 text-[12px] text-primary-soft">รอบก่อนไม่ผ่านการตรวจ — เช็กหลักฐานแล้วส่งใหม่ได้เลย</div>}
            <button
              onClick={onSubmit}
              disabled={!canSubmit || busy || !onSubmit}
              className={cx('mt-1 w-full rounded-2xl py-3.5 text-[15px] font-extrabold transition-all', canSubmit ? 'bg-gradient-to-r from-[#b91c1c] to-[#dc2626] text-white shadow-lg' : 'bg-surface-3 text-ink-faint')}
            >
              {busy ? 'กำลังส่ง…' : canSubmit ? '🎉 ส่งภารกิจ รับคูปอง!' : `ทำภารกิจให้ครบก่อน (${done}/3)`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Quest({ n, done, emoji, title, sub, children }: { n: number; done: boolean; emoji: string; title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className={cx('rounded-2xl border p-3.5 transition-colors', done ? 'border-[#16a34a]/45 bg-[#16a34a]/[0.07]' : 'border-subtle bg-surface-3/50')}>
      <div className="flex items-center gap-3">
        <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-full border text-lg', done ? 'border-[#16a34a] bg-[#16a34a]/[0.18]' : 'border-subtle bg-surface-3')}>{emoji}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13.5px] font-bold">
            <span className="text-ink-faint">ภารกิจ {n}</span>
            <span className="truncate">{title}</span>
          </div>
          <div className={cx('text-[11.5px] leading-tight', done ? 'text-[#4ade80]' : 'text-ink-faint')}>{sub}</div>
        </div>
        <span className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-full text-[13px] font-black', done ? 'bg-[#16a34a] text-white' : 'border border-subtle text-ink-faint')}>{done ? '✓' : ''}</span>
      </div>
      {children}
    </div>
  );
}
