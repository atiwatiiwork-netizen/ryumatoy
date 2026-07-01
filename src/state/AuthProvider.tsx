'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase, hasSupabase } from '@/data/supabaseClient';
import { useDatabase, useDispatch } from './DataProvider';
import { ensureAuthUser } from '@/data/mutations';
import { CURRENT_USER_ID } from '@/data/seed';

// Facebook accounts (Supabase auth uid) that are shop admins. Override via env.
const ADMIN_IDS = (process.env.NEXT_PUBLIC_ADMIN_IDS ?? '08809e6a-cfd1-4d57-a8f1-06a133bd2df6')
  .split(',').map((s) => s.trim()).filter(Boolean);

interface AuthState {
  currentUserId: string;
  isLoggedIn: boolean;
  isAdmin: boolean; // logged in with an admin Facebook account
  isApproved: boolean; // admin-approved member (legacy/demo users are approved)
  needsApproval: boolean; // logged in but not yet approved by admin
  needsProfile: boolean; // approved but phone/address not captured yet
  signInFacebook: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  currentUserId: CURRENT_USER_ID,
  isLoggedIn: false,
  isAdmin: false,
  isApproved: true,
  needsApproval: false,
  needsProfile: false,
  signInFacebook: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const db = useDatabase();
  const dispatch = useDispatch();
  const [authId, setAuthId] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    const adopt = (session: import('@supabase/supabase-js').Session | null) => {
      const u = session?.user;
      if (!u) { setAuthId(null); return; }
      const m = u.user_metadata ?? {};
      dispatch(ensureAuthUser({
        id: u.id,
        display_name: (m.full_name || m.name || 'ลูกค้าใหม่') as string,
        facebook_id: (m.provider_id || m.sub) as string | undefined,
        avatar_url: (m.avatar_url || m.picture) as string | undefined,
      }));
      setAuthId(u.id);
    };
    supabase.auth.getSession().then(({ data }) => adopt(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => adopt(session));
    return () => sub.subscription.unsubscribe();
  }, [dispatch]);

  // live + not logged in → no current user (anonymous); preview (no supabase) → demo u-me
  const currentUserId = authId ?? (hasSupabase ? '' : CURRENT_USER_ID);
  const me = db.users.find((u) => u.id === currentUserId);
  const isLoggedIn = authId != null;
  const isAdmin = isLoggedIn && ADMIN_IDS.includes(currentUserId);
  const isApproved = !isLoggedIn || isAdmin || me?.approved !== false; // demo/legacy/admin are approved
  const hasProfile = Boolean(me?.phone && me?.shipping_address);
  // flow: login → fill profile FIRST → then wait for admin approval → use (admins skip both)
  const needsProfile = isLoggedIn && !isAdmin && !hasProfile;
  const needsApproval = isLoggedIn && !isAdmin && hasProfile && me?.approved === false;

  const signInFacebook = async () => {
    if (!supabase) return;
    // request public_profile only — the FB app isn't reviewed for `email`, and we don't use it
    await supabase.auth.signInWithOAuth({ provider: 'facebook', options: { redirectTo: window.location.origin + '/profile', scopes: 'public_profile' } });
  };
  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    setAuthId(null);
  };

  return (
    <AuthContext.Provider value={{ currentUserId, isLoggedIn, isAdmin, isApproved, needsApproval, needsProfile, signInFacebook, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
export const useCurrentUserId = () => useContext(AuthContext).currentUserId;
export const canLogin = hasSupabase;
