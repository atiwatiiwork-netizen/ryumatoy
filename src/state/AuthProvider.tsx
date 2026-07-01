'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase, hasSupabase } from '@/data/supabaseClient';
import { useDatabase, useDispatch } from './DataProvider';
import { ensureAuthUser } from '@/data/mutations';
import { CURRENT_USER_ID } from '@/data/seed';

interface AuthState {
  currentUserId: string;
  isLoggedIn: boolean;
  isApproved: boolean; // admin-approved member (legacy/demo users are approved)
  needsApproval: boolean; // logged in but not yet approved by admin
  needsProfile: boolean; // approved but phone/address not captured yet
  signInFacebook: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  currentUserId: CURRENT_USER_ID,
  isLoggedIn: false,
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

  const currentUserId = authId ?? CURRENT_USER_ID;
  const me = db.users.find((u) => u.id === currentUserId);
  const isLoggedIn = authId != null;
  const isApproved = !isLoggedIn || me?.approved !== false; // demo/legacy users are approved
  const needsApproval = isLoggedIn && me?.approved === false;
  const needsProfile = isLoggedIn && isApproved && !(me?.phone && me?.shipping_address);

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
    <AuthContext.Provider value={{ currentUserId, isLoggedIn, isApproved, needsApproval, needsProfile, signInFacebook, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
export const useCurrentUserId = () => useContext(AuthContext).currentUserId;
export const canLogin = hasSupabase;
