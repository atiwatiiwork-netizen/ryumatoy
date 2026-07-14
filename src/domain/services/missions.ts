import type { Database, MissionSubmission } from '../entities';

/**
 * Event ภารกิจ (mission quest) — "ทำ 3 อย่าง รับคูปอง" (ryuma-event-spec):
 *   1) มีใบพรีอย่างน้อย 1 ใบ (นับทุกตั๋ว รวมรอบพิเศษ/หาของ — ตั๋วคือหลักฐานว่าเคยพรีจริง)
 *   2) ติดตั้งแอปลงหน้าจอ — SYSTEM-verified via users.installed_at (stamped when the member opens the
 *      app standalone, migration v46); fallback = screenshot proof the admin eyeballs
 *   3) เปิดกระดิ่ง — a push_subscriptions row under the member
 * Config lives in app_config key 'mission_event' (jsonb → no schema churn); submissions in
 * mission_submissions (migration v48). Reward coupon is granted by the ADMIN on approve (DNA rule 7).
 */

export const MISSION_KEY = 'mission_event';

export interface MissionConfig {
  title: string;
  blurb?: string;
  starts_at: string; // YYYY-MM-DD (inclusive)
  ends_at: string;   // YYYY-MM-DD (inclusive, whole day)
  reward_coupon_id: string;
  active: boolean;
}

export function missionConfig(db: Database): MissionConfig | null {
  const row = db.appConfig.find((c) => c.key === MISSION_KEY);
  if (!row) return null;
  const v = row.value as Partial<MissionConfig>;
  if (!v || typeof v.title !== 'string') return null;
  return {
    title: v.title,
    blurb: typeof v.blurb === 'string' ? v.blurb : undefined,
    starts_at: String(v.starts_at ?? ''),
    ends_at: String(v.ends_at ?? ''),
    reward_coupon_id: String(v.reward_coupon_id ?? ''),
    active: v.active === true,
  };
}

/** Inside the event window? ends_at counts the WHOLE day (customer expectation for "ถึงวันที่ X"). */
export function missionInWindow(cfg: MissionConfig, now: Date = new Date()): boolean {
  if (!cfg.starts_at || !cfg.ends_at) return false;
  const start = new Date(`${cfg.starts_at}T00:00:00`);
  const end = new Date(`${cfg.ends_at}T23:59:59.999`);
  return !isNaN(start.getTime()) && !isNaN(end.getTime()) && now >= start && now <= end;
}

/** Live = admin turned it ON and today is inside the window → customers see the quest. */
export function missionLive(db: Database, now: Date = new Date()): MissionConfig | null {
  const cfg = missionConfig(db);
  return cfg && cfg.active && missionInWindow(cfg, now) ? cfg : null;
}

/** A member's latest submission for the event (rejected ones don't block a resubmit). */
export function missionSubmissionFor(db: Database, userId: string): MissionSubmission | undefined {
  return db.missionSubmissions
    .filter((s) => s.event_key === MISSION_KEY && s.user_id === userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

export interface MissionState {
  hasTicket: boolean;   // เงื่อนไข 1
  installed: boolean;   // เงื่อนไข 2 (system: installed_at)
  bellOn: boolean;      // เงื่อนไข 3 (push subscription)
  doneCount: number;    // 0-3 system-verified checks (proof screenshot counts at submit, not here)
  submission?: MissionSubmission; // latest (pending/approved blocks resubmission; rejected doesn't)
  /** All checks pass (install may be satisfied by attaching a proof) and nothing pending/approved yet. */
  canSubmit: (hasProof: boolean) => boolean;
}

/** Everything the quest card needs, computed from what THIS session can see (RLS: own rows only —
 *  which is exactly the member's own tickets/subscriptions/user row, so the checks are correct). */
export function missionStateFor(db: Database, userId: string): MissionState {
  const me = db.users.find((u) => u.id === userId);
  const hasTicket = db.tickets.some((t) => t.owner_id === userId);
  const installed = !!me?.installed_at;
  const bellOn = db.pushSubscriptions.some((s) => s.user_id === userId);
  const submission = missionSubmissionFor(db, userId);
  const blocked = submission?.status === 'pending' || submission?.status === 'approved';
  return {
    hasTicket, installed, bellOn,
    doneCount: [hasTicket, installed, bellOn].filter(Boolean).length,
    submission,
    canSubmit: (hasProof: boolean) => !blocked && hasTicket && bellOn && (installed || hasProof),
  };
}
