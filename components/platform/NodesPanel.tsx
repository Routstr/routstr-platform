"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Copy, RefreshCw, XCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { DEFAULT_BASE_URL } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

type NodeInfo = {
  name?: string;
  description?: string;
  version?: string;
  npub?: string | null;
  mints?: string[];
};

type NodeModel = {
  id?: string;
  name?: string;
  sats_pricing?: {
    prompt?: number;
    completion?: number;
  } | null;
  [key: string]: unknown;
};

type NodeSummary = {
  endpoint: string;
  provider: DirectoryProvider | null;
  info: NodeInfo | null;
  models: NodeModel[];
  availableModelCount: number;
  isReachable: boolean;
  error?: string;
};

type SelectedModelDetail = {
  endpoint: string;
  nodeLabel: string;
  model: NodeModel;
};

type ModelPricingComparison = {
  endpoint: string;
  nodeLabel: string;
  promptPrice: number;
  completionPrice: number;
};

type ModelFieldRow = {
  label: string;
  value: string;
  isMarkdown?: boolean;
};

type ModelSortOption =
  | "name"
  | "release-new"
  | "release-old"
  | "price-low"
  | "price-high";

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fuzzyScore(candidate: string, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 1;

  const normalizedCandidate = normalizeSearchText(candidate);
  if (!normalizedCandidate) return 0;

  const directIndex = normalizedCandidate.indexOf(normalizedQuery);
  if (directIndex >= 0) {
    return 300 - directIndex;
  }

  let queryIndex = 0;
  let streak = 0;
  let bonus = 0;

  for (const char of normalizedCandidate) {
    if (char === normalizedQuery[queryIndex]) {
      queryIndex += 1;
      streak += 1;
      bonus += 2 + streak;
      if (queryIndex === normalizedQuery.length) break;
    } else {
      streak = 0;
    }
  }

  if (queryIndex !== normalizedQuery.length) return 0;

  const density = normalizedQuery.length / normalizedCandidate.length;
  return 100 + bonus + density * 10;
}

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
  return !url.startsWith("http://");
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

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readKnownEndpointsFromStorage(): string[] {
  if (typeof window === "undefined") return [];

  const endpoints = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) return;
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

  add(localStorage.getItem("platform_active_base_url"));

  return Array.from(endpoints).sort((a, b) => a.localeCompare(b));
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

function getNodeLabel(summary: NodeSummary): string {
  return summary.info?.name || summary.provider?.name || hostFromBaseUrl(summary.endpoint);
}

function formatPriceValue(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString();
}

function toPerMillionTokens(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value * 1_000_000;
}

function formatModelFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value || "-";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => formatModelFieldValue(item))
      .join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, nested]) => `${key.replace(/_/g, " ")}: ${formatModelFieldValue(nested)}`)
      .join(" • ");
  }
  return String(value);
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getModelCreatedValue(model: NodeModel): number | null {
  return numericOrNull((model as Record<string, unknown>).created);
}

function getModelTotalPrice(model: NodeModel): number | null {
  const prompt = numericOrNull(model.sats_pricing?.prompt);
  const completion = numericOrNull(model.sats_pricing?.completion);
  if (prompt === null && completion === null) return null;
  return (prompt || 0) + (completion || 0);
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  ascending: boolean
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return ascending ? left - right : right - left;
}

async function fetchProvidersDirectory(): Promise<DirectoryProvider[]> {
  const response = await fetch("https://api.routstr.com/v1/providers/", {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) return [];

  const payload = (await response.json()) as { providers?: DirectoryProvider[] };
  return Array.isArray(payload.providers) ? payload.providers : [];
}

async function fetchNodeInfo(baseUrl: string): Promise<NodeInfo> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${baseUrl}/v1/info`, {
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Unable to load node info (${response.status})`);
    }
    const payload = (await response.json()) as NodeInfo;
    return payload || {};
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchNodeModels(baseUrl: string): Promise<NodeModel[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Unable to load models (${response.status})`);
    }

    const payload = (await response.json()) as { data?: NodeModel[] };
    return Array.isArray(payload.data) ? payload.data : [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function NodesPanel({
  baseUrl,
}: {
  baseUrl: string;
}) {
  const normalizedBaseUrl = useMemo(() => {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized || isOnionUrl(normalized)) {
      return DEFAULT_BASE_URL.replace(/\/+$/, "");
    }
    return normalized;
  }, [baseUrl]);

  const [storedEndpoints, setStoredEndpoints] = useState<string[]>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState(normalizedBaseUrl);
  const [search, setSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [modelSort, setModelSort] = useState<ModelSortOption>("release-new");
  const [selectedModelDetail, setSelectedModelDetail] =
    useState<SelectedModelDetail | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const refreshStorageState = () => {
      setStoredEndpoints(readKnownEndpointsFromStorage());
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
  }, [normalizedBaseUrl, providersDirectory, storedEndpoints]);

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
          const models = modelsResult.status === "fulfilled" ? modelsResult.value : [];
          const availableModelCount = models.filter(
            (model) =>
              Boolean(model?.sats_pricing) &&
              typeof model?.id === "string" &&
              model.id.length > 0
          ).length;
          const isReachable = Boolean(info) || models.length > 0;

          const infoError =
            infoResult.status === "rejected"
              ? getErrorMessage(infoResult.reason, "Unable to load /v1/info")
              : undefined;
          const modelsError =
            modelsResult.status === "rejected"
              ? getErrorMessage(modelsResult.reason, "Unable to load /v1/models")
              : undefined;

          return {
            endpoint,
            provider: providerByEndpoint.get(endpoint) || null,
            info,
            models,
            availableModelCount,
            isReachable,
            error: isReachable ? undefined : [infoError, modelsError].filter(Boolean).join(" • "),
          };
        })
      );

      return summaries.sort((a, b) => {
        if (a.endpoint === normalizedBaseUrl) return -1;
        if (b.endpoint === normalizedBaseUrl) return 1;
        if (a.availableModelCount !== b.availableModelCount) {
          return b.availableModelCount - a.availableModelCount;
        }
        return hostFromBaseUrl(a.endpoint).localeCompare(hostFromBaseUrl(b.endpoint));
      });
    },
  });

  useEffect(() => {
    setSelectedEndpoint((current) => {
      if (discoveredEndpoints.includes(current)) return current;
      return discoveredEndpoints[0] || normalizedBaseUrl;
    });
  }, [discoveredEndpoints, normalizedBaseUrl]);

  const filteredSummaries = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return nodeSummaries || [];
    return (nodeSummaries || [])
      .map((summary) => {
        const endpointHost = hostFromBaseUrl(summary.endpoint);
        const providerName = summary.provider?.name || summary.info?.name || "";
        const version = summary.info?.version || "";
        const score = Math.max(
          fuzzyScore(endpointHost, term),
          fuzzyScore(providerName, term),
          fuzzyScore(summary.endpoint, term),
          fuzzyScore(version, term)
        );
        return { summary, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.summary);
  }, [nodeSummaries, search]);

  const coverageSummary = useMemo(() => {
    const summaries = nodeSummaries || [];
    const discoveredCount = summaries.length;
    const reachableCount = summaries.filter((summary) => summary.isReachable).length;
    const routableModelCount = summaries.reduce(
      (total, summary) => total + summary.availableModelCount,
      0
    );
    return { discoveredCount, reachableCount, routableModelCount };
  }, [nodeSummaries]);

  const selectedSummary = useMemo(() => {
    return (nodeSummaries || []).find((summary) => summary.endpoint === selectedEndpoint) || null;
  }, [nodeSummaries, selectedEndpoint]);

  useEffect(() => {
    setModelSearch("");
  }, [selectedEndpoint]);

  const displayModels = useMemo(() => {
    return (selectedSummary?.models || []).filter(
      (model) => typeof model?.id === "string" && model.id.trim().length > 0
    );
  }, [selectedSummary]);

  const filteredDisplayModels = useMemo(() => {
    const term = modelSearch.trim().toLowerCase();
    const filtered = !term
      ? [...displayModels]
      : displayModels.filter((model) => {
          const modelId = String(model.id || "");
          const modelName = String(model.name || "");
          return Math.max(fuzzyScore(modelId, term), fuzzyScore(modelName, term)) > 0;
        });

    const withName = (model: NodeModel): string => {
      const modelId = String(model.id || "");
      const modelName =
        typeof model.name === "string" && model.name.trim().length > 0
          ? model.name
          : modelId;
      return modelName.toLowerCase();
    };
    const withId = (model: NodeModel): string => String(model.id || "").toLowerCase();

    return filtered.sort((left, right) => {
      const leftName = withName(left);
      const rightName = withName(right);

      let comparison = 0;
      if (modelSort === "release-new") {
        comparison = compareNullableNumbers(
          getModelCreatedValue(left),
          getModelCreatedValue(right),
          false
        );
      } else if (modelSort === "release-old") {
        comparison = compareNullableNumbers(
          getModelCreatedValue(left),
          getModelCreatedValue(right),
          true
        );
      } else if (modelSort === "price-low") {
        comparison = compareNullableNumbers(
          getModelTotalPrice(left),
          getModelTotalPrice(right),
          true
        );
      } else if (modelSort === "price-high") {
        comparison = compareNullableNumbers(
          getModelTotalPrice(left),
          getModelTotalPrice(right),
          false
        );
      } else {
        comparison = leftName.localeCompare(rightName);
      }

      if (comparison !== 0) return comparison;
      return withId(left).localeCompare(withId(right));
    });
  }, [displayModels, modelSearch, modelSort]);

  const pricingComparisonRows = useMemo<ModelPricingComparison[]>(() => {
    if (!selectedModelDetail) return [];
    const modelId = typeof selectedModelDetail.model.id === "string" ? selectedModelDetail.model.id : "";
    if (!modelId) return [];

    const rows: ModelPricingComparison[] = [];
    for (const summary of nodeSummaries || []) {
      const match = summary.models.find((model) => model.id === modelId);
      if (!match) continue;

      const promptPrice = toPerMillionTokens(match.sats_pricing?.prompt);
      const completionPrice = toPerMillionTokens(match.sats_pricing?.completion);

      rows.push({
        endpoint: summary.endpoint,
        nodeLabel: getNodeLabel(summary),
        promptPrice,
        completionPrice,
      });
    }

    return rows.sort(
      (a, b) =>
        a.promptPrice + a.completionPrice - (b.promptPrice + b.completionPrice)
    );
  }, [nodeSummaries, selectedModelDetail]);

  const maxComparisonPrice = useMemo(() => {
    return Math.max(
      ...pricingComparisonRows.map((row) =>
        Math.max(row.promptPrice, row.completionPrice)
      ),
      0.000001
    );
  }, [pricingComparisonRows]);

  const selectedModelFieldRows = useMemo<Array<ModelFieldRow>>(() => {
    if (!selectedModelDetail) return [];
    const rows: Array<ModelFieldRow> = [];
    const model = selectedModelDetail.model as Record<string, unknown>;

    const modelId = typeof model.id === "string" ? model.id : "";
    const modelName = typeof model.name === "string" ? model.name : "";
    if (modelId) rows.push({ label: "Model id", value: modelId });
    if (modelName) rows.push({ label: "Name", value: modelName });

    rows.push({
      label: "Prompt price",
      value: `${formatPriceValue(toPerMillionTokens(selectedModelDetail.model.sats_pricing?.prompt))} sats / 1M`,
    });
    rows.push({
      label: "Completion price",
      value: `${formatPriceValue(toPerMillionTokens(selectedModelDetail.model.sats_pricing?.completion))} sats / 1M`,
    });

    const orderedKeys = Object.keys(model)
      .filter((key) => key !== "id" && key !== "name" && key !== "sats_pricing")
      .sort((a, b) => a.localeCompare(b));
    for (const key of orderedKeys) {
      const rawValue = model[key];
      rows.push({
        label: key.replace(/_/g, " "),
        value: formatModelFieldValue(rawValue),
        isMarkdown: key === "description" && typeof rawValue === "string",
      });
    }

    return rows;
  }, [selectedModelDetail]);

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Unable to copy");
    }
  };

  const handleOpenModelDetail = (model: NodeModel) => {
    if (!selectedSummary) return;
    setSelectedModelDetail({
      endpoint: selectedSummary.endpoint,
      nodeLabel: getNodeLabel(selectedSummary),
      model,
    });
  };

  const selectedModelId =
    selectedModelDetail && typeof selectedModelDetail.model.id === "string"
      ? selectedModelDetail.model.id
      : "";
  const selectedModelName =
    selectedModelDetail &&
    typeof selectedModelDetail.model.name === "string" &&
    selectedModelDetail.model.name.trim().length > 0
      ? selectedModelDetail.model.name
      : selectedModelId || "Model Details";

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refetchDirectory();
      await refetchSummaries();
      setStoredEndpoints(readKnownEndpointsFromStorage());
      toast.success("Node list refreshed");
    } catch {
      toast.error("Unable to refresh node list");
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="space-y-3 md:flex md:h-full md:min-h-0 md:flex-col">
      <Card className="gap-0 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Node Directory</h2>
            <p className="text-xs text-muted-foreground">
              Browse endpoints and inspect available models.
            </p>
          </div>
          <Button
            onClick={handleRefresh}
            disabled={isRefreshing || isDirectoryLoading || isSummariesLoading}
            variant="outline"
            size="sm"
            type="button"
            className="h-8 px-2.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <div className="mt-2.5 flex flex-wrap gap-2">
          <div className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">Discovered</span>
            <span className="font-semibold tabular-nums">{coverageSummary.discoveredCount}</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">Reachable</span>
            <span className="font-semibold tabular-nums">{coverageSummary.reachableCount}</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">Models</span>
            <span className="font-semibold tabular-nums">{coverageSummary.routableModelCount}</span>
          </div>
        </div>
      </Card>

      <section className="grid gap-3 md:min-h-0 md:flex-1 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <Card className="gap-0 p-3 md:min-h-0 md:h-full">
          <div className="space-y-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search nodes"
            />
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-auto overscroll-y-contain">
            {isDirectoryLoading || isSummariesLoading ? (
              <div className="space-y-2" aria-hidden="true">
                {[0, 1, 2, 3].map((index) => (
                  <div
                    key={`node-skeleton-${index}`}
                    className="h-14 animate-pulse rounded-md border border-border/60 bg-muted/20"
                  />
                ))}
              </div>
            ) : filteredSummaries.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No nodes found.</p>
            ) : (
              <RadioGroup
                value={selectedEndpoint}
                onValueChange={setSelectedEndpoint}
                className="gap-2"
              >
                {filteredSummaries.map((summary, index) => {
                  const isActive = summary.endpoint === selectedEndpoint;
                  const displayName =
                    summary.info?.name ||
                    summary.provider?.name ||
                    hostFromBaseUrl(summary.endpoint);
                  const version = summary.info?.version?.trim();
                  const optionId = `node-endpoint-${index}`;
                  return (
                    <label
                      key={summary.endpoint}
                      htmlFor={optionId}
                      className={`flex w-full cursor-pointer items-start gap-2 rounded-md border p-2.5 transition-colors ${
                        isActive
                          ? "border-border/85 bg-muted/45"
                          : "border-border/70 bg-muted/15 hover:bg-muted/25"
                      }`}
                    >
                      <RadioGroupItem
                        id={optionId}
                        value={summary.endpoint}
                        className="mt-0.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{displayName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {hostFromBaseUrl(summary.endpoint)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {version ? `v${version} • ` : ""}
                          {summary.availableModelCount} models
                        </p>
                      </div>
                    </label>
                  );
                })}
              </RadioGroup>
            )}
          </div>
        </Card>

        <Card className="gap-0 p-3 md:min-h-0 md:h-full">
          {!selectedSummary ? (
            <p className="text-sm text-muted-foreground">Select a node to inspect models.</p>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <h3 className="truncate text-sm font-semibold tracking-tight">
                      {selectedSummary.info?.name ||
                        selectedSummary.provider?.name ||
                        hostFromBaseUrl(selectedSummary.endpoint)}
                    </h3>
                    {selectedSummary.info?.version ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground leading-tight">
                        v{selectedSummary.info.version}
                      </span>
                    ) : null}
                  </div>
                  <p className="break-all text-[11px] text-muted-foreground leading-tight">
                    {withTrailingSlash(selectedSummary.endpoint)}
                  </p>
                  {selectedSummary.info?.description || selectedSummary.provider?.description ? (
                    <p className="truncate text-xs text-muted-foreground">
                      {selectedSummary.info?.description || selectedSummary.provider?.description}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {selectedSummary.isReachable ? (
                  <CheckCircle2 className="h-3 w-3 text-foreground/85" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                <span>
                  {selectedSummary.isReachable
                    ? "Reachable"
                    : selectedSummary.error || "Currently unreachable"}
                </span>
                <span>•</span>
                <span>{filteredDisplayModels.length} models</span>
              </div>

              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
                <Input
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder="Search models"
                />
                <Select
                  value={modelSort}
                  onValueChange={(value) => setModelSort(value as ModelSortOption)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="name">Sort: Name</SelectItem>
                    <SelectItem value="release-new">Sort: Newest</SelectItem>
                    <SelectItem value="release-old">Sort: Oldest</SelectItem>
                    <SelectItem value="price-low">Sort: Cheapest</SelectItem>
                    <SelectItem value="price-high">Sort: Most Expensive</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="mt-2.5 min-h-0 flex-1 overflow-auto overscroll-y-contain space-y-1.5 pr-1">
                {filteredDisplayModels.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {displayModels.length === 0 ? "No models returned." : "No models match this search."}
                  </p>
                ) : (
                  filteredDisplayModels.map((model) => {
                    const modelId = String(model.id);
                    const modelName =
                      typeof model.name === "string" && model.name.trim().length > 0
                        ? model.name
                        : modelId;
                    const promptCost = model.sats_pricing?.prompt;
                    const completionCost = model.sats_pricing?.completion;
                    return (
                      <div
                        key={modelId}
                        className="cursor-pointer rounded-md border border-border/70 bg-muted/15 px-2.5 py-2 transition-colors hover:bg-muted/25"
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpenModelDetail(model)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleOpenModelDetail(model);
                          }
                        }}
                        aria-label={`Open model details for ${modelId}`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex items-center gap-1.5">
                            <p className="truncate text-sm font-medium leading-tight">
                              {modelName}
                            </p>
                            <span className="shrink-0 text-[11px] text-muted-foreground">•</span>
                            <p className="truncate text-[11px] text-muted-foreground leading-tight">
                              {modelId}
                            </p>
                            <Button
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleCopy(modelId);
                              }}
                              variant="ghost"
                              size="icon-xs"
                              type="button"
                              className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                              title="Copy model id"
                            >
                              <Copy className="h-2.5 w-2.5" />
                              <span className="sr-only">Copy model id</span>
                            </Button>
                          </div>
                        </div>
                        <p
                          className="mt-0.5 truncate text-[11px] text-muted-foreground leading-tight"
                          title={
                            typeof promptCost === "number" || typeof completionCost === "number"
                              ? `Prompt ${formatPriceValue(toPerMillionTokens(promptCost))} sats / 1M, completion ${formatPriceValue(toPerMillionTokens(completionCost))} sats / 1M`
                              : "Pricing unavailable"
                          }
                        >
                          {typeof promptCost === "number" || typeof completionCost === "number"
                            ? `p ${formatPriceValue(toPerMillionTokens(promptCost))} • c ${formatPriceValue(toPerMillionTokens(completionCost))} sats / 1M`
                            : "Pricing unavailable"}
                        </p>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </Card>
      </section>

      <Dialog
        open={Boolean(selectedModelDetail)}
        onOpenChange={(open) => {
          if (!open) setSelectedModelDetail(null);
        }}
      >
        <DialogContent className="max-h-[95svh] p-4 sm:max-w-3xl sm:p-5">
          <DialogHeader className="pr-8 text-left">
            <DialogTitle className="flex flex-wrap items-center gap-1.5 pr-2 text-left">
              <span className="min-w-0 flex-1 truncate text-base font-semibold">
                {selectedModelName}
              </span>
              {selectedModelId ? (
                <>
                  <span className="text-muted-foreground text-xs">•</span>
                  <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground">
                    {selectedModelId}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    className="h-5 w-5 shrink-0"
                    onClick={() => void handleCopy(selectedModelId)}
                    title="Copy model id"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    <span className="sr-only">Copy model id</span>
                  </Button>
                </>
              ) : null}
            </DialogTitle>
            <DialogDescription>
              Full model info and price comparison across discovered nodes.
            </DialogDescription>
          </DialogHeader>

          {selectedModelDetail ? (
            <div className="max-h-[calc(100svh-11.5rem)] space-y-3 overflow-auto pr-1 sm:max-h-[70vh]">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-border/70 bg-muted/15 px-2.5 py-2">
                  <p className="text-[11px] text-muted-foreground">Node</p>
                  <p className="truncate text-sm font-medium">{selectedModelDetail.nodeLabel}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {hostFromBaseUrl(selectedModelDetail.endpoint)}
                  </p>
                </div>
                <div className="rounded-md border border-border/70 bg-muted/15 px-2.5 py-2">
                  <p className="text-[11px] text-muted-foreground">Selected node pricing</p>
                  <p className="text-sm font-medium tabular-nums">
                    p {formatPriceValue(toPerMillionTokens(selectedModelDetail.model.sats_pricing?.prompt))}
                    <span className="mx-1.5 text-muted-foreground">•</span>
                    c {formatPriceValue(toPerMillionTokens(selectedModelDetail.model.sats_pricing?.completion))}
                  </p>
                  <p className="text-[11px] text-muted-foreground">sats / 1M tokens</p>
                </div>
              </div>

              <div className="rounded-md border border-border/70 bg-muted/10 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">Price Comparison</h4>
                  <span className="text-[11px] text-muted-foreground">
                    sats / 1M tokens
                  </span>
                </div>
                {pricingComparisonRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No comparable pricing data found for this model on other nodes.
                  </p>
                ) : (
                  <div className="divide-y divide-border/60">
                    {pricingComparisonRows.map((entry) => {
                      const promptWidth = Math.max(
                        2,
                        (entry.promptPrice / maxComparisonPrice) * 100
                      );
                      const completionWidth = Math.max(
                        2,
                        (entry.completionPrice / maxComparisonPrice) * 100
                      );
                      return (
                        <div
                          key={`${entry.endpoint}-${selectedModelId}`}
                          className="py-2.5 first:pt-0 last:pb-0"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <p className="truncate text-xs font-medium">{entry.nodeLabel}</p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {hostFromBaseUrl(entry.endpoint)}
                            </p>
                          </div>
                          <div className="space-y-1.5">
                            <div className="grid grid-cols-[2.8rem_minmax(0,1fr)_7.4rem] items-center gap-2 text-[11px]">
                              <span className="text-muted-foreground">Input</span>
                              <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                                <div
                                  className="h-full rounded-full bg-emerald-500/80 transition-all"
                                  style={{ width: `${promptWidth}%` }}
                                />
                              </div>
                              <span className="text-right tabular-nums">
                                {formatPriceValue(entry.promptPrice)}
                              </span>
                            </div>
                            <div className="grid grid-cols-[2.8rem_minmax(0,1fr)_7.4rem] items-center gap-2 text-[11px]">
                              <span className="text-muted-foreground">Output</span>
                              <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                                <div
                                  className="h-full rounded-full bg-blue-500/80 transition-all"
                                  style={{ width: `${completionWidth}%` }}
                                />
                              </div>
                              <span className="text-right tabular-nums">
                                {formatPriceValue(entry.completionPrice)}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="rounded-md border border-border/70 p-3">
                <h4 className="mb-2 text-sm font-semibold">Model Fields</h4>
                <div className="space-y-0.5">
                  {selectedModelFieldRows.map((row, index) => (
                    <div
                      key={`${row.label}-${index}`}
                      className="grid gap-1 border-b border-border/60 py-1.5 last:border-0 sm:grid-cols-[10rem_minmax(0,1fr)]"
                    >
                      <p className="text-[11px] font-medium text-muted-foreground">{row.label}</p>
                      {row.isMarkdown ? (
                        <div className="min-w-0 break-words text-[11px] leading-5 text-foreground [&_a]:break-all [&_a]:underline [&_a]:underline-offset-2">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              p: ({ children }) => <p className="m-0">{children}</p>,
                              a: ({ href, children }) => (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="underline underline-offset-2"
                                >
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {row.value}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <p className="break-all text-[11px] text-foreground">{row.value}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
