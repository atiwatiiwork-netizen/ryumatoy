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

export class Store {
  private db: Database = structuredClone(SEED_DATABASE);
  private lastSynced: Database = this.db;
  private listeners = new Set<() => void>();
  private ready = false;
  private timer?: ReturnType<typeof setTimeout>;
  private saving: Promise<void> = Promise.resolve();
  private pendingSaves = 0; // >0 while a persist is in flight (block idle-reload from clobbering un-synced rows)
  private reloadSeq = 0;
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
      const data = await this.adapter.load();
      if (seq === this.reloadSeq) {
        this.db = data;
        this.lastSynced = data;
      }
    } catch (err) {
      console.error('[store] load failed — using in-memory seed', err);
    }
    this.ready = true;
    this.emit();
  };

  update = (mutation: Mutation): Database => {
    this.db = mutation(this.db);
    this.emit();
    this.scheduleFlush();
    return this.db;
  };

  flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    if (!this.ready) return; // never persist the in-memory seed before the real load finishes (would clobber DB)
    const base = this.lastSynced;
    const target = this.db;
    if (base === target) return;
    this.lastSynced = target;
    this.pendingSaves++;
    this.saving = this.saving
      .then(() => this.adapter.persist(target, base))
      .catch((err) => {
        console.error('[store] persist failed', err);
        // rewind so the next change re-attempts these rows instead of treating them as synced
        this.lastSynced = base;
        this.onPersistError?.(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { this.pendingSaves--; });
    await this.saving;
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
      data = await this.adapter.load();
    } catch (err) {
      console.error('[store] reload failed', err);
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
      data = await this.adapter.load();
    } catch {
      return; // transient network error → just skip this tick
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
