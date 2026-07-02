'use client';

import { createContext, useContext, useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import type { Session, User as SupaUser } from '@supabase/supabase-js';
import { supabase, hasSupabase } from '@/data/supabaseClient';
import { store } from '@/data/store';
import { useDatabase, useDispatch } from './DataProvider';
import { ensureAuthUser } from '@/data/mutations';
import { CURRENT_USER_ID } from '@/data/seed';

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
  currentUserId: CURRENT_USER_ID, isLoggedIn: false, isAdmin: false, isApproved: true,
  needsApproval: false, needsProfile: false,
  signInFacebook: async () => {}, signupPhone: noop, loginPhone: noop, setNewPin: noop, signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const [authUser, setAuthUser] = useState<SupaUser | null>(null);
  const [appUserId, setAppUserId] = useState<string | null>(null);
  const prevUid = useRef<string | null>(null);

  // Map a Supabase Auth session to the app users.id. FB admin: users.id = auth uid.
  // Phone customer: users row linked via auth_id.
  const resolveAppUser = useCallback(async (u: SupaUser | null): Promise<string | null> => {
    if (!supabase || !u) return null;
    if (isFacebook(u)) return u.id;
    const { data } = await supabase.from('users').select('id').eq('auth_id', u.id).maybeSingle();
    return (data?.id as string | undefined) ?? null;
  }, []);

  // One unified session handler for both Facebook (admin) and phone+PIN (customer).
  useEffect(() => {
    if (!supabase) return;
    const adopt = async (session: Session | null) => {
      const u = session?.user ?? null;
      setAuthUser(u);
      if (isFacebook(u) && u) {
        const m = u.user_metadata ?? {};
        dispatch(ensureAuthUser({ id: u.id, display_name: (m.full_name || m.name || 'ลูกค้าใหม่') as string, facebook_id: (m.provider_id || m.sub) as string | undefined, avatar_url: (m.avatar_url || m.picture) as string | undefined }));
      }
      // Don't clobber a known id with null: right after signUp the session exists
      // but the linked users row may be written a beat later (signup_v2/link_auth).
      const r1 = await resolveAppUser(u);
      if (r1 || !u) setAppUserId(r1);
      // reload the store only when the identity actually changes (not on token refresh)
      const uid = u?.id ?? null;
      if (uid !== prevUid.current) {
        prevUid.current = uid;
        await store.reload();
        if (u) { const r2 = await resolveAppUser(u); if (r2) setAppUserId(r2); } // row may have just appeared
      }
    };
    supabase.auth.getSession().then(({ data }) => adopt(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => adopt(s));
    return () => sub.subscription.unsubscribe();
  }, [dispatch, resolveAppUser]);

  const currentUserId = appUserId ?? (hasSupabase ? '' : CURRENT_USER_ID);
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
    const { data: su, error: suErr } = await supabase.auth.signUp({ email, password: pin });
    if (suErr) return /already/i.test(suErr.message) ? { error: 'phone_taken' } : { error: suErr.message };
    if (!su.session || !su.user) return { error: 'confirm_email_on' }; // Supabase "Confirm email" must be OFF
    const { data, error } = await supabase.rpc('ryuma_signup_v2', { p_name: name, p_phone: phone, p_fb: fb, p_auth_id: su.user.id });
    const res = (data ?? { error: error?.message ?? 'error' }) as RpcResult;
    if (res.ok && res.user_id) {
      setAppUserId(res.user_id);   // beat the adopt() race
      await store.reload();        // row is committed now → make sure the store has it
    }
    return res;
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
    if (supabase) await supabase.auth.signOut();
    setAuthUser(null);
    setAppUserId(null);
  };

  return (
    <AuthContext.Provider value={{ currentUserId, isLoggedIn, isAdmin, isApproved, needsApproval, needsProfile, signInFacebook, signupPhone, loginPhone, setNewPin, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
export const useCurrentUserId = () => useContext(AuthContext).currentUserId;
export const canLogin = hasSupabase;
