import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthResponse, UserDTO } from '@messenger/shared';
import { apiGet, apiPost } from './api';
import { connectSocket, disconnectSocket } from './socket';

interface AuthContextValue {
  user: UserDTO | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    apiGet<AuthResponse>('/api/auth/me')
      .then((res) => {
        if (!cancelled) setUser(res.user);
      })
      .catch(() => {
        // A 401 (not logged in) is the expected default state, not an error;
        // any other failure also just leaves the visitor logged out.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Real-time lifecycle: hold a live socket exactly while a user is signed in.
  // Connecting only after `user` is set guarantees the session cookie exists for
  // the handshake; the cleanup disconnects on logout (user -> null).
  useEffect(() => {
    if (!user) return;
    connectSocket();
    return () => {
      disconnectSocket();
    };
  }, [user]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiPost<AuthResponse>('/api/auth/login', { email, password });
    setUser(res.user);
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    const res = await apiPost<AuthResponse>('/api/auth/register', { email, password, displayName });
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    await apiPost<void>('/api/auth/logout');
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
