import type { Database } from '../domain/entities';
import { SEED_DATABASE } from './seed';

/**
 * Persistence boundary. The store talks to this interface, never to a concrete
 * backend. localStorage and Supabase both implement it, so swapping storage
 * touches no feature code. The interface is async so a network backend fits.
 */
export interface PersistenceAdapter {
  load(): Promise<Database>;
  persist(next: Database, base: Database): Promise<void>;
  reset(): Promise<Database>;
}

const STORAGE_KEY = 'ryuma-db:v1';

/** Default adapter: browser localStorage (used when Supabase is not configured). */
export const localStorageAdapter: PersistenceAdapter = {
  async load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(SEED_DATABASE);
      const parsed = JSON.parse(raw) as Partial<Database>;
      if (!parsed || !Array.isArray(parsed.products)) return structuredClone(SEED_DATABASE);
      // ⚠ settings ต้อง merge ทีละคีย์ — สแนปช็อตเก่าใน localStorage ไม่มีคีย์ที่เพิ่มทีหลัง (เช่น points_* v66)
      //   spread ชั้นเดียวจะทับ settings ทั้งก้อน → ค่าใหม่เป็น undefined → หน้าจอโชว์ NaN (เจอตอนพรีวิว 2026-09-11)
      const seed = structuredClone(SEED_DATABASE);
      return { ...seed, ...parsed, settings: { ...seed.settings, ...(parsed.settings ?? {}) } } as Database;
    } catch {
      return structuredClone(SEED_DATABASE);
    }
  },
  async persist(next) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  },
  async reset() {
    const fresh = structuredClone(SEED_DATABASE);
    await this.persist(fresh, fresh);
    return fresh;
  },
};
