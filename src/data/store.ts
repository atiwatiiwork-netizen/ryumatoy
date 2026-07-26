import type { Database } from '../domain/entities';
import { localStorageAdapter, type PersistenceAdapter } from './persistence';
import { hasSupabase } from './supabaseClient';
import { supabaseAdapter } from './supabaseAdapter';
import { SEED_DATABASE } from './seed';

/**
 * The central store — the single runtime source of truth.
 *
 * It holds exactly one Database, loaded from the configured backend: Supabase
 * when NEXT_PUBLIC_SUPABASE_* env vars are set, otherwise localStorage (preview).
 * Reads derive from this object via the domain services; writes go through
 * `update()` with a pure mutation, which updates memory immediately (optimistic)
 * and persists soon after (debounced, diff-based).
 */
export type Mutation = (db: Database) => Database;

/** Reject if a promise doesn't settle in time — so a stalled network on resume can't hang a load
 *  forever (the app then falls back to seed/keeps current data and the next poll retries). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}
const LOAD_TIMEOUT = 12_000;
// persist ก็ต้องมีเพดานเหมือน load: บน resume ที่ client ค้างตาย (dead socket) request ไม่ settle เลย —
// ถ้าปล่อยค้าง pendingSaves จะ >0 ตลอดกาล → reloadIfIdle (poll/focus ที่เป็นกลไกฟื้นตัวหลัก) โดนบล็อกถาวร,
// และ saving chain ไม่จบ → ทุก await flush (checkout/missions/เลือกวิธีรับของ) ค้างปุ่มตลอด. timeout →
// rewind + onPersistError แจ้งผู้ใช้ + คิวเดินต่อ; diff-upsert เป็น idempotent การส่งซ้ำรอบหน้าปลอดภัย.
const PERSIST_TIMEOUT = 20_000;

export class Store {
  private db: Database = structuredClone(SEED_DATABASE);
  private lastSynced: Database = this.db;
  private listeners = new Set<() => void>();
  private ready = false;
  private timer?: ReturnType<typeof setTimeout>;
  private saving: Promise<void> = Promise.resolve();
  private pendingSaves = 0; // >0 while a persist is in flight (block idle-reload from clobbering un-synced rows)
  private reloadSeq = 0;
  private lastFailure: string | null = null; // ข้อความ error ของการเซฟรอบล่าสุดที่ล้ม (ให้ flush() คืน)
  /** Set by the UI to surface a failed background save (e.g. schema drift / RLS) instead of
   *  silently losing data. Called with the backend error message. */
  onPersistError?: (message: string) => void;

  constructor(private adapter: PersistenceAdapter) {}

  getState = (): Database => this.db;
  isReady = (): boolean => this.ready;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  init = async (): Promise<void> => {
    // Seq-guarded like reload(): if a session-aware reload (from AuthProvider) starts
    // while this initial anon load is still in flight, don't let this stale anon result
    // clobber it. Under RLS the anon load returns no private rows, so clobbering would
    // leave the logged-in user's own row missing (me = undefined → stuck loading).
    const seq = ++this.reloadSeq;
    try {
      const data = await withTimeout(this.adapter.load(), LOAD_TIMEOUT, 'initial load');
      if (seq === this.reloadSeq) {
        this.db = data;
        this.lastSynced = data;
      }
    } catch (err) {
      console.error('[store] load failed — using in-memory seed', err);
    }
    this.ready = true; // ALWAYS become ready (even on timeout) so the UI never hangs; a later
    this.emit();       // reloadIfIdle (poll/focus) recovers the real data once the network is back
  };

  update = (mutation: Mutation): Database => {
    this.db = mutation(this.db);
    this.emit();
    this.scheduleFlush();
    return this.db;
  };

  /** เซฟทันที. คืน `null` = เซฟผ่าน, คืนข้อความ = เซฟไม่ผ่าน (audit v57 #5).
   *  ⚠ ตัวนี้ **ไม่ throw** (โดยตั้งใจ — จะได้ไม่ทำ flow พัง) ดังนั้นจุดไหนที่จะทำอะไร
   *  "ย้อนกลับไม่ได้" ต่อจากเซฟ (ยิง push / ส่ง LINE / บอกลูกค้าว่าสำเร็จ) **ต้องเช็คค่าที่คืนมา**
   *  ไม่ใช่แค่ `await store.flush()` เฉยๆ ไม่งั้นจะแจ้งเรื่องที่ไม่ได้เกิดขึ้นจริง. */
  flush = async (): Promise<string | null> => {
    clearTimeout(this.timer);
    if (!this.ready) return null; // never persist the in-memory seed before the real load finishes (would clobber DB)
    const base = this.lastSynced;
    const target = this.db;
    // ⚠ ไม่มีอะไรใหม่ให้ส่ง "ไม่ได้แปลว่าเซฟเสร็จแล้ว" — ตัวจับเวลา 350ms อาจเพิ่งคว้า target ก้อนเดียวกัน
    //   ไปอัปโหลดอยู่ (ระหว่างนั้น checkout ยัง await RPC จองของอยู่นานกว่า 350ms เสมอ)
    //   เดิม return ทันที → เคลียร์ตะกร้า/บอกสำเร็จ/เด้งหน้าทั้งที่ตั๋วยังไม่ขึ้นเซิร์ฟเวอร์ (audit persist #1)
    //   ต้องรอคิวที่ค้างอยู่ให้จบก่อนเสมอ
    if (base === target) { await this.saving; return this.lastFailure; }
    this.lastSynced = target;
    this.lastFailure = null;
    this.pendingSaves++;
    this.saving = this.saving
      .then(() => withTimeout(this.adapter.persist(target, base), PERSIST_TIMEOUT, 'persist'))
      .catch((err) => {
        console.error('[store] persist failed', err);
        // rewind so the next change re-attempts these rows instead of treating them as synced
        this.lastSynced = base;
        this.lastFailure = err instanceof Error ? err.message : String(err);
        this.onPersistError?.(this.lastFailure);
      })
      .finally(() => { this.pendingSaves--; });
    await this.saving;
    return this.lastFailure;
  };

  reset = async (): Promise<void> => {
    this.db = await this.adapter.reset();
    this.lastSynced = this.db;
    this.emit();
  };

  // Re-fetch from the backend with whatever auth session is now active. Called on
  // login/logout so RLS-filtered rows (own orders/tickets) appear or disappear.
  // Sequence-guarded: concurrent reloads can race (e.g. the auth-change listener vs
  // an explicit reload right after signup). Only the most-recently-STARTED reload is
  // applied, so a stale in-flight fetch can never clobber fresher data.
  reload = async (): Promise<void> => {
    const seq = ++this.reloadSeq;
    let data: Database;
    try {
      data = await withTimeout(this.adapter.load(), LOAD_TIMEOUT, 'reload');
    } catch (err) {
      console.error('[store] reload failed', err);
      this.ready = true; // don't leave the store un-ready on a stalled reload (would block reloadIfIdle)
      this.emit();
      return;
    }
    if (seq !== this.reloadSeq) return; // superseded by a newer reload
    this.db = data;
    this.lastSynced = this.db;
    this.ready = true;
    this.emit();
  };

  /** Background auto-refresh (polling / tab-focus). Safe by design: it does NOTHING when there
   *  are unsaved local changes (lastSynced !== db), and bails if any local write lands while the
   *  fetch is in flight — so it can never clobber something the user just did or is typing. */
  reloadIfIdle = async (): Promise<void> => {
    // pending edits OR a save in flight → leave the optimistic db alone. (Without the pendingSaves
    // guard, a poll landing during a persist — when lastSynced === db momentarily — could overwrite
    // rows that haven't finished uploading, losing them.)
    if (!this.ready || this.pendingSaves > 0 || this.lastSynced !== this.db) return;
    const before = this.db;
    const seq = ++this.reloadSeq;
    let data: Database;
    try {
      data = await withTimeout(this.adapter.load(), LOAD_TIMEOUT, 'idle reload');
    } catch {
      return; // transient network error / timeout → just skip this tick, the next poll retries
    }
    if (seq !== this.reloadSeq || this.db !== before) return; // superseded or a local write landed
    this.db = data;
    this.lastSynced = data;
    this.emit();
  };

  private scheduleFlush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 350);
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

// Supabase when configured, otherwise localStorage (preview / offline).
const adapter: PersistenceAdapter = hasSupabase ? supabaseAdapter : localStorageAdapter;

export const store = new Store(adapter);

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void store.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void store.flush();
  });
}
