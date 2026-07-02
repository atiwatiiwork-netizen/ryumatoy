'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, hasSupabase } from '@/data/supabaseClient';
import { useDatabase, useDispatch } from './DataProvider';
import { ensureAuthUser, upsertUserRow } from '@/data/mutations';
import { CURRENT_USER_ID } from '@/data/seed';
import type { User } from '@/domain/entities';

// Admin accounts (Facebook auth uid). Override via env NEXT_PUBLIC_ADMIN_IDS (csv).
const ADMIN_IDS = (process.env.NEXT_PUBLIC_ADMIN_IDS ?? '08809e6a-cfd1-4d57-a8f1-06a133bd2df6')
  .split(',').map((s) => s.trim()).filter(Boolean);
const UID_KEY = 'ryuma_uid';

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
  const [fbId, setFbId] = useState<string | null>(null);
  const [phoneUid, setPhoneUid] = useState<string | null>(null);

  // restore phone+PIN session from localStorage
  useEffect(() => {
    const uid = typeof window !== 'undefined' ? localStorage.getItem(UID_KEY) : null;
    if (uid) setPhoneUid(uid);
  }, []);

  // optional Facebook session (admin uses this)
  useEffect(() => {
    if (!supabase) return;
    const adopt = (session: Session | null) => {
      const u = session?.user;
      if (!u) { setFbId(null); return; }
      const m = u.user_metadata ?? {};
      dispatch(ensureAuthUser({ id: u.id, display_name: (m.full_name || m.name || 'ลูกค้าใหม่') as string, facebook_id: (m.provider_id || m.sub) as string | undefined, avatar_url: (m.avatar_url || m.picture) as string | undefined }));
      setFbId(u.id);
    };
    supabase.auth.getSession().then(({ data }) => adopt(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => adopt(s));
    return () => sub.subscription.unsubscribe();
  }, [dispatch]);

  const currentUserId = fbId ?? phoneUid ?? (hasSupabase ? '' : CURRENT_USER_ID);
  const me = db.users.find((u) => u.id === currentUserId);
  const isLoggedIn = (fbId ?? phoneUid) != null;
  const isAdmin = isLoggedIn && ADMIN_IDS.includes(currentUserId);
  const isApproved = !isLoggedIn || isAdmin || me?.approved !== false;
  // flow: login → (if not approved) wait → (approved) fill address → in
  const needsApproval = isLoggedIn && !isAdmin && me?.approved === false;
  const needsProfile = isLoggedIn && !isAdmin && me?.approved !== false && !me?.shipping_address;

  const injectUser = useCallback(async (uid: string) => {
    if (!supabase) return;
    const { data } = await supabase.from('users').select('*').eq('id', uid).maybeSingle();
    if (data) dispatch(upsertUserRow(data as User));
  }, [dispatch]);

  const loginPhone = useCallback(async (phone: string, pin: string): Promise<RpcResult> => {
    if (!supabase) return { error: 'no_server' };
    const { data, error } = await supabase.rpc('ryuma_login', { p_phone: phone, p_pin: pin });
    const res = (data ?? { error: error?.message ?? 'error' }) as RpcResult;
    if (res.ok && res.user_id) { await injectUser(res.user_id); localStorage.setItem(UID_KEY, res.user_id); setPhoneUid(res.user_id); }
    return res;
  }, [injectUser]);

  const signupPhone = useCallback(async (name: string, phone: string, fb: string, pin: string): Promise<RpcResult> => {
    if (!supabase) return { error: 'no_server' };
    const { data, error } = await supabase.rpc('ryuma_signup', { p_name: name, p_phone: phone, p_fb: fb, p_pin: pin });
    return (data ?? { error: error?.message ?? 'error' }) as RpcResult;
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
    localStorage.removeItem(UID_KEY);
    setPhoneUid(null);
    if (supabase) await supabase.auth.signOut();
    setFbId(null);
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
