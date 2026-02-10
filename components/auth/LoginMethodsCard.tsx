"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ClipboardPaste,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  QrCode,
  Shield,
  UserPlus,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import { QRCodeSVG } from "qrcode.react";
import {
  ExtensionAccount,
  NostrConnectAccount,
  PrivateKeyAccount,
} from "applesauce-accounts/accounts";
import { NostrConnectSigner } from "applesauce-signers";
import { RelayPool } from "applesauce-relay";
import { toast } from "sonner";
import { useAccountManager, AccountMetadata } from "@/components/providers/ClientProviders";

type LoginMethod = "nsec" | "bunker" | "qr";
type SignupStep = "initial" | "save-keys";

const pool = new RelayPool();
NostrConnectSigner.subscriptionMethod = pool.subscription.bind(pool);
NostrConnectSigner.publishMethod = pool.publish.bind(pool);

export default function LoginMethodsCard({
  onLoggedIn,
}: {
  onLoggedIn?: () => void;
}) {
  const { manager, manualSave } = useAccountManager();
  const [hasExtension] = useState(() => {
    if (typeof window === "undefined") return false;
    return Boolean((window as Window & { nostr?: unknown }).nostr);
  });
  const [activeMethod, setActiveMethod] = useState<LoginMethod>("nsec");
  const [signupStep, setSignupStep] = useState<SignupStep>("initial");
  const [generatedAccount, setGeneratedAccount] =
    useState<PrivateKeyAccount<AccountMetadata> | null>(null);
  const [showNsec, setShowNsec] = useState(false);
  const [savedConfirmation, setSavedConfirmation] = useState(false);
  const [nsecCopied, setNsecCopied] = useState(false);

  const [loginNsec, setLoginNsec] = useState("");
  const [bunkerUrl, setBunkerUrl] = useState("");
  const [nostrConnectUri, setNostrConnectUri] = useState<string | null>(null);

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isConnectingExtension, setIsConnectingExtension] = useState(false);
  const [isConnectingBunker, setIsConnectingBunker] = useState(false);
  const [isConnectingQR, setIsConnectingQR] = useState(false);

  const generatedNsec = useMemo(() => {
    if (!generatedAccount) return null;
    try {
      return nip19.nsecEncode(generatedAccount.signer.key);
    } catch {
      return null;
    }
  }, [generatedAccount]);

  const completeLogin = useCallback(() => {
    onLoggedIn?.();
  }, [onLoggedIn]);

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Failed to copy");
    }
  }, []);

  const createNewIdentity = useCallback(() => {
    const account = PrivateKeyAccount.generateNew<AccountMetadata>();
    const count = manager.accounts$.value.length + 1;
    account.metadata = { name: `Account ${count}` };
    setGeneratedAccount(account);
    setSignupStep("save-keys");
    setSavedConfirmation(false);
    setShowNsec(false);
  }, [manager]);

  const finalizeNewIdentity = useCallback(() => {
    if (!generatedAccount) return;
    manager.addAccount(generatedAccount);
    manager.setActive(generatedAccount);
    manualSave.next();
    setGeneratedAccount(null);
    setSignupStep("initial");
    completeLogin();
  }, [generatedAccount, manager, manualSave, completeLogin]);

  const handleExtensionLogin = useCallback(async () => {
    if (!hasExtension) return;
    setIsConnectingExtension(true);
    try {
      const account = await ExtensionAccount.fromExtension();
      manager.addAccount(account);
      manager.setActive(account);
      manualSave.next();
      completeLogin();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Extension login failed");
    } finally {
      setIsConnectingExtension(false);
    }
  }, [hasExtension, manager, manualSave, completeLogin]);

  const handleKeyLogin = useCallback(() => {
    if (!loginNsec.trim()) return;
    setIsLoggingIn(true);
    try {
      const account = PrivateKeyAccount.fromKey<AccountMetadata>(loginNsec.trim());
      const count = manager.accounts$.value.length + 1;
      account.metadata = { name: `Account ${count}` };
      manager.addAccount(account);
      manager.setActive(account);
      manualSave.next();
      setLoginNsec("");
      completeLogin();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid private key");
    } finally {
      setIsLoggingIn(false);
    }
  }, [loginNsec, manager, manualSave, completeLogin]);

  const handleBunkerConnect = useCallback(async () => {
    if (!bunkerUrl.trim()) return;
    setIsConnectingBunker(true);
    try {
      const signer = await NostrConnectSigner.fromBunkerURI(bunkerUrl.trim());
      const pubkey = await signer.getPublicKey();
      const account = new NostrConnectAccount<AccountMetadata>(pubkey, signer);
      const count = manager.accounts$.value.length + 1;
      account.metadata = { name: `Bunker ${count}` };
      manager.addAccount(account);
      manager.setActive(account);
      manualSave.next();
      setBunkerUrl("");
      setActiveMethod("nsec");
      completeLogin();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Bunker connection failed");
    } finally {
      setIsConnectingBunker(false);
    }
  }, [bunkerUrl, manager, manualSave, completeLogin]);

  const cancelQrFlow = useCallback(() => {
    setNostrConnectUri(null);
    setActiveMethod("nsec");
    setIsConnectingQR(false);
  }, []);

  const handleQrConnect = useCallback(async () => {
    setIsConnectingQR(true);
    try {
      const signer = new NostrConnectSigner({
        relays: ["wss://relay.nsec.app"],
      });

      const uri = signer.getNostrConnectURI({ name: "Routstr Platform" });
      setNostrConnectUri(uri);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000);

      await signer.waitForSigner(controller.signal);
      clearTimeout(timeoutId);

      const pubkey = await signer.getPublicKey();
      const account = new NostrConnectAccount<AccountMetadata>(pubkey, signer);
      const count = manager.accounts$.value.length + 1;
      account.metadata = { name: `Signer ${count}` };
      manager.addAccount(account);
      manager.setActive(account);
      manualSave.next();
      setNostrConnectUri(null);
      setActiveMethod("nsec");
      completeLogin();
    } catch (error) {
      if (error instanceof Error && error.message === "Aborted") {
        toast.error("QR connection timed out");
      } else {
        toast.error(error instanceof Error ? error.message : "QR login failed");
      }
      setNostrConnectUri(null);
    } finally {
      setIsConnectingQR(false);
    }
  }, [manager, manualSave, completeLogin]);

  const methodButtonBase =
    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap";

  return (
    <div className="space-y-4 rounded-xl border border-border/80 bg-background/70 p-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-foreground">Developer Sign In</h2>
        <p className="text-sm text-muted-foreground">
          Connect a Nostr identity to access key and wallet controls.
        </p>
      </div>

      {signupStep === "save-keys" && generatedNsec ? (
        <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">New identity</p>
            <button
              onClick={() => setShowNsec((prev) => !prev)}
              className="platform-btn-ghost px-2 py-1 text-xs font-normal"
              type="button"
            >
              {showNsec ? (
                <span className="inline-flex items-center gap-1">
                  <EyeOff className="h-3 w-3" />
                  Hide
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Eye className="h-3 w-3" />
                  Show
                </span>
              )}
            </button>
          </div>

          <div className="px-2 py-2 bg-muted/60 border border-border rounded-lg text-xs text-foreground/80 break-all font-mono flex items-center gap-2">
            <span className="flex-1">
              {showNsec
                ? generatedNsec
                : `${generatedNsec.slice(0, 8)}${"•".repeat(24)}${generatedNsec.slice(
                    -8
                  )}`}
            </span>
            <button
              onClick={async () => {
                await copy(generatedNsec);
                setNsecCopied(true);
                setTimeout(() => setNsecCopied(false), 2000);
              }}
              className="platform-btn-secondary shrink-0 px-2 py-1 text-[10px]"
              type="button"
            >
              {nsecCopied ? "Copied" : "Copy"}
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={savedConfirmation}
              onChange={(event) => setSavedConfirmation(event.target.checked)}
            />
            I have safely saved this key
          </label>

          <div className="flex gap-2">
            <button
              onClick={() => {
                setSignupStep("initial");
                setGeneratedAccount(null);
              }}
              className="platform-btn-secondary flex-1 py-2 text-xs"
              type="button"
            >
              Cancel
            </button>
            <button
              onClick={finalizeNewIdentity}
              disabled={!savedConfirmation}
              className="platform-btn-primary flex-1 py-2 text-xs"
              type="button"
            >
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-muted/40 p-4 flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">Create new identity</p>
          <button
            onClick={createNewIdentity}
            className="platform-btn-muted px-3 py-2 text-xs font-semibold"
            type="button"
          >
            <UserPlus className="h-4 w-4" />
            Create
          </button>
        </div>
      )}

      {signupStep === "initial" && (
        <>
          <div className="flex flex-nowrap gap-1.5 overflow-x-auto pb-1">
            <button
              onClick={() => setActiveMethod("nsec")}
              className={`${methodButtonBase} ${
                activeMethod === "nsec"
                  ? "bg-background/45 text-foreground border-border/80"
                  : "bg-muted/35 border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
              type="button"
            >
              <KeyRound className="h-3 w-3" />
              Private key
            </button>

            {hasExtension && (
              <button
                onClick={handleExtensionLogin}
                disabled={isConnectingExtension}
                className={`${methodButtonBase} bg-muted/60 border-border text-foreground hover:bg-muted/80 disabled:opacity-60`}
                type="button"
              >
                {isConnectingExtension ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-3 w-3 border-2 border-muted-foreground/40 border-t-foreground rounded-full animate-spin" />
                    Connecting
                  </span>
                ) : (
                  <>
                    <Shield className="h-3 w-3" />
                    Extension
                  </>
                )}
              </button>
            )}

            <button
              onClick={() => {
                const nextMethod = activeMethod === "qr" ? "nsec" : "qr";
                setActiveMethod(nextMethod);
                if (nextMethod === "qr" && !nostrConnectUri) {
                  void handleQrConnect();
                }
              }}
              className={`${methodButtonBase} ${
                activeMethod === "qr"
                  ? "bg-background/45 text-foreground border-border/80"
                  : "bg-muted/35 border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
              type="button"
            >
              <QrCode className="h-3 w-3" />
              QR signer
            </button>

            <button
              onClick={() =>
                setActiveMethod((prev) => (prev === "bunker" ? "nsec" : "bunker"))
              }
              className={`${methodButtonBase} ${
                activeMethod === "bunker"
                  ? "bg-background/45 text-foreground border-border/80"
                  : "bg-muted/35 border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
              type="button"
            >
              <Link2 className="h-3 w-3" />
              Bunker
            </button>
          </div>

          {activeMethod === "nsec" && (
            <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <KeyRound className="h-3 w-3" />
                Private key (nsec)
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <input
                    type="password"
                    value={loginNsec}
                    onChange={(event) => setLoginNsec(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleKeyLogin();
                      }
                    }}
                    placeholder="nsec1..."
                    className="platform-input pr-10"
                  />
                  <button
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        setLoginNsec(text.trim());
                      } catch {
                        toast.error("Clipboard not available");
                      }
                    }}
                    className="platform-btn-icon absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
                    type="button"
                    title="Paste"
                  >
                    <ClipboardPaste className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button
                  onClick={handleKeyLogin}
                  disabled={isLoggingIn || !loginNsec.trim()}
                  className="platform-btn-secondary shrink-0 px-3 py-1.5 text-xs"
                  type="button"
                >
                  <KeyRound className="h-4 w-4" />
                  {isLoggingIn ? "Signing in..." : "Sign in"}
                </button>
              </div>
            </div>
          )}

          {activeMethod === "bunker" && (
            <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Link2 className="h-3 w-3" />
                Bunker URL
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    placeholder="bunker://..."
                    value={bunkerUrl}
                    onChange={(event) => setBunkerUrl(event.target.value)}
                    className="platform-input pr-10"
                  />
                  <button
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        setBunkerUrl(text.trim());
                      } catch {
                        toast.error("Clipboard not available");
                      }
                    }}
                    className="platform-btn-icon absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
                    type="button"
                    title="Paste"
                  >
                    <ClipboardPaste className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button
                  onClick={() => void handleBunkerConnect()}
                  disabled={!bunkerUrl.trim() || isConnectingBunker}
                  className="platform-btn-secondary shrink-0 px-3 py-1.5 text-xs"
                  type="button"
                >
                  {isConnectingBunker ? "Connecting..." : "Connect"}
                </button>
              </div>
            </div>
          )}

          {activeMethod === "qr" && (
            <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <QrCode className="h-3 w-3" />
                QR signer
              </div>
              {nostrConnectUri ? (
                <div className="flex flex-col items-center gap-3">
                  <p className="text-xs text-muted-foreground text-center">
                    Scan with your Nostr mobile signer.
                  </p>
                  <div className="platform-card-soft p-3">
                    <QRCodeSVG value={nostrConnectUri} size={150} />
                  </div>
                  <button
                    onClick={cancelQrFlow}
                    className="platform-btn-ghost px-3 py-1.5 text-xs"
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-center py-2">
                  <button
                    onClick={() => void handleQrConnect()}
                    className="platform-btn-secondary px-3 py-2 text-xs"
                    type="button"
                    disabled={isConnectingQR}
                  >
                    <QrCode className="h-4 w-4" />
                    {isConnectingQR ? "Generating..." : "Generate QR"}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
