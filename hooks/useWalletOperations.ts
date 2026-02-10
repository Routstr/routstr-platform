"use client";

import { useCallback, useRef } from "react";
import {
  CashuMint,
  CashuWallet,
  MeltQuoteState,
  MintQuoteState,
} from "@cashu/cashu-ts";
import {
  appendCashuProofs,
  appendTransaction,
  getProofsBalanceSats,
  readCashuProofs,
  readTransactionHistory,
  readWalletInvoices,
  type WalletInvoiceState,
  type WalletTransactionHistory,
  updateWalletInvoiceByQuote,
  upsertWalletInvoice,
  writeCashuProofs,
} from "@/lib/platformWallet";
import { useObservableState } from "applesauce-react/hooks";
import { useAccountManager } from "@/components/providers/ClientProviders";
import {
  annotateProofsWithMint,
  getProofsForMint,
  isCloudSyncCapableAccount,
  publishNip60MintSnapshot,
  type WalletProof,
} from "@/lib/nip60WalletSync";

interface CashuProof {
  amount: number;
  secret: string;
  C: string;
  id: string;
  [key: string]: unknown;
}

interface MintQuoteResponse {
  quote: string;
  request?: string;
  state?: MintQuoteState;
  expiry?: number;
}

interface MeltQuoteResponse {
  quote: string;
  amount: number;
  fee_reserve?: number;
  state?: MeltQuoteState;
  expiry?: number;
}

interface UseWalletOperationsProps {
  mintUrl: string;
  setBalance: (balance: number | ((prevBalance: number) => number)) => void;
  setTransactionHistory: (
    transactionHistory:
      | WalletTransactionHistory[]
      | ((prevTransactionHistory: WalletTransactionHistory[]) => WalletTransactionHistory[])
  ) => void;
}

interface CheckPendingInvoicesResult {
  checked: number;
  updated: number;
}

const FALLBACK_MINT_URL = "https://mint.minibits.cash/Bitcoin";

function getInvoiceAmountFallback(quoteId: string): number | null {
  const invoice = readWalletInvoices().find((item) => item.quoteId === quoteId);
  if (!invoice) return null;
  return Number.isFinite(invoice.amount) ? invoice.amount : null;
}

function mapMintStateToInvoiceState(state: MintQuoteState): WalletInvoiceState {
  const upper = String(state).toUpperCase();
  if (upper === "UNPAID") return "UNPAID";
  if (upper === "PAID") return "PAID";
  if (upper === "ISSUED") return "ISSUED";
  return "PENDING";
}

function mapMeltStateToInvoiceState(state: MeltQuoteState | string): WalletInvoiceState {
  const upper = String(state).toUpperCase();
  if (upper === "UNPAID") return "UNPAID";
  if (upper === "PAID") return "PAID";
  if (upper === "ISSUED") return "ISSUED";
  if (upper === "EXPIRED" || upper === "FAILED") return "EXPIRED";
  return "PENDING";
}

function isAlreadyProcessedError(message: string): boolean {
  const value = message.toLowerCase();
  return (
    value.includes("already issued") ||
    value.includes("already minted") ||
    value.includes("already spent") ||
    value.includes("token already spent")
  );
}

function addMintTransaction(
  quoteId: string,
  amount: number,
  balance: number
): WalletTransactionHistory {
  return {
    type: "mint",
    amount,
    timestamp: Date.now(),
    status: "success",
    message: "Tokens minted",
    balance,
    quoteId,
  };
}

function proofIdentity(proof: CashuProof | WalletProof): string {
  if (typeof proof.secret === "string" && proof.secret.length > 0) {
    return proof.secret;
  }
  return `${String(proof.id)}:${Number(proof.amount)}:${String(proof.C || "")}`;
}

export function useWalletOperations({
  mintUrl,
  setBalance,
  setTransactionHistory,
}: UseWalletOperationsProps) {
  const { manager } = useAccountManager();
  const activeAccount = useObservableState(manager.active$);
  const cashuWalletRef = useRef<CashuWallet | null>(null);
  const mintQuoteRef = useRef<MintQuoteResponse | null>(null);
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const syncAccount = isCloudSyncCapableAccount(activeAccount) ? activeAccount : null;

  const syncBalanceAndHistory = useCallback(() => {
    setBalance(getProofsBalanceSats());
    setTransactionHistory(readTransactionHistory());
  }, [setBalance, setTransactionHistory]);

  const syncMintSnapshotToNip60 = useCallback(
    async (
      mintUrlToSync: string,
      beforeProofs: WalletProof[],
      afterProofs: WalletProof[]
    ) => {
      if (!syncAccount) return;

      const beforeMintProofs = getProofsForMint(beforeProofs, mintUrlToSync);
      const afterMintProofs = getProofsForMint(afterProofs, mintUrlToSync);

      const eventIdsToDelete = Array.from(
        new Set(
          beforeMintProofs
            .map((proof) => proof.eventId)
            .filter((eventId): eventId is string => typeof eventId === "string")
        )
      );

      if (afterMintProofs.length === 0 && eventIdsToDelete.length === 0) {
        return;
      }

      try {
        const newEventId = await publishNip60MintSnapshot(
          syncAccount,
          mintUrlToSync,
          afterMintProofs,
          eventIdsToDelete
        );

        const updatedProofs = afterProofs.map((proof) => {
          if (proof.mintUrl !== mintUrlToSync) return proof;
          return {
            ...proof,
            eventId: newEventId,
          };
        });
        writeCashuProofs(updatedProofs);
      } catch (error) {
        console.warn("Failed to sync NIP-60 wallet proofs:", error);
      }
    },
    [syncAccount]
  );

  const createWalletForMint = useCallback(async (candidateMintUrl: string) => {
    const mint = new CashuMint(candidateMintUrl);
    const keysets = await mint.getKeySets();
    const activeKeysets = keysets.keysets.filter((k) => k.active);
    const units = [...new Set(activeKeysets.map((k) => String(k.unit).toLowerCase()))];

    const preferredUnit =
      units.includes("msat") ? "msat" : units.includes("sat") ? "sat" : null;
    if (!preferredUnit) {
      throw new Error(
        `Mint ${candidateMintUrl} has no active sat/msat keyset (units: ${
          units.join(", ") || "none"
        })`
      );
    }

    const wallet = new CashuWallet(mint, { unit: preferredUnit });
    await wallet.loadMint();
    return wallet;
  }, []);

  const initWallet = useCallback(async () => {
    const candidates = Array.from(
      new Set([mintUrl, FALLBACK_MINT_URL].filter(Boolean))
    );

    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const wallet = await createWalletForMint(candidate);
        cashuWalletRef.current = wallet;
        return wallet;
      } catch (error) {
        lastError = error;
      }
    }

    const reason =
      lastError instanceof Error ? lastError.message : "Unknown wallet error";
    throw new Error(`Failed to initialize wallet for ${mintUrl}. ${reason}`);
  }, [createWalletForMint, mintUrl]);

  const checkMintQuote = useCallback(
    async (
      isAutoChecking: boolean,
      setIsAutoChecking: (checking: boolean) => void,
      mintAmount: string,
      setError: (error: string) => void,
      setSuccessMessage: (message: string) => void,
      setShowInvoiceModal: (show: boolean) => void,
      setMintQuote: (quote: MintQuoteResponse | null) => void,
      setMintInvoice: (invoice: string) => void,
      _countdown: number,
      _setCountdown: (countdown: number) => void
    ) => {
      if (!cashuWalletRef.current || !mintQuoteRef.current) return;

      if (!isAutoChecking) {
        setIsAutoChecking(true);
      }
      setError("");

      try {
        const quoteId = mintQuoteRef.current.quote;
        const checkedQuote = await cashuWalletRef.current.checkMintQuote(quoteId);

        const mappedState = mapMintStateToInvoiceState(checkedQuote.state);
        updateWalletInvoiceByQuote(quoteId, {
          state: mappedState,
          ...(mappedState === "PAID" || mappedState === "ISSUED"
            ? { paidAt: Date.now() }
            : {}),
        });

        const stateUpper = String(checkedQuote.state).toUpperCase();
        if (stateUpper !== "PAID" && stateUpper !== "ISSUED") {
          return;
        }

        if (checkIntervalRef.current) {
          clearInterval(checkIntervalRef.current);
          checkIntervalRef.current = null;
        }
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
        setIsAutoChecking(false);

        const parsedAmount = parseInt(mintAmount, 10);
        const amount = Number.isFinite(parsedAmount) && parsedAmount > 0
          ? parsedAmount
          : (getInvoiceAmountFallback(quoteId) ?? 0);

        try {
          if (amount > 0) {
            const proofs = (await cashuWalletRef.current.mintProofs(
              amount,
              quoteId
            )) as CashuProof[];

            if (Array.isArray(proofs) && proofs.length > 0) {
              const proofsBefore = readCashuProofs() as WalletProof[];
              appendCashuProofs(annotateProofsWithMint(proofs, mintUrl));
              const proofsAfter = readCashuProofs() as WalletProof[];
              await syncMintSnapshotToNip60(mintUrl, proofsBefore, proofsAfter);
              const balance = getProofsBalanceSats();
              appendTransaction(addMintTransaction(quoteId, amount, balance));
              setSuccessMessage("Payment received! Tokens minted successfully.");
            } else {
              setSuccessMessage("Payment confirmed. No new proofs returned.");
            }
          } else {
            setSuccessMessage("Payment confirmed.");
          }

          updateWalletInvoiceByQuote(quoteId, {
            state: "ISSUED",
            paidAt: Date.now(),
          });
        } catch (mintError) {
          const message =
            mintError instanceof Error
              ? mintError.message
              : "Failed to process payment";

          if (isAlreadyProcessedError(message)) {
            updateWalletInvoiceByQuote(quoteId, {
              state: "ISSUED",
              paidAt: Date.now(),
            });
            setSuccessMessage("Payment already processed. Balance updated.");
          } else {
            setError(message);
          }
        } finally {
          syncBalanceAndHistory();
          setShowInvoiceModal(false);
          setMintQuote(null);
          mintQuoteRef.current = null;
          setMintInvoice("");
        }
      } catch (err) {
        if (!isAutoChecking) {
          setError(
            err instanceof Error ? err.message : "Failed to check payment status"
          );
        }
      } finally {
        if (!isAutoChecking) {
          setIsAutoChecking(false);
        }
      }
    },
    [mintUrl, syncBalanceAndHistory, syncMintSnapshotToNip60]
  );

  const createMintQuote = useCallback(
    async (
      setIsMinting: (minting: boolean) => void,
      setError: (error: string) => void,
      setSuccessMessage: (message: string) => void,
      setShowInvoiceModal: (show: boolean) => void,
      mintAmount: string,
      setMintQuote: (quote: MintQuoteResponse | null) => void,
      setMintInvoice: (invoice: string) => void,
      amountOverride?: number
    ) => {
      if (!cashuWalletRef.current) return;

      setIsMinting(true);
      setError("");
      setSuccessMessage("");

      try {
        const amount = amountOverride ?? parseInt(mintAmount, 10);
        if (isNaN(amount) || amount <= 0) {
          throw new Error("Please enter a valid amount");
        }

        const quote = await cashuWalletRef.current.createMintQuote(amount);
        setMintQuote(quote);
        mintQuoteRef.current = quote;
        setMintInvoice(quote.request || "");

        upsertWalletInvoice({
          id: `invoice-${quote.quote}`,
          type: "mint",
          mintUrl,
          quoteId: quote.quote,
          paymentRequest: quote.request || "",
          amount,
          state: "UNPAID",
          createdAt: Date.now(),
          checkedAt: Date.now(),
          expiresAt: quote.expiry ? quote.expiry * 1000 : undefined,
        });

        setSuccessMessage("Invoice generated! Pay it to mint tokens.");
        setShowInvoiceModal(true);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create mint quote"
        );
      } finally {
        setIsMinting(false);
      }
    },
    [mintUrl]
  );

  const createMeltQuote = useCallback(
    async (paymentRequest: string): Promise<MeltQuoteResponse> => {
      if (!cashuWalletRef.current) {
        await initWallet();
      }
      if (!cashuWalletRef.current) {
        throw new Error("Wallet is not initialized");
      }

      const normalizedRequest = paymentRequest.trim();
      if (!normalizedRequest) {
        throw new Error("Please enter a Lightning invoice");
      }

      const meltQuote = (await cashuWalletRef.current.createMeltQuote(
        normalizedRequest
      )) as MeltQuoteResponse;

      const normalizedQuote: MeltQuoteResponse = {
        ...meltQuote,
        amount: Number(meltQuote.amount || 0),
        fee_reserve: Number(meltQuote.fee_reserve || 0),
      };

      return normalizedQuote;
    },
    [initWallet]
  );

  const payMeltQuote = useCallback(
    async (
      meltQuote: MeltQuoteResponse,
      paymentRequest = ""
    ): Promise<void> => {
      if (!cashuWalletRef.current) {
        await initWallet();
      }
      if (!cashuWalletRef.current) {
        throw new Error("Wallet is not initialized");
      }

      const proofsBefore = readCashuProofs() as WalletProof[];
      if (!Array.isArray(proofsBefore) || proofsBefore.length === 0) {
        throw new Error("No tokens available to pay this invoice");
      }

      const proofsForMint = getProofsForMint(proofsBefore, mintUrl);
      if (proofsForMint.length === 0) {
        throw new Error("No tokens available for the selected mint");
      }

      const amount = Number(meltQuote.amount || 0);
      const feeReserve = Number(meltQuote.fee_reserve || 0);
      const amountToSend = amount + feeReserve;
      if (!Number.isFinite(amountToSend) || amountToSend <= 0) {
        throw new Error("Invalid invoice amount");
      }

      upsertWalletInvoice({
        id: `invoice-${meltQuote.quote}`,
        type: "melt",
        mintUrl,
        quoteId: meltQuote.quote,
        paymentRequest,
        amount,
        state: "UNPAID",
        createdAt: Date.now(),
        checkedAt: Date.now(),
        expiresAt: meltQuote.expiry ? meltQuote.expiry * 1000 : undefined,
        fee: feeReserve,
      });

      const currentBalance = getProofsBalanceSats();
      if (amountToSend > currentBalance) {
        throw new Error("Insufficient balance to pay invoice");
      }

      const sendResult = await cashuWalletRef.current.send(
        amountToSend,
        proofsForMint,
        {
          includeFees: true,
        }
      );
      const { send, keep } = sendResult;

      if (!send || send.length === 0) {
        throw new Error("Unable to select proofs for payment");
      }

      const meltResult = await cashuWalletRef.current.meltProofs(
        meltQuote as Parameters<CashuWallet["meltProofs"]>[0],
        send
      );

      const change = Array.isArray(meltResult?.change)
        ? (meltResult.change as CashuProof[])
        : [];

      const previousByIdentity = new Map(
        proofsForMint.map((proof) => [proofIdentity(proof), proof])
      );
      const keepWithMetadata = (keep as CashuProof[]).map((proof) => {
        const existing = previousByIdentity.get(proofIdentity(proof));
        return {
          ...proof,
          mintUrl,
          ...(existing?.eventId ? { eventId: existing.eventId } : {}),
        };
      });
      const changeWithMetadata = annotateProofsWithMint(change, mintUrl);

      const updatedMintProofs = [...keepWithMetadata, ...changeWithMetadata];
      const untouchedProofs = proofsBefore.filter(
        (proof) => proof.mintUrl && proof.mintUrl !== mintUrl
      );
      const nextProofs = [...untouchedProofs, ...updatedMintProofs];
      writeCashuProofs(nextProofs);
      await syncMintSnapshotToNip60(mintUrl, proofsBefore, nextProofs);

      try {
        const checkedQuote = await cashuWalletRef.current.checkMeltQuote(
          meltQuote.quote
        );
        updateWalletInvoiceByQuote(meltQuote.quote, {
          state: mapMeltStateToInvoiceState(
            String((checkedQuote as { state?: string }).state || "")
          ),
          paidAt: Date.now(),
          fee: feeReserve,
        });
      } catch {
        updateWalletInvoiceByQuote(meltQuote.quote, {
          state: "PAID",
          paidAt: Date.now(),
          fee: feeReserve,
        });
      }

      const nextBalance = getProofsBalanceSats();
      appendTransaction({
        type: "send",
        amount,
        timestamp: Date.now(),
        status: "success",
        message: "Lightning invoice paid",
        balance: nextBalance,
        quoteId: meltQuote.quote,
      });

      syncBalanceAndHistory();
    },
    [initWallet, mintUrl, syncBalanceAndHistory, syncMintSnapshotToNip60]
  );

  const importToken = useCallback(
    async (
      setIsImporting: (importing: boolean) => void,
      setError: (error: string) => void,
      setSuccessMessage: (message: string) => void,
      tokenToImport: string,
      setTokenToImport: (token: string) => void
    ) => {
      if (!cashuWalletRef.current || !tokenToImport.trim()) return;

      setIsImporting(true);
      setError("");
      setSuccessMessage("");

      try {
        const result = await cashuWalletRef.current.receive(tokenToImport);
        const proofs = Array.isArray(result)
          ? (result as CashuProof[])
          : (result &&
              typeof result === "object" &&
              Array.isArray((result as { proofs?: unknown }).proofs)
            ? ((result as { proofs: CashuProof[] }).proofs as CashuProof[])
            : []);

        if (!proofs || proofs.length === 0) {
          setError("Invalid token format. Please check and try again.");
          return;
        }

        appendCashuProofs(proofs);

        const importedAmount = proofs.reduce(
          (total: number, proof: CashuProof) => total + proof.amount,
          0
        );

        const balance = getProofsBalanceSats();
        appendTransaction({
          type: "import",
          amount: importedAmount,
          timestamp: Date.now(),
          status: "success",
          message: "Tokens imported",
          balance,
        });

        syncBalanceAndHistory();
        setSuccessMessage(`Successfully imported ${importedAmount} sats!`);
        setTokenToImport("");
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to import token. Please try again.";

        if (isAlreadyProcessedError(message)) {
          setError("This token has already been spent.");
        } else {
          setError(message);
        }
      } finally {
        setIsImporting(false);
      }
    },
    [syncBalanceAndHistory]
  );

  const generateTokenCore = useCallback(async (amount: number): Promise<string> => {
    if (!cashuWalletRef.current) {
      throw new Error("Wallet not initialized");
    }

    if (isNaN(amount) || amount <= 0) {
      throw new Error("Please enter a valid amount");
    }

    const existingProofs = readCashuProofs() as CashuProof[];
    if (!existingProofs || existingProofs.length === 0) {
      throw new Error("No tokens available to send");
    }

    const sendResult = await cashuWalletRef.current.send(amount, existingProofs);
    const { send, keep } = sendResult;

    if (!send || send.length === 0) {
      throw new Error("Failed to generate token");
    }

    writeCashuProofs(keep as CashuProof[]);

    const tokenObj = {
      token: [{ mint: mintUrl, proofs: send }],
    };
    return `cashuA${btoa(JSON.stringify(tokenObj))}`;
  }, [mintUrl]);

  const generateSendToken = useCallback(
    async (
      setIsGeneratingSendToken: (generating: boolean) => void,
      setError: (error: string) => void,
      setSuccessMessage: (message: string) => void,
      sendAmount: string,
      balance: number,
      setSendAmount: (amount: string) => void,
      setGeneratedToken: (token: string) => void
    ) => {
      if (!cashuWalletRef.current) return;

      setIsGeneratingSendToken(true);
      setError("");
      setSuccessMessage("");

      try {
        const amount = parseInt(sendAmount, 10);

        if (isNaN(amount) || amount <= 0) {
          throw new Error("Please enter a valid amount");
        }

        if (amount > balance) {
          throw new Error("Amount exceeds available balance");
        }

        const token = await generateTokenCore(amount);
        setGeneratedToken(token);

        const nextBalance = getProofsBalanceSats();
        appendTransaction({
          type: "send",
          amount,
          timestamp: Date.now(),
          status: "success",
          message: "Tokens sent",
          balance: nextBalance,
        });

        syncBalanceAndHistory();
        setSuccessMessage(
          `Generated token for ${amount} sats. Share it with the recipient.`
        );
        setSendAmount("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to generate token");
      } finally {
        setIsGeneratingSendToken(false);
      }
    },
    [generateTokenCore, syncBalanceAndHistory]
  );

  const checkPendingInvoices = useCallback(async (): Promise<CheckPendingInvoicesResult> => {
    if (!cashuWalletRef.current) {
      await initWallet();
    }
    if (!cashuWalletRef.current) {
      throw new Error("Wallet is not initialized");
    }

    const now = Date.now();
    const invoices = readWalletInvoices();
    const pendingMintInvoices = invoices.filter((invoice) => {
      if (invoice.type !== "mint") return false;
      if (invoice.state === "ISSUED" || invoice.state === "PAID") return false;
      if (invoice.expiresAt && now > invoice.expiresAt) return false;
      return true;
    });
    const pendingMeltInvoices = invoices.filter((invoice) => {
      if (invoice.type !== "melt") return false;
      if (invoice.state === "ISSUED" || invoice.state === "PAID") return false;
      if (invoice.expiresAt && now > invoice.expiresAt) return false;
      return true;
    });

    let updated = 0;

    for (const invoice of pendingMintInvoices) {
      try {
        const quoteStatus = await cashuWalletRef.current.checkMintQuote(invoice.quoteId);
        const nextState = mapMintStateToInvoiceState(quoteStatus.state);

        if (nextState === "PAID" || nextState === "ISSUED") {
          updateWalletInvoiceByQuote(invoice.quoteId, {
            state: "PAID",
            paidAt: Date.now(),
          });

          try {
            const proofs = (await cashuWalletRef.current.mintProofs(
              invoice.amount,
              invoice.quoteId
            )) as CashuProof[];
            if (Array.isArray(proofs) && proofs.length > 0) {
              appendCashuProofs(proofs);
              const balance = getProofsBalanceSats();
              appendTransaction(addMintTransaction(invoice.quoteId, invoice.amount, balance));
            }
          } catch (mintError) {
            const message =
              mintError instanceof Error ? mintError.message : "Mint failed";
            if (!isAlreadyProcessedError(message)) {
              console.warn("Failed to mint pending invoice", invoice.quoteId, message);
            }
          }

          updateWalletInvoiceByQuote(invoice.quoteId, {
            state: "ISSUED",
            paidAt: Date.now(),
          });
          updated += 1;
        } else {
          updateWalletInvoiceByQuote(invoice.quoteId, {
            state: nextState,
          });
        }
      } catch {
        updateWalletInvoiceByQuote(invoice.quoteId, {
          retryCount: (invoice.retryCount || 0) + 1,
          nextRetryAt: Date.now() + 30_000,
        });
      }
    }

    for (const invoice of pendingMeltInvoices) {
      try {
        const meltStatus = await cashuWalletRef.current.checkMeltQuote(invoice.quoteId);
        const nextState = mapMeltStateToInvoiceState(
          String((meltStatus as { state?: string }).state || "")
        );
        updateWalletInvoiceByQuote(invoice.quoteId, {
          state: nextState,
          ...(nextState === "PAID" || nextState === "ISSUED"
            ? { paidAt: Date.now() }
            : {}),
        });
        if (nextState === "PAID" || nextState === "ISSUED") {
          updated += 1;
        }
      } catch {
        updateWalletInvoiceByQuote(invoice.quoteId, {
          retryCount: (invoice.retryCount || 0) + 1,
          nextRetryAt: Date.now() + 30_000,
        });
      }
    }

    for (const invoice of invoices) {
      if (invoice.state === "UNPAID" && invoice.expiresAt && now > invoice.expiresAt) {
        updateWalletInvoiceByQuote(invoice.quoteId, { state: "EXPIRED" });
      }
    }

    syncBalanceAndHistory();
    return {
      checked: pendingMintInvoices.length + pendingMeltInvoices.length,
      updated,
    };
  }, [initWallet, syncBalanceAndHistory]);

  const setupAutoRefresh = useCallback(
    (
      mintInvoice: string,
      mintQuote: MintQuoteResponse | null,
      checkQuote: () => Promise<void>,
      _isAutoChecking: boolean,
      setIsAutoChecking: (checking: boolean) => void,
      _countdown: number,
      setCountdown: (countdown: number | ((prev: number) => number)) => void
    ) => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
        checkIntervalRef.current = null;
        setIsAutoChecking(false);
      }

      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }

      if (mintInvoice && mintQuote) {
        setIsAutoChecking(true);
        setCountdown(3);

        countdownIntervalRef.current = setInterval(() => {
          setCountdown((prev: number) => {
            if (prev <= 1) {
              void checkQuote();
              return 3;
            }
            return prev - 1;
          });
        }, 1000);

        checkIntervalRef.current = setInterval(() => {
          void checkQuote();
        }, 3000);
      }

      return () => {
        if (checkIntervalRef.current) {
          clearInterval(checkIntervalRef.current);
          checkIntervalRef.current = null;
          setIsAutoChecking(false);
        }
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      };
    },
    []
  );

  return {
    initWallet,
    checkMintQuote,
    createMintQuote,
    createMeltQuote,
    payMeltQuote,
    importToken,
    generateSendToken,
    generateTokenCore,
    checkPendingInvoices,
    setupAutoRefresh,
    cashuWalletRef,
    mintQuoteRef,
    checkIntervalRef,
    countdownIntervalRef,
  };
}
