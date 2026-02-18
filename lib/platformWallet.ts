"use client";

export const PLATFORM_WALLET_UPDATED_EVENT = "platform-wallet-updated";

const CASHU_PROOFS_STORAGE_KEY = "cashu_proofs";
const CHAT_LIGHTNING_INVOICES_STORAGE_KEY = "lightning_invoices";
const LEGACY_PLATFORM_INVOICES_STORAGE_KEY = "platform_lightning_invoices";
const TRANSACTION_HISTORY_STORAGE_KEY = "transaction_history";

export type WalletTransactionType = "mint" | "send" | "import" | "refund";

export interface WalletTransactionHistory {
  type: WalletTransactionType;
  amount: number;
  timestamp: number;
  status: "success" | "failed";
  message?: string;
  balance?: number;
  quoteId?: string;
}

export type WalletInvoiceState =
  | "UNPAID"
  | "PAID"
  | "ISSUED"
  | "EXPIRED"
  | "PENDING";

export interface WalletInvoice {
  id: string;
  type: "mint" | "melt";
  mintUrl: string;
  quoteId: string;
  paymentRequest: string;
  amount: number;
  state: WalletInvoiceState;
  createdAt: number;
  expiresAt?: number;
  checkedAt?: number;
  paidAt?: number;
  fee?: number;
  retryCount?: number;
  nextRetryAt?: number;
}

interface WalletInvoiceStore {
  invoices: WalletInvoice[];
  lastSync: number;
}

interface ProofLike {
  amount: number;
  secret?: string;
  C?: string;
  id?: string;
  mintUrl?: string;
  eventId?: string;
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function emitPlatformWalletUpdated(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(PLATFORM_WALLET_UPDATED_EVENT));
}

export function readCashuProofs(): ProofLike[] {
  if (!isBrowser()) return [];
  return safeJsonParse<ProofLike[]>(
    localStorage.getItem(CASHU_PROOFS_STORAGE_KEY),
    []
  );
}

export function writeCashuProofs(proofs: ProofLike[]): void {
  if (!isBrowser()) return;
  localStorage.setItem(CASHU_PROOFS_STORAGE_KEY, JSON.stringify(proofs));
  emitPlatformWalletUpdated();
}

export function appendCashuProofs(proofs: ProofLike[]): ProofLike[] {
  const existing = readCashuProofs();
  const next = [...existing, ...proofs];
  writeCashuProofs(next);
  return next;
}

export function getProofsBalanceSats(): number {
  return readCashuProofs().reduce((total, proof) => {
    const amount = Number(proof.amount);
    return total + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}

export function readWalletInvoices(): WalletInvoice[] {
  if (!isBrowser()) return [];

  const parseInvoices = (raw: string | null): WalletInvoice[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as WalletInvoice[] | WalletInvoiceStore;
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.invoices)) {
        return parsed.invoices;
      }
      return [];
    } catch {
      return [];
    }
  };

  const chatRaw = localStorage.getItem(CHAT_LIGHTNING_INVOICES_STORAGE_KEY);
  if (chatRaw !== null) {
    return parseInvoices(chatRaw);
  }

  return parseInvoices(localStorage.getItem(LEGACY_PLATFORM_INVOICES_STORAGE_KEY));
}

export function writeWalletInvoices(invoices: WalletInvoice[]): void {
  if (!isBrowser()) return;
  const store: WalletInvoiceStore = {
    invoices,
    lastSync: Date.now(),
  };
  localStorage.setItem(CHAT_LIGHTNING_INVOICES_STORAGE_KEY, JSON.stringify(store));
  localStorage.setItem(LEGACY_PLATFORM_INVOICES_STORAGE_KEY, JSON.stringify(invoices));
  emitPlatformWalletUpdated();
}

export function upsertWalletInvoice(invoice: WalletInvoice): WalletInvoice[] {
  const existing = readWalletInvoices();
  const next = existing
    .filter((item) => item.id !== invoice.id && item.quoteId !== invoice.quoteId)
    .concat(invoice);
  writeWalletInvoices(next);
  return next;
}

export function updateWalletInvoice(
  id: string,
  updates: Partial<WalletInvoice>
): WalletInvoice | null {
  const existing = readWalletInvoices();
  let updatedInvoice: WalletInvoice | null = null;
  const next = existing.map((invoice) => {
    if (invoice.id !== id) return invoice;
    updatedInvoice = {
      ...invoice,
      ...updates,
      checkedAt: Date.now(),
    };
    return updatedInvoice;
  });
  writeWalletInvoices(next);
  return updatedInvoice;
}

export function updateWalletInvoiceByQuote(
  quoteId: string,
  updates: Partial<WalletInvoice>
): WalletInvoice | null {
  const existing = readWalletInvoices();
  let updatedInvoice: WalletInvoice | null = null;
  const next = existing.map((invoice) => {
    if (invoice.quoteId !== quoteId) return invoice;
    updatedInvoice = {
      ...invoice,
      ...updates,
      checkedAt: Date.now(),
    };
    return updatedInvoice;
  });
  writeWalletInvoices(next);
  return updatedInvoice;
}

export function deleteWalletInvoice(id: string): WalletInvoice[] {
  const existing = readWalletInvoices();
  const next = existing.filter((invoice) => invoice.id !== id);
  writeWalletInvoices(next);
  return next;
}

export function readTransactionHistory(): WalletTransactionHistory[] {
  if (!isBrowser()) return [];
  return safeJsonParse<WalletTransactionHistory[]>(
    localStorage.getItem(TRANSACTION_HISTORY_STORAGE_KEY),
    []
  );
}

export function writeTransactionHistory(
  history: WalletTransactionHistory[]
): WalletTransactionHistory[] {
  if (!isBrowser()) return history;
  localStorage.setItem(TRANSACTION_HISTORY_STORAGE_KEY, JSON.stringify(history));
  emitPlatformWalletUpdated();
  return history;
}

export function appendTransaction(
  transaction: WalletTransactionHistory
): WalletTransactionHistory[] {
  const existing = readTransactionHistory();

  if (
    transaction.quoteId &&
    existing.some(
      (item) =>
        item.quoteId === transaction.quoteId &&
        item.type === transaction.type &&
        item.status === transaction.status
    )
  ) {
    return existing;
  }

  const next = [...existing, transaction];
  return writeTransactionHistory(next);
}
