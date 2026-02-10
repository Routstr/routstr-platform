"use client";

import { ReactNode, createContext, useContext, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountManager } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { Subject } from "rxjs";
import { ThemeProvider } from "@/components/providers/ThemeProvider";

export interface AccountMetadata {
  name: string;
}

const accountManager = new AccountManager<unknown>();
registerCommonAccountTypes(accountManager);
const manualSave = new Subject<void>();

interface AccountContextValue {
  manager: AccountManager<unknown>;
  manualSave: Subject<void>;
}

const AccountContext = createContext<AccountContextValue>({
  manager: accountManager,
  manualSave,
});

export const useAccountManager = () => useContext(AccountContext);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60_000,
      gcTime: Infinity,
    },
  },
});

export default function ClientProviders({ children }: { children: ReactNode }) {
  useEffect(() => {
    const savedAccounts = JSON.parse(localStorage.getItem("accounts") || "[]");
    accountManager.fromJSON(savedAccounts);

    const activeAccountId = localStorage.getItem("activeAccount");
    if (activeAccountId) {
      const account = accountManager.getAccount(activeAccountId);
      if (account) accountManager.setActive(account);
    }

    const accountSub = accountManager.accounts$.subscribe(() => {
      localStorage.setItem("accounts", JSON.stringify(accountManager.toJSON()));
    });

    const activeSub = accountManager.active$.subscribe((account) => {
      if (account) {
        localStorage.setItem("activeAccount", account.id);
      } else {
        localStorage.removeItem("activeAccount");
      }
    });

    const manualSub = manualSave.subscribe(() => {
      localStorage.setItem("accounts", JSON.stringify(accountManager.toJSON()));
    });

    return () => {
      accountSub.unsubscribe();
      activeSub.unsubscribe();
      manualSub.unsubscribe();
    };
  }, []);

  return (
    <AccountContext.Provider value={{ manager: accountManager, manualSave }}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </ThemeProvider>
    </AccountContext.Provider>
  );
}
