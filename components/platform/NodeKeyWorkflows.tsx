"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, QrCode, RefreshCw, Zap } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";

type StoredApiKeyLike = {
  key: string;
  balance: number | null;
  label?: string;
  baseUrl?: string;
  isInvalid?: boolean;
};

type LightningInvoice = {
  invoice_id: string;
  bolt11: string;
  amount_sats: number;
  expires_at: number;
  payment_hash: string;
};

type LightningInvoiceStatus = {
  status: string;
  api_key?: string;
  amount_sats: number;
  paid_at?: number;
  created_at: number;
  expires_at: number;
};

type ChildKeyCreateResponse = {
  api_keys?: string[];
  count?: number;
  cost_msats?: number;
  parent_balance?: number;
};

type ChildKeyStatus = {
  totalSpentMsats: number;
  balanceLimitMsats: number | null;
  validityDateUnix: number | null;
  isExpired: boolean;
  isDrained: boolean;
};

type NodeKeyWorkflowsProps = {
  defaultBaseUrl: string;
  availableBaseUrls: string[];
  storedApiKeys: StoredApiKeyLike[];
  onUpsertKey: (baseUrl: string, apiKey: string, label: string) => Promise<void>;
};

type TabOption<T extends string> = {
  id: T;
  label: string;
  description?: string;
};

type SegmentedTabsProps<T extends string> = {
  idPrefix: string;
  label: string;
  options: readonly TabOption<T>[];
  value: T;
  onChange: (next: T) => void;
};

function getStoredTabValue<T extends string>(
  storageKey: string,
  fallback: T,
  options: readonly TabOption<T>[]
): T {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return fallback;
  const matched = options.find((option) => option.id === raw);
  return matched ? matched.id : fallback;
}

function SegmentedTabs<T extends string>({
  idPrefix,
  label,
  options,
  value,
  onChange,
}: SegmentedTabsProps<T>) {
  const tabClass = (isActive: boolean): string =>
    `rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
      isActive
        ? "border border-border/70 bg-muted/55 text-foreground"
        : "border border-transparent text-muted-foreground hover:bg-muted/35 hover:text-foreground"
    }`;

  const selectedOption = options.find((option) => option.id === value) ?? options[0];

  return (
    <div className="w-full max-w-[24rem] space-y-2">
      <div
        role="tablist"
        aria-label={label}
        className="inline-flex w-full rounded-lg border border-border/70 bg-muted/15 p-1"
      >
        {options.map((option, index) => {
          const isActive = option.id === value;
          return (
            <button
              key={option.id}
              id={`${idPrefix}-tab-${option.id}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`${idPrefix}-panel-${option.id}`}
              tabIndex={isActive ? 0 : -1}
              type="button"
              className={`${tabClass(isActive)} flex-1 text-center`}
              onClick={() => onChange(option.id)}
              onKeyDown={(event) => {
                if (
                  event.key !== "ArrowRight" &&
                  event.key !== "ArrowLeft" &&
                  event.key !== "Home" &&
                  event.key !== "End"
                ) {
                  return;
                }

                event.preventDefault();
                let nextIndex = index;
                if (event.key === "ArrowRight") {
                  nextIndex = (index + 1) % options.length;
                }
                if (event.key === "ArrowLeft") {
                  nextIndex = (index - 1 + options.length) % options.length;
                }
                if (event.key === "Home") {
                  nextIndex = 0;
                }
                if (event.key === "End") {
                  nextIndex = options.length - 1;
                }
                onChange(options[nextIndex].id);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="min-h-10 text-xs leading-relaxed text-muted-foreground">
        {selectedOption?.description || "\u00A0"}
      </p>
    </div>
  );
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;
}

function formatSats(msats: number): string {
  return `${(msats / 1000).toLocaleString()} sats`;
}

function shortKey(key: string): string {
  if (!key) return "";
  if (key.length <= 16) return key;
  return `${key.slice(0, 8)}...${key.slice(-6)}`;
}

function getErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

function endOfDayUnix(dateInput: string): number | undefined {
  const trimmed = dateInput.trim();
  if (!trimmed) return undefined;
  const asDate = new Date(`${trimmed}T23:59:59`);
  if (Number.isNaN(asDate.getTime())) return undefined;
  return Math.floor(asDate.getTime() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function keyCompositeId(item: StoredApiKeyLike, fallbackBaseUrl: string): string {
  const base = normalizeBaseUrl(item.baseUrl || fallbackBaseUrl) || fallbackBaseUrl;
  return `${base}::${item.key}`;
}

async function parseResponseError(response: Response, fallback: string): Promise<Error> {
  let detail = "";
  try {
    const payload = await response.json();
    if (typeof payload?.detail === "string") {
      detail = payload.detail;
    } else if (typeof payload?.error === "string") {
      detail = payload.error;
    } else if (typeof payload?.message === "string") {
      detail = payload.message;
    } else if (payload?.detail && typeof payload.detail?.message === "string") {
      detail = payload.detail.message;
    }
  } catch {
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
  }
  return new Error(detail || fallback);
}

async function createLightningInvoice(
  baseUrl: string,
  payload: {
    amount_sats: number;
    purpose: "create" | "topup";
    api_key?: string;
    balance_limit?: number;
    balance_limit_reset?: string;
    validity_date?: number;
  }
): Promise<LightningInvoice> {
  const response = await fetch(`${baseUrl}v1/balance/lightning/invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw await parseResponseError(response, "Failed to create Lightning invoice");
  }

  return (await response.json()) as LightningInvoice;
}

async function fetchLightningInvoiceStatus(
  baseUrl: string,
  invoiceId: string
): Promise<LightningInvoiceStatus> {
  const response = await fetch(`${baseUrl}v1/balance/lightning/invoice/${invoiceId}/status`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw await parseResponseError(response, "Failed to check invoice status");
  }

  return (await response.json()) as LightningInvoiceStatus;
}

async function recoverLightningInvoice(
  baseUrl: string,
  bolt11: string
): Promise<LightningInvoiceStatus> {
  const response = await fetch(`${baseUrl}v1/balance/lightning/recover`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bolt11 }),
  });

  if (!response.ok) {
    throw await parseResponseError(response, "Failed to recover invoice");
  }

  return (await response.json()) as LightningInvoiceStatus;
}

export default function NodeKeyWorkflows({
  defaultBaseUrl,
  availableBaseUrls,
  storedApiKeys,
  onUpsertKey,
}: NodeKeyWorkflowsProps) {
  const normalizedDefaultBaseUrl = normalizeBaseUrl(defaultBaseUrl) || defaultBaseUrl;

  const endpointOptions = useMemo(() => {
    const unique = new Set<string>([
      normalizedDefaultBaseUrl,
      ...availableBaseUrls.map((url) => normalizeBaseUrl(url)).filter(Boolean),
    ]);
    return Array.from(unique);
  }, [availableBaseUrls, normalizedDefaultBaseUrl]);

  const keyOptions = useMemo(() => {
    return storedApiKeys.map((item) => {
      const base = normalizeBaseUrl(item.baseUrl || normalizedDefaultBaseUrl) || normalizedDefaultBaseUrl;
      return {
        id: keyCompositeId(item, normalizedDefaultBaseUrl),
        key: item.key,
        baseUrl: base,
        label: item.label || "Unnamed",
        isInvalid: Boolean(item.isInvalid),
      };
    });
  }, [normalizedDefaultBaseUrl, storedApiKeys]);

  const [createBaseUrl, setCreateBaseUrl] = useState(normalizedDefaultBaseUrl);
  const [topupBaseUrl, setTopupBaseUrl] = useState(normalizedDefaultBaseUrl);
  const [recoverBaseUrl, setRecoverBaseUrl] = useState(normalizedDefaultBaseUrl);
  const [childBaseUrl, setChildBaseUrl] = useState(normalizedDefaultBaseUrl);
  const [checkChildBaseUrl, setCheckChildBaseUrl] = useState(normalizedDefaultBaseUrl);

  useEffect(() => {
    const fallback = endpointOptions[0] || normalizedDefaultBaseUrl;

    if (!endpointOptions.includes(createBaseUrl)) {
      setCreateBaseUrl(fallback);
    }
    if (!endpointOptions.includes(topupBaseUrl)) {
      setTopupBaseUrl(fallback);
    }
    if (!endpointOptions.includes(recoverBaseUrl)) {
      setRecoverBaseUrl(fallback);
    }
    if (!endpointOptions.includes(childBaseUrl)) {
      setChildBaseUrl(fallback);
    }
    if (!endpointOptions.includes(checkChildBaseUrl)) {
      setCheckChildBaseUrl(fallback);
    }
  }, [
    childBaseUrl,
    checkChildBaseUrl,
    createBaseUrl,
    endpointOptions,
    normalizedDefaultBaseUrl,
    recoverBaseUrl,
    topupBaseUrl,
  ]);

  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const handleCopy = useCallback(async (value: string, key: string) => {
    if (!value) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error("Clipboard API unavailable");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(key);
      setTimeout(() => {
        setCopiedValue((current) => (current === key ? null : current));
      }, 1400);
      toast.success("Copied");
    } catch {
      toast.error("Unable to copy");
    }
  }, []);

  const [createAmount, setCreateAmount] = useState("");
  const [createBalanceLimit, setCreateBalanceLimit] = useState("");
  const [createBalanceLimitReset, setCreateBalanceLimitReset] = useState("");
  const [createValidityDate, setCreateValidityDate] = useState("");
  const [createInvoice, setCreateInvoice] = useState<LightningInvoice | null>(null);
  const [createInvoiceStatus, setCreateInvoiceStatus] = useState<string>("idle");
  const [createdApiKey, setCreatedApiKey] = useState<string | null>(null);
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
  const [isPollingCreateInvoice, setIsPollingCreateInvoice] = useState(false);

  const [selectedTopupKeyId, setSelectedTopupKeyId] = useState<string>("");
  const [topupApiKey, setTopupApiKey] = useState("");
  const [topupAmount, setTopupAmount] = useState("");
  const [topupInvoice, setTopupInvoice] = useState<LightningInvoice | null>(null);
  const [topupInvoiceStatus, setTopupInvoiceStatus] = useState<string>("idle");
  const [isCreatingTopupInvoice, setIsCreatingTopupInvoice] = useState(false);
  const [isPollingTopupInvoice, setIsPollingTopupInvoice] = useState(false);

  const [recoverBolt11, setRecoverBolt11] = useState("");
  const [isRecoveringInvoice, setIsRecoveringInvoice] = useState(false);
  const [recoveredApiKey, setRecoveredApiKey] = useState<string | null>(null);

  useEffect(() => {
    const firstValid = keyOptions.find((item) => !item.isInvalid) || keyOptions[0];

    if (!firstValid) {
      setSelectedTopupKeyId("");
      return;
    }

    if (!keyOptions.some((item) => item.id === selectedTopupKeyId)) {
      setSelectedTopupKeyId(firstValid.id);
      setTopupApiKey(firstValid.key);
      setTopupBaseUrl(firstValid.baseUrl);
    }
  }, [keyOptions, selectedTopupKeyId]);

  useEffect(() => {
    const selected = keyOptions.find((item) => item.id === selectedTopupKeyId);
    if (!selected) return;
    setTopupApiKey(selected.key);
    setTopupBaseUrl(selected.baseUrl);
  }, [keyOptions, selectedTopupKeyId]);

  const pollInvoiceUntilResolved = useCallback(
    async (
      baseUrl: string,
      invoiceId: string,
      onStatus: (status: string) => void
    ): Promise<LightningInvoiceStatus> => {
      const maxAttempts = 60;
      let lastStatus: LightningInvoiceStatus | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const status = await fetchLightningInvoiceStatus(baseUrl, invoiceId);
        lastStatus = status;
        onStatus(status.status);

        if (status.status === "paid") {
          return status;
        }

        if (status.status === "expired" || status.status === "cancelled") {
          return status;
        }

        await sleep(5000);
      }

      if (lastStatus) {
        return lastStatus;
      }

      throw new Error("Invoice polling timed out");
    },
    []
  );

  const handleCreateInvoice = useCallback(async () => {
    const amount = Number.parseInt(createAmount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid amount in sats");
      return;
    }

    setIsCreatingInvoice(true);
    setIsPollingCreateInvoice(false);
    setCreatedApiKey(null);
    setCreateInvoiceStatus("pending");

    try {
      const payload: {
        amount_sats: number;
        purpose: "create";
        balance_limit?: number;
        balance_limit_reset?: string;
        validity_date?: number;
      } = {
        amount_sats: amount,
        purpose: "create",
      };

      if (createBalanceLimit.trim()) {
        const value = Number.parseInt(createBalanceLimit.trim(), 10);
        if (Number.isFinite(value) && value > 0) {
          payload.balance_limit = value;
        }
      }
      if (createBalanceLimitReset.trim()) {
        payload.balance_limit_reset = createBalanceLimitReset.trim();
      }

      const validityDate = endOfDayUnix(createValidityDate);
      if (validityDate) {
        payload.validity_date = validityDate;
      }

      const invoice = await createLightningInvoice(createBaseUrl, payload);
      setCreateInvoice(invoice);
      toast.success("Lightning invoice created");

      setIsPollingCreateInvoice(true);
      const status = await pollInvoiceUntilResolved(
        createBaseUrl,
        invoice.invoice_id,
        setCreateInvoiceStatus
      );

      if (status.status === "paid" && status.api_key) {
        await onUpsertKey(createBaseUrl, status.api_key, "Lightning key");
        setCreatedApiKey(status.api_key);
        toast.success("Payment received and API key synced");
      } else if (status.status === "paid") {
        toast.success("Payment received");
      } else {
        toast.error(`Invoice ${status.status}`);
      }
    } catch (error) {
      setCreateInvoiceStatus("error");
      toast.error(getErrorMessage(error, "Failed to create invoice"));
    } finally {
      setIsCreatingInvoice(false);
      setIsPollingCreateInvoice(false);
    }
  }, [
    createAmount,
    createBalanceLimit,
    createBalanceLimitReset,
    createBaseUrl,
    createValidityDate,
    onUpsertKey,
    pollInvoiceUntilResolved,
  ]);

  const handleTopupInvoice = useCallback(async () => {
    const amount = Number.parseInt(topupAmount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid amount in sats");
      return;
    }
    if (!topupApiKey.trim()) {
      toast.error("Pick or enter an API key");
      return;
    }

    setIsCreatingTopupInvoice(true);
    setIsPollingTopupInvoice(false);
    setTopupInvoiceStatus("pending");

    try {
      const invoice = await createLightningInvoice(topupBaseUrl, {
        amount_sats: amount,
        purpose: "topup",
        api_key: topupApiKey.trim(),
      });
      setTopupInvoice(invoice);
      toast.success("Top-up invoice created");

      setIsPollingTopupInvoice(true);
      const status = await pollInvoiceUntilResolved(
        topupBaseUrl,
        invoice.invoice_id,
        setTopupInvoiceStatus
      );

      if (status.status === "paid") {
        await onUpsertKey(topupBaseUrl, topupApiKey.trim(), "Top-up key");
        toast.success("Top-up confirmed and key refreshed");
      } else {
        toast.error(`Invoice ${status.status}`);
      }
    } catch (error) {
      setTopupInvoiceStatus("error");
      toast.error(getErrorMessage(error, "Failed to create top-up invoice"));
    } finally {
      setIsCreatingTopupInvoice(false);
      setIsPollingTopupInvoice(false);
    }
  }, [onUpsertKey, pollInvoiceUntilResolved, topupAmount, topupApiKey, topupBaseUrl]);

  const handleRecoverInvoice = useCallback(async () => {
    const bolt11 = recoverBolt11.trim();
    if (!bolt11) {
      toast.error("Paste a BOLT11 invoice first");
      return;
    }

    setIsRecoveringInvoice(true);
    setRecoveredApiKey(null);

    try {
      const status = await recoverLightningInvoice(recoverBaseUrl, bolt11);
      if (status.status === "paid" && status.api_key) {
        await onUpsertKey(recoverBaseUrl, status.api_key, "Recovered key");
        setRecoveredApiKey(status.api_key);
        toast.success("Recovered and synced API key");
      } else {
        toast.error(`Invoice status: ${status.status}`);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to recover invoice"));
    } finally {
      setIsRecoveringInvoice(false);
    }
  }, [onUpsertKey, recoverBaseUrl, recoverBolt11]);

  const [selectedParentKeyId, setSelectedParentKeyId] = useState<string>("");
  const [parentApiKey, setParentApiKey] = useState("");
  const [childCount, setChildCount] = useState("1");
  const [childBalanceLimit, setChildBalanceLimit] = useState("");
  const [childBalanceLimitReset, setChildBalanceLimitReset] = useState("");
  const [childValidityDate, setChildValidityDate] = useState("");
  const [isCreatingChildKeys, setIsCreatingChildKeys] = useState(false);
  const [createdChildKeys, setCreatedChildKeys] = useState<string[]>([]);
  const [childCostMsats, setChildCostMsats] = useState<number | null>(null);
  const [parentBalanceMsats, setParentBalanceMsats] = useState<number | null>(null);

  const [childKeyToCheck, setChildKeyToCheck] = useState("");
  const [isCheckingChildKey, setIsCheckingChildKey] = useState(false);
  const [childKeyStatus, setChildKeyStatus] = useState<ChildKeyStatus | null>(null);

  useEffect(() => {
    const firstValid = keyOptions.find((item) => !item.isInvalid) || keyOptions[0];

    if (!firstValid) {
      setSelectedParentKeyId("");
      return;
    }

    if (!keyOptions.some((item) => item.id === selectedParentKeyId)) {
      setSelectedParentKeyId(firstValid.id);
      setParentApiKey(firstValid.key);
      setChildBaseUrl(firstValid.baseUrl);
      setCheckChildBaseUrl(firstValid.baseUrl);
    }
  }, [keyOptions, selectedParentKeyId]);

  useEffect(() => {
    const selected = keyOptions.find((item) => item.id === selectedParentKeyId);
    if (!selected) return;
    setParentApiKey(selected.key);
    setChildBaseUrl(selected.baseUrl);
  }, [keyOptions, selectedParentKeyId]);

  const handleCreateChildKeys = useCallback(async () => {
    const parent = parentApiKey.trim();
    const count = Math.max(1, Math.min(50, Number.parseInt(childCount, 10) || 1));

    if (!parent) {
      toast.error("Enter a parent API key first");
      return;
    }

    setIsCreatingChildKeys(true);
    try {
      const payload: {
        count: number;
        balance_limit?: number;
        balance_limit_reset?: string;
        validity_date?: number;
      } = { count };

      if (childBalanceLimit.trim()) {
        const parsed = Number.parseInt(childBalanceLimit.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          payload.balance_limit = parsed;
        }
      }

      if (childBalanceLimitReset.trim()) {
        payload.balance_limit_reset = childBalanceLimitReset.trim();
      }

      const validityDate = endOfDayUnix(childValidityDate);
      if (validityDate) {
        payload.validity_date = validityDate;
      }

      const response = await fetch(`${childBaseUrl}v1/balance/child-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${parent}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw await parseResponseError(response, "Failed to create child keys");
      }

      const result = (await response.json()) as ChildKeyCreateResponse;
      const newKeys = Array.isArray(result.api_keys) ? result.api_keys : [];
      setCreatedChildKeys(newKeys);
      setChildCostMsats(
        typeof result.cost_msats === "number" ? result.cost_msats : null
      );
      setParentBalanceMsats(
        typeof result.parent_balance === "number" ? result.parent_balance : null
      );

      await onUpsertKey(childBaseUrl, parent, "Parent key");

      toast.success(
        `${newKeys.length} child key${newKeys.length === 1 ? "" : "s"} generated`
      );
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create child keys"));
    } finally {
      setIsCreatingChildKeys(false);
    }
  }, [
    childBalanceLimit,
    childBalanceLimitReset,
    childBaseUrl,
    childCount,
    childValidityDate,
    onUpsertKey,
    parentApiKey,
  ]);

  const handleCheckChildStatus = useCallback(async () => {
    const key = childKeyToCheck.trim();
    if (!key) {
      toast.error("Enter a child API key first");
      return;
    }

    setIsCheckingChildKey(true);
    setChildKeyStatus(null);

    try {
      const response = await fetch(`${checkChildBaseUrl}v1/balance/info`, {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });

      if (!response.ok) {
        throw await parseResponseError(response, "Failed to check child key");
      }

      const payload = (await response.json()) as {
        total_spent?: number;
        balance_limit?: number | null;
        validity_date?: number | null;
      };

      const totalSpent = Number(payload.total_spent ?? 0);
      const balanceLimit =
        typeof payload.balance_limit === "number" ? payload.balance_limit : null;
      const validityDate =
        typeof payload.validity_date === "number" ? payload.validity_date : null;
      const now = Math.floor(Date.now() / 1000);

      const status: ChildKeyStatus = {
        totalSpentMsats: Number.isFinite(totalSpent) ? totalSpent : 0,
        balanceLimitMsats: balanceLimit,
        validityDateUnix: validityDate,
        isExpired: validityDate !== null ? now > validityDate : false,
        isDrained:
          balanceLimit !== null
            ? (Number.isFinite(totalSpent) ? totalSpent : 0) >= balanceLimit
            : false,
      };

      setChildKeyStatus(status);
      toast.success("Child key status loaded");
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to check child key"));
    } finally {
      setIsCheckingChildKey(false);
    }
  }, [checkChildBaseUrl, childKeyToCheck]);

  const lightningTabOptions = useMemo(
    (): readonly TabOption<"create" | "topup" | "recover">[] => [
      {
        id: "create",
        label: "Create",
        description: "Generate a Lightning invoice to create a new API key.",
      },
      {
        id: "topup",
        label: "Top up",
        description: "Top up an existing API key balance via Lightning invoice.",
      },
      {
        id: "recover",
        label: "Recover",
        description: "Recover API key details from a previously paid invoice.",
      },
    ],
    []
  );
  const childTabOptions = useMemo(
    (): readonly TabOption<"create" | "status">[] => [
      {
        id: "create",
        label: "Create",
        description: "Generate one or more child keys from a parent API key.",
      },
      {
        id: "status",
        label: "Check status",
        description: "Inspect spending, limits, and expiry for a child key.",
      },
    ],
    []
  );

  const [lightningMode, setLightningMode] = useState<"create" | "topup" | "recover">(
    "create"
  );
  const [childMode, setChildMode] = useState<"create" | "status">("create");

  useEffect(() => {
    setLightningMode((current) =>
      getStoredTabValue("platform:workflow:lightning-tab", current, lightningTabOptions)
    );
    setChildMode((current) =>
      getStoredTabValue("platform:workflow:child-tab", current, childTabOptions)
    );
  }, [childTabOptions, lightningTabOptions]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("platform:workflow:lightning-tab", lightningMode);
  }, [lightningMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("platform:workflow:child-tab", childMode);
  }, [childMode]);

  const controlClass = "platform-input";
  const labelClass = "text-xs font-medium text-muted-foreground";

  return (
    <div className="space-y-5">
      <section className="platform-card p-5">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <Zap className="h-4 w-4 text-foreground/80" />
              Lightning Key Workflow
            </h3>
            <p className="text-sm text-muted-foreground">
              Create keys, top up existing keys, or recover a key from a paid invoice.
            </p>
          </div>
          <SegmentedTabs
            idPrefix="lightning-workflow"
            label="Lightning workflow tabs"
            options={lightningTabOptions}
            value={lightningMode}
            onChange={setLightningMode}
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="rounded-xl border border-border/60 bg-muted/15 p-4 space-y-4 min-h-[30rem]">
            {lightningMode === "create" ? (
              <div
                id="lightning-workflow-panel-create"
                role="tabpanel"
                aria-labelledby="lightning-workflow-tab-create"
                className="space-y-4"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className={labelClass}>Endpoint</span>
                    <select
                      value={createBaseUrl}
                      onChange={(event) => setCreateBaseUrl(event.target.value)}
                      className={controlClass}
                    >
                      {endpointOptions.map((url) => (
                        <option key={`create-${url}`} value={url}>
                          {url}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Amount (sats)</span>
                    <input
                      value={createAmount}
                      onChange={(event) => setCreateAmount(event.target.value)}
                      type="number"
                      min={1}
                      className={controlClass}
                      placeholder="1000"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Validity date</span>
                    <input
                      value={createValidityDate}
                      onChange={(event) => setCreateValidityDate(event.target.value)}
                      type="date"
                      className={controlClass}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Balance limit (optional, msats)</span>
                    <input
                      value={createBalanceLimit}
                      onChange={(event) => setCreateBalanceLimit(event.target.value)}
                      type="number"
                      min={1}
                      className={controlClass}
                      placeholder="500000"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Limit reset rule (optional)</span>
                    <input
                      value={createBalanceLimitReset}
                      onChange={(event) => setCreateBalanceLimitReset(event.target.value)}
                      className={controlClass}
                      placeholder="daily"
                    />
                  </label>
                </div>

                <button
                  onClick={() => {
                    void handleCreateInvoice();
                  }}
                  disabled={isCreatingInvoice || isPollingCreateInvoice}
                  className="platform-btn-primary w-full py-2.5"
                  type="button"
                >
                  {isCreatingInvoice || isPollingCreateInvoice ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {isPollingCreateInvoice ? "Waiting for payment" : "Create invoice"}
                </button>
              </div>
            ) : null}

            {lightningMode === "topup" ? (
              <div
                id="lightning-workflow-panel-topup"
                role="tabpanel"
                aria-labelledby="lightning-workflow-tab-topup"
                className="space-y-4"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className={labelClass}>Saved key</span>
                    <select
                      value={selectedTopupKeyId}
                      onChange={(event) => setSelectedTopupKeyId(event.target.value)}
                      className={controlClass}
                    >
                      {keyOptions.length === 0 ? (
                        <option value="">No keys available</option>
                      ) : (
                        keyOptions.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label} ({shortKey(item.key)})
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Endpoint</span>
                    <select
                      value={topupBaseUrl}
                      onChange={(event) => setTopupBaseUrl(event.target.value)}
                      className={controlClass}
                    >
                      {endpointOptions.map((url) => (
                        <option key={`topup-${url}`} value={url}>
                          {url}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Amount (sats)</span>
                    <input
                      value={topupAmount}
                      onChange={(event) => setTopupAmount(event.target.value)}
                      type="number"
                      min={1}
                      className={controlClass}
                      placeholder="1000"
                    />
                  </label>
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className={labelClass}>API key</span>
                    <input
                      value={topupApiKey}
                      onChange={(event) => setTopupApiKey(event.target.value)}
                      className={`${controlClass} font-mono text-xs`}
                      placeholder="sk-..."
                    />
                  </label>
                </div>

                <button
                  onClick={() => {
                    void handleTopupInvoice();
                  }}
                  disabled={
                    isCreatingTopupInvoice ||
                    isPollingTopupInvoice ||
                    !topupApiKey.trim()
                  }
                  className="platform-btn-primary w-full py-2.5"
                  type="button"
                >
                  {isCreatingTopupInvoice || isPollingTopupInvoice ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <QrCode className="h-4 w-4" />
                  )}
                  {isPollingTopupInvoice
                    ? "Waiting for payment"
                    : "Create top-up invoice"}
                </button>
              </div>
            ) : null}

            {lightningMode === "recover" ? (
              <div
                id="lightning-workflow-panel-recover"
                role="tabpanel"
                aria-labelledby="lightning-workflow-tab-recover"
                className="space-y-4"
              >
                <label className="space-y-1.5">
                  <span className={labelClass}>Endpoint</span>
                  <select
                    value={recoverBaseUrl}
                    onChange={(event) => setRecoverBaseUrl(event.target.value)}
                    className={controlClass}
                  >
                    {endpointOptions.map((url) => (
                      <option key={`recover-${url}`} value={url}>
                        {url}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>BOLT11 invoice</span>
                  <textarea
                    value={recoverBolt11}
                    onChange={(event) => setRecoverBolt11(event.target.value)}
                    placeholder="Paste BOLT11 invoice"
                    className={`${controlClass} h-28 resize-none`}
                  />
                </label>
                <button
                  onClick={() => {
                    void handleRecoverInvoice();
                  }}
                  disabled={isRecoveringInvoice || !recoverBolt11.trim()}
                  className="platform-btn-primary w-full py-2.5"
                  type="button"
                >
                  {isRecoveringInvoice ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Recover API key
                </button>
                {recoveredApiKey ? (
                  <p className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-foreground">
                    Recovered key: <span className="font-mono">{shortKey(recoveredApiKey)}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <aside className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3 min-h-[30rem]">
            <p className="text-xs font-medium text-muted-foreground">Invoice preview</p>
            {lightningMode === "create" && createInvoice ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Status:{" "}
                  <span className="font-semibold text-foreground">{createInvoiceStatus}</span>
                </p>
                <div className="platform-card-soft flex justify-center p-2">
                  <QRCodeSVG value={createInvoice.bolt11} size={120} />
                </div>
                <textarea
                  readOnly
                  value={createInvoice.bolt11}
                  className={`${controlClass} h-24 resize-none font-mono text-[11px]`}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      void handleCopy(createInvoice.bolt11, `create-bolt11-${createInvoice.invoice_id}`);
                    }}
                    className="platform-btn-secondary gap-1 px-2 py-1.5 text-xs"
                    type="button"
                  >
                    {copiedValue === `create-bolt11-${createInvoice.invoice_id}` ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    Copy
                  </button>
                  <button
                    onClick={() => {
                      void (async () => {
                        try {
                          const status = await fetchLightningInvoiceStatus(
                            createBaseUrl,
                            createInvoice.invoice_id
                          );
                          setCreateInvoiceStatus(status.status);
                          toast.success("Invoice status refreshed");
                        } catch (error) {
                          toast.error(getErrorMessage(error, "Failed to refresh invoice"));
                        }
                      })();
                    }}
                    className="platform-btn-secondary gap-1 px-2 py-1.5 text-xs"
                    type="button"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Refresh
                  </button>
                </div>
                {createdApiKey ? (
                  <p className="text-xs text-foreground">
                    Key created: <span className="font-mono">{shortKey(createdApiKey)}</span>
                  </p>
                ) : null}
              </>
            ) : null}

            {lightningMode === "topup" && topupInvoice ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Status:{" "}
                  <span className="font-semibold text-foreground">{topupInvoiceStatus}</span>
                </p>
                <div className="platform-card-soft flex justify-center p-2">
                  <QRCodeSVG value={topupInvoice.bolt11} size={120} />
                </div>
                <textarea
                  readOnly
                  value={topupInvoice.bolt11}
                  className={`${controlClass} h-24 resize-none font-mono text-[11px]`}
                />
                <button
                  onClick={() => {
                    void handleCopy(topupInvoice.bolt11, `topup-bolt11-${topupInvoice.invoice_id}`);
                  }}
                  className="platform-btn-secondary gap-1 px-2 py-1.5 text-xs"
                  type="button"
                >
                  {copiedValue === `topup-bolt11-${topupInvoice.invoice_id}` ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  Copy
                </button>
              </>
            ) : null}

            {(lightningMode === "recover" ||
              (lightningMode === "create" && !createInvoice) ||
              (lightningMode === "topup" && !topupInvoice)) && (
              <div className="rounded-lg border border-dashed border-border/70 p-3 text-xs text-muted-foreground leading-relaxed">
                {lightningMode === "recover"
                  ? "Recover mode checks invoice status and syncs the API key if paid."
                  : "Create an invoice to show QR and payment details here."}
              </div>
            )}
          </aside>
        </div>
      </section>

      <section className="platform-card p-5">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-base font-semibold tracking-tight">Child Key Tools</h3>
            <p className="text-sm text-muted-foreground">
              Generate child keys from a parent key and inspect child-key limits.
            </p>
          </div>
          <SegmentedTabs
            idPrefix="child-workflow"
            label="Child key workflow tabs"
            options={childTabOptions}
            value={childMode}
            onChange={setChildMode}
          />
        </div>

        <div className="mt-4 rounded-xl border border-border/60 bg-muted/15 p-4 space-y-4 min-h-[26rem]">
          {childMode === "create" ? (
            <div
              id="child-workflow-panel-create"
              role="tabpanel"
              aria-labelledby="child-workflow-tab-create"
              className="space-y-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 sm:col-span-2">
                  <span className={labelClass}>Parent key (saved keys)</span>
                  <select
                    value={selectedParentKeyId}
                    onChange={(event) => setSelectedParentKeyId(event.target.value)}
                    className={controlClass}
                  >
                    {keyOptions.length === 0 ? (
                      <option value="">No parent key available</option>
                    ) : (
                      keyOptions.map((item) => (
                        <option key={`parent-${item.id}`} value={item.id}>
                          {item.label} ({shortKey(item.key)})
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Endpoint</span>
                  <select
                    value={childBaseUrl}
                    onChange={(event) => setChildBaseUrl(event.target.value)}
                    className={controlClass}
                  >
                    {endpointOptions.map((url) => (
                      <option key={`child-${url}`} value={url}>
                        {url}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Number of keys</span>
                  <input
                    value={childCount}
                    onChange={(event) => setChildCount(event.target.value)}
                    type="number"
                    min={1}
                    max={50}
                    className={controlClass}
                  />
                </label>
                <label className="space-y-1.5 sm:col-span-2">
                  <span className={labelClass}>Parent API key</span>
                  <input
                    value={parentApiKey}
                    onChange={(event) => setParentApiKey(event.target.value)}
                    className={`${controlClass} font-mono text-xs`}
                    placeholder="sk-..."
                  />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Balance limit (optional, msats)</span>
                  <input
                    value={childBalanceLimit}
                    onChange={(event) => setChildBalanceLimit(event.target.value)}
                    type="number"
                    min={1}
                    className={controlClass}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Limit reset rule (optional)</span>
                  <input
                    value={childBalanceLimitReset}
                    onChange={(event) => setChildBalanceLimitReset(event.target.value)}
                    className={controlClass}
                    placeholder="daily"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Validity date</span>
                  <input
                    value={childValidityDate}
                    onChange={(event) => setChildValidityDate(event.target.value)}
                    type="date"
                    className={controlClass}
                  />
                </label>
              </div>

              <button
                onClick={() => {
                  void handleCreateChildKeys();
                }}
                disabled={isCreatingChildKeys || !parentApiKey.trim()}
                className="platform-btn-primary w-full py-2.5"
                type="button"
              >
                {isCreatingChildKeys ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                Generate child keys
              </button>

              {childCostMsats !== null || parentBalanceMsats !== null ? (
                <div className="rounded-lg border border-border/70 bg-background/40 p-3 text-xs text-muted-foreground">
                  {childCostMsats !== null ? <p>Cost: {formatSats(childCostMsats)}</p> : null}
                  {parentBalanceMsats !== null ? (
                    <p>Parent balance: {formatSats(parentBalanceMsats)}</p>
                  ) : null}
                </div>
              ) : null}

              {createdChildKeys.length > 0 ? (
                <div className="rounded-lg border border-border/70 bg-background/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      Generated keys: {createdChildKeys.length}
                    </p>
                    <button
                      onClick={() => {
                        void handleCopy(createdChildKeys.join("\n"), "all-child-keys");
                      }}
                      className="platform-btn-secondary gap-1 px-2 py-1.5 text-xs"
                      type="button"
                    >
                      {copiedValue === "all-child-keys" ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      Copy all
                    </button>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-auto">
                    {createdChildKeys.map((key) => (
                      <div
                        key={key}
                        className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5"
                      >
                        <code className="flex-1 truncate text-[11px]">{key}</code>
                        <button
                          onClick={() => {
                            void handleCopy(key, `child-${key}`);
                          }}
                          className="platform-btn-secondary gap-1 px-2 py-1 text-xs"
                          type="button"
                        >
                          {copiedValue === `child-${key}` ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {childMode === "status" ? (
            <div
              id="child-workflow-panel-status"
              role="tabpanel"
              aria-labelledby="child-workflow-tab-status"
              className="space-y-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className={labelClass}>Endpoint</span>
                  <select
                    value={checkChildBaseUrl}
                    onChange={(event) => setCheckChildBaseUrl(event.target.value)}
                    className={controlClass}
                  >
                    {endpointOptions.map((url) => (
                      <option key={`check-child-${url}`} value={url}>
                        {url}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5 sm:col-span-2">
                  <span className={labelClass}>Child API key</span>
                  <input
                    value={childKeyToCheck}
                    onChange={(event) => setChildKeyToCheck(event.target.value)}
                    placeholder="sk-..."
                    className={`${controlClass} font-mono text-xs`}
                  />
                </label>
              </div>

              <button
                onClick={() => {
                  void handleCheckChildStatus();
                }}
                disabled={isCheckingChildKey || !childKeyToCheck.trim()}
                className="platform-btn-primary w-full py-2.5"
                type="button"
              >
                {isCheckingChildKey ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Check status
              </button>

              {childKeyStatus ? (
                <div className="rounded-lg border border-border/70 bg-background/40 p-3 text-sm space-y-2">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Total spent</span>
                    <span className="font-medium">{formatSats(childKeyStatus.totalSpentMsats)}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Balance limit</span>
                    <span className="font-medium">
                      {childKeyStatus.balanceLimitMsats === null
                        ? "No limit"
                        : formatSats(childKeyStatus.balanceLimitMsats)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Validity date</span>
                    <span className="font-medium">
                      {childKeyStatus.validityDateUnix === null
                        ? "No expiry"
                        : new Date(childKeyStatus.validityDateUnix * 1000).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex gap-2 pt-1">
                    {childKeyStatus.isDrained ? (
                      <span className="rounded-md border border-border/70 bg-muted/35 px-2 py-1 text-xs text-foreground">
                        Drained
                      </span>
                    ) : null}
                    {childKeyStatus.isExpired ? (
                      <span className="rounded-md border border-border/70 bg-muted/35 px-2 py-1 text-xs text-foreground">
                        Expired
                      </span>
                    ) : null}
                    {!childKeyStatus.isDrained && !childKeyStatus.isExpired ? (
                      <span className="rounded-md border border-border/70 bg-muted/35 px-2 py-1 text-xs text-foreground">
                        Active
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
