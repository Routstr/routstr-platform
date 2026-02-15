"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Copy,
  RefreshCw,
  RotateCcw,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  deleteWalletInvoice,
  PLATFORM_WALLET_UPDATED_EVENT,
  readWalletInvoices,
  type WalletInvoice,
} from "@/lib/platformWallet";
import { Button } from "@/components/ui/button";

interface InvoiceHistoryProps {
  mintUrl?: string;
  isChecking?: boolean;
  onCheckNow?: () => Promise<void>;
}

function isInvoicePaid(invoice: WalletInvoice): boolean {
  const state = String(invoice.state).toUpperCase();
  return state === "PAID" || state === "ISSUED";
}

function isInvoiceExpired(invoice: WalletInvoice): boolean {
  if (invoice.expiresAt && Date.now() > invoice.expiresAt) return true;
  return String(invoice.state).toUpperCase() === "EXPIRED";
}

function getStatusText(invoice: WalletInvoice): "Paid" | "Expired" | "Pending" {
  if (isInvoicePaid(invoice)) return "Paid";
  if (isInvoiceExpired(invoice)) return "Expired";
  return "Pending";
}

function formatSats(amount: number): string {
  return `${Number(amount || 0).toLocaleString()} sats`;
}

function formatRelativeDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function truncateInvoice(paymentRequest: string): string {
  if (!paymentRequest || paymentRequest.length <= 20) return paymentRequest;
  return `${paymentRequest.slice(0, 10)}...${paymentRequest.slice(-10)}`;
}

const InvoiceHistory: React.FC<InvoiceHistoryProps> = ({
  mintUrl,
  isChecking = false,
  onCheckNow,
}) => {
  const [invoices, setInvoices] = useState<WalletInvoice[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refreshInvoices = () => {
    setInvoices(readWalletInvoices());
  };

  useEffect(() => {
    refreshInvoices();

    const handleWalletUpdate = () => refreshInvoices();
    const handleStorage = () => refreshInvoices();

    window.addEventListener(PLATFORM_WALLET_UPDATED_EVENT, handleWalletUpdate);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(
        PLATFORM_WALLET_UPDATED_EVENT,
        handleWalletUpdate
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const filteredInvoices = useMemo(() => {
    const list = mintUrl
      ? invoices.filter((invoice) => invoice.mintUrl === mintUrl)
      : invoices;
    return [...list].sort((a, b) => b.createdAt - a.createdAt);
  }, [invoices, mintUrl]);

  const pendingCount = filteredInvoices.filter(
    (invoice) => getStatusText(invoice) === "Pending"
  ).length;
  const paidCount = filteredInvoices.filter(
    (invoice) => getStatusText(invoice) === "Paid"
  ).length;
  const expiredCount = filteredInvoices.filter(
    (invoice) => getStatusText(invoice) === "Expired"
  ).length;

  const statusIcon = (invoice: WalletInvoice) => {
    const status = getStatusText(invoice);
    if (status === "Paid") {
      return <CheckCircle className="h-4 w-4 text-foreground/85" />;
    }
    if (status === "Expired") {
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
    }
    return <Clock className="h-4 w-4 text-muted-foreground animate-pulse" />;
  };

  if (filteredInvoices.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Zap className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p className="text-sm">No lightning invoices yet</p>
        <p className="text-xs mt-1">Your invoice history will appear here</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/25 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/35 px-3 py-1 text-xs">
            <span className="text-muted-foreground">Pending</span>
            <span className="font-semibold text-foreground">{pendingCount}</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/35 px-3 py-1 text-xs">
            <span className="text-muted-foreground">Paid</span>
            <span className="font-semibold text-foreground">{paidCount}</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/35 px-3 py-1 text-xs">
            <span className="text-muted-foreground">Expired</span>
            <span className="font-semibold text-foreground">{expiredCount}</span>
          </div>
          <Button
            onClick={() => {
              if (onCheckNow) void onCheckNow();
            }}
            disabled={isChecking || !onCheckNow}
            variant="secondary"
            size="sm"
            className="ml-auto"
            type="button"
          >
            <RefreshCw className={`h-3 w-3 ${isChecking ? "animate-spin" : ""}`} />
            {isChecking ? "Checking..." : "Check Now"}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>{pendingCount > 0 ? "Pending invoices need checks." : "All invoices processed"}</span>
        </div>
      </div>

      <div className="space-y-2">
        {filteredInvoices.map((invoice) => {
          const status = getStatusText(invoice);

          return (
            <div
              key={invoice.id}
              className="bg-muted/50 border border-border rounded-md p-3 hover:bg-muted transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {statusIcon(invoice)}
                    <span className="text-sm font-medium text-foreground">
                      {invoice.type === "mint" ? "Receive" : "Send"}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {formatSats(invoice.amount)}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full border border-border/60 bg-background/35 text-muted-foreground">
                      {status}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatRelativeDate(invoice.createdAt)}</span>
                    {invoice.paidAt ? (
                      <>
                        <span>•</span>
                        <span>Paid {formatRelativeDate(invoice.paidAt)}</span>
                      </>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2 mt-2">
                    <code className="text-xs text-muted-foreground font-mono">
                      {truncateInvoice(invoice.paymentRequest)}
                    </code>
                    <Button
                      onClick={() => {
                        void navigator.clipboard.writeText(invoice.paymentRequest);
                        toast.success("Copied to clipboard");
                      }}
                      variant="ghost"
                      size="icon-xs"
                      title="Copy invoice"
                      type="button"
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>

                  <div className="flex items-center gap-2 mt-2">
                    {status === "Pending" && (invoice.retryCount || 0) > 0 ? (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <RotateCcw className="h-3 w-3" />
                        Retry count: {invoice.retryCount}
                      </span>
                    ) : null}

                    {status === "Expired" || (invoice.retryCount || 0) >= 10 ? (
                      confirmDelete === invoice.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            Delete?
                          </span>
                          <Button
                            onClick={() => {
                              deleteWalletInvoice(invoice.id);
                              setConfirmDelete(null);
                              toast.success("Invoice deleted");
                              refreshInvoices();
                            }}
                            variant="ghost"
                            size="xs"
                            type="button"
                          >
                            Yes
                          </Button>
                          <Button
                            onClick={() => setConfirmDelete(null)}
                            variant="ghost"
                            size="xs"
                            type="button"
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Button
                          onClick={() => setConfirmDelete(invoice.id)}
                          variant="ghost"
                          size="xs"
                          title="Delete invoice"
                          type="button"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </Button>
                      )
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default InvoiceHistory;
