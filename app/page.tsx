"use client";

import { useEffect, useRef, useState } from "react";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthProvider";
import LoginMethodsCard from "@/components/auth/LoginMethodsCard";
import PlatformShell from "@/components/platform/PlatformShell";
import {
  useAccountManager,
  type AccountMetadata,
} from "@/components/providers/ClientProviders";
import { DEFAULT_BASE_URL } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type StoredApiKey = {
  key: string;
  balance: number | null;
  label?: string;
  baseUrl?: string;
  isInvalid?: boolean;
};

type DirectoryProvider = {
  endpoint_url?: string;
  endpoint_urls?: string[];
  http_url?: string;
  onion_url?: string;
  onion_urls?: string[];
};

type KeyProbeResult =
  | {
      status: "valid";
      endpoint: string;
      apiKey: string;
      balance: number | null;
    }
  | {
      status: "invalid";
      endpoint: string;
    }
  | {
      status: "error";
      endpoint: string;
    };

const API_KEYS_STORAGE_KEY = "api_keys";
const BASE_URLS_LIST_STORAGE_KEY = "base_urls_list";
const PROVIDER_MODELS_STORAGE_KEY = "modelsFromAllProviders";
const LOGIN_DIALOG_PARAM_NAME = "login";
const API_KEY_PARAM_NAMES = ["apikey", "api_key"] as const;
const BASE_URL_PARAM_NAMES = ["endpoint", "base_url", "baseurl", "baseUrl"] as const;
const LABEL_PARAM_NAMES = ["label", "api_label", "apiLabel"] as const;

function getFirstParam(
  params: URLSearchParams,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null) return value;
  }
  return null;
}

function deleteParams(params: URLSearchParams, keys: readonly string[]): void {
  for (const key of keys) {
    params.delete(key);
  }
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
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

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;
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

function shouldAllowHttp(url: string): boolean {
  return !url.startsWith("http://");
}

function resolveImportBaseUrl(candidate: string | null): string {
  if (!candidate) return DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(candidate);
  if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) {
    return DEFAULT_BASE_URL;
  }
  return normalized;
}

function getProviderEndpoints(provider: DirectoryProvider): string[] {
  const rawUrls: (string | undefined)[] = [
    provider.endpoint_url,
    ...(Array.isArray(provider.endpoint_urls) ? provider.endpoint_urls : []),
    provider.http_url,
    provider.onion_url,
    ...(Array.isArray(provider.onion_urls) ? provider.onion_urls : []),
  ];

  const seen = new Set<string>();
  const endpoints: string[] = [];

  for (const candidate of rawUrls) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    endpoints.push(normalized);
  }

  return endpoints;
}

function readKnownEndpointsFromStorage(): string[] {
  if (typeof window === "undefined") return [DEFAULT_BASE_URL];

  const endpoints = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) {
      return;
    }
    endpoints.add(normalized);
  };

  add(DEFAULT_BASE_URL);
  add(localStorage.getItem("platform_active_base_url"));

  const baseUrlsList = safeJsonParse<unknown[]>(
    localStorage.getItem(BASE_URLS_LIST_STORAGE_KEY),
    []
  );
  for (const item of baseUrlsList) {
    add(item);
  }

  const modelsByProvider = safeJsonParse<Record<string, unknown>>(
    localStorage.getItem(PROVIDER_MODELS_STORAGE_KEY),
    {}
  );
  for (const key of Object.keys(modelsByProvider)) {
    add(key);
  }

  const keys = parseStoredApiKeys(localStorage.getItem(API_KEYS_STORAGE_KEY));
  for (const item of keys) {
    add(item.baseUrl);
  }

  return Array.from(endpoints).sort((a, b) => a.localeCompare(b));
}

async function fetchDirectoryEndpoints(): Promise<string[]> {
  try {
    const response = await fetch("https://api.routstr.com/v1/providers/", {
      cache: "no-store",
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { providers?: DirectoryProvider[] };
    const providers = Array.isArray(payload.providers) ? payload.providers : [];
    const endpoints = new Set<string>();
    for (const provider of providers) {
      for (const endpoint of getProviderEndpoints(provider)) {
        endpoints.add(endpoint);
      }
    }
    return Array.from(endpoints).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function getKeyCompositeId(keyData: StoredApiKey, fallbackBaseUrl: string): string {
  const base = resolveImportBaseUrl(keyData.baseUrl || fallbackBaseUrl);
  return `${base}::${keyData.key}`;
}

function isInvalidApiKeyPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const parsed = payload as {
    detail?: string | { message?: string; error?: { code?: string; message?: string } };
    error?: string;
    message?: string;
  };

  const code =
    parsed.detail && typeof parsed.detail === "object"
      ? parsed.detail.error?.code || ""
      : "";
  const detailMessage =
    typeof parsed.detail === "string"
      ? parsed.detail
      : parsed.detail?.message || parsed.detail?.error?.message || "";
  const errorMessage = parsed.error || parsed.message || "";

  const combined = `${code} ${detailMessage} ${errorMessage}`.toLowerCase();
  return (
    code === "invalid_api_key" ||
    combined.includes("invalid api key") ||
    combined.includes("invalid_api_key")
  );
}

async function probeApiKeyOnEndpoint(
  endpoint: string,
  apiKey: string
): Promise<KeyProbeResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(`${endpoint}v1/wallet/info`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      try {
        const payload = (await response.json()) as unknown;
        if (isInvalidApiKeyPayload(payload)) {
          return { status: "invalid", endpoint };
        }
      } catch {
        // Ignore parse failures.
      }
      return { status: "error", endpoint };
    }

    const payload = (await response.json()) as {
      api_key?: unknown;
      apiKey?: unknown;
      balance?: unknown;
    };
    const resolvedKey =
      typeof payload.api_key === "string" && payload.api_key
        ? payload.api_key
        : typeof payload.apiKey === "string" && payload.apiKey
          ? payload.apiKey
          : apiKey;

    return {
      status: "valid",
      endpoint,
      apiKey: resolvedKey,
      balance:
        typeof payload.balance === "number" && Number.isFinite(payload.balance)
          ? payload.balance
          : null,
    };
  } catch {
    return { status: "error", endpoint };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function findMatchingKeyEndpoint(
  apiKey: string,
  preferredEndpoint: string
): Promise<{
  match: Extract<KeyProbeResult, { status: "valid" }> | null;
  sawInvalid: boolean;
}> {
  const localKnown = readKnownEndpointsFromStorage();
  const discovered = await fetchDirectoryEndpoints();

  const seen = new Set<string>();
  const candidates: string[] = [];
  const addEndpoint = (value: string) => {
    const normalized = resolveImportBaseUrl(value);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  addEndpoint(preferredEndpoint);
  for (const endpoint of localKnown) {
    addEndpoint(endpoint);
  }
  for (const endpoint of discovered) {
    addEndpoint(endpoint);
  }

  const batchSize = 6;
  let sawInvalid = false;

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    const results = await Promise.all(
      batch.map((endpoint) => probeApiKeyOnEndpoint(endpoint, apiKey))
    );

    for (const result of results) {
      if (result.status === "valid") {
        return { match: result, sawInvalid };
      }
      if (result.status === "invalid") {
        sawInvalid = true;
      }
    }
  }

  return { match: null, sawInvalid };
}

function navigateToApiKeysTab(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("platform:navigate-tab", {
      detail: { tab: "api-keys" },
    })
  );
}

export default function PlatformPage() {
  const { isAuthenticated, authChecked } = useAuth();
  const { manager, manualSave } = useAccountManager();
  const importHandledRef = useRef(false);
  const [importSignal, setImportSignal] = useState(0);
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);

  useEffect(() => {
    if (!authChecked || importHandledRef.current) return;
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    const queryApiKey = getFirstParam(url.searchParams, API_KEY_PARAM_NAMES);

    const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const hashLooksLikeParams =
      rawHash.length > 0 && (rawHash.includes("=") || rawHash.includes("&"));
    const hashParams = hashLooksLikeParams ? new URLSearchParams(rawHash) : null;
    const hashApiKey = hashParams
      ? getFirstParam(hashParams, API_KEY_PARAM_NAMES)
      : null;

    const rawApiKey = (queryApiKey || hashApiKey || "").trim();
    const hasApiKeyParam = Boolean(queryApiKey || hashApiKey);

    importHandledRef.current = true;
    if (!hasApiKeyParam) return;

    const rawBaseUrl =
      getFirstParam(url.searchParams, BASE_URL_PARAM_NAMES) ||
      (hashParams ? getFirstParam(hashParams, BASE_URL_PARAM_NAMES) : null);
    const rawLabel =
      getFirstParam(url.searchParams, LABEL_PARAM_NAMES) ||
      (hashParams ? getFirstParam(hashParams, LABEL_PARAM_NAMES) : null);

    deleteParams(url.searchParams, API_KEY_PARAM_NAMES);
    deleteParams(url.searchParams, BASE_URL_PARAM_NAMES);
    deleteParams(url.searchParams, LABEL_PARAM_NAMES);

    if (hashParams) {
      deleteParams(hashParams, API_KEY_PARAM_NAMES);
      deleteParams(hashParams, BASE_URL_PARAM_NAMES);
      deleteParams(hashParams, LABEL_PARAM_NAMES);
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : "";
    }

    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);

    if (!rawApiKey) {
      toast.error("Missing API key in URL");
      return;
    }

    void (async () => {
      const preferredBaseUrl = resolveImportBaseUrl(rawBaseUrl);
      const probe = await findMatchingKeyEndpoint(rawApiKey, preferredBaseUrl);

      if (!probe.match) {
        toast.error(
          probe.sawInvalid
            ? "Invalid API key on discovered nodes"
            : "Could not verify API key on discovered nodes"
        );
        return;
      }
      const match = probe.match;

      if (manager.accounts$.value.length === 0) {
        const account = PrivateKeyAccount.generateNew<AccountMetadata>();
        const count = manager.accounts$.value.length + 1;
        account.metadata = { name: `Ephemeral ${count}` };
        manager.addAccount(account);
        manager.setActive(account);
        manualSave.next();
      }

      const candidate: StoredApiKey = {
        key: match.apiKey,
        balance: match.balance,
        label: rawLabel?.trim() || "Imported",
        baseUrl: match.endpoint,
        isInvalid: false,
      };
      const candidateId = getKeyCompositeId(candidate, match.endpoint);

      const existing = parseStoredApiKeys(localStorage.getItem(API_KEYS_STORAGE_KEY));
      const alreadyExists = existing.some(
        (item) => getKeyCompositeId(item, match.endpoint) === candidateId
      );
      const merged = [
        candidate,
        ...existing.filter(
          (item) => getKeyCompositeId(item, match.endpoint) !== candidateId
        ),
      ];

      localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(merged));
      localStorage.setItem("platform_active_base_url", match.endpoint);
      window.dispatchEvent(new Event("platform-api-keys-updated"));
      toast.success(
        alreadyExists
          ? "API key updated"
          : `API key imported (${new URL(match.endpoint).host})`
      );
      setImportSignal((current) => current + 1);
    })();
  }, [authChecked, manager, manualSave]);

  useEffect(() => {
    if (!isAuthenticated || importSignal === 0) return;
    navigateToApiKeysTab();
    const timeoutId = window.setTimeout(() => {
      navigateToApiKeysTab();
    }, 200);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [importSignal, isAuthenticated]);

  useEffect(() => {
    if (!authChecked || isAuthenticated) return;
    setLoginDialogOpen(true);
  }, [authChecked, isAuthenticated]);

  useEffect(() => {
    if (!authChecked) return;
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    const loginParam = url.searchParams.get(LOGIN_DIALOG_PARAM_NAME);
    if (!loginParam) return;

    const shouldOpenLoginDialog = ["1", "true", "yes"].includes(
      loginParam.toLowerCase()
    );
    url.searchParams.delete(LOGIN_DIALOG_PARAM_NAME);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);

    if (!isAuthenticated && shouldOpenLoginDialog) {
      setLoginDialogOpen(true);
    }
  }, [authChecked, isAuthenticated]);

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Dialog open={loginDialogOpen} onOpenChange={setLoginDialogOpen}>
        <PlatformShell
          activeTab="home"
          allowUnauthenticated
          onRequestLogin={() => setLoginDialogOpen(true)}
        />
        <DialogContent className="max-w-md p-4 sm:p-5">
          <DialogHeader className="px-1">
            <DialogTitle>Sign in</DialogTitle>
            <DialogDescription>
              Use your Nostr identity to continue.
            </DialogDescription>
          </DialogHeader>
          <LoginMethodsCard
            compact
            onLoggedIn={() => setLoginDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return <PlatformShell activeTab="home" />;
}
