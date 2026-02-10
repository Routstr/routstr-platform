"use client";

import { createContext, useContext } from "react";
import { useAuthState, UseAuthStateReturn } from "@/hooks/useAuthState";

const AuthContext = createContext<UseAuthStateReturn | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const authState = useAuthState();
  return <AuthContext.Provider value={authState}>{children}</AuthContext.Provider>;
}
