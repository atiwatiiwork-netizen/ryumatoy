'use client';

import { createContext, useContext, useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import type { Session, User as SupaUser } from '@supabase/supabase-js';
import { supabase, hasSupabase } from '@/data/supabaseClient';
import { store } from '@/data/store';
import { useDatabase, useDispatch } from './DataProvider';
import { ensureAuthUser } from '@/data/mutations';
import { CURRENT_USER_ID } from '@/data/seed';
import { notifyAdminLine } from '@/lib/notify';

// Admin accounts (Facebook auth uid). Override via env NEXT_PUBLIC_ADMIN_IDS (csv).
const ADMIN_IDS = (process.env.NEXT_PUBLIC_ADMIN_IDS ?? '08809e6a-cfd1-4d57-a8f1-06a133bd2df6')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Customer accounts are Supabase Auth users with a synthetic email built from the
// phone number. The PIN is the password. This email is never sent anything.
const emailFor = (phone: string) => `${phone.replace(/\D/g, '')}@ryuma.local`;
const isFacebook = (u: SupaUser | null) => u?.app_metadata?.provider === 'facebook';

export type RpcResult = { ok?: boolean; error?: string; user_id?: string; member_code?: string; until?: string };

interface AuthState {
  currentUserId: string;
  isLoggedIn: boolean;
  isAdmin: boolean;
  isApproved: boolean;
  authReady: boolean; // false until the first session restore completes (avoids login flash on refresh)
  needsApproval: boolean;
  needsProfile: boolean;
  signInFacebook: () => Promise<void>;
  signupPhone: (name: string, phone: string, fb: string, pin: string) => Promise<RpcResult>;
  loginPhone: (phone: string, pin: string) => Promise<RpcResult>;
  setNewPin: (phone: string, pin: string) => Promise<RpcResult>;
  signOut: () => Promise<void>;
}

const noop = async (): Promise<RpcResult> => ({ error: 'no_server' });
const AuthContext = createContext<AuthState>({
  currentUserId: CURRENT_USER_ID, isLoggedIn: false, isAdmin: false, isApproved: true, authReady: true,
  needsApproval: false, needsProfile: false,
  signInFacebook: async () => {}, signupPhone: noop, loginPhone: noop, setNewPin: noop, signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const [authUser, setAuthUser] = useState<SupaUser | null>(null);
  const [appUserId, setAppUserId] = useState<string | null>(null);
  const [ready, setReady] = useState(!hasSupabase); // demo (no backend) is ready at once
  const prevUid = useRef<string | null>(null);
  const signingUp = useRef(false); // block adopt() auto-provision while our own signup is creating the row

  // Map a Supabase Auth session to the app users.id. FB admin: users.id = auth uid.
  // Phone customer: users row linked via auth_id.
  const resolveAppUser = useCallback(async (u: SupaUser | null): Promise<string | null> => {
    if (!supabase || !u) return null;
    if (isFacebook(u)) return u.id;
    // TIMEOUT-bounded: on a resume with a dead socket a fetch can hang forever without erroring —
    // an un-bounded await here froze the identity retry loop on its first attempt (customer stuck on
    // "กำลังโหลดบัญชี" until force-close). Time out → null → caller retries / local fallback covers.
    try {
      const q = supabase.from('users').select('id').eq('auth_id', u.id).maybeSingle();
      const { data } = await Promise.race([
        q,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('resolve timed out')), 8000)),
      ]);
      return (data?.id as string | undefined) ?? null;
    } catch {
      return null;
    }
  }, []);

  // One unified session handler for both Facebook (admin) and phone+PIN (customer).
  useEffect(() => {
    if (!supabase) return;
    let settled = false;
    const finishReady = () => { if (!settled) { settled = true; setReady(true); } };
    // FAIL-SAFE against the "resume hang": when a backgrounded PWA is discarded by the OS and reopened,
    // the page reloads and restores the session over a possibly-stalled network. If getSession/adopt
    // hangs, the loading screen would spin forever (customer must force-close + reopen). So: (1) clear
    // the spinner as soon as the session is KNOWN — before the heavier user-row + store loads — and
    // (2) a 6s watchdog clears it no matter what. Data/identity fill in via the background reload.
    const watchdog = setTimeout(finishReady, 6000);

    const adopt = async (session: Session | null) => {
      const u = session?.user ?? null;
      setAuthUser(u);
      finishReady(); // session resolved → render the app now; the loads below run in the background
      if (isFacebook(u) && u) {
        const m = u.user_metadata ?? {};
        dispatch(ensureAuthUser({ id: u.id, display_name: (m.full_name || m.name || 'ลูกค้าใหม่') as string, facebook_id: (m.provider_id || m.sub) as string | undefined, avatar_url: (m.avatar_url || m.picture) as string | undefined }));
      }
      try {
        // Don't clobber a known id with null: right after signUp the session exists
        // but the linked users row may be written a beat later (signup_v2/link_auth).
        let r1 = await resolveAppUser(u);
        // self-heal: a valid session that resolves to nothing means users.auth_id was
        // never linked (e.g. logged in during the v21-before-v23 window) → the app would
        // hang forever. Link it by the phone in the synthetic email, then re-resolve.
        if (u && !isFacebook(u) && !r1 && !signingUp.current) {
          try { await supabase?.rpc('ryuma_link_self'); } catch { /* RPC may not exist yet */ }
          r1 = await resolveAppUser(u);
        }
        if (r1 || !u) setAppUserId(r1);
        // reload the store only when the identity actually changes (not on token refresh)
        const uid = u?.id ?? null;
        if (uid !== prevUid.current) {
          prevUid.current = uid;
          await store.reload();
          if (u) { const r2 = await resolveAppUser(u); if (r2) setAppUserId(r2); } // row may have just appeared
        }
      } catch (err) {
        console.error('[auth] adopt failed (app still usable; data will refresh)', err);
      }
    };
    supabase.auth.getSession().then(({ data }) => adopt(data.session)).catch(finishReady).finally(finishReady);
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => adopt(s));
    return () => { clearTimeout(watchdog); sub.subscription.unsubscribe(); };
  }, [dispatch, resolveAppUser]);

  // SELF-HEAL the "กำลังโหลดบัญชี…" hang at its ROOT: the session restored (authUser set) but our
  // app-user id never resolved — resolveAppUser's network call stalled on a resume, so currentUserId
  // stays '' and `me` is undefined forever (products loaded fine, only identity is missing → the overlay
  // hangs until the user force-closes + reopens). adopt() runs once per auth event and doesn't retry, so
  // re-resolve here on a short loop until the id lands. (ryuma-bugs: resume stuck loading account)
  useEffect(() => {
    if (!supabase || !authUser || appUserId) return;
    let cancelled = false, tries = 0;
    const run = async () => {
      if (cancelled || tries >= 6) return;
      tries++;
      try {
        let r = await resolveAppUser(authUser);
        if (!r && !isFacebook(authUser) && !signingUp.current) {
          try { await supabase!.rpc('ryuma_link_self'); } catch { /* RPC may not exist */ }
          r = await resolveAppUser(authUser);
        }
        if (r) { await store.reload(); if (!cancelled) setAppUserId((await resolveAppUser(authUser)) || r); return; }
      } catch { /* network flake → retry below */ }
      if (!cancelled) setTimeout(run, 2000);
    };
    const t = setTimeout(run, 900);
    return () => { cancelled = true; clearTimeout(t); };
  }, [authUser, appUserId, resolveAppUser]);

  // LOCAL identity fallback (ZERO network): once the store's session-aware load holds our own users
  // row, the app-user id is derivable straight from db (auth_id ↔ session uid; FB admin: users.id =
  // auth uid). This makes the overlay independent of any hanging fetch — the store recovers by its own
  // timeout+poll (products appear), and identity then resolves instantly from memory. (resume hang #4)
  const localAppUserId = authUser
    ? (db.users.find((u) => u.auth_id === authUser.id)?.id ?? (isFacebook(authUser) ? authUser.id : undefined))
    : undefined;
  // solidify the local resolution into state so effects keyed on appUserId settle too
  useEffect(() => {
    if (!appUserId && localAppUserId) setAppUserId(localAppUserId);
  }, [appUserId, localAppUserId]);

  const currentUserId = appUserId ?? localAppUserId ?? (hasSupabase ? '' : CURRENT_USER_ID);
  const me = db.users.find((u) => u.id === currentUserId);
  const isLoggedIn = authUser != null;
  const isAdmin = isLoggedIn && (ADMIN_IDS.includes(currentUserId) || me?.is_admin === true);
  const isApproved = !isLoggedIn || isAdmin || me?.approved !== false;
  // flow: login → (if not approved) wait → (approved) fill address → in.
  // Gate on `me != null`: while the logged-in user's own row is still loading, don't
  // flash the wrong gate (needsProfile would otherwise default true when me is undefined).
  const needsApproval = isLoggedIn && !isAdmin && me != null && me.approved === false;
  const needsProfile = isLoggedIn && !isAdmin && me != null && me.approved !== false && !me.shipping_address;

  const loginPhone = useCallback(async (phone: string, pin: string): Promise<RpcResult> => {
    if (!supabase) return { error: 'no_server' };
    const email = emailFor(phone);
    const { data: si, error: siErr } = await supabase.auth.signInWithPassword({ email, password: pin });
    if (!siErr && si.user) return { ok: true, user_id: si.user.id }; // adopt() finishes the rest

    // sign-in failed → user may predate Supabase Auth. Verify via the legacy bcrypt
    // path, and if that passes, lazily create the Auth account with the same PIN.
    const { data: leg } = await supabase.rpc('ryuma_login', { p_phone: phone, p_pin: pin });
    const lr = (leg ?? {}) as RpcResult;
    if (!lr.ok || !lr.user_id) return lr.error ? lr : { error: 'wrong_pin' };

    const { data: su, error: suErr } = await supabase.auth.signUp({ email, password: pin });
    if (suErr) return /already/i.test(suErr.message) ? { error: 'wrong_pin' } : { error: suErr.message };
    if (su.user) await supabase.rpc('ryuma_link_auth', { p_user_id: lr.user_id, p_auth_id: su.user.id });
    setAppUserId(lr.user_id); // we know the app id now — beat the adopt() race
    await store.reload();     // row is committed+linked now → make sure the store has it
    return { ok: true, user_id: lr.user_id };
  }, []);

  const signupPhone = useCallback(async (name: string, phone: string, fb: string, pin: string): Promise<RpcResult> => {
    if (!supabase) return { error: 'no_server' };
    if ((pin || '').length !== 6) return { error: 'bad_pin' };
    const email = emailFor(phone);
    signingUp.current = true; // stop adopt() from auto-provisioning a nameless row underneath us
    try {
      const { data: su, error: suErr } = await supabase.auth.signUp({ email, password: pin });
      if (suErr) return /already/i.test(suErr.message) ? { error: 'phone_taken' } : { error: suErr.message };
      if (!su.session || !su.user) return { error: 'confirm_email_on' }; // Supabase "Confirm email" must be OFF
      const authId = su.user.id;
      // With signingUp guarding adopt(), no auto-provision races us → this inserts the row with the
      // real name + FB. v34 makes the RPC also self-heal a provisioned row if one ever slips through.
      const { data, error } = await supabase.rpc('ryuma_signup_v2', { p_name: name, p_phone: phone, p_fb: fb, p_auth_id: authId });
      const res = (data ?? { error: error?.message ?? 'error' }) as RpcResult;
      if (res.ok && res.user_id) {
        setAppUserId(res.user_id);
        notifyAdminLine(`👤 สมัครสมาชิกใหม่รออนุมัติ: ${name} · ${phone}`); // ping the owner's LINE
        await store.reload();
      }
      return res;
    } finally {
      signingUp.current = false;
    }
  }, []);

  const setNewPin = useCallback(async (phone: string, pin: string): Promise<RpcResult> => {
    if (!supabase) return { error: 'no_server' };
    const { data, error } = await supabase.rpc('ryuma_set_new_pin', { p_phone: phone, p_new_pin: pin });
    return (data ?? { error: error?.message ?? 'error' }) as RpcResult;
  }, []);

  const signInFacebook = async () => {
    if (!supabase) return;
    await supabase.auth.signInWithOAuth({ provider: 'facebook', options: { redirectTo: window.location.origin + '/profile', scopes: 'public_profile' } });
  };
  const signOut = async () => {
    // WEDGED-CLIENT SAFE: never await the auth client — on a bad resume its internal lock can deadlock
    // and signOut() hangs forever (observed live: the logout button "did nothing"). Fire it best-effort
    // with a short race, then clear the persisted session OURSELVES so the logout always sticks.
    if (supabase) {
      try { await Promise.race([supabase.auth.signOut(), new Promise((r) => setTimeout(r, 1500))]); } catch { /* hung/failed — storage clear below still logs out */ }
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.includes('-auth-token')) localStorage.removeItem(k);
      }
    } catch { /* private mode */ }
    setAuthUser(null);
    setAppUserId(null);
  };

  return (
    <AuthContext.Provider value={{ currentUserId, isLoggedIn, isAdmin, isApproved, authReady: ready, needsApproval, needsProfile, signInFacebook, signupPhone, loginPhone, setNewPin, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
export const useCurrentUserId = () => useContext(AuthContext).currentUserId;
export const canLogin = hasSupabase;
