"use client";

import { useEffect, useMemo, useState } from "react";
import { Code2, KeyRound, Network, Wallet } from "lucide-react";
import { DEFAULT_BASE_URL } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type StoredApiKey = {
  key: string;
  balance: number | null;
  label?: string;
  baseUrl?: string;
  isInvalid?: boolean;
};

type PlatformTab = "home" | "nodes" | "playground" | "api-keys" | "wallet";

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function isOnionUrl(url: string): boolean {
  if (!url) return false;
  try {
    const normalized = /^https?:\/\//.test(url) ? url : `http://${url}`;
    return new URL(normalized).hostname.endsWith(".onion");
  } catch {
    return url.includes(".onion");
  }
}

function parseStoredApiKeys(raw: string | null): StoredApiKey[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is StoredApiKey =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as StoredApiKey).key === "string"
      )
      .map((item) => ({
        key: item.key,
        balance:
          typeof item.balance === "number" && Number.isFinite(item.balance)
            ? item.balance
            : null,
        label: typeof item.label === "string" ? item.label : undefined,
        baseUrl: typeof item.baseUrl === "string" ? item.baseUrl : undefined,
        isInvalid: Boolean(item.isInvalid),
      }));
  } catch {
    return [];
  }
}

function readApiKeysFromStorage(): StoredApiKey[] {
  if (typeof window === "undefined") return [];
  return parseStoredApiKeys(localStorage.getItem("api_keys"));
}

function navigateToTab(tab: PlatformTab): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("platform:navigate-tab", {
      detail: { tab },
    })
  );
}

function formatSats(msats: number): string {
  return (msats / 1000).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function maskApiKey(key: string): string {
  if (!key) return "-";
  if (key.length <= 16) return key;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

export default function DeveloperHome({ baseUrl }: { baseUrl: string }) {
  const normalizedBaseUrl = useMemo(() => {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized || isOnionUrl(normalized)) {
      return DEFAULT_BASE_URL.replace(/\/+$/, "");
    }
    return normalized;
  }, [baseUrl]);

  const [storedApiKeys, setStoredApiKeys] = useState<StoredApiKey[]>([]);

  useEffect(() => {
    const refreshStorageState = () => {
      setStoredApiKeys(readApiKeysFromStorage());
    };

    refreshStorageState();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshStorageState();
      }
    };

    window.addEventListener("storage", refreshStorageState);
    window.addEventListener("platform-api-keys-updated", refreshStorageState);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("storage", refreshStorageState);
      window.removeEventListener("platform-api-keys-updated", refreshStorageState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const endpointScopedKeys = useMemo(() => {
    return storedApiKeys.filter((keyData) => {
      const keyBase = normalizeBaseUrl(keyData.baseUrl || normalizedBaseUrl);
      return keyBase === normalizedBaseUrl;
    });
  }, [normalizedBaseUrl, storedApiKeys]);

  const fundedKeyCount = useMemo(() => {
    return storedApiKeys.filter(
      (keyData) =>
        typeof keyData.balance === "number" && keyData.balance > 0 && !keyData.isInvalid
    ).length;
  }, [storedApiKeys]);

  const invalidKeyCount = useMemo(() => {
    return storedApiKeys.filter((keyData) => Boolean(keyData.isInvalid)).length;
  }, [storedApiKeys]);

  const totalKeyBalanceMsats = useMemo(() => {
    return storedApiKeys.reduce((sum, keyData) => {
      if (typeof keyData.balance !== "number" || !Number.isFinite(keyData.balance)) {
        return sum;
      }
      return sum + keyData.balance;
    }, 0);
  }, [storedApiKeys]);

  const sortedEndpointKeys = useMemo(() => {
    return [...endpointScopedKeys].sort((a, b) => {
      if (Boolean(a.isInvalid) !== Boolean(b.isInvalid)) {
        return a.isInvalid ? 1 : -1;
      }

      const aBalance =
        typeof a.balance === "number" && Number.isFinite(a.balance) ? a.balance : 0;
      const bBalance =
        typeof b.balance === "number" && Number.isFinite(b.balance) ? b.balance : 0;
      return bBalance - aBalance;
    });
  }, [endpointScopedKeys]);

  const endpointKeyPreview = sortedEndpointKeys.slice(0, 5);

  const hasEndpointKey = endpointScopedKeys.length > 0;
  const hasFundedEndpointKey = endpointScopedKeys.some(
    (keyData) =>
      typeof keyData.balance === "number" && keyData.balance > 0 && !keyData.isInvalid
  );

  const heroSummary = "Overview and quick actions for your active endpoint.";

  const primaryActionLabel = !hasEndpointKey
    ? "Create API key"
    : !hasFundedEndpointKey
      ? "Top up key"
      : "Open Playground";

  const primaryAction = () => {
    if (!hasEndpointKey || !hasFundedEndpointKey) {
      navigateToTab("api-keys");
      return;
    }
    navigateToTab("playground");
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card className="relative gap-0 overflow-hidden p-4 sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.12),transparent_48%),radial-gradient(circle_at_bottom_left,rgba(16,185,129,0.10),transparent_44%)]" />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
          <div className="max-w-3xl space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Home</h1>
            <p className="text-sm text-muted-foreground">{heroSummary}</p>
          </div>
          <div className="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap">
            <Button
              onClick={primaryAction}
              variant="outline"
              className="w-full justify-center sm:w-auto sm:justify-start"
              type="button"
            >
              <KeyRound className="h-4 w-4" />
              {primaryActionLabel}
            </Button>
            <Button
              onClick={() => navigateToTab("api-keys")}
              variant="outline"
              className="w-full justify-center sm:w-auto sm:justify-start"
              type="button"
            >
              Open API Keys
            </Button>
          </div>
        </div>
      </Card>

      <section className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-5">
        <div className="rounded-xl border border-border/70 bg-card p-3 sm:p-3.5">
          <p className="text-xs text-muted-foreground">API keys</p>
          <p className="mt-1 text-base font-semibold sm:text-lg">{storedApiKeys.length}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3 sm:p-3.5">
          <p className="text-xs text-muted-foreground">Endpoint keys</p>
          <p className="mt-1 text-base font-semibold sm:text-lg">{endpointScopedKeys.length}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3 sm:p-3.5">
          <p className="text-xs text-muted-foreground">Funded keys</p>
          <p className="mt-1 text-base font-semibold sm:text-lg">{fundedKeyCount}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3 sm:p-3.5">
          <p className="text-xs text-muted-foreground">Invalid keys</p>
          <p className="mt-1 text-base font-semibold sm:text-lg">{invalidKeyCount}</p>
        </div>
        <div className="col-span-2 rounded-xl border border-border/70 bg-card p-3 sm:p-3.5 xl:col-span-1">
          <p className="text-xs text-muted-foreground">Total key balance</p>
          <p className="mt-1 text-base font-semibold sm:text-lg">
            {(totalKeyBalanceMsats / 1000).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}{" "}
            sats
          </p>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card className="gap-0 border-border/70 bg-card p-3.5 sm:p-4">
          <div className="mb-3">
            <h2 className="text-base font-semibold tracking-tight">Quick Actions</h2>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => navigateToTab("playground")}
              variant="outline"
              className="h-10 justify-start gap-2"
              type="button"
            >
              <Code2 className="h-4 w-4" />
              Playground
            </Button>
            <Button
              onClick={() => navigateToTab("api-keys")}
              variant="outline"
              className="h-10 justify-start gap-2"
              type="button"
            >
              <KeyRound className="h-4 w-4" />
              API Keys
            </Button>
            <Button
              onClick={() => navigateToTab("nodes")}
              variant="outline"
              className="h-10 justify-start gap-2"
              type="button"
            >
              <Network className="h-4 w-4" />
              Nodes
            </Button>
            <Button
              onClick={() => navigateToTab("wallet")}
              variant="outline"
              className="h-10 justify-start gap-2"
              type="button"
            >
              <Wallet className="h-4 w-4" />
              Wallet
            </Button>
          </div>
        </Card>

        <Card className="gap-0 border-border/70 bg-card p-3.5 sm:p-4">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-tight">Endpoint Keys</h2>
              <p className="text-xs text-muted-foreground">
                {endpointScopedKeys.length} key{endpointScopedKeys.length === 1 ? "" : "s"} on
                this endpoint
              </p>
            </div>
            <Button
              onClick={() => navigateToTab("api-keys")}
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              type="button"
            >
              View all
            </Button>
          </div>

          {endpointKeyPreview.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-4 text-xs text-muted-foreground">
              No API keys found for this endpoint yet.
            </div>
          ) : (
            <div className="space-y-2">
              {endpointKeyPreview.map((keyData) => {
                const keyBalanceMsats =
                  typeof keyData.balance === "number" && Number.isFinite(keyData.balance)
                    ? keyData.balance
                    : 0;
                const statusLabel = keyData.isInvalid
                  ? "Invalid"
                  : keyBalanceMsats > 0
                    ? "Funded"
                    : "Empty";

                return (
                  <div
                    key={keyData.key}
                    className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {keyData.label?.trim() || "API key"}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {maskApiKey(keyData.key)}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{statusLabel}</span>
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {formatSats(keyBalanceMsats)} sats
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
