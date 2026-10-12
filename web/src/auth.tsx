import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { API } from "./lib/endpoints";
import type { Role, User } from "./types";

/** The two roles, by name. */
export const ROLE = { admin: "admin", manager: "manager" } as const satisfies Record<Role, Role>;

/** Roles in the order the user form offers them. */
export const ROLES: readonly Role[] = [ROLE.manager, ROLE.admin];

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ user: User }>(API.me)
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    const r = await api.post<{ user: User }>(API.login, { username, password });
    setUser(r.user);
  };

  const logout = async () => {
    await api.post(API.logout);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setUser }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** Whether the signed-in user is an admin (false while signed out). */
export function useIsAdmin(): boolean {
  return useAuth().user?.role === ROLE.admin;
}
