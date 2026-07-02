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
  private reloadSeq = 0;

  constructor(private adapter: PersistenceAdapter) {}

  getState = (): Database => this.db;
  isReady = (): boolean => this.ready;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  init = async (): Promise<void> => {
    try {
      this.db = await this.adapter.load();
    } catch (err) {
      console.error('[store] load failed — using in-memory seed', err);
    }
    this.lastSynced = this.db;
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
    this.saving = this.saving
      .then(() => this.adapter.persist(target, base))
      .catch((err) => console.error('[store] persist failed', err));
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
