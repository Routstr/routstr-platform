"use client";

import React from "react";
import { X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { ModalShell } from "@/components/ui/ModalShell";
import { useBitcoinConnectStatus } from "@/hooks/useBitcoinConnect";
import BitcoinConnectStatusRow from "@/components/wallet/BitcoinConnectStatusRow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface MintQuoteLike {
  quote: string;
  request?: string;
}

interface InvoiceModalProps {
  showInvoiceModal: boolean;
  mintInvoice: string;
  mintAmount: string;
  mintUnit: string;
  isAutoChecking: boolean;
  countdown: number;
  setShowInvoiceModal: (show: boolean) => void;
  setMintInvoice: (invoice: string) => void;
  setMintQuote: (quote: MintQuoteLike | null) => void;
  checkIntervalRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
  countdownIntervalRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
  setIsAutoChecking: (checking: boolean) => void;
  onPayWithWallet?: (invoice: string) => Promise<void>;
  isPayingWithWallet?: boolean;
  showWalletConnect?: boolean;
}

const InvoiceModal: React.FC<InvoiceModalProps> = ({
  showInvoiceModal,
  mintInvoice,
  mintAmount,
  mintUnit,
  isAutoChecking,
  countdown,
  setShowInvoiceModal,
  setMintInvoice,
  setMintQuote,
  checkIntervalRef,
  countdownIntervalRef,
  setIsAutoChecking,
  onPayWithWallet,
  isPayingWithWallet,
  showWalletConnect,
}) => {
  const {
    status: bcStatus,
    balance: bcBalance,
    connect: connectWallet,
  } = useBitcoinConnectStatus();

  if (!showInvoiceModal || !mintInvoice) return null;

  const clearIntervals = () => {
    if (checkIntervalRef.current) {
      clearInterval(checkIntervalRef.current);
      checkIntervalRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setIsAutoChecking(false);
  };

  const closeModal = () => {
    setShowInvoiceModal(false);
    setMintInvoice("");
    setMintQuote(null);
    clearIntervals();
  };

  return (
    <ModalShell
      open={showInvoiceModal && !!mintInvoice}
      onClose={closeModal}
      overlayClassName="bg-black/80 z-50"
      contentClassName="bg-card rounded-lg max-w-md w-full m-4 border border-border max-h-[90vh] flex flex-col"
      closeOnOverlayClick
    >
      <div className="flex justify-between items-center p-4 border-b border-border shrink-0">
        <h3 className="text-lg font-semibold text-foreground">Lightning Invoice</h3>
        <Button
          onClick={closeModal}
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label="Close invoice modal"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="p-6 space-y-4 overflow-y-auto">
        {showWalletConnect && (
          <BitcoinConnectStatusRow
            status={bcStatus}
            balance={bcBalance}
            onConnect={connectWallet}
            className="rounded-md p-3"
          />
        )}

        <Card className="gap-0 bg-muted/20 flex items-center justify-center p-4 py-4 shadow-none">
          <div className="w-56 h-56 flex items-center justify-center p-2 rounded-md">
            <QRCodeSVG
              value={mintInvoice}
              size={220}
              bgColor="transparent"
              fgColor="currentColor"
              className="text-foreground"
            />
          </div>
        </Card>

        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Amount</span>
            <span className="text-sm font-medium text-foreground">
              {mintAmount} {mintUnit}s
            </span>
          </div>

          {isAutoChecking && (
            <Card className="gap-0 bg-muted/20 flex items-center justify-between p-3 py-3 shadow-none">
              <span className="text-xs text-muted-foreground">
                After payment, tokens will be automatically minted
              </span>
              <span className="flex items-center text-xs text-muted-foreground">
                {countdown}s
                <svg className="ml-2 w-3 h-3 animate-spin" viewBox="0 0 24 24">
                  <path
                    d="M21 12a9 9 0 1 1-6.219-8.56"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </span>
            </Card>
          )}

          <div className="mt-2">
            <div className="text-xs text-muted-foreground mb-1">Lightning Invoice</div>
            <div className="font-mono text-xs text-muted-foreground bg-muted/50 border border-border rounded-md p-3 break-all">
              {mintInvoice}
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(mintInvoice);
              }}
              variant="secondary"
              className="flex-1"
              type="button"
            >
              Copy Invoice
            </Button>
            {onPayWithWallet && (
              <Button
                onClick={() => {
                  void onPayWithWallet(mintInvoice);
                }}
                disabled={Boolean(isPayingWithWallet)}
                variant="secondary"
                className="flex-1"
                type="button"
              >
                {isPayingWithWallet ? "Paying..." : "Pay with wallet"}
              </Button>
            )}
            <Button
              onClick={closeModal}
              variant="ghost"
              className="flex-1"
              type="button"
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
};

export default InvoiceModal;
