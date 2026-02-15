"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  ClipboardPaste,
  Loader2,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

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
  type WalletWorkflowId = "deposit" | "send" | "history";
  const [activeTab, setActiveTab] = useState<WalletWorkflowId>("deposit");

  const mintDisplay = useMemo(() => {
    try {
      return new URL(mintUrl).host;
    } catch {
      return mintUrl;
    }
  }, [mintUrl]);

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
    <div className="min-w-0 space-y-5">
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

      <div className="grid min-w-0 gap-4 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-xl border border-border/70 bg-card/70 p-2.5 lg:h-[34rem] lg:overflow-y-auto">
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">Wallet</p>
          <nav className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden lg:block lg:space-y-1.5 lg:overflow-visible lg:pb-0">
            <Button
              onClick={() => setActiveTab("deposit")}
              variant={activeTab === "deposit" ? "secondary" : "ghost"}
              size="lg"
              className="min-w-[6.75rem] shrink-0 justify-start lg:w-full lg:min-w-0"
              type="button"
            >
              Deposit
            </Button>
            <Button
              onClick={() => setActiveTab("send")}
              variant={activeTab === "send" ? "secondary" : "ghost"}
              size="lg"
              className="min-w-[6.75rem] shrink-0 justify-start lg:w-full lg:min-w-0"
              type="button"
            >
              Send
            </Button>
            <Button
              onClick={() => setActiveTab("history")}
              variant={activeTab === "history" ? "secondary" : "ghost"}
              size="lg"
              className="min-w-[6.75rem] shrink-0 justify-start lg:w-full lg:min-w-0"
              type="button"
            >
              Invoices
            </Button>
          </nav>
        </aside>

        <section className="min-w-0 overflow-x-clip rounded-xl border border-border/70 bg-card/80 p-4 sm:p-5 min-h-[24rem] sm:min-h-[30rem] lg:h-[34rem]">
          {activeTab === "deposit" && (
            <div className="h-full min-w-0 space-y-6 overflow-x-clip lg:overflow-y-auto lg:pr-1">
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

              <div className="space-y-4">
                <h3 className="text-sm font-medium text-foreground/80">Via Lightning</h3>
                <div className="space-y-4">
                  <BitcoinConnectStatusRow
                    status={bcStatus}
                    balance={bcBalance}
                    onConnect={connectWallet}
                    className="border-border/60 bg-muted/10"
                  />

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {popularAmounts.map((amount) => (
                      <Button
                        key={`mint-quick-${amount}`}
                        onClick={() => void handleQuickMint(amount)}
                        disabled={isMinting}
                        variant="secondary"
                        type="button"
                      >
                        {amount} sats
                      </Button>
                    ))}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,13rem)]">
                    <Input
                      className="min-w-0"
                      type="number"
                      value={mintAmount}
                      onChange={(event) => setMintAmount(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void createMintQuote();
                        }
                      }}
                      placeholder="Amount in sats"
                    />
                    <Button
                      onClick={() => void createMintQuote()}
                      disabled={isMinting || !mintAmount}
                      className="w-full"
                      type="button"
                    >
                      {isMinting ? "Creating..." : "Create invoice"}
                    </Button>
                  </div>

                  {mintInvoice ? (
                    <div className="rounded-md border border-border/60 bg-muted/10 p-4 space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">
                            Lightning invoice
                          </span>
                          <button
                            onClick={() => setShowInvoiceModal(true)}
                            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                            type="button"
                          >
                            Show QR code
                          </button>
                        </div>
                        <div className="font-mono text-xs break-all text-muted-foreground">
                          {mintInvoice}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-3">
                        <span className="text-xs text-muted-foreground">
                          Pay with connected wallet
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            onClick={() => {
                              void payMintInvoiceWithConnectedWallet();
                            }}
                            disabled={isPayingWithWallet}
                            size="sm"
                            variant="secondary"
                            type="button"
                          >
                            {isPayingWithWallet ? "Paying..." : "Pay"}
                          </Button>
                          <Button
                            onClick={handleCancel}
                            variant="ghost"
                            size="sm"
                            type="button"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <Separator className="bg-border/60" />

              <div className="space-y-4">
                <h3 className="text-sm font-medium text-foreground/80">Via Cashu</h3>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">Import token</h4>
                  <div className="relative">
                    <Textarea
                      value={tokenToImport}
                      onChange={(event) => setTokenToImport(event.target.value)}
                      className="h-28 resize-none pr-10"
                      placeholder="Paste Cashu token"
                    />
                    <Button
                      onClick={handlePasteTokenToImport}
                      variant="outline"
                      size="icon-sm"
                      className="absolute right-2 top-2"
                      type="button"
                      title="Paste"
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Button
                    onClick={() => void importToken()}
                    disabled={isImporting || !tokenToImport.trim()}
                    type="button"
                  >
                    {isImporting ? "Importing..." : "Import token"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Paste a received Cashu token to top up your wallet balance.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === "send" && (
            <div className="h-full min-w-0 space-y-6 overflow-x-clip lg:overflow-y-auto lg:pr-1">
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-foreground/80">
                  Via Lightning
                </h3>
                <div className="space-y-5">
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">Invoice</span>
                    <Input
                      className="min-w-0"
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
                    />
                  </label>

                  {hasPayInvoiceInput ? (
                    <div className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-xs text-muted-foreground">Amount</p>
                          <p className="mt-1 text-base font-semibold text-foreground">
                            {invoiceAmount !== null
                              ? `${invoiceAmount.toLocaleString()} sats`
                              : "Awaiting quote"}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Max fee reserve</p>
                          <p className="mt-1 text-base font-semibold text-foreground">
                            {invoiceFeeReserve !== null
                              ? `${invoiceFeeReserve.toLocaleString()} sats`
                              : "—"}
                          </p>
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-[11px] text-muted-foreground">Available balance</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">
                            {balance.toLocaleString()} sats
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">Total spend budget</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">
                            {payTotalBudget !== null
                              ? `${payTotalBudget.toLocaleString()} sats`
                              : "Awaiting quote"}
                          </p>
                        </div>
                      </div>
                      <Separator className="bg-border/45" />
                      <div className="space-y-2 px-1">
                        <div className="flex items-center gap-2 text-xs">
                          <CheckCircle2 className="h-3.5 w-3.5 text-foreground/90" />
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
                  ) : null}

                  <div className="flex flex-wrap items-center gap-3">
                    {hasPayInvoiceInput ? (
                      <Button
                        onClick={resetSendInvoiceState}
                        variant="ghost"
                        type="button"
                      >
                        Clear
                      </Button>
                    ) : null}
                    <Button
                      onClick={() => void handlePayInvoice()}
                      disabled={
                        isProcessing || isLoadingInvoice || !sendInvoice || invoiceAmount === null
                      }
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
                    </Button>
                  </div>
                </div>
              </div>

              <Separator className="bg-border/60" />

              <div className="space-y-4">
                <h3 className="text-sm font-medium text-foreground/80">
                  Via eCash
                </h3>
                <div className="space-y-5">
                  <div className="space-y-3">
                    <h4 className="text-sm font-medium">Generate token</h4>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {popularAmounts.map((amount) => (
                        <Button
                          key={`send-quick-${amount}`}
                          onClick={() => setSendAmount(amount.toString())}
                          variant="secondary"
                          type="button"
                        >
                          {amount} sats
                        </Button>
                      ))}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,13rem)]">
                      <Input
                        className="min-w-0"
                        type="number"
                        value={sendAmount}
                        onChange={(event) => setSendAmount(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void generateSendToken();
                          }
                        }}
                        placeholder="Amount in sats"
                      />
                      <Button
                        onClick={() => void generateSendToken()}
                        disabled={isGeneratingSendToken || !sendAmount}
                        className="w-full"
                        type="button"
                      >
                        {isGeneratingSendToken ? "Generating..." : "Generate"}
                      </Button>
                    </div>
                    {generatedToken ? (
                      <div className="rounded-md border border-border/60 bg-background/35 p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">Generated token</span>
                          <Button
                            onClick={copyTokenToClipboard}
                            variant="ghost"
                            size="xs"
                            type="button"
                          >
                            Copy
                          </Button>
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
                </div>
              </div>
            </div>
          )}

          {activeTab === "history" && (
            <div className="h-full space-y-3 overflow-x-clip lg:overflow-y-auto lg:pr-1">
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
