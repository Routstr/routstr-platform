"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound } from "lucide-react";
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

type PlatformTab = "home" | "playground" | "api-keys" | "wallet";

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

  const hasEndpointKey = endpointScopedKeys.length > 0;
  const hasFundedEndpointKey = endpointScopedKeys.some(
    (keyData) =>
      typeof keyData.balance === "number" && keyData.balance > 0 && !keyData.isInvalid
  );

  const heroSummary = !hasEndpointKey
    ? "Add an API key for this endpoint to start."
    : !hasFundedEndpointKey
      ? "A key exists, but balance is empty. Top up before sending requests."
      : "Setup is ready. Continue in Playground.";

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
    <div className="space-y-5">
      <Card className="relative gap-0 overflow-hidden p-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.12),transparent_48%),radial-gradient(circle_at_bottom_left,rgba(16,185,129,0.10),transparent_44%)]" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Home</h1>
            <p className="text-sm text-muted-foreground">{heroSummary}</p>
            <p className="text-xs text-muted-foreground">Endpoint: {normalizedBaseUrl}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={primaryAction} type="button">
              <KeyRound className="h-4 w-4" />
              {primaryActionLabel}
            </Button>
            <Button
              onClick={() => navigateToTab("api-keys")}
              variant="secondary"
              type="button"
            >
              Open API Keys
            </Button>
          </div>
        </div>
      </Card>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">API keys</p>
          <p className="mt-1 text-lg font-semibold">{storedApiKeys.length}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Endpoint keys</p>
          <p className="mt-1 text-lg font-semibold">{endpointScopedKeys.length}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Funded keys</p>
          <p className="mt-1 text-lg font-semibold">{fundedKeyCount}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Invalid keys</p>
          <p className="mt-1 text-lg font-semibold">{invalidKeyCount}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Total key balance</p>
          <p className="mt-1 text-lg font-semibold">
            {(totalKeyBalanceMsats / 1000).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}{" "}
            sats
          </p>
        </div>
      </section>
    </div>
  );
}
