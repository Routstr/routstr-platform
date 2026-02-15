"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Code2,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Flame,
  Home,
  KeyRound,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Sun,
  Wallet,
} from "lucide-react";
import { useTheme } from "next-themes";
import { nip19 } from "nostr-tools";
import { toast } from "sonner";
import { useObservableState } from "applesauce-react/hooks";
import { useAuth } from "@/context/AuthProvider";
import { useAccountManager } from "@/components/providers/ClientProviders";
import { DEFAULT_BASE_URL } from "@/lib/utils";
import DeveloperHome from "@/components/platform/DeveloperHome";
import PlaygroundPanel from "@/components/platform/PlaygroundPanel";
import ApiKeysPanel from "@/components/platform/ApiKeysPanel";
import Nip60WalletPanel from "@/components/platform/Nip60WalletPanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type PlatformTab = "home" | "playground" | "api-keys" | "wallet";

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
  const withProtocol = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;
}

const TAB_PATHS: Record<PlatformTab, string> = {
  home: "/home",
  playground: "/playground",
  "api-keys": "/api-keys",
  wallet: "/wallet",
};

const TAB_META: Record<
  PlatformTab,
  {
    title: string;
    description: string;
  }
> = {
  home: {
    title: "Home",
    description: "Quickstart, network coverage, and setup health checks.",
  },
  playground: {
    title: "Playground",
    description: "Run test requests and iterate on prompts with live responses.",
  },
  "api-keys": {
    title: "API Keys",
    description: "Create, import, and manage keys across endpoint nodes.",
  },
  wallet: {
    title: "Wallet",
    description: "Manage your NIP-60 wallet balance, mints, and sync state.",
  },
};

function resolveAccountNsec(account: unknown): string | null {
  const hexToBytes = (hex: string): Uint8Array | null => {
    const normalized = hex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) return null;
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  };

  if (!account || typeof account !== "object") return null;
  const signer = (account as { signer?: unknown }).signer;
  if (!signer || typeof signer !== "object") return null;
  const key = (signer as { key?: unknown }).key;
  try {
    if (key instanceof Uint8Array) {
      return nip19.nsecEncode(key);
    }
    if (typeof key === "string") {
      const bytes = hexToBytes(key);
      if (bytes) return nip19.nsecEncode(bytes);
    }
    return null;
  } catch {
    return null;
  }
}

export default function PlatformShell({
  activeTab,
  allowUnauthenticated = false,
  onRequestLogin,
}: {
  activeTab: PlatformTab;
  allowUnauthenticated?: boolean;
  onRequestLogin?: () => void;
}) {
  const { logout, isAuthenticated, authChecked } = useAuth();
  const { manager } = useAccountManager();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const isGuestMode = allowUnauthenticated && !isAuthenticated;
  const [themeMounted, setThemeMounted] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showNsec, setShowNsec] = useState(false);
  const [copiedNsec, setCopiedNsec] = useState(false);
  const [baseUrl, setBaseUrl] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_BASE_URL;
    const saved = window.localStorage.getItem("platform_active_base_url");
    const normalized = normalizeBaseUrl(saved || DEFAULT_BASE_URL);
    if (!normalized || isOnionUrl(normalized)) {
      return DEFAULT_BASE_URL;
    }
    return normalized;
  });

  useEffect(() => {
    if (allowUnauthenticated || !authChecked || isAuthenticated) return;
    router.replace("/");
  }, [allowUnauthenticated, authChecked, isAuthenticated, router]);

  useEffect(() => {
    const handleTabNavigation = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: PlatformTab }>;
      const requestedTab = customEvent.detail?.tab;
      if (
        requestedTab === "home" ||
        requestedTab === "playground" ||
        requestedTab === "api-keys" ||
        requestedTab === "wallet"
      ) {
        if (isGuestMode && requestedTab !== "home") {
          onRequestLogin?.();
          return;
        }
        router.push(TAB_PATHS[requestedTab]);
      }
    };

    window.addEventListener("platform:navigate-tab", handleTabNavigation);
    return () => {
      window.removeEventListener("platform:navigate-tab", handleTabNavigation);
    };
  }, [isGuestMode, onRequestLogin, router]);

  useEffect(() => {
    setThemeMounted(true);
  }, []);

  const tabs: Array<{
    id: PlatformTab;
    label: string;
    icon: typeof Home;
    href: string;
  }> = [
    {
      id: "home",
      label: "Home",
      icon: Home,
      href: TAB_PATHS.home,
    },
    {
      id: "playground",
      label: "Playground",
      icon: Code2,
      href: TAB_PATHS.playground,
    },
    {
      id: "api-keys",
      label: "API Keys",
      icon: KeyRound,
      href: TAB_PATHS["api-keys"],
    },
    {
      id: "wallet",
      label: "Wallet",
      icon: Wallet,
      href: TAB_PATHS.wallet,
    },
  ];
  const handleBaseUrlChange = (nextBaseUrl: string) => {
    const normalized = normalizeBaseUrl(nextBaseUrl);
    const safeBaseUrl =
      normalized && !isOnionUrl(normalized) ? normalized : DEFAULT_BASE_URL;
    setBaseUrl(safeBaseUrl);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("platform_active_base_url", safeBaseUrl);
    }
  };
  const themeTabs = [
    { value: "dark", label: "Dark", icon: Moon },
    { value: "red", label: "Red", icon: Flame },
    { value: "light", label: "Light", icon: Sun },
    { value: "system", label: "System", icon: Monitor },
  ] as const;
  const activeTheme = themeMounted
    ? themeTabs.some((item) => item.value === theme)
      ? theme
      : "system"
    : "system";
  const activeAccount = useObservableState(manager.active$);
  const exportNsec = useMemo(() => resolveAccountNsec(activeAccount), [activeAccount]);
  const currentTab = isGuestMode ? "home" : activeTab;
  const tabMeta = TAB_META[currentTab];

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated && !allowUnauthenticated) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(var(--platform-tint),var(--platform-tint)),radial-gradient(circle_at_10%_0%,var(--platform-glow-top),transparent_38%),radial-gradient(circle_at_90%_100%,var(--platform-glow-bottom),transparent_45%),var(--background)] text-foreground">
      <div className="mx-auto w-full max-w-6xl px-3 py-4 sm:px-5 sm:py-5">
        <div className="grid items-start gap-4 md:grid-cols-[11.5rem_minmax(0,1fr)] md:gap-0">
          <aside className="space-y-5 md:sticky md:top-5 md:flex md:min-h-[calc(100vh-2.5rem)] md:flex-col md:self-start">
            <div className="space-y-2 px-1">
              <Button
                onClick={() => router.push(isGuestMode ? "/" : TAB_PATHS.home)}
                variant="ghost"
                className="h-auto w-full justify-start px-0 text-left text-xl font-semibold"
                type="button"
              >
                Routstr Platform
              </Button>
              <p className="text-[11px] text-muted-foreground/75">Developer Console</p>
            </div>

            <div className="flex flex-col py-1 md:min-h-0 md:flex-1">
              <nav className="space-y-2.5">
                {tabs.map((tab) => {
                  const TabIcon = tab.icon;
                  const isActive = currentTab === tab.id;
                  return (
                    <Button
                      key={tab.id}
                      variant={isActive ? "secondary" : "ghost"}
                      size="lg"
                      className="w-full justify-start"
                      onClick={() => {
                        if (isGuestMode) {
                          if (tab.id === "home") {
                            router.push("/");
                          } else {
                            onRequestLogin?.();
                          }
                          return;
                        }
                        router.push(tab.href);
                      }}
                      type="button"
                    >
                      <TabIcon className="h-4 w-4" />
                      {tab.label}
                    </Button>
                  );
                })}
              </nav>
              <div className="mt-4 space-y-2">
                <Button
                  asChild
                  variant="ghost"
                  className="w-full justify-between"
                >
                  <a href="https://docs.routstr.com" target="_blank" rel="noreferrer">
                    <span>Docs</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button
                  asChild
                  variant="ghost"
                  className="w-full justify-between"
                >
                  <a href="https://chat.routstr.com" target="_blank" rel="noreferrer">
                    <span>Chat App</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
              {isAuthenticated ? (
                <>
                  <Button
                    onClick={() => setShowExportDialog(true)}
                    variant="ghost"
                    className="mt-3 w-full justify-start"
                    type="button"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Export nsec
                  </Button>
                  <Button
                    onClick={() => void logout()}
                    variant="ghost"
                    className="mt-1 w-full justify-start"
                    type="button"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign out
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => onRequestLogin?.()}
                  variant="secondary"
                  className="mt-3 w-full justify-start"
                  type="button"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  Sign in
                </Button>
              )}
              <div className="mt-3 px-2 md:mt-auto md:px-1">
                <Tabs
                  value={activeTheme}
                  onValueChange={(value) =>
                    setTheme(value as "light" | "dark" | "system" | "red")
                  }
                >
                  <TabsList>
                    {themeTabs.map((themeOption) => {
                      const ThemeIcon = themeOption.icon;
                      return (
                        <TabsTrigger
                          key={themeOption.value}
                          value={themeOption.value}
                          aria-label={`Set ${themeOption.label.toLowerCase()} theme`}
                          title={themeOption.label}
                          disabled={!themeMounted}
                          className="w-8"
                        >
                          <ThemeIcon className="h-3.5 w-3.5" />
                          <span className="sr-only">{themeOption.label}</span>
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>
                </Tabs>
              </div>
            </div>
          </aside>

          <section className="relative p-4 sm:p-5 md:ml-5 md:min-h-[calc(100vh-2.5rem)] md:pl-7 md:pr-2 md:before:absolute md:before:bottom-0 md:before:left-0 md:before:top-0 md:before:w-px md:before:bg-gradient-to-b md:before:from-border/55 md:before:via-border/40 md:before:to-border/15">
            <div className="space-y-5">
              <header className="space-y-1">
                <h1 className="text-xl font-semibold tracking-tight text-foreground">
                  {tabMeta.title}
                </h1>
                <p className="text-sm text-muted-foreground">{tabMeta.description}</p>
              </header>
              {currentTab === "home" && (
                <DeveloperHome
                  baseUrl={baseUrl}
                  onBaseUrlChange={handleBaseUrlChange}
                />
              )}
              {currentTab === "playground" && (
                <PlaygroundPanel
                  baseUrl={baseUrl}
                  onBaseUrlChange={handleBaseUrlChange}
                />
              )}
              {currentTab === "api-keys" && <ApiKeysPanel baseUrl={baseUrl} />}
              {currentTab === "wallet" && <Nip60WalletPanel baseUrl={baseUrl} />}
            </div>
          </section>
        </div>
      </div>
      <Dialog
        open={showExportDialog}
        onOpenChange={(open) => {
          setShowExportDialog(open);
          if (!open) {
            setShowNsec(false);
            setCopiedNsec(false);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Export nsec</DialogTitle>
            <DialogDescription>
              Keep this private. Anyone with it can control your account.
            </DialogDescription>
          </DialogHeader>
          {exportNsec ? (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted/35 p-3">
                <p className="break-all font-mono text-xs text-foreground/90">
                  {showNsec
                    ? exportNsec
                    : `${exportNsec.slice(0, 8)}${"•".repeat(24)}${exportNsec.slice(-8)}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => setShowNsec((prev) => !prev)}
                  variant="outline"
                  size="sm"
                  type="button"
                >
                  {showNsec ? (
                    <>
                      <EyeOff className="h-3.5 w-3.5" />
                      Hide
                    </>
                  ) : (
                    <>
                      <Eye className="h-3.5 w-3.5" />
                      Show
                    </>
                  )}
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(exportNsec);
                      setCopiedNsec(true);
                      setTimeout(() => setCopiedNsec(false), 1500);
                      toast.success("nsec copied");
                    } catch {
                      toast.error("Failed to copy nsec");
                    }
                  }}
                  variant="secondary"
                  size="sm"
                  type="button"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copiedNsec ? "Copied" : "Copy nsec"}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Current account does not expose a private key. Use a local private-key
              signer account to export nsec.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
