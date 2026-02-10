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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-border/60 bg-background/35 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground">Pending</p>
              <p className="text-sm font-semibold text-foreground">{pendingCount}</p>
            </div>
            <div className="rounded-md border border-border/60 bg-background/35 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground">Paid</p>
              <p className="text-sm font-semibold text-foreground">{paidCount}</p>
            </div>
            <div className="rounded-md border border-border/60 bg-background/35 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground">Expired</p>
              <p className="text-sm font-semibold text-foreground">{expiredCount}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {pendingCount > 0 ? "Pending invoices need checks." : "All invoices processed"}
            </span>
          </div>
        </div>
        <div className="mt-3">
          <button
            onClick={() => {
              if (onCheckNow) void onCheckNow();
            }}
            disabled={isChecking || !onCheckNow}
            className="platform-btn-secondary gap-2 px-3 py-1 text-xs"
            type="button"
          >
            <RefreshCw className={`h-3 w-3 ${isChecking ? "animate-spin" : ""}`} />
            {isChecking ? "Checking..." : "Check Now"}
          </button>
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
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(invoice.paymentRequest);
                        toast.success("Copied to clipboard");
                      }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title="Copy invoice"
                      type="button"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
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
                          <button
                            onClick={() => {
                              deleteWalletInvoice(invoice.id);
                              setConfirmDelete(null);
                              toast.success("Invoice deleted");
                              refreshInvoices();
                            }}
                            className="text-xs text-foreground hover:opacity-80"
                            type="button"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="text-xs text-muted-foreground hover:text-foreground"
                            type="button"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(invoice.id)}
                          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                          title="Delete invoice"
                          type="button"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </button>
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
