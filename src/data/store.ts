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
  /** คิวที่กำลังอัปโหลดอยู่ + ผลของมัน (ผูกกับ db ชุดนั้นโดยเฉพาะ ไม่ปนกับ flush อื่น) */
  private inflight: { target: Database; done: Promise<string | null> } | null = null;
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
    const target = this.db;
    // ⚠ ผลลัพธ์ต้องผูกกับ "ข้อมูลชุดนี้" เท่านั้น ห้ามใช้ตัวแปรกลาง (audit regression #7):
    //   ถ้าใช้ตัวแปรกลาง flush ของ A ที่ล้ม จะถูกรายงานเป็นผลของ flush ของ B ที่สำเร็จ
    //   → checkout บอก "บันทึกไม่สำเร็จ" ทั้งที่ออเดอร์ขึ้นแล้ว → ลูกค้ากดส่งซ้ำ = ออเดอร์ซ้ำหลังโอนครั้งเดียว
    // ถ้าตัวจับเวลา 350ms เพิ่งคว้าชุดเดียวกันไปส่งอยู่ → รอ "ผลของคิวนั้น" ไม่ใช่ตอบ null ทันที
    if (this.inflight?.target === target) return this.inflight.done;
    if (this.lastSynced === target) return null; // ไม่มีอะไรใหม่ และไม่มีคิวของชุดนี้ค้างอยู่
    const base = this.lastSynced;
    this.lastSynced = target;
    this.pendingSaves++;
    const done = this.saving
      .then(() => withTimeout(this.adapter.persist(target, base), PERSIST_TIMEOUT, 'persist'))
      .then((): string | null => null)
      .catch((err): string | null => {
        console.error('[store] persist failed', err);
        // rewind so the next change re-attempts these rows instead of treating them as synced
        this.lastSynced = base;
        const msg = err instanceof Error ? err.message : String(err);
        this.onPersistError?.(msg);
        // ⚠ ต้องนัดลองใหม่เสมอ — หลัง rewind จะได้ lastSynced !== db ค้างอยู่ ซึ่งทำให้
        //   reloadIfIdle (ตัวรีเฟรชอัตโนมัติ) ถูกบล็อกถาวร → คิวแอดมินหยุดอัปเดตทั้งแท็บ
        //   แล้วแอดมินทำงานบนข้อมูลเก่าโดยไม่รู้ตัว (ต้นตอของเคสอนุมัติซ้ำ) audit concurrency #10
        this.scheduleFlush(5_000);   // ถอยหลังพอสมควร ไม่ยิงรัวจนแบตหมด
        return msg;
      })
      .finally(() => {
        this.pendingSaves--;
        if (this.inflight?.target === target) this.inflight = null;
      });
    this.inflight = { target, done };
    this.saving = done.then(() => undefined);
    return done;
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
    // ⚠ ต้องเซฟงานที่ค้างอยู่ก่อนเสมอ — reload เขียนทับทั้ง db และ lastSynced
    //   ถ้ามีของที่ยังไม่ขึ้นเซิร์ฟเวอร์ (เพิ่งกดรับเรื่องจัดส่ง/แก้มัดจำ/เริ่มงานหาของ ซึ่งรอ debounce 350ms อยู่)
    //   งานนั้นจะหายไปเงียบๆ แล้ว flush รอบถัดไปจะรายงานว่า "เซฟสำเร็จ" เพราะ lastSynced === db แล้ว
    //   (AuthProvider เรียก reload ตอน resume/ล็อกอิน ซึ่งชนกับการกดปุ่มพอดีได้) audit concurrency #5
    if (this.lastSynced !== this.db || this.pendingSaves > 0) await this.flush();
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

  private scheduleFlush(ms = 350) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), ms);
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
