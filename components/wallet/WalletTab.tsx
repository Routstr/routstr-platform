"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  ClipboardPaste,
  History,
  Loader2,
  QrCode,
  Zap,
} from "lucide-react";
import { MintQuoteState } from "@cashu/cashu-ts";
import { toast } from "sonner";
import { useWalletOperations } from "@/hooks/useWalletOperations";
import type { WalletTransactionHistory } from "@/lib/platformWallet";
import InvoiceModal from "@/components/wallet/InvoiceModal";
import InvoiceHistory from "@/components/wallet/InvoiceHistory";
import BitcoinConnectStatusRow from "@/components/wallet/BitcoinConnectStatusRow";
import {
  requestBitcoinConnectProvider,
  useBitcoinConnectStatus,
} from "@/hooks/useBitcoinConnect";

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
  expiry?: number;
}

interface WalletTabProps {
  balance: number;
  setBalance: (balance: number | ((prevBalance: number) => number)) => void;
  mintUrl: string;
  setTransactionHistory: (
    transactionHistory:
      | WalletTransactionHistory[]
      | ((prevTransactionHistory: WalletTransactionHistory[]) => WalletTransactionHistory[])
  ) => void;
}

const WalletTab: React.FC<WalletTabProps> = ({
  balance,
  setBalance,
  mintUrl,
  setTransactionHistory,
}) => {
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [mintAmount, setMintAmount] = useState("");
  const [mintInvoice, setMintInvoice] = useState("");
  const [mintQuote, setMintQuote] = useState<MintQuoteResponse | null>(null);
  const [isMinting, setIsMinting] = useState(false);
  const [isAutoChecking, setIsAutoChecking] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [sendAmount, setSendAmount] = useState("");
  const [isGeneratingSendToken, setIsGeneratingSendToken] = useState(false);
  const [generatedToken, setGeneratedToken] = useState("");
  const [tokenToImport, setTokenToImport] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [isCheckingInvoices, setIsCheckingInvoices] = useState(false);
  const [sendInvoice, setSendInvoice] = useState("");
  const [currentMeltQuote, setCurrentMeltQuote] =
    useState<MeltQuoteResponse | null>(null);
  const [invoiceAmount, setInvoiceAmount] = useState<number | null>(null);
  const [invoiceFeeReserve, setInvoiceFeeReserve] = useState<number | null>(
    null
  );
  const [isLoadingInvoice, setIsLoadingInvoice] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPayingWithWallet, setIsPayingWithWallet] = useState(false);
  const processingInvoiceRef = useRef<string | null>(null);

  const {
    status: bcStatus,
    balance: bcBalance,
    connect: connectWallet,
  } = useBitcoinConnectStatus();

  const handlePasteTokenToImport = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setTokenToImport(text);
    } catch {
      toast.error("Failed to read from clipboard");
    }
  }, []);

  const {
    initWallet,
    checkMintQuote: hookCheckMintQuote,
    createMintQuote: hookCreateMintQuote,
    createMeltQuote: hookCreateMeltQuote,
    payMeltQuote: hookPayMeltQuote,
    importToken: hookImportToken,
    generateSendToken: hookGenerateSendToken,
    checkPendingInvoices,
    setupAutoRefresh,
    checkIntervalRef,
    countdownIntervalRef,
  } = useWalletOperations({
    mintUrl,
    setBalance,
    setTransactionHistory,
  });

  const checkMintQuote = useCallback(async () => {
    await hookCheckMintQuote(
      isAutoChecking,
      setIsAutoChecking,
      mintAmount,
      setError,
      setSuccessMessage,
      setShowInvoiceModal,
      setMintQuote,
      setMintInvoice,
      countdown,
      setCountdown
    );
  }, [
    hookCheckMintQuote,
    isAutoChecking,
    mintAmount,
    countdown,
    setCountdown,
  ]);

  const createMintQuote = async (amountOverride?: number) => {
    await hookCreateMintQuote(
      setIsMinting,
      setError,
      setSuccessMessage,
      setShowInvoiceModal,
      mintAmount,
      setMintQuote,
      setMintInvoice,
      amountOverride
    );
  };

  const importToken = async () => {
    await hookImportToken(
      setIsImporting,
      setError,
      setSuccessMessage,
      tokenToImport,
      setTokenToImport
    );
  };

  const generateSendToken = async () => {
    await hookGenerateSendToken(
      setIsGeneratingSendToken,
      setError,
      setSuccessMessage,
      sendAmount,
      balance,
      setSendAmount,
      setGeneratedToken
    );
  };

  const loadMeltQuote = useCallback(
    async (invoice: string): Promise<MeltQuoteResponse | null> => {
      const trimmedInvoice = invoice.trim();
      if (!trimmedInvoice) {
        setCurrentMeltQuote(null);
        setInvoiceAmount(null);
        setInvoiceFeeReserve(null);
        return null;
      }

      if (processingInvoiceRef.current === trimmedInvoice) {
        return currentMeltQuote;
      }
      processingInvoiceRef.current = trimmedInvoice;

      try {
        setIsLoadingInvoice(true);
        setError("");
        const meltQuote = await hookCreateMeltQuote(trimmedInvoice);
        const amount = Number(meltQuote.amount || 0);
        const feeReserve = Number(meltQuote.fee_reserve || 0);

        setCurrentMeltQuote(meltQuote);
        setInvoiceAmount(Number.isFinite(amount) ? amount : null);
        setInvoiceFeeReserve(Number.isFinite(feeReserve) ? feeReserve : null);
        return meltQuote;
      } catch (err) {
        setCurrentMeltQuote(null);
        setInvoiceAmount(null);
        setInvoiceFeeReserve(null);
        setError(
          "Failed to create melt quote: " +
            (err instanceof Error ? err.message : String(err))
        );
        return null;
      } finally {
        setIsLoadingInvoice(false);
        processingInvoiceRef.current = null;
      }
    },
    [currentMeltQuote, hookCreateMeltQuote]
  );

  const handleInvoiceInput = async (value: string) => {
    setSendInvoice(value);

    if (!value.trim()) {
      setCurrentMeltQuote(null);
      setInvoiceAmount(null);
      setInvoiceFeeReserve(null);
      return;
    }

    await loadMeltQuote(value);
  };

  const handlePayInvoice = async () => {
    if (!sendInvoice.trim()) {
      setError("Please enter a Lightning invoice");
      return;
    }

    let meltQuote = currentMeltQuote;
    if (!meltQuote) {
      meltQuote = await loadMeltQuote(sendInvoice);
    }

    if (!meltQuote) {
      return;
    }

    const amount = Number(meltQuote.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Could not parse invoice amount");
      return;
    }

    try {
      setIsProcessing(true);
      setError("");
      setSuccessMessage("");

      await hookPayMeltQuote(meltQuote, sendInvoice.trim());
      setSuccessMessage(`Paid ${amount.toLocaleString()} sats!`);
      setSendInvoice("");
      setInvoiceAmount(null);
      setInvoiceFeeReserve(null);
      setCurrentMeltQuote(null);
      processingInvoiceRef.current = null;
    } catch (err) {
      setError(
        "Failed to pay Lightning invoice: " +
          (err instanceof Error ? err.message : String(err))
      );
      setCurrentMeltQuote(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const payMintInvoiceWithConnectedWallet = async () => {
    if (!mintInvoice.trim()) return;

    setIsPayingWithWallet(true);
    try {
      const provider = await requestBitcoinConnectProvider();
      if (provider && typeof provider.sendPayment === "function") {
        await provider.sendPayment(mintInvoice.trim());
      }
      setSuccessMessage("Payment sent from connected wallet. Waiting for mint...");
      setTimeout(() => {
        void checkMintQuote();
      }, 2000);
    } catch {
      setError("Connected wallet payment failed. You can still pay via any wallet.");
    } finally {
      setIsPayingWithWallet(false);
    }
  };

  const checkInvoicesNow = async () => {
    setIsCheckingInvoices(true);
    setError("");
    try {
      const result = await checkPendingInvoices();
      if (result.updated > 0) {
        setSuccessMessage(`Recovered ${result.updated} paid invoice(s).`);
      } else {
        setSuccessMessage(`Checked ${result.checked} pending invoice(s).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check invoices");
    } finally {
      setIsCheckingInvoices(false);
    }
  };

  const copyTokenToClipboard = () => {
    if (!generatedToken) return;
    void navigator.clipboard.writeText(generatedToken);
    setSuccessMessage("Token copied to clipboard");
    setTimeout(() => setSuccessMessage(""), 3000);
  };

  const handleCancel = () => {
    setMintInvoice("");
    setMintQuote(null);
    setSendInvoice("");
    setInvoiceAmount(null);
    setInvoiceFeeReserve(null);
    setCurrentMeltQuote(null);
    processingInvoiceRef.current = null;
  };

  useEffect(() => {
    const initializeWallet = async () => {
      try {
        await initWallet();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to initialize wallet. Please try again."
        );
      }
    };

    void initializeWallet();
  }, [mintUrl, initWallet]);

  useEffect(() => {
    const cleanup = setupAutoRefresh(
      mintInvoice,
      mintQuote,
      checkMintQuote,
      isAutoChecking,
      setIsAutoChecking,
      countdown,
      setCountdown
    );

    return cleanup;
  }, [
    mintInvoice,
    mintQuote,
    checkMintQuote,
    isAutoChecking,
    setupAutoRefresh,
    countdown,
  ]);

  const popularAmounts = [100, 500, 1000];
  type WalletWorkflowId = "fund" | "pay" | "tokens" | "history";
  const [activeTab, setActiveTab] = useState<WalletWorkflowId>("fund");

  const mintDisplay = useMemo(() => {
    try {
      return new URL(mintUrl).host;
    } catch {
      return mintUrl;
    }
  }, [mintUrl]);

  const workflowTabs: Array<{
    id: WalletWorkflowId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    {
      id: "fund",
      label: "Deposit",
      icon: Zap,
    },
    {
      id: "pay",
      label: "Pay",
      icon: QrCode,
    },
    {
      id: "tokens",
      label: "Send",
      icon: ClipboardPaste,
    },
    {
      id: "history",
      label: "Invoices",
      icon: History,
    },
  ];

  const handleQuickMint = async (amount: number) => {
    setMintAmount(amount.toString());
    await createMintQuote(amount);
  };

  const resetSendInvoiceState = () => {
    setSendInvoice("");
    setInvoiceAmount(null);
    setInvoiceFeeReserve(null);
    setCurrentMeltQuote(null);
    processingInvoiceRef.current = null;
  };
  const hasPayInvoiceInput = sendInvoice.trim().length > 0;
  const payTotalBudget =
    invoiceAmount !== null
      ? invoiceAmount + Math.max(invoiceFeeReserve ?? 0, 0)
      : null;
  const canCoverPayBudget =
    payTotalBudget !== null ? balance >= payTotalBudget : false;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border/70 bg-muted/20 p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Wallet balance</p>
            <p className="text-3xl font-semibold tracking-tight text-foreground">
              {balance.toLocaleString()} sats
            </p>
          </div>
          <div className="space-y-1 sm:text-right">
            <p className="text-xs text-muted-foreground">Active mint</p>
            <p className="text-xs font-mono text-foreground/90 sm:text-sm">
              {mintDisplay}
            </p>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-foreground/90">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-foreground">
          {successMessage}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="rounded-xl border border-border/70 bg-card/70 p-2.5">
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">
            Wallet
          </p>
          <nav className="space-y-1.5">
            {workflowTabs.map((tab) => {
              const isActive = activeTab === tab.id;
              const TabIcon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? "border-border/80 bg-muted/45 text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border/40 hover:bg-muted/20 hover:text-foreground"
                  }`}
                  type="button"
                >
                  <div className="flex items-center gap-2.5">
                    <TabIcon className="h-4 w-4" />
                    <span className="text-sm font-medium">{tab.label}</span>
                  </div>
                </button>
              );
            })}
          </nav>
        </aside>

        <section className="rounded-xl border border-border/70 bg-card/80 p-4 sm:p-5 min-h-[30rem]">
          {activeTab === "fund" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold tracking-tight">Deposit</h3>
                  <p className="text-sm text-muted-foreground">
                    Create a Lightning quote, then track and settle it.
                  </p>
                </div>
                {mintInvoice ? (
                  <span className="rounded-full border border-border/70 bg-muted/25 px-2.5 py-1 text-xs text-muted-foreground">
                    Invoice pending
                  </span>
                ) : null}
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/15 p-4 space-y-4">
                <BitcoinConnectStatusRow
                  status={bcStatus}
                  balance={bcBalance}
                  onConnect={connectWallet}
                  className="rounded-md border border-border/60 bg-muted/25 p-3"
                />

                <div className="grid gap-2 sm:grid-cols-3">
                  {popularAmounts.map((amount) => (
                    <button
                      key={`mint-quick-${amount}`}
                      onClick={() => void handleQuickMint(amount)}
                      disabled={isMinting}
                      className="platform-btn-secondary px-3"
                      type="button"
                    >
                      {amount} sats
                    </button>
                  ))}
                </div>

                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_13rem]">
                  <input
                    type="number"
                    value={mintAmount}
                    onChange={(event) => setMintAmount(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void createMintQuote();
                      }
                    }}
                    className="platform-input"
                    placeholder="Amount in sats"
                  />
                  <button
                    onClick={() => void createMintQuote()}
                    disabled={isMinting || !mintAmount}
                    className="platform-btn-primary w-full gap-1 px-4"
                    type="button"
                  >
                    {isMinting ? "Creating..." : "Create invoice"}
                  </button>
                </div>

                <div className="rounded-md border border-border/60 bg-background/30 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-medium">Invoice Console</h4>
                    <span className="rounded-full border border-border/60 bg-background/35 px-2 py-0.5 text-[11px] text-muted-foreground">
                      {mintInvoice ? "Quote ready" : "Waiting for quote"}
                    </span>
                  </div>
                  {mintInvoice ? (
                    <>
                      <div className="rounded-md border border-border/60 bg-background/40 p-3">
                        <p className="text-xs text-muted-foreground">BOLT11</p>
                        <p className="mt-1 max-h-24 overflow-auto break-all font-mono text-xs text-foreground/85">
                          {mintInvoice}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Quote status:{" "}
                        <span className="font-medium text-foreground/90">
                          {String(mintQuote?.state || "pending")}
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => setShowInvoiceModal(true)}
                          className="platform-btn-secondary px-3"
                          type="button"
                        >
                          Open QR modal
                        </button>
                        <button
                          onClick={() => {
                            void payMintInvoiceWithConnectedWallet();
                          }}
                          disabled={isPayingWithWallet}
                          className="platform-btn-secondary px-3"
                          type="button"
                        >
                          {isPayingWithWallet ? "Paying..." : "Pay with connected wallet"}
                        </button>
                        <button
                          onClick={() => {
                            void checkMintQuote();
                          }}
                          className="platform-btn-secondary px-3"
                          type="button"
                        >
                          Check status now
                        </button>
                        <button
                          onClick={handleCancel}
                          className="platform-btn-ghost px-3"
                          type="button"
                        >
                          Clear invoice
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-2">
                      {[
                        "Choose an amount and create an invoice quote.",
                        "Pay using any Lightning wallet or NWC.",
                        "Run a check to confirm mint settlement.",
                      ].map((step) => (
                        <div
                          key={step}
                          className="flex items-start gap-2 rounded-md border border-border/50 bg-background/30 px-2.5 py-2"
                        >
                          <Circle className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">{step}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === "pay" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-semibold tracking-tight">Pay Lightning</h3>
                <p className="text-sm text-muted-foreground">
                  Paste an invoice and settle directly from your wallet balance.
                </p>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4 space-y-4">
                <label className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Invoice</span>
                  <input
                    placeholder="lnbc..."
                    value={sendInvoice}
                    onChange={(event) => {
                      void handleInvoiceInput(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handlePayInvoice();
                      }
                    }}
                    className="platform-input"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md bg-background/30 p-2.5">
                    <p className="text-xs text-muted-foreground">Amount</p>
                    <p className="mt-1 text-base font-semibold text-foreground">
                      {invoiceAmount !== null
                        ? `${invoiceAmount.toLocaleString()} sats`
                        : "Awaiting quote"}
                    </p>
                  </div>
                  <div className="rounded-md bg-background/30 p-2.5">
                    <p className="text-xs text-muted-foreground">Max fee reserve</p>
                    <p className="mt-1 text-base font-semibold text-foreground">
                      {invoiceFeeReserve !== null
                        ? `${invoiceFeeReserve.toLocaleString()} sats`
                        : "—"}
                    </p>
                  </div>
                </div>

                <div className="bg-background/20 p-1 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md bg-background/25 p-2.5">
                      <p className="text-[11px] text-muted-foreground">Available balance</p>
                      <p className="mt-1 text-sm font-semibold text-foreground">
                        {balance.toLocaleString()} sats
                      </p>
                    </div>
                    <div className="rounded-md bg-background/25 p-2.5">
                      <p className="text-[11px] text-muted-foreground">Total spend budget</p>
                      <p className="mt-1 text-sm font-semibold text-foreground">
                        {payTotalBudget !== null
                          ? `${payTotalBudget.toLocaleString()} sats`
                          : "Awaiting quote"}
                      </p>
                    </div>
                  </div>
                  <div className="h-px bg-border/45" />
                  <div className="space-y-2 px-1">
                    <div className="flex items-center gap-2 text-xs">
                      {hasPayInvoiceInput ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-foreground/90" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="text-muted-foreground">Invoice pasted</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {invoiceAmount !== null ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-foreground/90" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="text-muted-foreground">Quote resolved</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {payTotalBudget !== null && canCoverPayBudget ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-foreground/90" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="text-muted-foreground">Budget sufficient</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <button
                    onClick={resetSendInvoiceState}
                    className="platform-btn-ghost px-3"
                    type="button"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => void handlePayInvoice()}
                    disabled={
                      isProcessing || isLoadingInvoice || !sendInvoice || invoiceAmount === null
                    }
                    className="platform-btn-primary gap-1 px-3"
                    type="button"
                  >
                    {isProcessing || isLoadingInvoice ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    {isProcessing
                      ? "Processing..."
                      : isLoadingInvoice
                        ? "Loading quote..."
                        : "Pay invoice"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "tokens" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-semibold tracking-tight">Send Tokens</h3>
                <p className="text-sm text-muted-foreground">
                  Export eCash to share, or import a token you received.
                </p>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/15 p-4 space-y-5">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">Generate token</h4>
                  <div className="grid gap-2 grid-cols-3">
                    {popularAmounts.map((amount) => (
                      <button
                        key={`send-quick-${amount}`}
                        onClick={() => setSendAmount(amount.toString())}
                        className="platform-btn-secondary px-3"
                        type="button"
                      >
                        {amount} sats
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_13rem]">
                    <input
                      type="number"
                      value={sendAmount}
                      onChange={(event) => setSendAmount(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void generateSendToken();
                        }
                      }}
                      className="platform-input"
                      placeholder="Amount in sats"
                    />
                    <button
                      onClick={() => void generateSendToken()}
                      disabled={isGeneratingSendToken || !sendAmount}
                      className="platform-btn-primary w-full gap-1 px-4"
                      type="button"
                    >
                      {isGeneratingSendToken ? "Generating..." : "Generate"}
                    </button>
                  </div>
                  {generatedToken ? (
                    <div className="rounded-md border border-border/60 bg-background/35 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Generated token</span>
                        <button
                          onClick={copyTokenToClipboard}
                          className="text-xs text-muted-foreground hover:text-foreground"
                          type="button"
                        >
                          Copy
                        </button>
                      </div>
                      <p className="max-h-36 overflow-auto break-all font-mono text-xs text-foreground/85">
                        {generatedToken}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Set an amount and generate a transferable eCash token.
                    </p>
                  )}
                </div>

                <div className="h-px bg-border/60" />

                <div className="space-y-3">
                  <h4 className="text-sm font-medium">Import token</h4>
                  <div className="relative">
                    <textarea
                      value={tokenToImport}
                      onChange={(event) => setTokenToImport(event.target.value)}
                      className="platform-input h-28 resize-none pr-10"
                      placeholder="Paste Cashu token"
                    />
                    <button
                      onClick={handlePasteTokenToImport}
                      className="platform-btn-icon absolute right-2 top-2 h-7 w-7 p-0"
                      type="button"
                      title="Paste"
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <button
                    onClick={() => void importToken()}
                    disabled={isImporting || !tokenToImport.trim()}
                    className="platform-btn-primary gap-1 px-3"
                    type="button"
                  >
                    {isImporting ? "Importing..." : "Import token"}
                  </button>
                  <div className="rounded-md bg-background/25 p-2.5">
                    <p className="text-xs text-muted-foreground">
                      Refunds return a Cashu token. Import it here to restore balance.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "history" && (
            <div className="space-y-3">
              <div>
                <h3 className="text-base font-semibold tracking-tight">Invoices</h3>
                <p className="text-sm text-muted-foreground">
                  Inspect pending invoices and recover paid quotes.
                </p>
              </div>
              <InvoiceHistory
                mintUrl={mintUrl}
                isChecking={isCheckingInvoices}
                onCheckNow={checkInvoicesNow}
              />
            </div>
          )}
        </section>
      </div>

      <InvoiceModal
        showInvoiceModal={showInvoiceModal}
        mintInvoice={mintInvoice}
        mintAmount={mintAmount}
        mintUnit="sat"
        isAutoChecking={isAutoChecking}
        countdown={countdown}
        setShowInvoiceModal={setShowInvoiceModal}
        setMintInvoice={setMintInvoice}
        setMintQuote={setMintQuote}
        checkIntervalRef={checkIntervalRef}
        countdownIntervalRef={countdownIntervalRef}
        setIsAutoChecking={setIsAutoChecking}
        onPayWithWallet={payMintInvoiceWithConnectedWallet}
        isPayingWithWallet={isPayingWithWallet}
        showWalletConnect
      />
    </div>
  );
};

export default WalletTab;
