'use client';

import { useState } from 'react';
import { useDatabase, useDispatch } from '@/state/DataProvider';
import { useCurrentUserId } from '@/state/AuthProvider';
import { useToast } from '@/state/ToastProvider';
import { useSmartBack } from '@/lib/nav';
import { BackBar } from '@/components/ui';
import { MissionQuestCard } from '@/components/MissionQuest';
import { missionLive, missionConfig, missionStateFor, missionInWindow } from '@/domain/services/missions';
import { submitMission } from '@/data/mutations';
import { uploadImage } from '@/lib/upload';
import { enablePush, pushSupported } from '@/lib/push';
import { store } from '@/data/store';

export default function MissionsPage() {
  const db = useDatabase();
  const dispatch = useDispatch();
  const uid = useCurrentUserId();
  const { flash } = useToast();
  const goBack = useSmartBack('/profile');
  const [proofUrl, setProofUrl] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const live = missionLive(db);
  const cfg = missionConfig(db);
  const state = uid ? missionStateFor(db, uid) : null;
  const reward = cfg ? db.coupons.find((c) => c.id === cfg.reward_coupon_id) : undefined;

  const onProofFile = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try { setProofUrl(await uploadImage(f, 'mission')); flash('แนบรูปแล้ว ✓'); }
    catch { flash('อัปโหลดรูปไม่สำเร็จ ลองใหม่'); }
    finally { setBusy(false); }
  };

  const onEnableBell = async () => {
    if (!uid) return;
    if (!pushSupported()) return flash('iPhone: ติดตั้งลงหน้าจอโฮมก่อน แล้วเปิดจากไอคอน จึงเปิดกระดิ่งได้');
    setBusy(true);
    try { await enablePush(uid, dispatch); flash('เปิดกระดิ่งแล้ว 🔔 ภารกิจ 3 ผ่าน!'); }
    catch (e) { flash((e as Error).message === 'denied' ? 'ไม่ได้รับอนุญาต — เปิดได้ใน ตั้งค่า > การแจ้งเตือน' : 'เปิดกระดิ่งไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const onSubmit = async () => {
    if (!uid || !state || !state.canSubmit(!!proofUrl)) return;
    setBusy(true);
    // guard against a stale mobile session: re-verify against the freshest in-memory state right now
    dispatch(submitMission(uid, state.installed ? undefined : proofUrl));
    await store.flush(); // ส่งจริงถึง DB ก่อนบอกว่า "ส่งแล้ว" — กัน split flush ทำใบสมัครหาย (DNA rule 7)
    setBusy(false);
    flash('ส่งภารกิจแล้ว 🎉 รอแอดมินตรวจสอบ');
  };

  return (
    <div className="mx-auto max-w-[560px]">
      <BackBar title="Event ภารกิจ" onBack={goBack} />
      {!cfg || !live ? (
        <div className="rounded-3xl border border-subtle bg-surface-2 px-6 py-14 text-center">
          <div className="mb-2 text-4xl">🗓️</div>
          <div className="text-[15px] font-bold">{cfg && cfg.active && !missionInWindow(cfg) ? 'กิจกรรมยังไม่เริ่ม / จบไปแล้ว' : 'ยังไม่มีกิจกรรมตอนนี้'}</div>
          <div className="mt-1 text-[12.5px] text-ink-faint">เปิดกระดิ่งไว้ มีกิจกรรมใหม่จะแจ้งเตือนทันที</div>
        </div>
      ) : !state ? null : (
        <MissionQuestCard
          cfg={live}
          rewardValue={reward?.value ?? 0}
          flags={state}
          proofUrl={proofUrl}
          busy={busy}
          onProofFile={onProofFile}
          onEnableBell={onEnableBell}
          onSubmit={onSubmit}
        />
      )}
    </div>
  );
}
