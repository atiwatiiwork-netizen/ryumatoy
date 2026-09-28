/**
 * ฐานข้อมูลจำลองสำหรับเทสต์ระดับ SQL — Postgres ตัวจริง (PGlite · WASM) รัน migration ทุกไฟล์ในโฟลเดอร์ supabase/
 * ตามลำดับเวอร์ชัน แบบเดียวกับที่เจ้าของรันบน production → RPC / trigger / RLS ถูกเทสต์ของจริง ไม่ใช่ตัวเลียนแบบ
 *
 * ทำไมต้องมี (2026-09-24): plpgsql ไม่ตรวจชื่อคอลัมน์/ตารางตอน "สร้าง" ฟังก์ชัน — บั๊กจะโผล่ตอนลูกค้ากดครั้งแรก
 *   และ RPC ตลาดใบพรีทั้งชุดเป็นด่านจริง (ฝั่งแอปแค่บอกเหตุผล) จึงต้องเทสต์ที่ SQL
 *
 * ของที่ Supabase มีแต่ Postgres เปล่าไม่มี → จำลองขั้นต่ำ: role anon/authenticated/service_role,
 *   auth.users + auth.uid() (อ่าน request.jwt.claim.sub แบบ Supabase), storage.buckets/objects
 * ตัวตน: as(user) = ตั้ง jwt sub เป็น auth_id ของคนนั้น + SET ROLE authenticated (RLS ทำงานจริง)
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** แยก SQL เป็นคำสั่งทีละตัว (เคารพ '…' "…" -- /* *\/ และ $tag$…$tag$) */
export function splitSql(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n2 = src.slice(i, i + 2);
    if (n2 === '--') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; cur += src.slice(i, end); i = end; continue; }
    if (n2 === '/*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; cur += src.slice(i, end); i = end; continue; }
    if (c === "'") { let j = i + 1; while (j < src.length) { if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; } if (src[j] === "'") break; j++; } cur += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === '"') { const e = src.indexOf('"', i + 1); const end = e < 0 ? src.length : e + 1; cur += src.slice(i, end); i = end; continue; }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
      if (m) { const tag = m[0]; const e = src.indexOf(tag, i + tag.length); const end = e < 0 ? src.length : e + tag.length; cur += src.slice(i, end); i = end; continue; }
    }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  // คำสั่งที่มีแต่คอมเมนต์ = ทิ้ง
  return out.filter((s) => s.split('\n').some((l) => l.trim() && !l.trim().startsWith('--')));
}

const STUBS = `
create extension if not exists pgcrypto;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(), email text, phone text, encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false, created_at timestamptz default now());
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
`;

export interface MigrationError { file: string; stmt: string; error: string }

const version = (f: string) => (f === 'schema.sql' ? 0 : Number(/_v(\d+)/.exec(f)?.[1] ?? 9999));

/** สร้างฐานจำลอง + รัน migration ทุกไฟล์ (ข้ามไฟล์ล้างข้อมูล) · คืน error รายคำสั่ง (คำสั่งที่พึ่ง Supabase จริงพังได้ ไม่เป็นไร) */
export async function bootDb(dir: string): Promise<{ db: PGlite; errors: MigrationError[]; files: string[] }> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUBS);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && (f === 'schema.sql' || f.startsWith('migration_')))
    .sort((a, b) => version(a) - version(b) || a.localeCompare(b));
  const errors: MigrationError[] = [];
  for (const f of files) {
    for (const stmt of splitSql(readFileSync(join(dir, f), 'utf8'))) {
      try { await db.exec(stmt); } catch (e) { errors.push({ file: f, stmt: stmt.slice(0, 160).replace(/\s+/g, ' '), error: (e as Error).message }); }
    }
  }
  return { db, errors, files };
}

/** รันในฐานะผู้ใช้คนหนึ่ง (RLS + security definer ทำงานเหมือน Supabase) · null = anon */
export async function asUser<T>(db: PGlite, authId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId ?? ''}', false); set role ${authId ? 'authenticated' : 'anon'};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}

/** เรียก RPC แบบ PostgREST (select fn(args)) คืน json ตัวเดียว */
export async function rpc<T = Record<string, unknown>>(db: PGlite, fn: string, args: unknown[] = []): Promise<T> {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query<{ r: T }>(`select ${fn}(${ph}) as r`, args as unknown[]);
  return r.rows[0]?.r as T;
}
