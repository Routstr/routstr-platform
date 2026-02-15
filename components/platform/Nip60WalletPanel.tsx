"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CashuMint, CashuWallet, CheckStateEnum, type Proof as CashuProof } from "@cashu/cashu-ts";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useObservableState } from "applesauce-react/hooks";
import { toast } from "sonner";
import WalletTab from "@/components/wallet/WalletTab";
import { useAccountManager } from "@/components/providers/ClientProviders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getStorageBoolean, setStorageBoolean } from "@/lib/storage";
import {
  getProofsBalanceSats,
  PLATFORM_WALLET_UPDATED_EVENT,
  readCashuProofs,
  readTransactionHistory,
  type WalletTransactionHistory,
  writeCashuProofs,
} from "@/lib/platformWallet";
import { DEFAULT_BASE_URL } from "@/lib/utils";
import {
  fetchNip60ActiveProofs,
  fetchNip60WalletConfig,
  getProofsForMint,
  isCloudSyncCapableAccount,
  publishNip60MintSnapshot,
  publishNip60WalletMints,
  type WalletProof,
} from "@/lib/nip60WalletSync";

const CHAT_NIP60_STORAGE_KEY = "usingNip60";
const LEGACY_PLATFORM_NIP60_STORAGE_KEY = "platform_use_nip60_wallet";
const FALLBACK_MINT_URL = "https://mint.minibits.cash/Bitcoin";
const PLATFORM_ACTIVE_MINT_STORAGE_KEY = "platform_active_mint_url";

interface StoredProofWithMint {
  id?: string;
  amount?: number;
  secret?: string;
  C?: string;
  mintUrl?: string;
  eventId?: string;
}

function readNip60Preference(): boolean {
  const chatValue = localStorage.getItem(CHAT_NIP60_STORAGE_KEY);
  if (chatValue !== null) {
    return chatValue === "true";
  }

  const legacyValue = getStorageBoolean(LEGACY_PLATFORM_NIP60_STORAGE_KEY, true);
  setStorageBoolean(CHAT_NIP60_STORAGE_KEY, legacyValue);
  return legacyValue;
}

function ensureNip60Enabled(): void {
  if (readNip60Preference()) return;
  setStorageBoolean(CHAT_NIP60_STORAGE_KEY, true);
  setStorageBoolean(LEGACY_PLATFORM_NIP60_STORAGE_KEY, true);
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

function normalizeMintUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function uniqueMints(mints: string[]): string[] {
  return Array.from(
    new Set(
      mints
        .map((mint) => normalizeMintUrl(mint))
        .filter((mint) => mint.length > 0 && !isOnionUrl(mint))
    )
  );
}

function cleanMintUrl(mintUrl: string): string {
  try {
    const parsed = new URL(mintUrl);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return mintUrl;
  }
}

function proofIdentity(proof: StoredProofWithMint): string {
  if (typeof proof.secret === "string" && proof.secret.length > 0) {
    return proof.secret;
  }
  return `${String(proof.id || "")}:${Number(proof.amount || 0)}:${String(proof.C || "")}`;
}

async function createWalletForMint(candidateMintUrl: string): Promise<CashuWallet> {
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
  return wallet;
}

async function isReachableMint(url: string): Promise<boolean> {
  const normalized = normalizeMintUrl(url);
  if (!normalized || isOnionUrl(normalized)) return false;

  try {
    const response = await fetch(`${normalized}/v1/keysets`, {
      cache: "no-store",
    });
    if (!response.ok) return false;

    const payload = (await response.json()) as {
      keysets?: Array<{ active?: boolean; unit?: string }>;
    };
    const keysets = Array.isArray(payload?.keysets) ? payload.keysets : [];
    return keysets.some((keyset) => {
      const unit = String(keyset?.unit || "").toLowerCase();
      return keyset?.active && (unit === "sat" || unit === "msat");
    });
  } catch {
    return false;
  }
}

const NORMALIZED_FALLBACK_MINT = normalizeMintUrl(FALLBACK_MINT_URL);

export default function Nip60WalletPanel({
  baseUrl,
}: {
  baseUrl: string;
}) {
  const { manager } = useAccountManager();
  const activeAccount = useObservableState(manager.active$);
  const [walletBalance, setWalletBalance] = useState(0);
  const [, setTransactionHistory] = useState<WalletTransactionHistory[]>([]);
  const [mintUrl, setMintUrl] = useState(NORMALIZED_FALLBACK_MINT);
  const [availableMints, setAvailableMints] = useState<string[]>([
    NORMALIZED_FALLBACK_MINT,
  ]);
  const [walletPrivkey, setWalletPrivkey] = useState<string | null>(null);
  const [customMintUrl, setCustomMintUrl] = useState("");
  const [showAddMintInput, setShowAddMintInput] = useState(false);
  const [showRemoveMintMode, setShowRemoveMintMode] = useState(false);
  const [isLoadingMints, setIsLoadingMints] = useState(true);
  const [isSavingMints, setIsSavingMints] = useState(false);
  const [isSyncingNip60, setIsSyncingNip60] = useState(false);
  const [isCleaningAllProofs, setIsCleaningAllProofs] = useState(false);
  const [walletSyncError, setWalletSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const syncAccount = useMemo(
    () => (isCloudSyncCapableAccount(activeAccount) ? activeAccount : null),
    [activeAccount]
  );

  const normalizedBaseUrl = useMemo(() => {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized || isOnionUrl(normalized)) {
      return DEFAULT_BASE_URL;
    }
    return normalized;
  }, [baseUrl]);

  useEffect(() => {
    ensureNip60Enabled();
    setWalletBalance(getProofsBalanceSats());
    setTransactionHistory(readTransactionHistory());

    const refreshWalletState = () => {
      setWalletBalance(getProofsBalanceSats());
      setTransactionHistory(readTransactionHistory());
    };

    window.addEventListener(PLATFORM_WALLET_UPDATED_EVENT, refreshWalletState);
    window.addEventListener("storage", refreshWalletState);

    return () => {
      window.removeEventListener(
        PLATFORM_WALLET_UPDATED_EVENT,
        refreshWalletState
      );
      window.removeEventListener("storage", refreshWalletState);
    };
  }, []);

  useEffect(() => {
    const normalizedMint = normalizeMintUrl(mintUrl);
    if (!normalizedMint) return;
    window.localStorage.setItem(PLATFORM_ACTIVE_MINT_STORAGE_KEY, normalizedMint);
  }, [mintUrl]);

  const syncProofsFromNip60 = useCallback(async () => {
    if (!syncAccount) {
      setWalletSyncError(null);
      setIsSyncingNip60(false);
      return;
    }

    setIsSyncingNip60(true);
    setWalletSyncError(null);
    try {
      const syncedProofs = await fetchNip60ActiveProofs(syncAccount);
      writeCashuProofs(syncedProofs);
      setWalletBalance(getProofsBalanceSats());
      setLastSyncedAt(Date.now());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to sync NIP-60 proofs";
      setWalletSyncError(message);
    } finally {
      setIsSyncingNip60(false);
    }
  }, [syncAccount]);

  const syncMintSnapshotToNip60 = useCallback(
    async (
      mintToSync: string,
      beforeProofs: WalletProof[],
      afterProofs: WalletProof[]
    ): Promise<WalletProof[]> => {
      if (!syncAccount) return afterProofs;

      const normalizedMint = normalizeMintUrl(mintToSync);
      const beforeMintProofs = getProofsForMint(beforeProofs, normalizedMint);
      const afterMintProofs = getProofsForMint(afterProofs, normalizedMint);
      const eventIdsToDelete = Array.from(
        new Set(
          beforeMintProofs
            .map((proof) => proof.eventId)
            .filter((eventId): eventId is string => typeof eventId === "string")
        )
      );

      if (afterMintProofs.length === 0 && eventIdsToDelete.length === 0) {
        return afterProofs;
      }

      const newEventId = await publishNip60MintSnapshot(
        syncAccount,
        normalizedMint,
        afterMintProofs,
        eventIdsToDelete
      );

      return afterProofs.map((proof) => {
        if (normalizeMintUrl(proof.mintUrl || "") !== normalizedMint) {
          return proof;
        }
        return {
          ...proof,
          eventId: newEventId,
        };
      });
    },
    [syncAccount]
  );

  const handleCleanAllSpentProofs = useCallback(async (): Promise<void> => {
    if (isCleaningAllProofs) return;

    setIsCleaningAllProofs(true);
    setWalletSyncError(null);
    try {
      const proofsBefore = readCashuProofs() as WalletProof[];
      if (proofsBefore.length === 0) {
        toast.success("No proofs found");
        return;
      }

      const proofMints = uniqueMints(
        proofsBefore
          .map((proof) => normalizeMintUrl(proof.mintUrl || ""))
          .filter((mint) => mint.length > 0)
      );

      if (proofMints.length === 0) {
        toast.success("No mint proofs found");
        return;
      }

      const spentProofIds = new Set<string>();
      const changedMints = new Set<string>();
      const failedMints: string[] = [];

      for (const mint of proofMints) {
        try {
          const proofsForMint = getProofsForMint(proofsBefore, mint);
          if (proofsForMint.length === 0) continue;

          const wallet = await createWalletForMint(mint);
          const proofStates = await wallet.checkProofsStates(proofsForMint as CashuProof[]);
          if (!Array.isArray(proofStates) || proofStates.length === 0) continue;

          let foundSpentForMint = false;
          proofsForMint.forEach((proof, index) => {
            if (proofStates[index]?.state === CheckStateEnum.SPENT) {
              spentProofIds.add(proofIdentity(proof));
              foundSpentForMint = true;
            }
          });
          if (foundSpentForMint) {
            changedMints.add(mint);
          }
        } catch {
          failedMints.push(cleanMintUrl(mint));
        }
      }

      if (spentProofIds.size === 0) {
        if (failedMints.length > 0) {
          const errorMessage = `Unable to check ${failedMints.length} mint${
            failedMints.length === 1 ? "" : "s"
          }.`;
          setWalletSyncError(errorMessage);
          toast.error(errorMessage);
        } else {
          toast.success("No spent proofs found");
        }
        return;
      }

      let proofsAfter = proofsBefore.filter(
        (proof) => !spentProofIds.has(proofIdentity(proof))
      );

      let nip60SyncFailed = false;
      for (const mint of changedMints) {
        try {
          proofsAfter = await syncMintSnapshotToNip60(mint, proofsBefore, proofsAfter);
        } catch (syncError) {
          console.warn("Failed to sync cleaned proofs to NIP-60", syncError);
          nip60SyncFailed = true;
        }
      }

      if (nip60SyncFailed || failedMints.length > 0) {
        const parts: string[] = [];
        if (failedMints.length > 0) {
          parts.push(
            `Unable to check ${failedMints.length} mint${failedMints.length === 1 ? "" : "s"}.`
          );
        }
        if (nip60SyncFailed) {
          parts.push("Cleaned proofs locally, but failed to publish part of NIP-60 snapshots.");
        }
        setWalletSyncError(parts.join(" "));
      }

      writeCashuProofs(proofsAfter);
      setWalletBalance(getProofsBalanceSats());
      toast.success(
        `Cleaned ${spentProofIds.size} spent proof${spentProofIds.size === 1 ? "" : "s"}`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clean spent proofs";
      setWalletSyncError(message);
      toast.error(message);
    } finally {
      setIsCleaningAllProofs(false);
    }
  }, [isCleaningAllProofs, syncMintSnapshotToNip60]);

  useEffect(() => {
    void syncProofsFromNip60();
  }, [syncProofsFromNip60]);

  useEffect(() => {
    let cancelled = false;

    const loadMints = async () => {
      if (!cancelled) {
        setIsLoadingMints(true);
      }
      try {
        const proofMints = (readCashuProofs() as StoredProofWithMint[])
          .map((proof) => normalizeMintUrl(proof.mintUrl || ""))
          .filter((mint) => mint.length > 0 && !isOnionUrl(mint));

        let walletConfigMints: string[] = [];
        if (syncAccount) {
          try {
            const walletConfig = await fetchNip60WalletConfig(syncAccount);
            if (cancelled) return;
            setWalletPrivkey(walletConfig.privkey);
            walletConfigMints = walletConfig.mints;
          } catch {
            if (!cancelled) setWalletPrivkey(null);
          }
        } else if (!cancelled) {
          setWalletPrivkey(null);
        }

        let nodeMints: string[] = [];
        try {
          const response = await fetch(`${normalizedBaseUrl}v1/info`, {
            cache: "no-store",
          });
          if (response.ok) {
            const payload = (await response.json()) as { mints?: string[] };
            nodeMints = Array.isArray(payload?.mints) ? payload.mints : [];
          }
        } catch {
          // Ignore endpoint errors and keep wallet-config mints
        }

        const nextMints = uniqueMints([
          ...walletConfigMints,
          ...proofMints,
          ...nodeMints,
          NORMALIZED_FALLBACK_MINT,
        ]);

        const resolvedMints =
          nextMints.length > 0 ? nextMints : [NORMALIZED_FALLBACK_MINT];
        if (cancelled) return;

        let firstReachableMint = resolvedMints[0];
        for (const candidate of resolvedMints) {
          if (await isReachableMint(candidate)) {
            firstReachableMint = candidate;
            break;
          }
        }
        if (cancelled) return;

        setAvailableMints(resolvedMints);
        setMintUrl((previous) => {
          const normalizedPrevious = normalizeMintUrl(previous);
          if (resolvedMints.includes(normalizedPrevious)) {
            return normalizedPrevious;
          }
          return firstReachableMint;
        });
      } finally {
        if (!cancelled) {
          setIsLoadingMints(false);
        }
      }
    };

    void loadMints();

    return () => {
      cancelled = true;
    };
  }, [normalizedBaseUrl, syncAccount]);

  const persistWalletMints = useCallback(
    async (nextMints: string[]) => {
      if (!syncAccount) {
        throw new Error("Connect a signer-enabled account to manage wallet mints.");
      }

      let privkey = walletPrivkey;
      if (!privkey) {
        const walletConfig = await fetchNip60WalletConfig(syncAccount);
        privkey = walletConfig.privkey;
        setWalletPrivkey(walletConfig.privkey);
      }

      if (!privkey) {
        throw new Error(
          "Missing NIP-60 wallet key. Open routstr-chat wallet once, then retry."
        );
      }

      await publishNip60WalletMints(syncAccount, nextMints, privkey);
    },
    [syncAccount, walletPrivkey]
  );

  const handleAddMint = useCallback(async () => {
    const normalizedMint = normalizeMintUrl(customMintUrl);
    if (!normalizedMint || isOnionUrl(normalizedMint)) {
      setWalletSyncError("Please enter a valid public mint URL.");
      return;
    }

    if (availableMints.includes(normalizedMint)) {
      setMintUrl(normalizedMint);
      setCustomMintUrl("");
      setShowAddMintInput(false);
      return;
    }

    setIsSavingMints(true);
    setWalletSyncError(null);
    try {
      const nextMints = uniqueMints([...availableMints, normalizedMint]);
      await persistWalletMints(nextMints);
      setAvailableMints(nextMints);
      setMintUrl(normalizedMint);
      setCustomMintUrl("");
      setShowAddMintInput(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add mint";
      setWalletSyncError(message);
    } finally {
      setIsSavingMints(false);
    }
  }, [availableMints, customMintUrl, persistWalletMints]);

  const handleRemoveMint = useCallback(
    async (mintToRemove: string): Promise<void> => {
      if (availableMints.length <= 1) return;

      setIsSavingMints(true);
      setWalletSyncError(null);
      try {
        const nextMints = availableMints.filter((mint) => mint !== mintToRemove);
        await persistWalletMints(nextMints);
        setAvailableMints(nextMints);
        setMintUrl((previous) => {
          if (previous !== mintToRemove) return previous;
          return nextMints[0] || NORMALIZED_FALLBACK_MINT;
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to remove mint";
        setWalletSyncError(message);
      } finally {
        setIsSavingMints(false);
      }
    },
    [availableMints, persistWalletMints]
  );

  const mintBalances: Record<string, number> = {};
  for (const mint of availableMints) {
    mintBalances[mint] = 0;
  }

  let untaggedBalance = 0;
  const storedProofs = readCashuProofs() as StoredProofWithMint[];
  for (const proof of storedProofs) {
    const amount = Number(proof?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const proofMint = normalizeMintUrl(proof?.mintUrl || "");
    if (!proofMint) {
      untaggedBalance += amount;
      continue;
    }

    if (mintBalances[proofMint] === undefined) {
      mintBalances[proofMint] = 0;
    }
    mintBalances[proofMint] += amount;
  }

  if (untaggedBalance > 0) {
    const targetMint =
      mintBalances[mintUrl] !== undefined
        ? mintUrl
        : availableMints[0] || NORMALIZED_FALLBACK_MINT;
    mintBalances[targetMint] = (mintBalances[targetMint] || 0) + untaggedBalance;
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button
            onClick={() => {
              if (!syncAccount || isSyncingNip60) return;
              void syncProofsFromNip60();
            }}
            disabled={!syncAccount || isSyncingNip60}
            variant="outline"
            size="sm"
            type="button"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSyncingNip60 ? "animate-spin" : ""}`} />
            {isSyncingNip60 ? "Syncing..." : "Sync now"}
          </Button>
          {lastSyncedAt ? (
            <span className="text-muted-foreground">
              Last sync: {new Date(lastSyncedAt).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
        {walletSyncError ? (
          <p className="text-xs text-foreground/80">{walletSyncError}</p>
        ) : null}
      </div>

      <Card className="min-w-0 gap-0 bg-muted/20 p-4 py-4 shadow-none">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Available balance</span>
          <span className="text-lg font-semibold text-foreground">
            {walletBalance.toLocaleString()} sats
          </span>
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground/85">Mints</h3>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                onClick={() => setShowAddMintInput((previous) => !previous)}
                disabled={!syncAccount || isSavingMints || isLoadingMints}
                variant="outline"
                size="icon-sm"
                aria-label="Add mint"
                type="button"
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                onClick={() => setShowRemoveMintMode((previous) => !previous)}
                disabled={
                  !syncAccount ||
                  isSavingMints ||
                  isLoadingMints ||
                  availableMints.length <= 1
                }
                variant="outline"
                size="icon-sm"
                aria-label="Toggle remove mint mode"
                title={
                  availableMints.length <= 1
                    ? "Cannot remove the last mint"
                    : showRemoveMintMode
                      ? "Exit remove mode"
                      : "Remove mints"
                }
                type="button"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={() => {
                        void handleCleanAllSpentProofs();
                      }}
                      disabled={isCleaningAllProofs || isSavingMints || isLoadingMints}
                      variant="outline"
                      size="icon-sm"
                      aria-label="Clean all spent proofs"
                      type="button"
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${isCleaningAllProofs ? "animate-spin" : ""}`}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end">
                    Remove spent proofs from all mints.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {isLoadingMints ? (
            <div className="space-y-2">
              {[0, 1, 2].map((index) => (
                <div
                  key={`mint-skeleton-${index}`}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/25 px-2.5 py-2"
                  aria-hidden="true"
                >
                  <span className="h-4 w-4 animate-pulse rounded-full bg-muted" />
                  <span className="h-4 flex-1 animate-pulse rounded bg-muted" />
                  <span className="h-4 w-16 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {availableMints.map((mint) => {
                const isActive = mint === mintUrl;
                return (
                  <div
                    key={mint}
                    className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 ${
                      isActive
                        ? "border-border bg-muted/60"
                        : "border-border/60 bg-muted/25 hover:bg-muted/40"
                    }`}
                  >
                    <input
                      type="radio"
                      id={`wallet-mint-${mint}`}
                      name="wallet-mint"
                      value={mint}
                      checked={isActive}
                      onChange={() => setMintUrl(mint)}
                      className="h-4 w-4 cursor-pointer"
                    />
                    <label
                      htmlFor={`wallet-mint-${mint}`}
                      className="min-w-0 flex-1 cursor-pointer truncate text-sm text-foreground/90"
                      title={mint}
                    >
                      {cleanMintUrl(mint)}
                    </label>
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {(mintBalances[mint] || 0).toLocaleString()} sats
                    </span>
                    {showRemoveMintMode ? (
                      <Button
                        onClick={() => {
                          void handleRemoveMint(mint);
                        }}
                        disabled={isSavingMints || availableMints.length <= 1}
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${cleanMintUrl(mint)}`}
                        title={
                          availableMints.length <= 1
                            ? "Cannot remove the last mint"
                            : `Remove ${cleanMintUrl(mint)}`
                        }
                        type="button"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {showAddMintInput ? (
            <div className="mt-3 border-t border-border pt-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  type="text"
                  value={customMintUrl}
                  onChange={(event) => setCustomMintUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleAddMint();
                    }
                  }}
                  className="flex-1"
                  placeholder="https://mint.example.com"
                />
                <Button
                  onClick={() => {
                    void handleAddMint();
                  }}
                  disabled={!customMintUrl.trim() || isSavingMints || isLoadingMints}
                  variant="outline"
                  type="button"
                >
                  {isSavingMints ? "Saving..." : "Add mint"}
                </Button>
              </div>
            </div>
          ) : null}

          {!syncAccount ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Mint editing is available after signer login.
            </p>
          ) : null}
        </div>
      </Card>

      <WalletTab
        balance={walletBalance}
        setBalance={setWalletBalance}
        mintUrl={mintUrl}
        setTransactionHistory={setTransactionHistory}
      />
    </div>
  );
}
