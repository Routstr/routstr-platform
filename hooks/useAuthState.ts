"use client";

import { useCallback, useEffect, useState } from "react";
import { useObservableState } from "applesauce-react/hooks";
import { useAccountManager } from "@/components/providers/ClientProviders";

export interface UseAuthStateReturn {
  isAuthenticated: boolean;
  authChecked: boolean;
  logout: () => Promise<void>;
}

export function useAuthState(): UseAuthStateReturn {
  const { manager } = useAccountManager();
  const accounts = useObservableState(manager.accounts$) || [];
  const [authChecked, setAuthChecked] = useState(false);

  const isAuthenticated = accounts.length > 0;

  const logout = useCallback(async () => {
    const allAccounts = manager.accounts$.value;
    for (const account of allAccounts) {
      manager.removeAccount(account.id);
    }
    localStorage.removeItem("accounts");
    localStorage.removeItem("activeAccount");
  }, [manager]);

  useEffect(() => {
    setAuthChecked(true);
  }, []);

  return {
    isAuthenticated,
    authChecked,
    logout,
  };
}
