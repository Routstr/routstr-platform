"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useObservableState } from "applesauce-react/hooks";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  Code2,
  Copy,
  Loader2,
  MessageCircle,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { useAccountManager } from "@/components/providers/ClientProviders";
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
import SettingsDialog from "@/components/ui/SettingsDialog";
import SearchableSelect, {
  SearchableSelectOption,
} from "@/components/ui/searchable-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type DirectoryProvider = {
  endpoint_url?: string;
  endpoint_urls?: string[];
  http_url?: string;
  onion_url?: string;
  onion_urls?: string[];
};

type NodeModel = {
  id?: string;
  name?: string;
};

type StoredApiKey = {
  key: string;
  balance: number | null;
  label?: string;
  baseUrl?: string;
  isInvalid?: boolean;
};

type PlaygroundSettings = {
  endpoint: string;
  selectedModelId: string;
  selectedApiKeyId: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
};

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

type RunStatus = "idle" | "running" | "success" | "error";

type RunState = {
  status: RunStatus;
  latencyMs: number | null;
  rawJson: string;
  error: string | null;
  completedAt: number | null;
};

type CodeSnippetKind = "curl" | "javascript" | "python";
type CodeSnippetLanguage = "bash" | "javascript" | "python";

const PLAYGROUND_SETTINGS_STORAGE_KEY_PREFIX = "platform_playground_settings_v1:";
const DEFAULT_MODEL_ID = "gpt-5.2";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_MAX_TOKENS = 512;

function navigateToApiKeysTab(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("platform:navigate-tab", {
      detail: { tab: "api-keys" },
    })
  );
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
    if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) {
      return;
    }
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
    add(keyData.baseUrl);
  }

  add(localStorage.getItem("platform_active_base_url"));

  return Array.from(endpoints).sort((a, b) => a.localeCompare(b));
}

function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEMPERATURE;
  return Math.min(1, Math.max(0, value));
}

function clampMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TOKENS;
  return Math.min(8192, Math.max(1, Math.round(value)));
}

function getErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

function pickPreferredModelId(modelIds: string[]): string {
  const exactDefault = modelIds.find((id) => id === DEFAULT_MODEL_ID);
  if (exactDefault) return exactDefault;

  const routedDefault = modelIds.find((id) => id === `openai/${DEFAULT_MODEL_ID}`);
  if (routedDefault) return routedDefault;

  const partialMatch = modelIds.find((id) =>
    id.toLowerCase().includes(DEFAULT_MODEL_ID.toLowerCase())
  );
  if (partialMatch) return partialMatch;

  return modelIds[0] || DEFAULT_MODEL_ID;
}

function buildRequestBody(params: {
  model: string;
  systemPrompt: string;
  conversation: Array<{ role: ChatRole; content: string }>;
  nextUserMessage: string;
  temperature: number;
  maxTokens: number;
}): {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature: number;
  max_tokens: number;
} {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  const systemText = params.systemPrompt.trim();
  const conversationMessages = params.conversation
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);
  const userText = params.nextUserMessage.trim();

  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }
  messages.push(...conversationMessages);
  if (userText) {
    messages.push({ role: "user", content: userText });
  }

  if (!messages.some((message) => message.role === "user")) {
    messages.push({ role: "user", content: "Hello" });
  }

  return {
    model: params.model,
    messages,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
  };
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const candidate = payload as {
    choices?: Array<{
      message?: { content?: unknown };
      text?: unknown;
    }>;
  };

  const firstChoice = Array.isArray(candidate.choices) ? candidate.choices[0] : null;
  if (!firstChoice) return "";

  if (typeof firstChoice.message?.content === "string") {
    return firstChoice.message.content;
  }

  if (Array.isArray(firstChoice.message?.content)) {
    return firstChoice.message.content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? typeof part.text === "string"
            ? part.text
            : ""
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }

  if (typeof firstChoice.text === "string") {
    return firstChoice.text;
  }

  return "";
}

function extractAssistantDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const candidate = payload as {
    choices?: Array<{
      delta?: { content?: unknown };
      message?: { content?: unknown };
      text?: unknown;
    }>;
  };

  const firstChoice = Array.isArray(candidate.choices) ? candidate.choices[0] : null;
  if (!firstChoice) return "";

  const deltaContent = firstChoice.delta?.content;
  if (typeof deltaContent === "string") {
    return deltaContent;
  }

  if (Array.isArray(deltaContent)) {
    return deltaContent
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? typeof part.text === "string"
            ? part.text
            : ""
          : ""
      )
      .filter(Boolean)
      .join("");
  }

  if (typeof firstChoice.text === "string") {
    return firstChoice.text;
  }

  if (typeof firstChoice.message?.content === "string") {
    return firstChoice.message.content;
  }

  return "";
}

function buildCurlSnippet(url: string, body: unknown): string {
  const payload = JSON.stringify(body, null, 2);
  return [
    `curl -X POST "${url}/v1/chat/completions" \\`,
    '  -H "Authorization: Bearer YOUR_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  --data @- <<'JSON'",
    payload,
    "JSON",
  ].join("\n");
}

function buildJavascriptSnippet(url: string, body: unknown): string {
  const payload = JSON.stringify(body, null, 2);
  return [
    'import OpenAI from "openai";',
    "",
    "const client = new OpenAI({",
    '  apiKey: process.env.ROUTSTR_API_KEY || "YOUR_API_KEY",',
    `  baseURL: "${url}/v1",`,
    "});",
    "",
    `const payload = ${payload};`,
    "",
    "const completion = await client.chat.completions.create(payload);",
    "console.log(completion.choices?.[0]?.message?.content || completion);",
  ].join("\n");
}

function buildPythonSnippet(url: string, body: unknown): string {
  const payload = JSON.stringify(body, null, 2).replace(/'/g, "\\'");
  return [
    "from openai import OpenAI",
    "",
    "client = OpenAI(",
    '    api_key="YOUR_API_KEY",',
    `    base_url="${url}/v1",`,
    ")",
    "",
    `payload = ${payload}`,
    "",
    "completion = client.chat.completions.create(**payload)",
    "print(completion.choices[0].message.content if completion.choices else completion)",
  ].join("\n");
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

    const payload = (await response.json()) as { data?: NodeModel[] } | NodeModel[];
    if (Array.isArray(payload)) return payload;
    return Array.isArray(payload.data) ? payload.data : [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function PlaygroundPanel({
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
  const onBaseUrlChangeRef = useRef(onBaseUrlChange);
  const { manager } = useAccountManager();
  const activeAccount = useObservableState(manager.active$);
  const activePubkey = activeAccount?.pubkey || "anon";
  const settingsStorageKey = `${PLAYGROUND_SETTINGS_STORAGE_KEY_PREFIX}${activePubkey}`;

  const [storedEndpoints, setStoredEndpoints] = useState<string[]>([]);
  const [storedApiKeys, setStoredApiKeys] = useState<StoredApiKey[]>([]);
  const [hydratedSettingsKey, setHydratedSettingsKey] = useState<string | null>(null);
  const [showRequestSettingsDialog, setShowRequestSettingsDialog] = useState(false);
  const [showCodeSnippetsDialog, setShowCodeSnippetsDialog] = useState(false);
  const [selectedSnippetKind, setSelectedSnippetKind] =
    useState<CodeSnippetKind>("curl");

  const [selectedModelId, setSelectedModelId] = useState(DEFAULT_MODEL_ID);
  const [selectedApiKeyId, setSelectedApiKeyId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [draftMessage, setDraftMessage] = useState("");
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const [runState, setRunState] = useState<RunState>({
    status: "idle",
    latencyMs: null,
    rawJson: "",
    error: null,
    completedAt: null,
  });

  useEffect(() => {
    onBaseUrlChangeRef.current = onBaseUrlChange;
  }, [onBaseUrlChange]);

  useEffect(() => {
    const refreshStorageState = () => {
      setStoredEndpoints(readKnownEndpointsFromStorage());
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    setHydratedSettingsKey(null);

    const saved = safeJsonParse<Partial<PlaygroundSettings>>(
      localStorage.getItem(settingsStorageKey),
      {}
    );

    const savedEndpoint =
      typeof saved.endpoint === "string" ? normalizeBaseUrl(saved.endpoint) : "";
    if (savedEndpoint && !isOnionUrl(savedEndpoint) && shouldAllowHttp(savedEndpoint)) {
      onBaseUrlChangeRef.current(withTrailingSlash(savedEndpoint));
    }

    setSelectedModelId(
      typeof saved.selectedModelId === "string" && saved.selectedModelId.trim()
        ? saved.selectedModelId.trim()
        : DEFAULT_MODEL_ID
    );
    setSelectedApiKeyId(
      typeof saved.selectedApiKeyId === "string" ? saved.selectedApiKeyId : ""
    );
    setSystemPrompt(
      typeof saved.systemPrompt === "string"
        ? saved.systemPrompt
        : DEFAULT_SYSTEM_PROMPT
    );
    setTemperature(
      clampTemperature(
        typeof saved.temperature === "number"
          ? saved.temperature
          : DEFAULT_TEMPERATURE
      )
    );
    setMaxTokens(
      clampMaxTokens(
        typeof saved.maxTokens === "number" ? saved.maxTokens : DEFAULT_MAX_TOKENS
      )
    );
    setRunState({
      status: "idle",
      latencyMs: null,
      rawJson: "",
      error: null,
      completedAt: null,
    });
    setChatMessages([]);
    setDraftMessage("");
    setHydratedSettingsKey(settingsStorageKey);
  }, [settingsStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hydratedSettingsKey !== settingsStorageKey) return;

    const settings: PlaygroundSettings = {
      endpoint: withTrailingSlash(normalizedBaseUrl),
      selectedModelId: selectedModelId.trim() || DEFAULT_MODEL_ID,
      selectedApiKeyId,
      systemPrompt,
      temperature: clampTemperature(temperature),
      maxTokens: clampMaxTokens(maxTokens),
    };
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
  }, [
    maxTokens,
    hydratedSettingsKey,
    normalizedBaseUrl,
    selectedApiKeyId,
    selectedModelId,
    settingsStorageKey,
    systemPrompt,
    temperature,
  ]);

  const { data: providersDirectory } = useQuery({
    queryKey: ["playground-providers-directory"],
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
  const endpointOptions = useMemo<SearchableSelectOption[]>(
    () =>
      discoveredEndpoints.map((endpoint) => ({
        value: endpoint,
        label: withTrailingSlash(endpoint),
        keywords: [endpoint, withTrailingSlash(endpoint)],
      })),
    [discoveredEndpoints]
  );

  const { data: models } = useQuery({
    queryKey: ["playground-models", normalizedBaseUrl],
    queryFn: () => fetchNodeModels(normalizedBaseUrl),
    staleTime: 120_000,
    refetchInterval: 300_000,
  });

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    return (models || []).reduce<Array<{ id: string; label: string }>>(
      (accumulator, model) => {
        const modelId = typeof model.id === "string" ? model.id.trim() : "";
        if (!modelId || seen.has(modelId)) return accumulator;
        seen.add(modelId);

        const modelName = typeof model.name === "string" ? model.name.trim() : "";
        const label =
          modelName && modelName !== modelId
            ? `${modelName} (${modelId})`
            : modelId;
        accumulator.push({ id: modelId, label });
        return accumulator;
      },
      []
    );
  }, [models]);

  const preferredModelId = useMemo(
    () => pickPreferredModelId(modelOptions.map((model) => model.id)),
    [modelOptions]
  );
  const modelForRequest = selectedModelId.trim() || preferredModelId;
  const modelSearchOptions = useMemo<SearchableSelectOption[]>(() => {
    const options = modelOptions.map((model) => ({
      value: model.id,
      label: model.label,
      keywords: [model.id, model.label],
    }));

    if (
      modelForRequest &&
      !options.some((option) => option.value === modelForRequest)
    ) {
      options.unshift({
        value: modelForRequest,
        label: modelForRequest,
        keywords: [modelForRequest],
      });
    }

    return options;
  }, [modelForRequest, modelOptions]);

  useEffect(() => {
    setSelectedModelId((current) => {
      if (modelOptions.some((model) => model.id === current)) {
        return current;
      }
      return preferredModelId;
    });
  }, [modelOptions, preferredModelId, normalizedBaseUrl]);

  const endpointScopedKeys = useMemo(() => {
    return storedApiKeys.filter((keyData) => {
      const keyBase = normalizeBaseUrl(keyData.baseUrl || normalizedBaseUrl);
      return keyBase === normalizedBaseUrl;
    });
  }, [normalizedBaseUrl, storedApiKeys]);

  const selectedEndpointKey = useMemo(() => {
    if (!endpointScopedKeys.length) return null;
    if (selectedApiKeyId) {
      const selected = endpointScopedKeys.find((keyData) => keyData.key === selectedApiKeyId);
      if (selected) return selected;
    }
    return (
      endpointScopedKeys.find((keyData) => !keyData.isInvalid) ||
      endpointScopedKeys[0] ||
      null
    );
  }, [endpointScopedKeys, selectedApiKeyId]);

  const endpointKeyOptions = useMemo<SearchableSelectOption[]>(() => {
    return endpointScopedKeys.map((keyData) => {
      const label = keyData.label?.trim();
      const keyText =
        keyData.key.length > 16
          ? `${keyData.key.slice(0, 8)}...${keyData.key.slice(-6)}`
          : keyData.key;
      const invalidSuffix = keyData.isInvalid ? " (invalid)" : "";
      return {
        value: keyData.key,
        label: label ? `${label} • ${keyText}${invalidSuffix}` : `${keyText}${invalidSuffix}`,
        keywords: [keyData.key, keyText, label || "", keyData.baseUrl || ""],
      };
    });
  }, [endpointScopedKeys]);

  useEffect(() => {
    if (!endpointScopedKeys.length) {
      if (selectedApiKeyId) {
        setSelectedApiKeyId("");
      }
      return;
    }
    if (endpointScopedKeys.some((keyData) => keyData.key === selectedApiKeyId)) {
      return;
    }
    const fallback =
      endpointScopedKeys.find((keyData) => !keyData.isInvalid) ||
      endpointScopedKeys[0];
    setSelectedApiKeyId(fallback?.key || "");
  }, [endpointScopedKeys, selectedApiKeyId]);

  const canRun =
    Boolean(selectedEndpointKey) &&
    !selectedEndpointKey?.isInvalid &&
    Boolean(modelForRequest.trim()) &&
    Boolean(draftMessage.trim());

  const conversationForRequest = useMemo(
    () =>
      chatMessages
        .map((message) => ({
          role: message.role,
          content: message.content.trim(),
        }))
        .filter((message) => message.content.length > 0),
    [chatMessages]
  );

  const requestBody = useMemo(
    () =>
      buildRequestBody({
        model: modelForRequest,
        systemPrompt,
        conversation: conversationForRequest,
        nextUserMessage: draftMessage,
        temperature: clampTemperature(temperature),
        maxTokens: clampMaxTokens(maxTokens),
      }),
    [
      conversationForRequest,
      draftMessage,
      maxTokens,
      modelForRequest,
      systemPrompt,
      temperature,
    ]
  );

  const curlSnippet = useMemo(
    () => buildCurlSnippet(normalizedBaseUrl, requestBody),
    [normalizedBaseUrl, requestBody]
  );
  const javascriptSnippet = useMemo(
    () => buildJavascriptSnippet(normalizedBaseUrl, requestBody),
    [normalizedBaseUrl, requestBody]
  );
  const pythonSnippet = useMemo(
    () => buildPythonSnippet(normalizedBaseUrl, requestBody),
    [normalizedBaseUrl, requestBody]
  );
  const codeSnippetOptions = useMemo(
    () =>
      [
        { id: "curl", label: "cURL", language: "bash", snippet: curlSnippet },
        {
          id: "javascript",
          label: "JavaScript",
          language: "javascript",
          snippet: javascriptSnippet,
        },
        { id: "python", label: "Python", language: "python", snippet: pythonSnippet },
      ] as const,
    [curlSnippet, javascriptSnippet, pythonSnippet]
  );
  const selectedCodeSnippet =
    codeSnippetOptions.find((option) => option.id === selectedSnippetKind) ||
    codeSnippetOptions[0];

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Unable to copy");
    }
  };

  const handleEndpointChange = (value: string) => {
    const normalized = normalizeBaseUrl(value);
    if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) {
      toast.error("Use a valid HTTPS endpoint");
      return;
    }
    onBaseUrlChangeRef.current(withTrailingSlash(normalized));
  };

  const runRequest = async () => {
    if (!canRun || !selectedEndpointKey) {
      toast.error("Add a valid API key and type a message first");
      return;
    }

    const nextUserMessage = draftMessage.trim();
    const userMessageEntry: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: nextUserMessage,
      createdAt: Date.now(),
    };
    const requestPayload = buildRequestBody({
      model: modelForRequest,
      systemPrompt,
      conversation: conversationForRequest,
      nextUserMessage,
      temperature: clampTemperature(temperature),
      maxTokens: clampMaxTokens(maxTokens),
    });

    setChatMessages((current) => [...current, userMessageEntry]);
    setDraftMessage("");

    const startedAt = performance.now();
    setRunState({
      status: "running",
      latencyMs: null,
      rawJson: "",
      error: null,
      completedAt: null,
    });

    try {
      const response = await fetch(`${normalizedBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${selectedEndpointKey.key}`,
        },
        body: JSON.stringify({ ...requestPayload, stream: true }),
      });

      if (!response.ok) {
        const rawText = await response.text();
        const latencyMs = Math.round(performance.now() - startedAt);
        let parsedPayload: unknown = null;
        try {
          parsedPayload = rawText ? JSON.parse(rawText) : null;
        } catch {
          parsedPayload = null;
        }

        const detail =
          parsedPayload &&
          typeof parsedPayload === "object" &&
          ("detail" in parsedPayload || "error" in parsedPayload)
            ? (() => {
                const payload = parsedPayload as { detail?: unknown; error?: unknown };
                if (typeof payload.detail === "string" && payload.detail) {
                  return payload.detail;
                }
                if (typeof payload.error === "string" && payload.error) {
                  return payload.error;
                }
                return `Request failed (${response.status})`;
              })()
            : rawText || `Request failed (${response.status})`;

        setRunState({
          status: "error",
          latencyMs,
          rawJson:
            parsedPayload !== null
              ? JSON.stringify(parsedPayload, null, 2)
              : rawText || "{}",
          error: detail,
          completedAt: Date.now(),
        });
        toast.error("Request failed");
        return;
      }

      const assistantMessageId = createMessageId();
      const assistantCreatedAt = Date.now();
      setChatMessages((current) => [
        ...current,
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          createdAt: assistantCreatedAt,
        },
      ]);

      let streamedAssistantText = "";
      let rawResponseText = "";
      const updateAssistantMessage = (nextContent: string) => {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content: nextContent }
              : message
          )
        );
      };

      const contentType = response.headers.get("content-type") || "";
      const isEventStream = contentType.includes("text/event-stream");
      const reader = response.body?.getReader();

      if (reader) {
        const decoder = new TextDecoder();
        let sseBuffer = "";

        const processSseChunk = (flush: boolean) => {
          const eventParts = sseBuffer.split(/\r?\n\r?\n/);
          if (!flush) {
            sseBuffer = eventParts.pop() || "";
          } else {
            sseBuffer = "";
          }

          for (const eventBlock of eventParts) {
            const dataLines = eventBlock
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());

            if (dataLines.length === 0) continue;
            const dataPayload = dataLines.join("\n").trim();
            if (!dataPayload || dataPayload === "[DONE]") continue;

            try {
              const parsed = JSON.parse(dataPayload) as unknown;
              const deltaText = extractAssistantDelta(parsed);
              if (deltaText) {
                streamedAssistantText += deltaText;
                updateAssistantMessage(streamedAssistantText);
              }
            } catch {
              streamedAssistantText += dataPayload;
              updateAssistantMessage(streamedAssistantText);
            }
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          const chunkText = decoder.decode(value, { stream: true });
          rawResponseText += chunkText;

          if (isEventStream || chunkText.includes("data:")) {
            sseBuffer += chunkText;
            processSseChunk(false);
          }
        }

        const finalChunk = decoder.decode();
        if (finalChunk) {
          rawResponseText += finalChunk;
          if (isEventStream || finalChunk.includes("data:")) {
            sseBuffer += finalChunk;
          }
        }
        if (isEventStream || sseBuffer.includes("data:")) {
          processSseChunk(true);
        }
      } else {
        rawResponseText = await response.text();
      }

      let parsedPayload: unknown = null;
      if (rawResponseText.trim().length > 0) {
        try {
          parsedPayload = JSON.parse(rawResponseText);
        } catch {
          parsedPayload = null;
        }
      }

      if (!streamedAssistantText) {
        const assistantText =
          parsedPayload !== null
            ? extractAssistantText(parsedPayload)
            : rawResponseText;
        const assistantOutput = assistantText || "(No assistant text returned)";
        streamedAssistantText = assistantOutput;
        updateAssistantMessage(assistantOutput);
      }

      const latencyMs = Math.round(performance.now() - startedAt);
      const assistantMessageEntry: ChatMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: streamedAssistantText,
        createdAt: assistantCreatedAt,
      };
      setChatMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageEntry.id ? assistantMessageEntry : message
        )
      );
      setRunState({
        status: "success",
        latencyMs,
        rawJson:
          parsedPayload !== null
            ? JSON.stringify(parsedPayload, null, 2)
            : rawResponseText || "{}",
        error: null,
        completedAt: Date.now(),
      });
    } catch (error) {
      setRunState({
        status: "error",
        latencyMs: Math.round(performance.now() - startedAt),
        rawJson: "",
        error: getErrorMessage(error, "Request failed"),
        completedAt: Date.now(),
      });
      toast.error("Request failed");
    }
  };

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [chatMessages, runState.status]);

  return (
    <div className="min-w-0 space-y-3">
      <section className="space-y-3">
        <Card className="gap-0 p-3">
          <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Endpoint</span>
              <SearchableSelect
                value={normalizedBaseUrl}
                onValueChange={handleEndpointChange}
                options={endpointOptions}
                placeholder="Select endpoint"
                searchPlaceholder="Search endpoints..."
                emptyMessage="No endpoint found."
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Model</span>
              <SearchableSelect
                value={modelForRequest}
                onValueChange={setSelectedModelId}
                options={modelSearchOptions}
                placeholder="Select model"
                searchPlaceholder="Search models..."
                emptyMessage="No model found."
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">API key</span>
              {endpointKeyOptions.length > 0 ? (
                <SearchableSelect
                  value={selectedEndpointKey?.key || ""}
                  onValueChange={setSelectedApiKeyId}
                  options={endpointKeyOptions}
                  placeholder="Select API key"
                  searchPlaceholder="Search API keys..."
                  emptyMessage="No API key found."
                />
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={navigateToApiKeysTab}
                  className="w-full"
                >
                  Add API Key
                </Button>
              )}
            </label>

            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setShowRequestSettingsDialog(true)}
              className="md:mb-0.5"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Settings
            </Button>
          </div>

          {selectedEndpointKey?.isInvalid ? (
            <p className="mt-2 text-xs text-muted-foreground">
              This key is marked invalid. Refresh or replace it in API Keys.
            </p>
          ) : null}
        </Card>

        <Card className="gap-0 h-[58svh] min-h-[18rem] overflow-hidden p-0 sm:h-[68vh] sm:min-h-[24rem] xl:h-[calc(100vh-13rem)] xl:min-h-0">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4">
            <h3 className="text-base font-semibold tracking-tight">Chat</h3>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                onClick={() => setShowCodeSnippetsDialog(true)}
                aria-label="Open code snippets"
              >
                <Code2 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setChatMessages([])}
                disabled={chatMessages.length === 0 || runState.status === "running"}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Clear
              </Button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
            {chatMessages.length === 0 ? (
              <div className="flex h-full min-h-[14rem] flex-col items-center justify-center gap-3 text-center sm:min-h-[18rem]">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border/80 bg-muted/35">
                  <MessageCircle className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">
                  Your conversation will appear here
                </p>
              </div>
            ) : (
              <div className="space-y-5 pb-3">
                {chatMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex w-full ${
                      message.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[92%] ${
                        message.role === "user" ? "text-right" : "text-left"
                      }`}
                    >
                      {message.role === "assistant" ? (
                        <div className="px-1 text-sm leading-6 break-words">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                              ul: ({ children }) => (
                                <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0">
                                  {children}
                                </ul>
                              ),
                              ol: ({ children }) => (
                                <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0">
                                  {children}
                                </ol>
                              ),
                              li: ({ children }) => <li>{children}</li>,
                              a: ({ href, children }) => (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
                                >
                                  {children}
                                </a>
                              ),
                              blockquote: ({ children }) => (
                                <blockquote className="mb-3 border-l-2 border-border/70 pl-3 text-muted-foreground last:mb-0">
                                  {children}
                                </blockquote>
                              ),
                              pre: ({ children }) => <>{children}</>,
                              code: (props) => {
                                const {
                                  className,
                                  children,
                                  ...rest
                                } = props as {
                                  className?: string;
                                  children?: React.ReactNode;
                                  inline?: boolean;
                                };
                                const inline = Boolean((props as { inline?: boolean }).inline);
                                const match = /language-(\w+)/.exec(className || "");
                                const codeText = String(children || "").replace(/\n$/, "");

                                if (!inline && match) {
                                  return (
                                    <div className="my-2 overflow-hidden rounded-md border border-border/70">
                                      <SyntaxHighlighter
                                        language={match[1]}
                                        style={oneDark}
                                        wrapLongLines
                                        customStyle={{
                                          margin: 0,
                                          padding: "0.75rem",
                                          fontSize: "0.75rem",
                                          lineHeight: "1.4",
                                        }}
                                        codeTagProps={{
                                          style: {
                                            fontFamily:
                                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                          },
                                        }}
                                      >
                                        {codeText}
                                      </SyntaxHighlighter>
                                    </div>
                                  );
                                }

                                return (
                                  <code
                                    className="rounded bg-muted/40 px-1 py-0.5 font-mono text-[0.82em]"
                                    {...rest}
                                  >
                                    {children}
                                  </code>
                                );
                              },
                            }}
                          >
                            {message.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <div className="px-1 text-sm leading-6 whitespace-pre-wrap">
                          {message.content}
                        </div>
                      )}
                      <p className="mt-1 px-1 text-[11px] text-muted-foreground/85">
                        {message.role === "user" ? "You" : "Assistant"} •{" "}
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {runState.status === "running" ? (
              <div className="mr-auto mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Generating response...
              </div>
            ) : null}
            <div ref={conversationEndRef} />
          </div>

          <div className="bg-card/95 px-3 py-2.5 sm:px-4">
            {runState.status === "error" ? (
              <div className="mb-2 rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs">
                {runState.error || "Request failed"}
              </div>
            ) : null}

            <div className="rounded-2xl border border-border/70 bg-muted/30">
              <textarea
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                placeholder="Type a message..."
                className="min-h-[56px] max-h-40 w-full resize-none bg-transparent px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (canRun && runState.status !== "running") {
                      void runRequest();
                    }
                  }
                }}
              />
              <div className="flex items-center justify-end px-3 py-1.5">
                <Button
                  size="icon-sm"
                  type="button"
                  onClick={() => void runRequest()}
                  disabled={!canRun || runState.status === "running"}
                  aria-label="Send message"
                >
                  {runState.status === "running" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </section>

      <Dialog open={showCodeSnippetsDialog} onOpenChange={setShowCodeSnippetsDialog}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Code Snippets</DialogTitle>
            <DialogDescription>
              Use the current endpoint, model, and message payload.
            </DialogDescription>
          </DialogHeader>
          <Tabs
            value={selectedSnippetKind}
            onValueChange={(value) => setSelectedSnippetKind(value as CodeSnippetKind)}
            className="gap-3"
          >
            <div className="flex items-center gap-2">
              <TabsList variant="line">
                {codeSnippetOptions.map((option) => (
                  <TabsTrigger key={option.id} value={option.id}>
                    {option.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                className="ml-auto"
                onClick={() => void handleCopy(selectedCodeSnippet.snippet)}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
            </div>

            {codeSnippetOptions.map((option) => (
              <TabsContent key={option.id} value={option.id} className="mt-0">
                <div className="overflow-hidden rounded-lg border border-border/70 bg-zinc-950">
                  <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                    <p className="text-xs font-medium text-foreground">{option.label}</p>
                    <p className="text-xs text-muted-foreground break-all">
                      {withTrailingSlash(normalizedBaseUrl)}
                    </p>
                  </div>
                  <div className="max-h-[55vh] overflow-auto">
                    <SyntaxHighlighter
                      language={option.language as CodeSnippetLanguage}
                      style={oneDark}
                      showLineNumbers
                      wrapLongLines
                      customStyle={{
                        margin: 0,
                        background: "transparent",
                        padding: "0.75rem",
                        fontSize: "0.75rem",
                        lineHeight: "1.4",
                      }}
                      codeTagProps={{
                        style: {
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        },
                      }}
                    >
                      {option.snippet}
                    </SyntaxHighlighter>
                  </div>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </DialogContent>
      </Dialog>

      <SettingsDialog
        open={showRequestSettingsDialog}
        onOpenChange={setShowRequestSettingsDialog}
        title="Playground Request Settings"
      >
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-foreground">Request Settings</h3>
          <p className="text-sm text-muted-foreground">
            Adjust system prompt and generation parameters.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 block">
              <span className="text-xs text-muted-foreground">Temperature</span>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={temperature}
                onChange={(event) => {
                  const parsed = Number.parseFloat(event.target.value);
                  setTemperature(Number.isFinite(parsed) ? parsed : DEFAULT_TEMPERATURE);
                }}
                onBlur={() => setTemperature((current) => clampTemperature(current))}
              />
            </label>

            <label className="space-y-1 block">
              <span className="text-xs text-muted-foreground">Max tokens</span>
              <Input
                type="number"
                min={1}
                max={8192}
                step={1}
                value={maxTokens}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  setMaxTokens(Number.isFinite(parsed) ? parsed : DEFAULT_MAX_TOKENS);
                }}
                onBlur={() => setMaxTokens((current) => clampMaxTokens(current))}
              />
            </label>
          </div>

          <label className="space-y-1 block">
            <span className="text-xs text-muted-foreground">System prompt</span>
            <Textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className="min-h-24"
            />
          </label>

          <div className="flex justify-end gap-2">
            <Button
              onClick={() => setShowRequestSettingsDialog(false)}
              variant="ghost"
              type="button"
            >
              Close
            </Button>
          </div>
        </div>
      </SettingsDialog>
    </div>
  );
}
