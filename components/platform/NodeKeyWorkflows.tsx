"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CashuMint,
  CashuWallet,
  getEncodedTokenV4,
  type Proof as CashuProof,
} from "@cashu/cashu-ts";
import { Check, Copy, Loader2, QrCode, RefreshCw, Zap } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  appendTransaction,
  getProofsBalanceSats,
  readCashuProofs,
  writeCashuProofs,
} from "@/lib/platformWallet";
import {
  annotateProofsWithMint,
  getProofsForMint,
  type WalletProof,
} from "@/lib/nip60WalletSync";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

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

const FALLBACK_MINT_URL = "https://mint.minibits.cash/Bitcoin";
const ACTIVE_MINT_STORAGE_KEY = "platform_active_mint_url";
type MintUnit = "sat" | "msat";

type NodeKeyWorkflowsProps = {
  defaultBaseUrl: string;
  availableBaseUrls: string[];
  storedApiKeys: StoredApiKeyLike[];
  onUpsertKey: (baseUrl: string, apiKey: string, label: string) => Promise<void>;
  activateCreateSignal?: number;
  showLightningSection?: boolean;
  showChildSection?: boolean;
  minimalLayout?: boolean;
};

type TabOption<T extends string> = {
  id: T;
  label: string;
  description?: string;
};

function SectionShell({
  children,
  isMinimalLayout,
}: {
  children: ReactNode;
  isMinimalLayout: boolean;
}) {
  return isMinimalLayout ? (
    <div className="space-y-3">{children}</div>
  ) : (
    <Card className="gap-0 p-5">{children}</Card>
  );
}

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

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;
}

function normalizeMintUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function proofIdentity(proof: WalletProof): string {
  if (typeof proof.secret === "string" && proof.secret.length > 0) {
    return proof.secret;
  }
  return `${String(proof.id)}:${Number(proof.amount)}:${String(proof.C || "")}`;
}

function sumProofsBalanceSats(proofs: WalletProof[]): number {
  return proofs.reduce((sum, proof) => sum + Number(proof.amount || 0), 0);
}

function encodeCashuTokenV4(
  mintUrl: string,
  unit: MintUnit,
  proofs: CashuProof[]
): string {
  const normalizedProofs = proofs.map((proof) => ({
    id: String(proof.id || ""),
    amount: Number(proof.amount || 0),
    secret: String(proof.secret || ""),
    C: String(proof.C || ""),
  }));

  if (
    normalizedProofs.some(
      (proof) =>
        !proof.id ||
        !proof.secret ||
        !proof.C ||
        !Number.isFinite(proof.amount) ||
        proof.amount <= 0
    )
  ) {
    throw new Error("Mint returned invalid proofs for token generation");
  }

  return getEncodedTokenV4({
    mint: mintUrl,
    unit,
    proofs: normalizedProofs,
  });
}

async function createWalletForMint(
  candidateMintUrl: string
): Promise<{ wallet: CashuWallet; unit: MintUnit; preferredKeysetId?: string }> {
  const mint = new CashuMint(candidateMintUrl);
  const keysets = await mint.getKeySets();
  const activeKeysets = keysets.keysets.filter((keyset) => keyset.active);
  const msatKeyset = activeKeysets.find(
    (keyset) => String(keyset.unit).toLowerCase() === "msat"
  );
  const satKeyset = activeKeysets.find(
    (keyset) => String(keyset.unit).toLowerCase() === "sat"
  );
  const preferredUnit = msatKeyset ? "msat" : satKeyset ? "sat" : null;

  if (!preferredUnit) {
    const units = [...new Set(activeKeysets.map((keyset) => String(keyset.unit).toLowerCase()))];
    throw new Error(
      `Mint ${candidateMintUrl} has no active sat/msat keyset (units: ${
        units.join(", ") || "none"
      })`
    );
  }

  const wallet = new CashuWallet(mint, { unit: preferredUnit });
  await wallet.loadMint();
  return {
    wallet,
    unit: preferredUnit,
    preferredKeysetId: (preferredUnit === "msat" ? msatKeyset?.id : satKeyset?.id) || undefined,
  };
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
  activateCreateSignal,
  showLightningSection,
  showChildSection,
  minimalLayout,
}: NodeKeyWorkflowsProps) {
  const shouldShowLightningSection = showLightningSection ?? true;
  const shouldShowChildSection = showChildSection ?? true;
  const isMinimalLayout = minimalLayout ?? false;
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
  const [createLabel, setCreateLabel] = useState("");
  const [createdApiKey, setCreatedApiKey] = useState<string | null>(null);
  const [isCreatingFromBalance, setIsCreatingFromBalance] = useState(false);

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

  const handleCreateFromBalance = useCallback(async () => {
    const amount = Number.parseInt(createAmount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid amount in sats");
      return;
    }

    const readStoredActiveMint = () => {
      if (typeof window === "undefined") return "";
      return normalizeMintUrl(localStorage.getItem(ACTIVE_MINT_STORAGE_KEY) || "");
    };

    const fetchAcceptedMints = async (baseUrl: string): Promise<string[]> => {
      try {
        const response = await fetch(`${baseUrl}v1/info`, {
          cache: "no-store",
        });
        if (!response.ok) return [];
        const payload = (await response.json()) as { mints?: string[] };
        if (!Array.isArray(payload?.mints)) return [];
        return payload.mints.map((mint) => normalizeMintUrl(mint)).filter(Boolean);
      } catch {
        return [];
      }
    };

    const createTokenFromBalance = async (
      amountSats: number,
      nodeMints: string[],
      preferredMint: string
    ): Promise<{ token: string }> => {
      const proofsBefore = readCashuProofs() as WalletProof[];
      if (!Array.isArray(proofsBefore) || proofsBefore.length === 0) {
        throw new Error("No wallet balance available");
      }

      const walletMintBalances = new Map<string, number>();
      for (const proof of proofsBefore) {
        const mint = normalizeMintUrl(proof.mintUrl || "");
        if (!mint) continue;
        walletMintBalances.set(
          mint,
          (walletMintBalances.get(mint) || 0) + Number(proof.amount || 0)
        );
      }

      const sortedWalletMints = Array.from(walletMintBalances.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([mint]) => mint);

      const normalizedNodeMints = Array.from(
        new Set(nodeMints.map((mint) => normalizeMintUrl(mint)).filter(Boolean))
      );
      const sortedNodeMints = normalizedNodeMints.sort(
        (a, b) => (walletMintBalances.get(b) || 0) - (walletMintBalances.get(a) || 0)
      );

      const nodeMintSet = new Set(sortedNodeMints);
      const hasNodeMintHints = nodeMintSet.size > 0;
      const baseCandidates = Array.from(
        new Set(
          [
            normalizeMintUrl(preferredMint),
            ...sortedWalletMints,
            normalizeMintUrl(FALLBACK_MINT_URL),
          ].filter(Boolean)
        )
      );
      const candidates = hasNodeMintHints
        ? [
            ...baseCandidates.filter((mint) => nodeMintSet.has(mint)),
            ...baseCandidates.filter((mint) => !nodeMintSet.has(mint)),
          ]
        : baseCandidates;

      if (candidates.length === 0) {
        throw new Error("No eligible mint found for wallet balance");
      }

      let lastError: unknown = null;

      for (const mint of candidates) {
        try {
          const { wallet, unit, preferredKeysetId } = await createWalletForMint(mint);
          const proofsForMint = getProofsForMint(proofsBefore, mint);
          if (!Array.isArray(proofsForMint) || proofsForMint.length === 0) {
            continue;
          }
          const amountInMintUnit = unit === "msat" ? amountSats * 1000 : amountSats;
          const availableForMint = sumProofsBalanceSats(proofsForMint);
          if (availableForMint < amountInMintUnit) {
            continue;
          }

          const sendOptions = {
            ...(preferredKeysetId ? { keysetId: preferredKeysetId } : {}),
          };
          let sendResult: Awaited<ReturnType<CashuWallet["send"]>>;
          try {
            sendResult = await wallet.send(amountInMintUnit, proofsForMint as CashuProof[], {
              ...sendOptions,
              includeFees: true,
            });
          } catch (firstSendError) {
            const firstMessage =
              firstSendError instanceof Error
                ? firstSendError.message
                : String(firstSendError);
            if (
              firstMessage.includes("Not enough funds available") ||
              firstMessage.includes("Token already spent") ||
              firstMessage.includes("Not enough balance to send")
            ) {
              sendResult = await wallet.send(amountInMintUnit, proofsForMint as CashuProof[], {
                ...sendOptions,
              });
            } else {
              throw firstSendError;
            }
          }

          const sendProofs = (sendResult?.send || []) as CashuProof[];
          const keepProofs = (sendResult?.keep || []) as CashuProof[];
          if (sendProofs.length === 0) {
            throw new Error("Unable to generate Cashu token");
          }

          const mintedProofIds = new Set(proofsForMint.map((proof) => proofIdentity(proof)));
          const untouched = proofsBefore.filter(
            (proof) => !mintedProofIds.has(proofIdentity(proof))
          );
          const keepWithMetadata = annotateProofsWithMint(keepProofs, mint);
          writeCashuProofs([...untouched, ...keepWithMetadata]);

          const nextBalance = getProofsBalanceSats();
          appendTransaction({
            type: "send",
            amount: amountSats,
            timestamp: Date.now(),
            status: "success",
            message: "Spent wallet balance for API key creation",
            balance: nextBalance,
          });

          return { token: encodeCashuTokenV4(mint, unit, sendProofs) };
        } catch (error) {
          lastError = error;
        }
      }

      if (lastError instanceof Error) {
        throw new Error(lastError.message);
      }
      throw new Error("Insufficient wallet balance on available mints");
    };

    setIsCreatingFromBalance(true);
    setCreatedApiKey(null);

    try {
      const nodeMints = await fetchAcceptedMints(createBaseUrl);
      const preferredMint = readStoredActiveMint();
      const result = await createTokenFromBalance(amount, nodeMints, preferredMint);

      const response = await fetch(`${createBaseUrl}v1/wallet/info`, {
        headers: {
          Authorization: `Bearer ${result.token}`,
        },
      });

      if (!response.ok) {
        throw await parseResponseError(
          response,
          "Failed to create API key from wallet balance"
        );
      }

      const payload = (await response.json()) as {
        api_key?: string;
        apiKey?: string;
      };
      const apiKey = String(payload.api_key || payload.apiKey || "").trim();
      if (!apiKey) {
        throw new Error("API key response did not include an api_key");
      }

      await onUpsertKey(createBaseUrl, apiKey, createLabel.trim() || "Unnamed");
      setCreatedApiKey(apiKey);
      setCreateAmount("");
      setCreateLabel("");
      toast.success("API key created from wallet balance");
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create API key from balance"));
    } finally {
      setIsCreatingFromBalance(false);
    }
  }, [createAmount, createBaseUrl, createLabel, onUpsertKey]);

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
        description: "Create a new API key by spending from wallet balance.",
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
  const createAmountInputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    if (!shouldShowLightningSection) return;
    if (activateCreateSignal === undefined) return;
    setLightningMode("create");
    setTimeout(() => {
      createAmountInputRef.current?.focus();
    }, 0);
  }, [activateCreateSignal, shouldShowLightningSection]);

  const lightningModeDescription =
    lightningTabOptions.find((option) => option.id === lightningMode)?.description || "\u00A0";
  const childModeDescription =
    childTabOptions.find((option) => option.id === childMode)?.description || "\u00A0";
  const labelClass = "text-xs font-medium text-muted-foreground";

  return (
    <div className={isMinimalLayout ? "space-y-4" : "space-y-5"}>
      {shouldShowLightningSection ? (
        <SectionShell isMinimalLayout={isMinimalLayout}>
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
          <Tabs
            value={lightningMode}
            onValueChange={(value) => setLightningMode(value as "create" | "topup" | "recover")}
            className="w-full max-w-[24rem] gap-2"
          >
            <TabsList>
              {lightningTabOptions.map((option) => (
                <TabsTrigger key={option.id} value={option.id}>
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <p className="min-h-10 text-xs leading-relaxed text-muted-foreground">
            {lightningModeDescription}
          </p>
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
                    <Select value={createBaseUrl} onValueChange={setCreateBaseUrl}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {endpointOptions.map((url) => (
                          <SelectItem key={`create-${url}`} value={url}>
                            {url}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className={labelClass}>Label (optional)</span>
                    <Input
                      value={createLabel}
                      onChange={(event) => setCreateLabel(event.target.value)}
                      placeholder="Unnamed"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Amount (sats)</span>
                    <Input
                      ref={createAmountInputRef}
                      value={createAmount}
                      onChange={(event) => setCreateAmount(event.target.value)}
                      type="number"
                      min={1}
                      placeholder="1000"
                    />
                  </label>
                </div>

                <Button
                  onClick={() => {
                    void handleCreateFromBalance();
                  }}
                  disabled={isCreatingFromBalance}
                  className="w-full"
                  type="button"
                >
                  {isCreatingFromBalance ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {isCreatingFromBalance ? "Creating key..." : "Create key from balance"}
                </Button>
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
                    <Select
                      value={selectedTopupKeyId}
                      onValueChange={setSelectedTopupKeyId}
                      disabled={keyOptions.length === 0}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="No keys available" />
                      </SelectTrigger>
                      <SelectContent>
                        {keyOptions.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.label} ({shortKey(item.key)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Endpoint</span>
                    <Select value={topupBaseUrl} onValueChange={setTopupBaseUrl}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {endpointOptions.map((url) => (
                          <SelectItem key={`topup-${url}`} value={url}>
                            {url}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Amount (sats)</span>
                    <Input
                      value={topupAmount}
                      onChange={(event) => setTopupAmount(event.target.value)}
                      type="number"
                      min={1}
                      placeholder="1000"
                    />
                  </label>
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className={labelClass}>API key</span>
                    <Input
                      value={topupApiKey}
                      onChange={(event) => setTopupApiKey(event.target.value)}
                      className="font-mono text-xs"
                      placeholder="sk-..."
                    />
                  </label>
                </div>

                <Button
                  onClick={() => {
                    void handleTopupInvoice();
                  }}
                  disabled={
                    isCreatingTopupInvoice ||
                    isPollingTopupInvoice ||
                    !topupApiKey.trim()
                  }
                  className="w-full"
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
                </Button>
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
                  <Select value={recoverBaseUrl} onValueChange={setRecoverBaseUrl}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {endpointOptions.map((url) => (
                        <SelectItem key={`recover-${url}`} value={url}>
                          {url}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>BOLT11 invoice</span>
                  <Textarea
                    value={recoverBolt11}
                    onChange={(event) => setRecoverBolt11(event.target.value)}
                    placeholder="Paste BOLT11 invoice"
                    className="h-28 resize-none"
                  />
                </label>
                <Button
                  onClick={() => {
                    void handleRecoverInvoice();
                  }}
                  disabled={isRecoveringInvoice || !recoverBolt11.trim()}
                  className="w-full"
                  type="button"
                >
                  {isRecoveringInvoice ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Recover API key
                </Button>
                {recoveredApiKey ? (
                  <p className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-foreground">
                    Recovered key: <span className="font-mono">{shortKey(recoveredApiKey)}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <aside className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3 min-h-[30rem]">
            <p className="text-xs font-medium text-muted-foreground">
              {lightningMode === "create" ? "Create status" : "Invoice preview"}
            </p>
            {lightningMode === "create" && createdApiKey ? (
              <p className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-foreground">
                Key created: <span className="font-mono">{shortKey(createdApiKey)}</span>
              </p>
            ) : null}

            {lightningMode === "topup" && topupInvoice ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Status:{" "}
                  <span className="font-semibold text-foreground">{topupInvoiceStatus}</span>
                </p>
                <Card className="gap-0 flex justify-center p-2 py-2 shadow-none">
                  <QRCodeSVG value={topupInvoice.bolt11} size={120} />
                </Card>
                <Textarea
                  readOnly
                  value={topupInvoice.bolt11}
                  className="h-24 resize-none font-mono text-[11px]"
                />
                <Button
                  onClick={() => {
                    void handleCopy(topupInvoice.bolt11, `topup-bolt11-${topupInvoice.invoice_id}`);
                  }}
                  variant="secondary"
                  size="sm"
                  type="button"
                >
                  {copiedValue === `topup-bolt11-${topupInvoice.invoice_id}` ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  Copy
                </Button>
              </>
            ) : null}

            {(lightningMode === "recover" ||
              (lightningMode === "topup" && !topupInvoice)) && (
              <div className="rounded-lg border border-dashed border-border/70 p-3 text-xs text-muted-foreground leading-relaxed">
                {lightningMode === "recover"
                  ? "Recover mode checks invoice status and syncs the API key if paid."
                  : "Create an invoice to show QR and payment details here."}
              </div>
            )}
          </aside>
        </div>
        </SectionShell>
      ) : null}

      {shouldShowChildSection ? (
        <SectionShell isMinimalLayout={isMinimalLayout}>
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-base font-semibold tracking-tight">Child Key Tools</h3>
            <p className="text-sm text-muted-foreground">
              Generate child keys from a parent key and inspect child-key limits.
            </p>
          </div>
          <Tabs
            value={childMode}
            onValueChange={(value) => setChildMode(value as "create" | "status")}
            className="w-full max-w-[24rem] gap-2"
          >
            <TabsList>
              {childTabOptions.map((option) => (
                <TabsTrigger key={option.id} value={option.id}>
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <p className="min-h-10 text-xs leading-relaxed text-muted-foreground">
            {childModeDescription}
          </p>
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
                  <Select
                    value={selectedParentKeyId}
                    onValueChange={setSelectedParentKeyId}
                    disabled={keyOptions.length === 0}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No parent key available" />
                    </SelectTrigger>
                    <SelectContent>
                      {keyOptions.map((item) => (
                        <SelectItem key={`parent-${item.id}`} value={item.id}>
                          {item.label} ({shortKey(item.key)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Endpoint</span>
                  <Select value={childBaseUrl} onValueChange={setChildBaseUrl}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {endpointOptions.map((url) => (
                        <SelectItem key={`child-${url}`} value={url}>
                          {url}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Number of keys</span>
                  <Input
                    value={childCount}
                    onChange={(event) => setChildCount(event.target.value)}
                    type="number"
                    min={1}
                    max={50}
                  />
                </label>
                <label className="space-y-1.5 sm:col-span-2">
                  <span className={labelClass}>Parent API key</span>
                  <Input
                    value={parentApiKey}
                    onChange={(event) => setParentApiKey(event.target.value)}
                    className="font-mono text-xs"
                    placeholder="sk-..."
                  />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Balance limit (optional, msats)</span>
                  <Input
                    value={childBalanceLimit}
                    onChange={(event) => setChildBalanceLimit(event.target.value)}
                    type="number"
                    min={1}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Limit reset rule (optional)</span>
                  <Input
                    value={childBalanceLimitReset}
                    onChange={(event) => setChildBalanceLimitReset(event.target.value)}
                    placeholder="daily"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Validity date</span>
                  <Input
                    value={childValidityDate}
                    onChange={(event) => setChildValidityDate(event.target.value)}
                    type="date"
                  />
                </label>
              </div>

              <Button
                onClick={() => {
                  void handleCreateChildKeys();
                }}
                disabled={isCreatingChildKeys || !parentApiKey.trim()}
                className="w-full"
                type="button"
              >
                {isCreatingChildKeys ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                Generate child keys
              </Button>

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
                    <Button
                      onClick={() => {
                        void handleCopy(createdChildKeys.join("\n"), "all-child-keys");
                      }}
                      variant="secondary"
                      size="sm"
                      type="button"
                    >
                      {copiedValue === "all-child-keys" ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      Copy all
                    </Button>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-auto">
                    {createdChildKeys.map((key) => (
                      <div
                        key={key}
                        className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5"
                      >
                        <code className="flex-1 truncate text-[11px]">{key}</code>
                        <Button
                          onClick={() => {
                            void handleCopy(key, `child-${key}`);
                          }}
                          variant="secondary"
                          size="sm"
                          type="button"
                        >
                          {copiedValue === `child-${key}` ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
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
                  <Select value={checkChildBaseUrl} onValueChange={setCheckChildBaseUrl}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {endpointOptions.map((url) => (
                        <SelectItem key={`check-child-${url}`} value={url}>
                          {url}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="space-y-1.5 sm:col-span-2">
                  <span className={labelClass}>Child API key</span>
                  <Input
                    value={childKeyToCheck}
                    onChange={(event) => setChildKeyToCheck(event.target.value)}
                    placeholder="sk-..."
                    className="font-mono text-xs"
                  />
                </label>
              </div>

              <Button
                onClick={() => {
                  void handleCheckChildStatus();
                }}
                disabled={isCheckingChildKey || !childKeyToCheck.trim()}
                className="w-full"
                type="button"
              >
                {isCheckingChildKey ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Check status
              </Button>

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
        </SectionShell>
      ) : null}
    </div>
  );
}
