"use client";

import { SimplePool, type Event as NostrEvent, type EventTemplate } from "nostr-tools";
import type { Proof } from "@cashu/cashu-ts";

const NOSTR_APP_CONFIG_STORAGE_KEY = "nostr:app-config";
const NOSTR_RELAYS_STORAGE_KEY = "nostr_relays";

const DEFAULT_SYNC_RELAYS = [
  "wss://relay.routstr.com",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://relay.chorus.community",
  "wss://relay.nsec.app",
];

const DEFAULT_TOKEN_QUERY_WAIT_MS = 7000;

const CASHU_WALLET_KIND = 17375;
const CASHU_TOKEN_KIND = 7375;

export interface CloudSyncCapableAccount {
  pubkey: string;
  signEvent: (event: EventTemplate) => Promise<NostrEvent>;
  nip44: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
}

export interface WalletProof extends Proof {
  mintUrl?: string;
  eventId?: string;
}

interface Nip60TokenPayload {
  mint: string;
  proofs: Proof[];
  del?: string[];
}

interface DecryptedTokenEvent {
  id: string;
  createdAt: number;
  token: Nip60TokenPayload;
}

interface Nip60WalletConfig {
  privkey: string | null;
  mints: string[];
}

type WalletTagTuple = [string, string];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function uniqueRelayUrls(candidates: string[]): string[] {
  const urls = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (!/^wss?:\/\//i.test(trimmed)) continue;
    urls.add(trimmed);
  }
  return Array.from(urls);
}

function parseTokenPayload(payload: unknown): Nip60TokenPayload | null {
  if (!isObject(payload)) return null;
  if (typeof payload.mint !== "string" || payload.mint.length === 0) return null;
  if (!Array.isArray(payload.proofs)) return null;
  const del =
    Array.isArray(payload.del) && payload.del.every((item) => typeof item === "string")
      ? (payload.del as string[])
      : undefined;
  return {
    mint: payload.mint,
    proofs: payload.proofs as Proof[],
    del,
  };
}

function normalizeMintUrl(url: string): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`.replace(/\/$/, "");
  }
  return trimmed.replace(/\/$/, "");
}

function proofIdentity(proof: Proof): string {
  if (typeof proof.secret === "string" && proof.secret.length > 0) {
    return proof.secret;
  }
  return `${String(proof.id)}:${Number(proof.amount)}:${String((proof as { C?: string }).C || "")}`;
}

export function isCloudSyncCapableAccount(
  account: unknown
): account is CloudSyncCapableAccount {
  if (!isObject(account)) return false;
  const candidate = account as Partial<CloudSyncCapableAccount>;
  return Boolean(
    typeof candidate.pubkey === "string" &&
      candidate.pubkey.length > 0 &&
      typeof candidate.signEvent === "function" &&
      candidate.nip44 &&
      typeof candidate.nip44.encrypt === "function" &&
      typeof candidate.nip44.decrypt === "function"
  );
}

export function getConfiguredRelayUrls(): string[] {
  if (typeof window === "undefined") return DEFAULT_SYNC_RELAYS;

  const fromAppConfig = (() => {
    try {
      const raw = localStorage.getItem(NOSTR_APP_CONFIG_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { relayUrls?: string[] };
      return Array.isArray(parsed?.relayUrls) ? parsed.relayUrls : [];
    } catch {
      return [];
    }
  })();

  const fromRelayStorage = (() => {
    try {
      const raw = localStorage.getItem(NOSTR_RELAYS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const relays = uniqueRelayUrls([
    ...fromAppConfig,
    ...fromRelayStorage,
    ...DEFAULT_SYNC_RELAYS,
  ]);

  return relays.length > 0 ? relays : DEFAULT_SYNC_RELAYS;
}

async function fetchDecryptedTokenEvents(
  account: CloudSyncCapableAccount,
  relays: string[],
  maxWaitMs = DEFAULT_TOKEN_QUERY_WAIT_MS
): Promise<DecryptedTokenEvent[]> {
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      relays,
      {
        kinds: [CASHU_TOKEN_KIND],
        authors: [account.pubkey],
        limit: 500,
      },
      { maxWait: maxWaitMs }
    );

    const decryptedEvents: DecryptedTokenEvent[] = [];
    for (const event of events) {
      try {
        const decrypted = await account.nip44.decrypt(account.pubkey, event.content);
        const token = parseTokenPayload(JSON.parse(decrypted));
        if (!token) continue;
        decryptedEvents.push({
          id: event.id,
          createdAt: event.created_at,
          token,
        });
      } catch {
        // Ignore malformed or undecryptable token events for this account
      }
    }

    return decryptedEvents;
  } finally {
    pool.close(relays);
    pool.destroy();
  }
}

export async function fetchNip60ActiveProofs(
  account: CloudSyncCapableAccount,
  options?: { maxWaitMs?: number }
): Promise<WalletProof[]> {
  const relays = getConfiguredRelayUrls();
  const tokenEvents = await fetchDecryptedTokenEvents(
    account,
    relays,
    options?.maxWaitMs
  );

  const deletedEventIds = new Set<string>();
  for (const event of tokenEvents) {
    for (const deletedId of event.token.del || []) {
      deletedEventIds.add(deletedId);
    }
  }

  const sortedEvents = [...tokenEvents].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });

  const proofByIdentity = new Map<string, WalletProof>();
  for (const event of sortedEvents) {
    if (deletedEventIds.has(event.id)) continue;
    for (const proof of event.token.proofs) {
      proofByIdentity.set(proofIdentity(proof), {
        ...proof,
        mintUrl: event.token.mint,
        eventId: event.id,
      });
    }
  }

  return Array.from(proofByIdentity.values());
}

export function getProofsForMint(
  proofs: WalletProof[],
  mintUrl: string
): WalletProof[] {
  const hasMintMetadata = proofs.some(
    (proof) => typeof proof.mintUrl === "string" && proof.mintUrl.length > 0
  );
  if (!hasMintMetadata) return proofs;
  const normalizedMint = normalizeMintUrl(mintUrl);
  const taggedForMint = proofs.filter(
    (proof) => normalizeMintUrl(proof.mintUrl || "") === normalizedMint
  );
  const untagged = proofs.filter(
    (proof) => typeof proof.mintUrl !== "string" || proof.mintUrl.length === 0
  );

  if (taggedForMint.length === 0 && untagged.length > 0) {
    return untagged;
  }
  return [...taggedForMint, ...untagged];
}

export function annotateProofsWithMint(
  proofs: Proof[],
  mintUrl: string,
  eventId?: string
): WalletProof[] {
  return proofs.map((proof) => ({
    ...proof,
    mintUrl,
    ...(eventId ? { eventId } : {}),
  }));
}

function parseWalletTags(payload: unknown): Nip60WalletConfig {
  if (!Array.isArray(payload)) {
    return { privkey: null, mints: [] };
  }

  let privkey: string | null = null;
  const mints = new Set<string>();

  for (const item of payload) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [key, value] = item as WalletTagTuple;
    if (typeof key !== "string" || typeof value !== "string") continue;

    if (key === "privkey" && value.trim()) {
      privkey = value.trim();
      continue;
    }
    if (key === "mint" && value.trim()) {
      const normalizedMint = normalizeMintUrl(value);
      if (normalizedMint) mints.add(normalizedMint);
    }
  }

  return {
    privkey,
    mints: Array.from(mints),
  };
}

export async function fetchNip60WalletConfig(
  account: CloudSyncCapableAccount
): Promise<Nip60WalletConfig> {
  const relays = getConfiguredRelayUrls();
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      relays,
      {
        kinds: [CASHU_WALLET_KIND],
        authors: [account.pubkey],
        limit: 50,
      },
      { maxWait: 7000 }
    );

    if (!events || events.length === 0) {
      return { privkey: null, mints: [] };
    }

    const latest = [...events].sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return b.id.localeCompare(a.id);
    })[0];

    const decrypted = await account.nip44.decrypt(account.pubkey, latest.content);
    return parseWalletTags(JSON.parse(decrypted));
  } catch {
    return { privkey: null, mints: [] };
  } finally {
    pool.close(relays);
    pool.destroy();
  }
}

export async function publishNip60WalletMints(
  account: CloudSyncCapableAccount,
  mints: string[],
  privkey: string
): Promise<void> {
  const relays = getConfiguredRelayUrls();
  const pool = new SimplePool();
  try {
    const normalizedMints = Array.from(
      new Set(
        mints
          .map((mint) => normalizeMintUrl(mint))
          .filter((mint) => mint.length > 0)
      )
    );

    const tags: WalletTagTuple[] = [
      ["privkey", String(privkey)],
      ...normalizedMints.map((mint): WalletTagTuple => ["mint", mint]),
    ];

    const encryptedContent = await account.nip44.encrypt(
      account.pubkey,
      JSON.stringify(tags)
    );

    const template: EventTemplate = {
      kind: CASHU_WALLET_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: encryptedContent,
    };

    const signedEvent = await account.signEvent(template);
    await Promise.allSettled(pool.publish(relays, signedEvent));
  } finally {
    pool.close(relays);
    pool.destroy();
  }
}

export async function publishNip60MintSnapshot(
  account: CloudSyncCapableAccount,
  mintUrl: string,
  proofs: WalletProof[],
  eventIdsToDelete: string[]
): Promise<string> {
  const relays = getConfiguredRelayUrls();
  const pool = new SimplePool();
  try {
    const payload: Nip60TokenPayload = {
      mint: mintUrl,
      proofs: proofs.map((proof) => ({
        id: String(proof.id),
        amount: Number(proof.amount),
        secret: String(proof.secret),
        C: String(proof.C),
      })),
      ...(eventIdsToDelete.length > 0
        ? { del: Array.from(new Set(eventIdsToDelete)) }
        : {}),
    };

    const encryptedContent = await account.nip44.encrypt(
      account.pubkey,
      JSON.stringify(payload)
    );

    const template: EventTemplate = {
      kind: CASHU_TOKEN_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: encryptedContent,
    };

    const signedEvent = await account.signEvent(template);
    await Promise.allSettled(pool.publish(relays, signedEvent));
    return signedEvent.id;
  } finally {
    pool.close(relays);
    pool.destroy();
  }
}
