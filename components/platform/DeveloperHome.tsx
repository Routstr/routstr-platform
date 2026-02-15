"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Wallet,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  getProofsBalanceSats,
  PLATFORM_WALLET_UPDATED_EVENT,
} from "@/lib/platformWallet";
import { DEFAULT_BASE_URL } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

type NodeInfo = {
  name: string;
  description: string;
  version: string;
  npub?: string | null;
  mints: string[];
  http_url?: string | null;
};

type NodeModel = {
  id?: string;
  name?: string;
  sats_pricing?: {
    prompt?: number;
    completion?: number;
  } | null;
};

type DirectoryProvider = {
  endpoint_url?: string;
  endpoint_urls?: string[];
  http_url?: string;
  onion_url?: string;
  onion_urls?: string[];
  name?: string;
  description?: string;
  pubkey?: string;
};

type NodeSummary = {
  endpoint: string;
  info: NodeInfo | null;
  models: NodeModel[];
  availableModelCount: number;
  defaultModelId: string | null;
  provider: DirectoryProvider | null;
  error?: string;
};

type StoredApiKey = {
  key: string;
  balance: number | null;
  label?: string;
  baseUrl?: string;
  isInvalid?: boolean;
};

type SmokeTestState = {
  status: "idle" | "pending" | "ok" | "fail";
  checkedAt: number | null;
  message: string | null;
};

type PlatformTab = "home" | "api-keys" | "wallet";

type WalletSummary = {
  isSynced: boolean;
  balanceSats: number;
};

type StepTone = "complete" | "action" | "blocked";

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
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
  if (!url.startsWith("http://")) return true;
  return url.includes("localhost") || url.includes("127.0.0.1");
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
    if (!normalized) continue;
    if (isOnionUrl(normalized)) continue;
    if (!shouldAllowHttp(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    endpoints.push(normalized);
  }

  return endpoints;
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

function readApiKeysFromStorage(): StoredApiKey[] {
  if (typeof window === "undefined") return [];
  return parseStoredApiKeys(localStorage.getItem("api_keys"));
}

function readKnownEndpointsFromStorage(): string[] {
  if (typeof window === "undefined") return [];

  const endpoints = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized || isOnionUrl(normalized)) return;
    if (!shouldAllowHttp(normalized)) return;
    endpoints.add(normalized);
  };

  const baseUrlsList = safeJsonParse<unknown[]>(
    localStorage.getItem("base_urls_list"),
    []
  );
  for (const item of baseUrlsList) {
    add(item);
  }

  const modelsByProvider = safeJsonParse<Record<string, unknown>>(
    localStorage.getItem("modelsFromAllProviders"),
    {}
  );
  for (const key of Object.keys(modelsByProvider)) {
    add(key);
  }

  const apiKeys = readApiKeysFromStorage();
  for (const keyData of apiKeys) {
    add(keyData?.baseUrl);
  }

  add(localStorage.getItem("platform_active_base_url"));

  return Array.from(endpoints).sort((a, b) => a.localeCompare(b));
}

function readWalletSummary(): WalletSummary {
  if (typeof window === "undefined") {
    return { isSynced: false, balanceSats: 0 };
  }

  const usingNip60 =
    localStorage.getItem("usingNip60") === "true" ||
    localStorage.getItem("platform_use_nip60_wallet") === "true";
  const hasProofStorage = localStorage.getItem("cashu_proofs") !== null;

  return {
    isSynced: usingNip60 && hasProofStorage,
    balanceSats: getProofsBalanceSats(),
  };
}

function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function getErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

function formatSatsFromMsats(msats: number | null): string {
  if (msats === null || !Number.isFinite(msats)) return "0";
  return (msats / 1000).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function navigateToTab(tab: PlatformTab): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("platform:navigate-tab", {
      detail: { tab },
    })
  );
}

async function fetchProvidersDirectory(): Promise<DirectoryProvider[]> {
  const response = await fetch("https://api.routstr.com/v1/providers/", {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as { providers?: DirectoryProvider[] };
  return Array.isArray(payload.providers) ? payload.providers : [];
}

async function fetchNodeInfo(baseUrl: string): Promise<NodeInfo> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/info`, {
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Unable to load node info");
  }

  const payload = (await response.json()) as NodeInfo;
  return {
    ...payload,
    mints: Array.isArray(payload.mints) ? payload.mints : [],
  };
}

async function fetchNodeModels(baseUrl: string): Promise<NodeModel[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Unable to load models (${response.status})`);
  }

  const payload = (await response.json()) as { data?: NodeModel[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

function getAvailableModelCount(models: NodeModel[]): number {
  return models.filter(
    (model) =>
      Boolean(model?.sats_pricing) &&
      typeof model?.id === "string" &&
      model.id.length > 0
  ).length;
}

function pickDefaultModelId(models: NodeModel[]): string | null {
  const candidates = models
    .filter(
      (model) =>
        Boolean(model?.sats_pricing) &&
        typeof model?.id === "string" &&
        model.id.length > 0
    )
    .map((model) => {
      const completionCost = model.sats_pricing?.completion;
      const promptCost = model.sats_pricing?.prompt;
      const score =
        typeof completionCost === "number"
          ? completionCost
          : typeof promptCost === "number"
            ? promptCost
            : Number.POSITIVE_INFINITY;
      return { id: model.id as string, score };
    })
    .sort((a, b) => a.score - b.score);

  return candidates[0]?.id || null;
}

function getStepToneClass(tone: StepTone): string {
  if (tone === "complete") {
    return "border-border/80 bg-muted/40";
  }
  if (tone === "action") {
    return "border-border/70 bg-muted/25";
  }
  return "border-border/60 bg-transparent";
}

function StepStatusIcon({ tone }: { tone: StepTone }) {
  if (tone === "complete") {
    return <CheckCircle2 className="h-4 w-4 text-foreground/85" />;
  }
  return (
    <XCircle
      className={`h-4 w-4 ${
        tone === "action" ? "text-foreground/70" : "text-muted-foreground"
      }`}
    />
  );
}

export default function DeveloperHome({
  baseUrl,
  onBaseUrlChange,
}: {
  baseUrl: string;
  onBaseUrlChange: (baseUrl: string) => void;
}) {
  const normalizedBaseUrl = useMemo(() => {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized || isOnionUrl(normalized)) {
      return DEFAULT_BASE_URL.replace(/\/$/, "");
    }
    return normalized;
  }, [baseUrl]);

  const [storedEndpoints, setStoredEndpoints] = useState<string[]>([]);
  const [storedApiKeys, setStoredApiKeys] = useState<StoredApiKey[]>([]);
  const [walletSummary, setWalletSummary] = useState<WalletSummary>({
    isSynced: false,
    balanceSats: 0,
  });
  const [smokeTest, setSmokeTest] = useState<SmokeTestState>({
    status: "idle",
    checkedAt: null,
    message: null,
  });

  useEffect(() => {
    const refreshStorageState = () => {
      setStoredEndpoints(readKnownEndpointsFromStorage());
      setStoredApiKeys(readApiKeysFromStorage());
      setWalletSummary(readWalletSummary());
    };

    refreshStorageState();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshStorageState();
      }
    };

    window.addEventListener("storage", refreshStorageState);
    window.addEventListener("platform-api-keys-updated", refreshStorageState);
    window.addEventListener(PLATFORM_WALLET_UPDATED_EVENT, refreshStorageState);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("storage", refreshStorageState);
      window.removeEventListener("platform-api-keys-updated", refreshStorageState);
      window.removeEventListener(PLATFORM_WALLET_UPDATED_EVENT, refreshStorageState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const {
    data: providersDirectory,
    isLoading: isDirectoryLoading,
    refetch: refetchDirectory,
  } = useQuery({
    queryKey: ["platform-providers-directory"],
    queryFn: fetchProvidersDirectory,
    staleTime: 120_000,
    refetchInterval: 300_000,
  });

  const discoveredEndpoints = useMemo(() => {
    const endpoints = new Set<string>([normalizedBaseUrl]);

    for (const endpoint of storedEndpoints) {
      endpoints.add(endpoint);
    }

    for (const provider of providersDirectory || []) {
      for (const endpoint of getProviderEndpoints(provider)) {
        endpoints.add(endpoint);
      }
    }

    return Array.from(endpoints).sort((a, b) => a.localeCompare(b));
  }, [providersDirectory, normalizedBaseUrl, storedEndpoints]);

  const providerByEndpoint = useMemo(() => {
    const map = new Map<string, DirectoryProvider>();
    for (const provider of providersDirectory || []) {
      for (const endpoint of getProviderEndpoints(provider)) {
        if (!map.has(endpoint)) {
          map.set(endpoint, provider);
        }
      }
    }
    return map;
  }, [providersDirectory]);

  const {
    data: nodeSummaries,
    isLoading: isSummariesLoading,
    refetch: refetchSummaries,
  } = useQuery({
    queryKey: ["platform-node-summaries", discoveredEndpoints],
    enabled: discoveredEndpoints.length > 0,
    staleTime: 120_000,
    refetchInterval: 300_000,
    queryFn: async (): Promise<NodeSummary[]> => {
      const summaries = await Promise.all(
        discoveredEndpoints.map(async (endpoint): Promise<NodeSummary> => {
          const [infoResult, modelsResult] = await Promise.allSettled([
            fetchNodeInfo(endpoint),
            fetchNodeModels(endpoint),
          ]);

          const info = infoResult.status === "fulfilled" ? infoResult.value : null;
          const models =
            modelsResult.status === "fulfilled" ? modelsResult.value : [];

          const availableModelCount = getAvailableModelCount(models);
          const defaultModelId = pickDefaultModelId(models);

          const infoError =
            infoResult.status === "rejected"
              ? getErrorMessage(infoResult.reason, "Unable to load /v1/info")
              : undefined;
          const modelsError =
            modelsResult.status === "rejected"
              ? getErrorMessage(modelsResult.reason, "Unable to load /v1/models")
              : undefined;

          const hasReachableSurface = Boolean(info) || models.length > 0;

          return {
            endpoint,
            info,
            models,
            availableModelCount,
            defaultModelId,
            provider: providerByEndpoint.get(endpoint) || null,
            error: hasReachableSurface
              ? undefined
              : [infoError, modelsError].filter(Boolean).join(" • "),
          };
        })
      );

      return summaries.sort((a, b) => {
        if (a.endpoint === normalizedBaseUrl) return -1;
        if (b.endpoint === normalizedBaseUrl) return 1;
        if (a.availableModelCount !== b.availableModelCount) {
          return b.availableModelCount - a.availableModelCount;
        }
        const aName = a.info?.name || hostFromBaseUrl(a.endpoint);
        const bName = b.info?.name || hostFromBaseUrl(b.endpoint);
        return aName.localeCompare(bName);
      });
    },
  });

  const activeSummary = useMemo(() => {
    return (
      nodeSummaries?.find((summary) => summary.endpoint === normalizedBaseUrl) ||
      null
    );
  }, [nodeSummaries, normalizedBaseUrl]);

  const defaultModelId = useMemo(() => {
    return activeSummary?.defaultModelId || "openai/gpt-4o-mini";
  }, [activeSummary]);
  const activeModelOptions = useMemo(() => {
    const seen = new Set<string>();
    return (activeSummary?.models || []).reduce<Array<{ id: string; label: string }>>(
      (accumulator, model) => {
        const modelId = typeof model?.id === "string" ? model.id.trim() : "";
        if (!modelId || seen.has(modelId)) return accumulator;
        seen.add(modelId);

        const modelName = typeof model?.name === "string" ? model.name.trim() : "";
        const label =
          modelName && modelName !== modelId
            ? `${modelName} (${modelId})`
            : modelId;

        accumulator.push({ id: modelId, label });
        return accumulator;
      },
      []
    );
  }, [activeSummary]);
  const [selectedModelId, setSelectedModelId] = useState<string>(
    "openai/gpt-4o-mini"
  );
  const modelForRequests = selectedModelId || defaultModelId;

  const routableNodeSummaries = useMemo(() => {
    const summaries = nodeSummaries || [];
    const filtered = summaries.filter(
      (summary) =>
        summary.availableModelCount > 0 || summary.endpoint === normalizedBaseUrl
    );
    return filtered.length > 0 ? filtered : summaries;
  }, [nodeSummaries, normalizedBaseUrl]);

  const coverageSummary = useMemo(() => {
    const summaries = nodeSummaries || [];
    const discoveredCount = summaries.length;
    const reachableCount = summaries.filter(
      (summary) => Boolean(summary.info) || summary.models.length > 0
    ).length;
    const routableModelCount = summaries.reduce(
      (total, summary) => total + summary.availableModelCount,
      0
    );

    return {
      discoveredCount,
      reachableCount,
      routableModelCount,
    };
  }, [nodeSummaries]);

  const endpointScopedKeysNormalized = useMemo(() => {
    return storedApiKeys.filter((keyData) => {
      const keyBaseRaw = normalizeBaseUrl(keyData.baseUrl || normalizedBaseUrl);
      const keyBase = keyBaseRaw.replace(/\/$/, "");
      return keyBase === normalizedBaseUrl;
    });
  }, [storedApiKeys, normalizedBaseUrl]);

  const primaryEndpointKey = useMemo(() => {
    return (
      endpointScopedKeysNormalized.find((keyData) => !keyData.isInvalid) ||
      endpointScopedKeysNormalized[0] ||
      null
    );
  }, [endpointScopedKeysNormalized]);

  const hasEndpointKey = Boolean(primaryEndpointKey);
  const hasUsableEndpointKey = Boolean(
    primaryEndpointKey &&
      typeof primaryEndpointKey.balance === "number" &&
      primaryEndpointKey.balance > 0 &&
      !primaryEndpointKey.isInvalid
  );

  const totalKeyBalanceMsats = useMemo(() => {
    return storedApiKeys.reduce((sum, keyData) => {
      if (typeof keyData.balance !== "number" || !Number.isFinite(keyData.balance)) {
        return sum;
      }
      return sum + keyData.balance;
    }, 0);
  }, [storedApiKeys]);

  useEffect(() => {
    if (activeModelOptions.length === 0) {
      setSelectedModelId(defaultModelId);
      return;
    }

    setSelectedModelId((current) => {
      if (activeModelOptions.some((model) => model.id === current)) {
        return current;
      }
      if (activeModelOptions.some((model) => model.id === defaultModelId)) {
        return defaultModelId;
      }
      return activeModelOptions[0].id;
    });
  }, [activeModelOptions, defaultModelId, normalizedBaseUrl]);

  useEffect(() => {
    setSmokeTest((current) => {
      if (current.status === "pending") return current;
      return {
        status: "idle",
        checkedAt: null,
        message: null,
      };
    });
  }, [normalizedBaseUrl, modelForRequests]);

  const [isRefreshingDirectory, setIsRefreshingDirectory] = useState(false);

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Unable to copy");
    }
  };

  const handleRefreshDirectory = async () => {
    setIsRefreshingDirectory(true);
    try {
      await refetchDirectory();
      await refetchSummaries();
      setStoredEndpoints(readKnownEndpointsFromStorage());
      toast.success("Network coverage refreshed");
    } catch {
      toast.error("Unable to refresh network coverage");
    } finally {
      setIsRefreshingDirectory(false);
    }
  };

  const runSmokeTest = async () => {
    if (!primaryEndpointKey) {
      toast.error("Create an API key first");
      setSmokeTest({
        status: "fail",
        checkedAt: Date.now(),
        message: "No API key found for this endpoint.",
      });
      return;
    }

    setSmokeTest({
      status: "pending",
      checkedAt: Date.now(),
      message: null,
    });

    try {
      const response = await fetch(`${normalizedBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${primaryEndpointKey.key}`,
        },
        body: JSON.stringify({
          model: modelForRequests,
          messages: [
            { role: "system", content: "You are Routstr health check." },
            { role: "user", content: "Reply with one word: pong" },
          ],
          max_tokens: 16,
        }),
      });

      if (!response.ok) {
        let detail = "Request failed";
        try {
          const payload = await response.json();
          if (typeof payload?.detail === "string") detail = payload.detail;
          else if (typeof payload?.error === "string") detail = payload.error;
        } catch {
          const text = await response.text();
          if (text) detail = text;
        }

        setSmokeTest({
          status: "fail",
          checkedAt: Date.now(),
          message: detail,
        });
        toast.error("Smoke test failed");
        return;
      }

      setSmokeTest({
        status: "ok",
        checkedAt: Date.now(),
        message: "Request succeeded.",
      });
      toast.success("Smoke test passed");
    } catch (error) {
      const message = getErrorMessage(error, "Smoke test failed");
      setSmokeTest({
        status: "fail",
        checkedAt: Date.now(),
        message,
      });
      toast.error("Smoke test failed");
    }
  };

  const curlSnippet = useMemo(() => {
    return [
      `curl -X POST "${normalizedBaseUrl}/v1/chat/completions"`,
      '  -H "Authorization: Bearer YOUR_API_KEY"',
      '  -H "Content-Type: application/json"',
      "  -d '{",
      `    \"model\": \"${modelForRequests}\",`,
      '    \"messages\": [',
      '      {\"role\":\"system\",\"content\":\"You are Routstr.\"},',
      '      {\"role\":\"user\",\"content\":\"Ping the platform\"}',
      "    ]",
      "  }'",
    ].join("\n");
  }, [modelForRequests, normalizedBaseUrl]);

  const smokeStatusLabel =
    smokeTest.status === "ok"
      ? "Passed"
      : smokeTest.status === "fail"
        ? "Failed"
        : smokeTest.status === "pending"
          ? "Running"
          : "Not run";

  const smokeStatusClass =
    smokeTest.status === "ok"
      ? "border-border/80 bg-muted/45 text-foreground"
      : smokeTest.status === "fail"
        ? "border-border/80 bg-muted/30 text-foreground"
        : smokeTest.status === "pending"
          ? "border-border/80 bg-muted/30 text-foreground"
          : "border-border/70 bg-muted/30 text-muted-foreground";

  const stepOneTone: StepTone = hasEndpointKey ? "complete" : "action";
  const stepTwoTone: StepTone = hasUsableEndpointKey
    ? "complete"
    : hasEndpointKey
      ? "action"
      : "blocked";
  const stepThreeTone: StepTone =
    smokeTest.status === "ok"
      ? "complete"
      : hasUsableEndpointKey
        ? "action"
        : "blocked";

  const primaryActionLabel = hasEndpointKey ? "Send test request" : "Create API key";
  const primaryAction = () => {
    if (!hasEndpointKey) {
      navigateToTab("api-keys");
      return;
    }
    void runSmokeTest();
  };
  const isSetupReady = hasUsableEndpointKey && smokeTest.status === "ok";
  const heroSummary = !hasEndpointKey
    ? "Create a key, verify readiness, and send your first successful request."
    : !hasUsableEndpointKey
      ? "You already have a key. Add balance (or refresh) and then run a test request."
      : isSetupReady
        ? "Setup is ready. Use the checks below as a quick health snapshot."
        : "Key is funded. Run a test request to finish setup verification.";
  const quickstartSummary = !hasEndpointKey
    ? "Follow these checks in order to get your first working request."
    : !hasUsableEndpointKey
      ? "Key exists. Complete funding and then validate with a smoke test."
      : isSetupReady
        ? "All checks are complete. You can still rerun them anytime."
        : "Almost done. Run the smoke test to confirm routing is working.";

  return (
    <div className="space-y-5">
      <Card className="gap-0 relative overflow-hidden p-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.12),transparent_48%),radial-gradient(circle_at_bottom_left,rgba(16,185,129,0.10),transparent_44%)]" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2 max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-tight">Developer Home</h1>
            <p className="text-sm text-muted-foreground">{heroSummary}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={primaryAction}
              type="button"
            >
              {smokeTest.status === "pending" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
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

      <Card className="gap-0 space-y-4 p-5">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Quickstart</h2>
          <p className="text-sm text-muted-foreground">{quickstartSummary}</p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div
            className={`rounded-xl border p-3 flex h-full flex-col ${getStepToneClass(stepOneTone)}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <p className="text-sm font-medium">1. API key available</p>
                <p className="text-xs text-muted-foreground">
                  {hasEndpointKey
                    ? "A key is available for the default endpoint."
                    : "No key found for the default endpoint."}
                </p>
              </div>
              <StepStatusIcon tone={stepOneTone} />
            </div>
            <div className="mt-auto pt-3">
              <Button
                onClick={() => navigateToTab("api-keys")}
                variant="secondary"
                size="sm"
                type="button"
              >
                {hasEndpointKey ? "Manage keys" : "Create API key"}
              </Button>
            </div>
          </div>

          <div
            className={`rounded-xl border p-3 flex h-full flex-col ${getStepToneClass(stepTwoTone)}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <p className="text-sm font-medium">2. Funded and usable</p>
                <p className="text-xs text-muted-foreground">
                  {hasUsableEndpointKey
                    ? `Available balance: ${formatSatsFromMsats(primaryEndpointKey?.balance || 0)} sats`
                    : hasEndpointKey
                      ? "Key exists but balance is empty or needs refresh."
                      : "Requires an API key first."}
                </p>
              </div>
              <StepStatusIcon tone={stepTwoTone} />
            </div>
            <div className="mt-auto pt-3">
              <Button
                onClick={() => navigateToTab("api-keys")}
                variant="secondary"
                size="sm"
                type="button"
              >
                {hasUsableEndpointKey ? "View balances" : "Top up key"}
              </Button>
            </div>
          </div>

          <div
            className={`rounded-xl border p-3 flex h-full flex-col ${getStepToneClass(stepThreeTone)}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <p className="text-sm font-medium">3. Test request success</p>
                <p className="text-xs text-muted-foreground">
                  {smokeTest.status === "ok"
                    ? "Latest test request succeeded."
                    : smokeTest.status === "fail"
                      ? smokeTest.message || "Latest test request failed."
                      : hasUsableEndpointKey
                        ? "Run a smoke test to verify your setup."
                        : "Requires a funded key first."}
                </p>
              </div>
              <StepStatusIcon tone={stepThreeTone} />
            </div>
            <div className="mt-auto pt-3">
              <Button
                onClick={() => void runSmokeTest()}
                disabled={!hasEndpointKey || smokeTest.status === "pending"}
                variant="secondary"
                size="sm"
                type="button"
              >
                {smokeTest.status === "pending" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Send test request
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Active API keys</p>
          <p className="mt-1 text-lg font-semibold">{storedApiKeys.length}</p>
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
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Routable nodes</p>
          <p className="mt-1 text-lg font-semibold">{routableNodeSummaries.length}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Routable models</p>
          <p className="mt-1 text-lg font-semibold">{coverageSummary.routableModelCount}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Wallet</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {walletSummary.balanceSats.toLocaleString()} sats
            </span>
            <Button
              onClick={() => navigateToTab("wallet")}
              variant="secondary"
              size="sm"
              type="button"
            >
              <Wallet className="h-3.5 w-3.5" />
              Open
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <Card className="gap-0 flex h-full flex-col p-5 lg:h-[34rem]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight">Request Setup</h2>
            <span className={`rounded-full border px-2.5 py-1 text-xs ${smokeStatusClass}`}>
              Smoke test: {smokeStatusLabel}
            </span>
          </div>

          <div className="mt-4 flex-1 min-h-0 space-y-4 overflow-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">Default request endpoint</span>
              <div className="flex items-center gap-2">
                <Input
                  value={normalizedBaseUrl}
                  placeholder={normalizedBaseUrl}
                  onChange={(event) => {
                    const normalized = normalizeBaseUrl(event.target.value);
                    if (!normalized || isOnionUrl(normalized)) return;
                    onBaseUrlChange(normalized);
                  }}
                  className="grow"
                />
                <Button
                  onClick={() => void handleCopy(normalizedBaseUrl)}
                  variant="outline"
                  size="icon"
                  type="button"
                  title="Copy endpoint"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </label>

            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Request model</span>
              <Select
                value={modelForRequests}
                onValueChange={setSelectedModelId}
                disabled={activeModelOptions.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {activeModelOptions.length === 0 ? (
                    <SelectItem value={modelForRequests}>
                      {modelForRequests}
                    </SelectItem>
                  ) : (
                    activeModelOptions.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </label>

            <div className="rounded-md border border-border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">Key used for test</p>
              <p className="mt-1 text-sm font-mono break-all">
                {primaryEndpointKey ? `${primaryEndpointKey.key.slice(0, 8)}...` : "No key"}
              </p>
            </div>
            </div>

            <div className="bg-muted/30 rounded-lg p-4 font-mono text-sm leading-6 border border-border/50">
              <pre className="break-all whitespace-pre-wrap">{curlSnippet}</pre>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={() => void handleCopy(curlSnippet)}
              variant="secondary"
              type="button"
            >
              <Copy className="h-4 w-4" />
              Copy curl
            </Button>
            <Button
              onClick={() => void runSmokeTest()}
              disabled={!hasEndpointKey || smokeTest.status === "pending"}
              type="button"
            >
              {smokeTest.status === "pending" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Send test request
            </Button>
            <Button asChild variant="ghost">
              <a
                href="https://docs.routstr.com"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="h-4 w-4" />
                Docs
              </a>
            </Button>
          </div>

          {smokeTest.checkedAt ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Last checked: {new Date(smokeTest.checkedAt).toLocaleTimeString()}
            </p>
          ) : null}
        </Card>

        <Card className="gap-0 flex h-full flex-col p-5 lg:h-[34rem]">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Network Coverage</h2>
              <p className="text-sm text-muted-foreground">
                Discovered {coverageSummary.discoveredCount} endpoints, reachable {coverageSummary.reachableCount}.
              </p>
            </div>
            <Button
              onClick={handleRefreshDirectory}
              disabled={
                isRefreshingDirectory || isDirectoryLoading || isSummariesLoading
              }
              variant="secondary"
              size="sm"
              type="button"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isRefreshingDirectory ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>

          <div className="mt-4 flex-1 min-h-0">
            {isDirectoryLoading || isSummariesLoading ? (
              <div className="space-y-2" aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <div
                    key={`coverage-skeleton-${index}`}
                    className="h-12 rounded-md border border-border/60 bg-muted/20 animate-pulse"
                  />
                ))}
              </div>
            ) : (nodeSummaries || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No endpoints discovered yet.
              </p>
            ) : (
              <div className="h-full space-y-2 overflow-auto pr-1">
                {(nodeSummaries || []).map((summary) => {
                  const isActive = summary.endpoint === normalizedBaseUrl;
                  const canRoute = summary.availableModelCount > 0;
                  const displayName =
                    summary.info?.name ||
                    summary.provider?.name ||
                    hostFromBaseUrl(summary.endpoint);

                  return (
                    <div
                      key={`all-endpoint-${summary.endpoint}`}
                      className={`rounded-md border p-2.5 ${
                        isActive
                          ? "border-border/85 bg-muted/45"
                          : "border-border/70 bg-muted/15"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{displayName}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {withTrailingSlash(summary.endpoint)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {canRoute ? "Routable" : "Unavailable"} • {summary.availableModelCount} models
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            onClick={() => onBaseUrlChange(withTrailingSlash(summary.endpoint))}
                            variant="secondary"
                            size="sm"
                            type="button"
                            disabled={!isActive && !canRoute}
                          >
                            {isActive ? "Using" : canRoute ? "Use" : "No models"}
                          </Button>
                          <Button
                            onClick={() => void handleCopy(withTrailingSlash(summary.endpoint))}
                            variant="outline"
                            size="icon-sm"
                            type="button"
                            title="Copy endpoint"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      </section>
    </div>
  );
}
