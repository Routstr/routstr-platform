"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Key,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { SimplePool, type Event as NostrEvent, type EventTemplate } from "nostr-tools";
import { toast } from "sonner";
import { useObservableState } from "applesauce-react/hooks";
import { useAccountManager } from "@/components/providers/ClientProviders";
import { DEFAULT_BASE_URL } from "@/lib/utils";
import { ModalShell } from "@/components/ui/ModalShell";
import SettingsDialog from "@/components/ui/SettingsDialog";
import NodeKeyWorkflows from "@/components/platform/NodeKeyWorkflows";

export interface StoredApiKey {
  key: string;
  balance: number | null;
  label?: string;
  baseUrl?: string;
  isInvalid?: boolean;
}

type DirectoryProvider = {
  endpoint_url?: string;
  endpoint_urls?: string[];
  http_url?: string;
  onion_url?: string;
  onion_urls?: string[];
};

type ProviderModel = {
  id?: string;
  sats_pricing?: {
    prompt?: number;
    completion?: number;
  } | null;
};

const CHAT_LOCAL_API_KEYS_STORAGE_KEY = "api_keys";
const LEGACY_PLATFORM_LOCAL_STORAGE_KEY = "platform_api_keys_local";
const CHAT_BASE_URLS_STORAGE_KEY = "base_urls_list";
const CHAT_PROVIDER_MODELS_STORAGE_KEY = "modelsFromAllProviders";
const NOSTR_APP_CONFIG_STORAGE_KEY = "nostr:app-config";
const NOSTR_RELAYS_STORAGE_KEY = "nostr_relays";
const API_KEYS_SYNC_KIND = 30078;
const API_KEYS_SYNC_D_TAG = "routstr-chat-api-keys-v1";
const DEFAULT_SYNC_RELAYS = [
  "wss://relay.routstr.com",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
];

type CloudSyncCapableAccount = {
  pubkey: string;
  signEvent: (event: EventTemplate) => Promise<NostrEvent>;
  nip44: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
};

function isCloudSyncCapableAccount(
  account: unknown
): account is CloudSyncCapableAccount {
  if (!account || typeof account !== "object") return false;
  const candidate = account as Partial<CloudSyncCapableAccount>;
  return Boolean(
    typeof candidate.pubkey === "string" &&
      candidate.pubkey.length > 0 &&
      typeof candidate.signEvent === "function" &&
      candidate.nip44 &&
      typeof candidate.nip44.encrypt === "function" &&
      typeof candidate.nip44.decrypt === "function"
  );
}

function parseStoredApiKeys(raw: string | null): StoredApiKey[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is StoredApiKey =>
          !!item &&
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

function uniqueRelayUrls(candidates: string[]): string[] {
  const urls = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (!/^wss?:\/\//i.test(trimmed)) continue;
    urls.add(trimmed);
  }
  return Array.from(urls);
}

function getConfiguredRelayUrls(): string[] {
  if (typeof window === "undefined") return DEFAULT_SYNC_RELAYS;

  const fromAppConfig = (() => {
    try {
      const raw = localStorage.getItem(NOSTR_APP_CONFIG_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { relayUrls?: string[] };
      return Array.isArray(parsed?.relayUrls) ? parsed.relayUrls : [];
    } catch {
      return [];
    }
  })();

  const fromRelayStorage = (() => {
    try {
      const raw = localStorage.getItem(NOSTR_RELAYS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const relays = uniqueRelayUrls([
    ...fromAppConfig,
    ...fromRelayStorage,
    ...DEFAULT_SYNC_RELAYS,
  ]);
  return relays.length > 0 ? relays : DEFAULT_SYNC_RELAYS;
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

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;
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

function readStoredBaseUrls(): string[] {
  if (typeof window === "undefined") return [];

  const urls = new Set<string>();
  const addUrl = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) return;
    urls.add(normalized);
  };

  const baseUrlsList = safeJsonParse<unknown[]>(
    localStorage.getItem(CHAT_BASE_URLS_STORAGE_KEY),
    []
  );
  for (const item of baseUrlsList) {
    addUrl(item);
  }

  const modelsByProvider = safeJsonParse<Record<string, unknown>>(
    localStorage.getItem(CHAT_PROVIDER_MODELS_STORAGE_KEY),
    {}
  );
  for (const key of Object.keys(modelsByProvider)) {
    addUrl(key);
  }

  const localApiKeys = parseStoredApiKeys(
    localStorage.getItem(CHAT_LOCAL_API_KEYS_STORAGE_KEY)
  );
  for (const keyData of localApiKeys) {
    addUrl(keyData.baseUrl);
  }

  addUrl(localStorage.getItem("platform_active_base_url"));
  return Array.from(urls);
}

async function fetchAvailableModelCount(baseUrl: string): Promise<number> {
  try {
    const response = await fetch(`${baseUrl}v1/models`, { cache: "no-store" });
    if (!response.ok) return 0;
    const payload = (await response.json()) as { data?: ProviderModel[] };
    const models = Array.isArray(payload.data) ? payload.data : [];
    return models.filter(
      (model) =>
        typeof model?.id === "string" &&
        model.id.length > 0 &&
        Boolean(model.sats_pricing)
    ).length;
  } catch {
    return 0;
  }
}

function formatSats(balanceMsats: number | null): string {
  if (balanceMsats === null) return "N/A";
  return `${(balanceMsats / 1000).toFixed(2)} sats`;
}

function getKeyBaseUrl(keyData: StoredApiKey, fallbackBaseUrl: string): string {
  return normalizeBaseUrl(keyData.baseUrl || fallbackBaseUrl) || fallbackBaseUrl;
}

function getKeyCompositeId(keyData: StoredApiKey, fallbackBaseUrl: string): string {
  return `${getKeyBaseUrl(keyData, fallbackBaseUrl)}::${keyData.key}`;
}

function normalizeStoredKeys(
  keys: StoredApiKey[],
  fallbackBaseUrl: string
): StoredApiKey[] {
  const deduped = new Map<string, StoredApiKey>();
  for (const keyData of keys) {
    const normalized: StoredApiKey = {
      ...keyData,
      label: keyData.label || "Unnamed",
      baseUrl: getKeyBaseUrl(keyData, fallbackBaseUrl),
    };
    deduped.set(getKeyCompositeId(normalized, fallbackBaseUrl), normalized);
  }
  return Array.from(deduped.values());
}

function readLocalApiKeys(
  fallbackBaseUrl: string,
  activePubkey: string | null
): StoredApiKey[] {
  if (typeof window === "undefined") return [];

  const unified = parseStoredApiKeys(
    localStorage.getItem(CHAT_LOCAL_API_KEYS_STORAGE_KEY)
  );
  const legacyLocal = parseStoredApiKeys(
    localStorage.getItem(LEGACY_PLATFORM_LOCAL_STORAGE_KEY)
  );
  const legacyAccountScoped = activePubkey
    ? parseStoredApiKeys(localStorage.getItem(`platform_api_keys_${activePubkey}`))
    : [];

  const merged = normalizeStoredKeys(
    [...unified, ...legacyLocal, ...legacyAccountScoped],
    fallbackBaseUrl
  );

  if (merged.length > 0) {
    localStorage.setItem(CHAT_LOCAL_API_KEYS_STORAGE_KEY, JSON.stringify(merged));
  }

  return merged;
}

async function fetchCloudApiKeys(
  account: CloudSyncCapableAccount,
  fallbackBaseUrl: string
): Promise<StoredApiKey[]> {
  const relays = getConfiguredRelayUrls();
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      relays,
      {
        kinds: [API_KEYS_SYNC_KIND],
        authors: [account.pubkey],
        "#d": [API_KEYS_SYNC_D_TAG],
        limit: 50,
      },
      { maxWait: 6000 }
    );

    if (!events || events.length === 0) return [];

    const latest = [...events].sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return b.id.localeCompare(a.id);
    })[0];

    const decrypted = await account.nip44.decrypt(account.pubkey, latest.content);
    const parsed = parseStoredApiKeys(decrypted);
    return normalizeStoredKeys(parsed, fallbackBaseUrl);
  } finally {
    pool.close(relays);
    pool.destroy();
  }
}

async function publishCloudApiKeys(
  account: CloudSyncCapableAccount,
  keys: StoredApiKey[]
): Promise<void> {
  const relays = getConfiguredRelayUrls();
  const pool = new SimplePool();
  try {
    const encryptedContent = await account.nip44.encrypt(
      account.pubkey,
      JSON.stringify(keys)
    );

    const eventTemplate: EventTemplate = {
      kind: API_KEYS_SYNC_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", API_KEYS_SYNC_D_TAG]],
      content: encryptedContent,
    };

    const signedEvent = await account.signEvent(eventTemplate);
    await Promise.allSettled(pool.publish(relays, signedEvent));
  } finally {
    pool.close(relays);
    pool.destroy();
  }
}

export default function ApiKeysPanel({
  baseUrl,
}: {
  baseUrl: string;
}) {
  const normalizedInputBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedBaseUrl =
    normalizedInputBaseUrl && !isOnionUrl(normalizedInputBaseUrl)
      ? normalizedInputBaseUrl
      : DEFAULT_BASE_URL;
  const { manager } = useAccountManager();
  const activeAccount = useObservableState(manager.active$);
  const activePubkey = activeAccount?.pubkey || null;

  const [isSyncBootstrapping, setIsSyncBootstrapping] = useState(false);
  const syncAccount = useMemo(
    () => (isCloudSyncCapableAccount(activeAccount) ? activeAccount : null),
    [activeAccount]
  );

  const [availableBaseUrls, setAvailableBaseUrls] = useState<string[]>([
    normalizedBaseUrl,
  ]);
  const [selectedCreateBaseUrl, setSelectedCreateBaseUrl] = useState(normalizedBaseUrl);
  const [selectedAddBaseUrl, setSelectedAddBaseUrl] = useState(normalizedBaseUrl);

  const [storedApiKeys, setStoredApiKeys] = useState<StoredApiKey[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [newApiLabel, setNewApiLabel] = useState("");
  const [newCashuToken, setNewCashuToken] = useState("");

  const [manualApiLabel, setManualApiLabel] = useState("");
  const [manualApiKey, setManualApiKey] = useState("");

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showTopupDialog, setShowTopupDialog] = useState(false);

  const [keyToDelete, setKeyToDelete] = useState<StoredApiKey | null>(null);
  const [keyToTopup, setKeyToTopup] = useState<StoredApiKey | null>(null);
  const [topupToken, setTopupToken] = useState("");

  const [editingLabelKey, setEditingLabelKey] = useState<string | null>(null);
  const [editingLabelValue, setEditingLabelValue] = useState("");

  const [isCreating, setIsCreating] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [isRefreshingKey, setIsRefreshingKey] = useState<string | null>(null);
  const [isDeletingKey, setIsDeletingKey] = useState<string | null>(null);
  const [isTopupKey, setIsTopupKey] = useState<string | null>(null);
  const [isRefundingKey, setIsRefundingKey] = useState<string | null>(null);

  const getKeyBase = (keyData: StoredApiKey): string => {
    return getKeyBaseUrl(keyData, normalizedBaseUrl);
  };

  const getKeyId = (keyData: StoredApiKey): string => {
    return getKeyCompositeId(keyData, normalizedBaseUrl);
  };

  useEffect(() => {
    let cancelled = false;
    const loadKeys = async () => {
      const localKeys = readLocalApiKeys(normalizedBaseUrl, activePubkey);

      if (!syncAccount) {
        if (!cancelled) {
          setStoredApiKeys(localKeys);
          setIsSyncBootstrapping(false);
        }
        return;
      }

      if (!cancelled) {
        setIsSyncBootstrapping(true);
      }
      try {
        const cloudKeys = await fetchCloudApiKeys(syncAccount, normalizedBaseUrl);
        if (cancelled) return;
        if (cloudKeys.length > 0) {
          setStoredApiKeys(cloudKeys);
          return;
        }

        if (localKeys.length > 0) {
          await publishCloudApiKeys(syncAccount, localKeys);
          if (cancelled) return;
          setStoredApiKeys(localKeys);
          localStorage.removeItem(CHAT_LOCAL_API_KEYS_STORAGE_KEY);
          return;
        }

        setStoredApiKeys([]);
      } catch {
        if (cancelled) return;
        setStoredApiKeys(localKeys);
      } finally {
        if (!cancelled) {
          setIsSyncBootstrapping(false);
        }
      }
    };

    void loadKeys();

    return () => {
      cancelled = true;
    };
  }, [syncAccount, normalizedBaseUrl, activePubkey]);

  const persistKeys = async (keys: StoredApiKey[]) => {
    const normalized = normalizeStoredKeys(keys, normalizedBaseUrl);
    setStoredApiKeys(normalized);

    if (syncAccount) {
      await publishCloudApiKeys(syncAccount, normalized);
    }

    localStorage.setItem(CHAT_LOCAL_API_KEYS_STORAGE_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new Event("platform-api-keys-updated"));
  };

  useEffect(() => {
    let cancelled = false;

    const fetchProviders = async () => {
      const requiredUrls = new Set<string>([normalizedBaseUrl]);
      for (const keyData of storedApiKeys) {
        requiredUrls.add(getKeyBaseUrl(keyData, normalizedBaseUrl));
      }

      const discoveredUrls = new Set<string>(requiredUrls);
      const addUrl = (candidate: unknown) => {
        if (typeof candidate !== "string") return;
        const normalized = normalizeBaseUrl(candidate);
        if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) {
          return;
        }
        discoveredUrls.add(normalized);
      };

      for (const cachedUrl of readStoredBaseUrls()) {
        addUrl(cachedUrl);
      }

      try {
        const response = await fetch("https://api.routstr.com/v1/providers/", {
          cache: "no-store",
        });
        if (response.ok) {
          const data = (await response.json()) as { providers?: DirectoryProvider[] };
          const providers = Array.isArray(data?.providers) ? data.providers : [];
          for (const provider of providers) {
            for (const endpoint of getProviderEndpoints(provider)) {
              addUrl(endpoint);
            }
          }
        }
      } catch {
        // keep fallback candidates
      }

      const candidates = Array.from(discoveredUrls).filter(Boolean);
      const modelCounts = new Map<string, number>();

      const counts = await Promise.allSettled(
        candidates.map(async (url) => ({
          url,
          count: await fetchAvailableModelCount(url),
        }))
      );

      for (const result of counts) {
        if (result.status === "fulfilled") {
          modelCounts.set(result.value.url, result.value.count);
        }
      }

      const filtered = candidates.filter((url) => {
        if (requiredUrls.has(url)) return true;
        return (modelCounts.get(url) || 0) > 0;
      });

      const list = filtered.sort((a, b) => {
        const aRequired = requiredUrls.has(a) ? 0 : 1;
        const bRequired = requiredUrls.has(b) ? 0 : 1;
        if (aRequired !== bRequired) return aRequired - bRequired;
        return a.localeCompare(b);
      });

      const finalList = list.length > 0 ? list : Array.from(requiredUrls);
      if (cancelled) return;

      setAvailableBaseUrls(finalList);
      setSelectedCreateBaseUrl((prev) => {
        const normalized = normalizeBaseUrl(prev);
        if (normalized && finalList.includes(normalized)) return normalized;
        return finalList[0] || normalizedBaseUrl;
      });
      setSelectedAddBaseUrl((prev) => {
        const normalized = normalizeBaseUrl(prev);
        if (normalized && finalList.includes(normalized)) return normalized;
        return finalList[0] || normalizedBaseUrl;
      });
    };

    void fetchProviders();

    return () => {
      cancelled = true;
    };
  }, [normalizedBaseUrl, storedApiKeys]);

  const totalBalanceSats = useMemo(() => {
    return storedApiKeys.reduce((sum, key) => sum + (key.balance || 0) / 1000, 0);
  }, [storedApiKeys]);

  const toggleExpanded = (keyId: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const handleCopy = async (value: string, keyId: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(keyId);
      toast.success("Copied");
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  const fetchKeyInfo = async (base: string, key: string) => {
    const response = await fetch(`${base}v1/wallet/info`, {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });

    if (!response.ok) {
      let message = "Failed to fetch key info";
      try {
        const data = await response.json();
        if (data?.detail?.error?.code === "invalid_api_key") {
          message = "Invalid API key";
        }
      } catch {
        // ignore
      }
      throw new Error(message);
    }

    const data = await response.json();
    return {
      apiKey: String(data.api_key || data.apiKey || key),
      balance: Number(data.balance ?? 0),
    };
  };

  const createFromCashuToken = async () => {
    if (!newCashuToken.trim()) {
      toast.error("Cashu token is required");
      return;
    }

    setIsCreating(true);
    try {
      const createBase = normalizeBaseUrl(selectedCreateBaseUrl) || normalizedBaseUrl;
      const info = await fetchKeyInfo(createBase, newCashuToken.trim());
      const next: StoredApiKey = {
        key: info.apiKey,
        balance: info.balance,
        label: newApiLabel.trim() || "Unnamed",
        baseUrl: createBase,
        isInvalid: false,
      };
      const already = storedApiKeys.some((item) => getKeyId(item) === getKeyId(next));
      if (already) {
        toast.error("This API key is already added for the selected node");
        return;
      }
      const updated = [next, ...storedApiKeys];
      await persistKeys(updated);
      setShowCreateDialog(false);
      setNewApiLabel("");
      setNewCashuToken("");
      toast.success("API key created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create API key");
    } finally {
      setIsCreating(false);
    }
  };

  const addExistingApiKey = async () => {
    if (!manualApiKey.trim()) {
      toast.error("API key is required");
      return;
    }

    setIsAdding(true);
    try {
      const addBase = normalizeBaseUrl(selectedAddBaseUrl) || normalizedBaseUrl;
      const info = await fetchKeyInfo(addBase, manualApiKey.trim());
      const candidate: StoredApiKey = {
        key: info.apiKey,
        balance: info.balance,
        label: manualApiLabel.trim() || "Manually Added",
        baseUrl: addBase,
        isInvalid: false,
      };
      const already = storedApiKeys.some((item) => getKeyId(item) === getKeyId(candidate));
      if (already) {
        toast.error("This API key is already added for the selected node");
        return;
      }

      await persistKeys([candidate, ...storedApiKeys]);
      setShowAddDialog(false);
      setManualApiLabel("");
      setManualApiKey("");
      toast.success("API key added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add API key");
    } finally {
      setIsAdding(false);
    }
  };

  const refreshSingleKey = async (keyData: StoredApiKey) => {
    const targetId = getKeyId(keyData);
    setIsRefreshingKey(targetId);
    try {
      const base = getKeyBase(keyData);
      const info = await fetchKeyInfo(base, keyData.key);
      const updated = storedApiKeys.map((item) =>
        getKeyId(item) === targetId
          ? { ...item, balance: info.balance, isInvalid: false }
          : item
      );
      await persistKeys(updated);
      toast.success("API key refreshed");
    } catch (error) {
      const updated = storedApiKeys.map((item) =>
        getKeyId(item) === targetId
          ? { ...item, isInvalid: true, balance: null }
          : item
      );
      await persistKeys(updated);
      toast.error(error instanceof Error ? error.message : "Failed to refresh key");
    } finally {
      setIsRefreshingKey(null);
    }
  };

  const refreshAllKeys = async () => {
    setIsRefreshingAll(true);
    try {
      const updated: StoredApiKey[] = [];
      for (const keyData of storedApiKeys) {
        try {
          const base = getKeyBase(keyData);
          const info = await fetchKeyInfo(base, keyData.key);
          updated.push({ ...keyData, balance: info.balance, isInvalid: false });
        } catch {
          updated.push({ ...keyData, balance: null, isInvalid: true });
        }
      }
      await persistKeys(updated);
      toast.success("Balances refreshed");
    } finally {
      setIsRefreshingAll(false);
    }
  };

  const startRename = (keyData: StoredApiKey) => {
    const keyId = getKeyId(keyData);
    setEditingLabelKey(keyId);
    setEditingLabelValue(keyData.label || "");
    setExpandedKeys((prev) => new Set(prev).add(keyId));
  };

  const saveRename = async (keyData: StoredApiKey) => {
    const targetId = getKeyId(keyData);
    const nextLabel = editingLabelValue.trim() || "Unnamed";
    const updated = storedApiKeys.map((item) =>
      getKeyId(item) === targetId ? { ...item, label: nextLabel } : item
    );
    await persistKeys(updated);
    setEditingLabelKey(null);
    setEditingLabelValue("");
    toast.success("API key name updated");
  };

  const performRefund = async (keyData: StoredApiKey) => {
    const base = getKeyBase(keyData);
    const response = await fetch(`${base}v1/wallet/refund`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keyData.key}`,
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || "Refund failed");
    }
    return (await response.json()) as { token?: string };
  };

  const deleteKey = async () => {
    if (!keyToDelete) return;
    const deleteId = getKeyId(keyToDelete);
    setIsDeletingKey(deleteId);
    try {
      const updated = storedApiKeys.filter((item) => getKeyId(item) !== deleteId);
      await persistKeys(updated);
      setShowDeleteDialog(false);
      setKeyToDelete(null);
      toast.success("API key deleted");
    } finally {
      setIsDeletingKey(null);
    }
  };

  const refundAndDeleteKey = async () => {
    if (!keyToDelete) return;
    setIsRefundingKey(getKeyId(keyToDelete));
    try {
      const result = await performRefund(keyToDelete);
      if (result.token) {
        toast.success("Refund complete. Token copied to clipboard.");
        await navigator.clipboard.writeText(result.token);
      } else {
        toast.success("Refund complete");
      }
      await deleteKey();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Refund failed");
    } finally {
      setIsRefundingKey(null);
    }
  };

  const topupKey = async () => {
    if (!keyToTopup || !topupToken.trim()) {
      toast.error("Cashu token is required for top-up");
      return;
    }

    const topupId = getKeyId(keyToTopup);
    setIsTopupKey(topupId);
    try {
      const base = getKeyBase(keyToTopup);
      const response = await fetch(
        `${base}v1/wallet/topup?cashu_token=${encodeURIComponent(topupToken.trim())}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${keyToTopup.key}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Top-up failed");
      }

      setShowTopupDialog(false);
      setTopupToken("");
      await refreshSingleKey(keyToTopup);
      toast.success("Top-up complete");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Top-up failed");
    } finally {
      setIsTopupKey(null);
    }
  };

  const upsertKeyFromWorkflow = async (
    workflowBaseUrl: string,
    workflowApiKey: string,
    fallbackLabel: string
  ) => {
    const normalizedWorkflowBase =
      normalizeBaseUrl(workflowBaseUrl) || normalizedBaseUrl;
    const trimmedKey = workflowApiKey.trim();
    if (!trimmedKey) {
      throw new Error("API key is required");
    }

    const info = await fetchKeyInfo(normalizedWorkflowBase, trimmedKey);
    const resolvedKey = info.apiKey;
    const resolvedId = `${normalizedWorkflowBase}::${resolvedKey}`;
    const requestedId = `${normalizedWorkflowBase}::${trimmedKey}`;

    let matchedExisting = false;
    const updated = storedApiKeys.map((item) => {
      const itemId = getKeyCompositeId(item, normalizedBaseUrl);
      if (itemId !== resolvedId && itemId !== requestedId) {
        return item;
      }

      matchedExisting = true;
      return {
        ...item,
        key: resolvedKey,
        balance: info.balance,
        baseUrl: normalizedWorkflowBase,
        isInvalid: false,
        label: item.label || fallbackLabel || "Imported",
      };
    });

    if (!matchedExisting) {
      updated.unshift({
        key: resolvedKey,
        balance: info.balance,
        label: fallbackLabel || "Imported",
        baseUrl: normalizedWorkflowBase,
        isInvalid: false,
      });
    }

    await persistKeys(updated);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">API Keys</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Create and manage keys per node.
        </p>
      </div>

      <div className="platform-card space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm text-muted-foreground">Total key balance</div>
            <div className="text-lg font-semibold text-foreground">
              {totalBalanceSats.toFixed(2)} sats
            </div>
          </div>
          <button
            onClick={refreshAllKeys}
            disabled={isRefreshingAll || isSyncBootstrapping || storedApiKeys.length === 0}
            className="platform-btn-muted"
            type="button"
          >
            <RefreshCw
              className={`h-4 w-4 ${isRefreshingAll ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>

      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setShowCreateDialog(true)}
          className="platform-btn-secondary"
          type="button"
        >
          <Plus className="h-4 w-4" />
          Create Key
        </button>
        <button
          onClick={() => setShowAddDialog(true)}
          className="platform-btn-secondary"
          type="button"
        >
          <Key className="h-4 w-4" />
          Add Existing Key
        </button>
      </div>

      <NodeKeyWorkflows
        defaultBaseUrl={normalizedBaseUrl}
        availableBaseUrls={availableBaseUrls}
        storedApiKeys={storedApiKeys}
        onUpsertKey={upsertKeyFromWorkflow}
      />

      {storedApiKeys.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
          No API keys yet. Start with `Create Key` or import one with `Add Existing Key`.
        </div>
      ) : (
        <div className="space-y-3">
          {storedApiKeys.map((keyData) => {
            const keyId = getKeyId(keyData);
            const expanded = expandedKeys.has(keyId);
            const displayUrl = getKeyBase(keyData)
              .replace(/^https?:\/\//, "")
              .replace(/\/$/, "");
            return (
              <div
                key={keyId}
                className="bg-muted/50 rounded-md border border-border overflow-hidden"
              >
                <div
                  className="flex items-center justify-between p-3 hover:bg-muted/60 cursor-pointer"
                  onClick={() => toggleExpanded(keyId)}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {editingLabelKey === keyId ? (
                      <div className="flex items-center gap-1 min-w-0 flex-1">
                        <input
                          value={editingLabelValue}
                          onChange={(event) => setEditingLabelValue(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          className="bg-background border border-border rounded-full px-3 py-1 text-sm text-foreground w-full"
                          autoFocus
                        />
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void saveRename(keyData);
                          }}
                          className="p-1 rounded-full hover:bg-muted"
                          type="button"
                          title="Save"
                        >
                          <Check className="h-4 w-4 text-muted-foreground" />
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditingLabelKey(null);
                            setEditingLabelValue("");
                          }}
                          className="p-1 rounded-full hover:bg-muted"
                          type="button"
                          title="Cancel"
                        >
                          <X className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-foreground truncate">
                          {keyData.label || "Unnamed API Key"}
                        </span>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            startRename(keyData);
                          }}
                          className="p-1 rounded-full hover:bg-muted"
                          type="button"
                          title="Rename"
                        >
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </>
                    )}
                    <span className="text-xs text-muted-foreground truncate">
                      ({displayUrl})
                    </span>
                    {keyData.isInvalid && (
                      <span className="px-2 py-0.5 text-xs rounded-full border border-border bg-background text-muted-foreground">
                        Invalid
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm font-medium text-foreground">
                      {formatSats(keyData.balance)}
                    </span>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpanded(keyId);
                      }}
                      className="p-1 rounded hover:bg-muted"
                      type="button"
                    >
                      {expanded ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="px-4 pb-4 pt-2 space-y-3 border-t border-border">
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        readOnly
                        value={keyData.key}
                        className="grow bg-background border border-border rounded-full px-3 py-1 text-[11px] text-foreground/80 font-mono"
                      />
                      <button
                        onClick={() => void handleCopy(keyData.key, keyId)}
                        className="platform-btn-secondary h-8 w-8 p-0"
                        type="button"
                        title="Copy API key"
                      >
                        {copiedKey === keyId ? (
                          <Check className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Copy className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                      <button
                        onClick={() => void refreshSingleKey(keyData)}
                        className="platform-btn-secondary gap-1 px-2 py-1 text-[11px]"
                        type="button"
                        disabled={isRefreshingKey === keyId}
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${
                            isRefreshingKey === keyId ? "animate-spin" : ""
                          }`}
                        />
                        Refresh
                      </button>
                    </div>

                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        onClick={() => {
                          setKeyToTopup(keyData);
                          setShowTopupDialog(true);
                        }}
                        className="platform-btn-secondary gap-1 px-3 py-1.5 text-xs"
                        type="button"
                        disabled={keyData.isInvalid || isTopupKey === keyId}
                      >
                        <Wallet className="h-3.5 w-3.5" />
                        {isTopupKey === keyId ? "Topping up..." : "Top Up"}
                      </button>
                      <button
                        onClick={async () => {
                          setIsRefundingKey(keyId);
                          try {
                            const result = await performRefund(keyData);
                            if (result.token) {
                              await navigator.clipboard.writeText(result.token);
                              toast.success("Refund token copied to clipboard");
                            } else {
                              toast.success("Refund complete");
                            }
                            await refreshSingleKey(keyData);
                          } catch (error) {
                            toast.error(
                              error instanceof Error ? error.message : "Refund failed"
                            );
                          } finally {
                            setIsRefundingKey(null);
                          }
                        }}
                        className="platform-btn-ghost px-3 py-1.5 text-xs"
                        type="button"
                        disabled={isRefundingKey === keyId}
                      >
                        {isRefundingKey === keyId ? "Refunding..." : "Refund"}
                      </button>
                      <button
                        onClick={() => {
                          setKeyToDelete(keyData);
                          setShowDeleteDialog(true);
                        }}
                        className="platform-btn-muted gap-1 px-3 py-1.5 text-xs"
                        type="button"
                        disabled={isDeletingKey === keyId}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SettingsDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        title="Create API Key"
      >
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-foreground">Create API Key</h3>
          <p className="text-sm text-muted-foreground">
            Create a new API key from a Cashu token.
          </p>
          <input
            placeholder="Label (optional)"
            value={newApiLabel}
            onChange={(event) => setNewApiLabel(event.target.value)}
            className="platform-input"
          />
          <textarea
            placeholder="Cashu token"
            value={newCashuToken}
            onChange={(event) => setNewCashuToken(event.target.value)}
            className="platform-input h-24 font-mono"
          />
          <select
            value={selectedCreateBaseUrl}
            onChange={(event) => setSelectedCreateBaseUrl(event.target.value)}
            className="platform-input"
          >
            {availableBaseUrls.map((url) => (
              <option key={url} value={url}>
                {url}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowCreateDialog(false)}
              className="platform-btn-ghost px-4"
              type="button"
            >
              Cancel
            </button>
            <button
              onClick={() => void createFromCashuToken()}
              className="platform-btn-secondary px-4"
              disabled={isCreating}
              type="button"
            >
              {isCreating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      </SettingsDialog>

      <SettingsDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        title="Add Existing API Key"
      >
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-foreground">Add Existing API Key</h3>
          <input
            placeholder="Label (optional)"
            value={manualApiLabel}
            onChange={(event) => setManualApiLabel(event.target.value)}
            className="platform-input"
          />
          <input
            placeholder="API key"
            value={manualApiKey}
            onChange={(event) => setManualApiKey(event.target.value)}
            className="platform-input font-mono"
          />
          <select
            value={selectedAddBaseUrl}
            onChange={(event) => setSelectedAddBaseUrl(event.target.value)}
            className="platform-input"
          >
            {availableBaseUrls.map((url) => (
              <option key={url} value={url}>
                {url}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowAddDialog(false)}
              className="platform-btn-ghost px-4"
              type="button"
            >
              Cancel
            </button>
            <button
              onClick={() => void addExistingApiKey()}
              className="platform-btn-secondary px-4"
              disabled={isAdding || !manualApiKey.trim()}
              type="button"
            >
              {isAdding ? "Adding..." : "Add"}
            </button>
          </div>
        </div>
      </SettingsDialog>

      <ModalShell
        open={showDeleteDialog && !!keyToDelete}
        onClose={() => {
          setShowDeleteDialog(false);
          setKeyToDelete(null);
        }}
        overlayClassName="bg-black/70 z-50 p-4"
        contentClassName="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4"
        closeOnOverlayClick
      >
        {keyToDelete && (
          <>
            <h3 className="text-lg font-semibold text-foreground">Delete API Key</h3>
            <p className="text-sm text-muted-foreground">
              Delete <span className="font-medium">{keyToDelete.label || "Unnamed"}</span>.
              You can refund first or delete immediately.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowDeleteDialog(false);
                  setKeyToDelete(null);
                }}
                className="platform-btn-ghost px-4"
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={() => void refundAndDeleteKey()}
                className="platform-btn-secondary px-4"
                type="button"
                disabled={isRefundingKey === getKeyId(keyToDelete)}
              >
                {isRefundingKey === getKeyId(keyToDelete)
                  ? "Refunding..."
                  : "Refund & Delete"}
              </button>
              <button
                onClick={() => void deleteKey()}
                className="platform-btn-muted px-4"
                type="button"
                disabled={isDeletingKey === getKeyId(keyToDelete)}
              >
                {isDeletingKey === getKeyId(keyToDelete)
                  ? "Deleting..."
                  : "Delete Only"}
              </button>
            </div>
          </>
        )}
      </ModalShell>

      <ModalShell
        open={showTopupDialog && !!keyToTopup}
        onClose={() => {
          setShowTopupDialog(false);
          setTopupToken("");
          setKeyToTopup(null);
        }}
        overlayClassName="bg-black/70 z-50 p-4"
        contentClassName="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4"
        closeOnOverlayClick
      >
        {keyToTopup && (
          <>
            <h3 className="text-lg font-semibold text-foreground">Top Up API Key</h3>
            <p className="text-sm text-muted-foreground">
              Add balance to <span className="font-medium">{keyToTopup.label || "Unnamed"}</span>{" "}
              using a Cashu token.
            </p>
            <textarea
              placeholder="Cashu token"
              value={topupToken}
              onChange={(event) => setTopupToken(event.target.value)}
              className="platform-input h-24 font-mono"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowTopupDialog(false);
                  setTopupToken("");
                  setKeyToTopup(null);
                }}
                className="platform-btn-ghost px-4"
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={() => void topupKey()}
                className="platform-btn-secondary px-4"
                type="button"
                disabled={!topupToken.trim() || isTopupKey === getKeyId(keyToTopup)}
              >
                {isTopupKey === getKeyId(keyToTopup)
                  ? "Topping up..."
                  : "Confirm Top Up"}
              </button>
            </div>
          </>
        )}
      </ModalShell>
    </div>
  );
}
