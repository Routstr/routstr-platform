"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
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
  Network,
  MoreHorizontal,
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
import NodesPanel from "@/components/platform/NodesPanel";
import PlaygroundPanel from "@/components/platform/PlaygroundPanel";
import ApiKeysPanel from "@/components/platform/ApiKeysPanel";
import Nip60WalletPanel from "@/components/platform/Nip60WalletPanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

export type PlatformTab = "home" | "nodes" | "playground" | "api-keys" | "wallet";

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

function shouldAllowHttp(url: string): boolean {
  return !url.startsWith("http://");
}

const TAB_PATHS: Record<PlatformTab, string> = {
  home: "/home",
  nodes: "/nodes",
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
    description: "Overview and quick actions for your active endpoint.",
  },
  nodes: {
    title: "Nodes",
    description: "Browse Routstr endpoints, inspect node metadata, and review models.",
  },
  playground: {
    title: "Playground",
    description:
      "Run test requests and iterate on prompts with live responses.",
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

const THEME_TABS = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "red", label: "Red", icon: Flame },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
] as const;

type PlatformTheme = (typeof THEME_TABS)[number]["value"];

function isPlatformTheme(value: unknown): value is PlatformTheme {
  return (
    value === "dark" ||
    value === "red" ||
    value === "light" ||
    value === "system"
  );
}

function readStoredPlatformTheme(): PlatformTheme {
  if (typeof window === "undefined") return "system";
  const savedTheme = window.localStorage.getItem("theme");
  return isPlatformTheme(savedTheme) ? savedTheme : "system";
}

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
  const [themeMounted, setThemeMounted] = useState(
    () => typeof window !== "undefined",
  );
  const [lastKnownTheme, setLastKnownTheme] = useState<PlatformTheme>(
    () => readStoredPlatformTheme(),
  );
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const [showMobileMoreDialog, setShowMobileMoreDialog] = useState(false);
  const [showNsec, setShowNsec] = useState(false);
  const [copiedNsec, setCopiedNsec] = useState(false);
  const [, startRouteTransition] = useTransition();
  const [baseUrl, setBaseUrl] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_BASE_URL;
    const saved = window.localStorage.getItem("platform_active_base_url");
    const normalized = normalizeBaseUrl(saved || DEFAULT_BASE_URL);
    if (!normalized || isOnionUrl(normalized) || !shouldAllowHttp(normalized)) {
      return DEFAULT_BASE_URL;
    }
    return normalized;
  });

  const navigateToPath = useCallback(
    (path: string) => {
      startRouteTransition(() => {
        router.push(path);
      });
    },
    [router, startRouteTransition]
  );

  useEffect(() => {
    if (allowUnauthenticated || !authChecked || isAuthenticated) return;
    startRouteTransition(() => {
      router.replace("/");
    });
  }, [allowUnauthenticated, authChecked, isAuthenticated, router, startRouteTransition]);

  useEffect(() => {
    if (!authChecked) return;
    Object.values(TAB_PATHS).forEach((path) => {
      router.prefetch(path);
    });
  }, [authChecked, router]);

  useEffect(() => {
    const handleTabNavigation = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: PlatformTab }>;
      const requestedTab = customEvent.detail?.tab;
      if (
        requestedTab === "home" ||
        requestedTab === "nodes" ||
        requestedTab === "playground" ||
        requestedTab === "api-keys" ||
        requestedTab === "wallet"
      ) {
        if (isGuestMode && requestedTab !== "home") {
          onRequestLogin?.();
          return;
        }
        navigateToPath(TAB_PATHS[requestedTab]);
      }
    };

    window.addEventListener("platform:navigate-tab", handleTabNavigation);
    return () => {
      window.removeEventListener("platform:navigate-tab", handleTabNavigation);
    };
  }, [isGuestMode, navigateToPath, onRequestLogin]);

  useEffect(() => {
    setThemeMounted(true);
  }, []);

  useEffect(() => {
    if (isPlatformTheme(theme)) {
      setLastKnownTheme(theme);
    }
  }, [theme]);

  const tabs: Array<{
    id: PlatformTab;
    label: string;
    icon: typeof Home;
  }> = [
    {
      id: "home",
      label: "Home",
      icon: Home,
    },
    {
      id: "nodes",
      label: "Nodes",
      icon: Network,
    },
    {
      id: "playground",
      label: "Playground",
      icon: Code2,
    },
    {
      id: "api-keys",
      label: "API Keys",
      icon: KeyRound,
    },
    {
      id: "wallet",
      label: "Wallet",
      icon: Wallet,
    },
  ];
  const navigateToTab = (tab: PlatformTab) => {
    if (!isGuestMode && tab === activeTab) return;
    if (isGuestMode) {
      if (tab === "home") {
        navigateToPath("/");
      } else {
        onRequestLogin?.();
      }
      return;
    }
    navigateToPath(TAB_PATHS[tab]);
  };
  const handleBaseUrlChange = (nextBaseUrl: string) => {
    const normalized = normalizeBaseUrl(nextBaseUrl);
    const safeBaseUrl =
      normalized && !isOnionUrl(normalized) && shouldAllowHttp(normalized)
        ? normalized
        : DEFAULT_BASE_URL;
    setBaseUrl(safeBaseUrl);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("platform_active_base_url", safeBaseUrl);
    }
  };
  const handleConfirmSignOut = async () => {
    setShowSignOutDialog(false);
    await logout();
  };
  const activeTheme = themeMounted
    ? isPlatformTheme(theme)
      ? theme
      : lastKnownTheme
    : lastKnownTheme;
  const activeAccount = useObservableState(manager.active$);
  const exportNsec = useMemo(
    () => resolveAccountNsec(activeAccount),
    [activeAccount],
  );
  const currentTab = isGuestMode ? "home" : activeTab;
  const tabMeta = TAB_META[currentTab];
  const mobileContentPadding =
    currentTab === "nodes"
      ? "pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
      : "pb-[calc(4.75rem+env(safe-area-inset-bottom))]";

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
    <div className="min-h-dvh overscroll-y-none bg-[linear-gradient(var(--platform-tint),var(--platform-tint)),radial-gradient(circle_at_10%_0%,var(--platform-glow-top),transparent_38%),radial-gradient(circle_at_90%_100%,var(--platform-glow-bottom),transparent_45%),var(--background)] text-foreground md:h-screen md:overflow-hidden">
      <div
        className={`mx-auto w-full max-w-6xl px-3 py-4 ${mobileContentPadding} sm:px-5 sm:py-5 md:h-full md:pb-5`}
      >
        <div className="grid min-w-0 items-start gap-4 md:h-full md:grid-cols-[11.5rem_minmax(0,1fr)] md:gap-0">
          <aside className="hidden min-w-0 space-y-5 md:sticky md:top-5 md:flex md:h-[calc(100vh-2.5rem)] md:flex-col md:self-start md:pt-5">
            <div className="space-y-2 px-1">
              <button
                onClick={() => navigateToTab("home")}
                className="w-full rounded-md bg-transparent px-0 text-left text-xl font-semibold text-foreground outline-none"
                type="button"
              >
                Routstr Platform
              </button>
              <p className="text-[11px] text-muted-foreground/75">
                Routstr nodes, API keys, playground testing, and wallet operations.
              </p>
            </div>

            <div className="flex flex-col py-1 md:min-h-0 md:flex-1">
              <nav className="hidden md:block md:space-y-2.5">
                {tabs.map((tab) => {
                  const TabIcon = tab.icon;
                  const isActive = currentTab === tab.id;
                  return (
                    <Button
                      key={tab.id}
                      variant={isActive ? "outline" : "ghost"}
                      size="lg"
                      className="w-full justify-start"
                      onClick={() => navigateToTab(tab.id)}
                      type="button"
                    >
                      <TabIcon className="h-4 w-4" />
                      {tab.label}
                    </Button>
                  );
                })}
              </nav>
              <div className="mt-3 grid grid-cols-2 gap-2 md:mt-4 md:block md:space-y-2">
                <Button
                  asChild
                  variant="ghost"
                  className="w-full justify-between"
                >
                  <a
                    href="https://docs.routstr.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>Docs</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button
                  asChild
                  variant="ghost"
                  className="w-full justify-between"
                >
                  <a
                    href="https://chat.routstr.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>Chat App</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
              <div className="mt-3 space-y-3 md:mt-auto">
                {isAuthenticated ? (
                  <div className="space-y-1">
                    <Button
                      onClick={() => setShowExportDialog(true)}
                      variant="ghost"
                      className="w-full justify-start"
                      type="button"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      Export nsec
                    </Button>
                    <Button
                      onClick={() => setShowSignOutDialog(true)}
                      variant="ghost"
                      className="w-full justify-start"
                      type="button"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      Sign out
                    </Button>
                  </div>
                ) : (
                  <Button
                    onClick={() => onRequestLogin?.()}
                    variant="outline"
                    className="w-full justify-start"
                    type="button"
                  >
                    <LogIn className="h-3.5 w-3.5" />
                    Sign in
                  </Button>
                )}
                <div className="px-2 md:px-1">
                  <Tabs
                    value={activeTheme}
                    onValueChange={(value) =>
                      setTheme(value as "light" | "dark" | "system" | "red")
                    }
                  >
                    <TabsList>
                      {THEME_TABS.map((themeOption) => {
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
            </div>
          </aside>

          <div className="relative min-w-0 md:ml-5 md:h-[calc(100vh-2.5rem)] md:before:absolute md:before:bottom-0 md:before:left-0 md:before:top-0 md:before:w-px md:before:bg-gradient-to-b md:before:from-border/55 md:before:via-border/40 md:before:to-border/15">
            <section
              className={`min-w-0 overflow-x-clip p-3 sm:p-5 md:h-full md:pl-7 md:pr-2 ${
                currentTab === "nodes"
                  ? "md:overflow-hidden"
                  : "md:overflow-y-auto md:overscroll-y-none"
              }`}
            >
              <div
                className={`space-y-5 ${
                  currentTab === "nodes" || currentTab === "playground"
                    ? "md:flex md:h-full md:min-h-0 md:flex-col"
                    : ""
                }`}
              >
                {currentTab !== "home" && (
                  <header className="space-y-1">
                    <h1 className="text-xl font-semibold tracking-tight text-foreground">
                      {tabMeta.title}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      {tabMeta.description}
                    </p>
                  </header>
                )}
                {currentTab === "home" && (
                  <DeveloperHome
                    baseUrl={baseUrl}
                  />
                )}
                {currentTab === "playground" && (
                  <div className="md:min-h-0 md:flex-1">
                    <PlaygroundPanel
                      baseUrl={baseUrl}
                      onBaseUrlChange={handleBaseUrlChange}
                    />
                  </div>
                )}
                {currentTab === "nodes" && (
                  <div className="md:min-h-0 md:flex-1">
                    <NodesPanel
                      baseUrl={baseUrl}
                    />
                  </div>
                )}
                {currentTab === "api-keys" && <ApiKeysPanel baseUrl={baseUrl} />}
                {currentTab === "wallet" && (
                  <Nip60WalletPanel baseUrl={baseUrl} />
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(0.35rem+env(safe-area-inset-bottom))] md:hidden">
        <nav
          className="pointer-events-auto mx-auto grid w-full max-w-[34rem] gap-2 rounded-[1.5rem] border border-border/65 bg-background/80 p-2.5 shadow-[0_-16px_36px_-22px_rgba(0,0,0,0.9)] backdrop-blur-2xl supports-[backdrop-filter]:bg-background/72"
          style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}
        >
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            const isActive = currentTab === tab.id;
            return (
              <Button
                key={`mobile-${tab.id}`}
                variant="ghost"
                size="sm"
                className={`group h-12 min-w-0 rounded-2xl px-0 transition-all duration-200 ${
                  isActive
                    ? "bg-foreground/10 text-foreground ring-1 ring-border/70"
                    : "text-foreground/65 hover:bg-foreground/5 hover:text-foreground"
                }`}
                onClick={() => navigateToTab(tab.id)}
                type="button"
                aria-label={tab.label}
                title={tab.label}
                aria-current={isActive ? "page" : undefined}
              >
                <TabIcon
                  className={`size-5 transition-all duration-200 ${
                    isActive
                      ? "scale-105 text-foreground"
                      : "text-current group-hover:scale-105 group-hover:text-foreground"
                  }`}
                />
              </Button>
            );
          })}
          {(() => {
            const isMoreActive = showMobileMoreDialog;
            return (
              <Button
                key="mobile-more"
                variant="ghost"
                size="sm"
                className={`group h-12 min-w-0 rounded-2xl px-0 transition-all duration-200 ${
                  isMoreActive
                    ? "bg-foreground/10 text-foreground ring-1 ring-border/70"
                    : "text-foreground/65 hover:bg-foreground/5 hover:text-foreground"
                }`}
                onClick={() => setShowMobileMoreDialog(true)}
                type="button"
                aria-label="More"
                title="More"
                aria-current={isMoreActive ? "page" : undefined}
              >
                <MoreHorizontal
                  className={`size-5 transition-all duration-200 ${
                    isMoreActive
                      ? "scale-105 text-foreground"
                      : "text-current group-hover:scale-105 group-hover:text-foreground"
                  }`}
                />
              </Button>
            );
          })()}
        </nav>
      </div>
      <Drawer
        open={showMobileMoreDialog}
        onOpenChange={setShowMobileMoreDialog}
      >
        <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[90vh]">
          <DrawerHeader className="text-left">
            <DrawerTitle>More</DrawerTitle>
            <DrawerDescription>
              Docs, chat, account tools, and theme settings.
            </DrawerDescription>
          </DrawerHeader>
          <div className="space-y-5 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            <section className="space-y-2.5">
              <p className="text-xs font-medium text-muted-foreground">Links</p>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="h-11 w-full justify-between"
              >
                <a
                  href="https://docs.routstr.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>Docs</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="h-11 w-full justify-between"
              >
                <a
                  href="https://chat.routstr.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>Chat App</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            </section>
            <Separator className="bg-border/60" />
            {isAuthenticated ? (
              <section className="space-y-2.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Account
                </p>
                <Button
                  variant="outline"
                  size="lg"
                  className="h-11 w-full justify-start"
                  onClick={() => {
                    setShowMobileMoreDialog(false);
                    setShowExportDialog(true);
                  }}
                  type="button"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Export nsec
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  className="h-11 w-full justify-start"
                  onClick={() => {
                    setShowMobileMoreDialog(false);
                    setShowSignOutDialog(true);
                  }}
                  type="button"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign out
                </Button>
              </section>
            ) : (
              <section className="space-y-2.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Account
                </p>
                <Button
                  variant="outline"
                  size="lg"
                  className="h-11 w-full justify-start"
                  onClick={() => {
                    setShowMobileMoreDialog(false);
                    onRequestLogin?.();
                  }}
                  type="button"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  Sign in
                </Button>
              </section>
            )}
            <Separator className="bg-border/60" />
            <section className="space-y-2.5">
              <p className="text-xs font-medium text-muted-foreground">Theme</p>
              <div className="grid grid-cols-2 gap-2">
                {THEME_TABS.map((themeOption) => {
                  const ThemeIcon = themeOption.icon;
                  return (
                    <Button
                      key={`mobile-theme-${themeOption.value}`}
                      variant="outline"
                      size="lg"
                      className="h-11 justify-start"
                      onClick={() => setTheme(themeOption.value)}
                      disabled={!themeMounted}
                      type="button"
                      aria-label={`Set ${themeOption.label.toLowerCase()} theme`}
                    >
                      <ThemeIcon className="h-3.5 w-3.5" />
                      {themeOption.label}
                    </Button>
                  );
                })}
              </div>
            </section>
          </div>
        </DrawerContent>
      </Drawer>
      <Dialog
        open={showSignOutDialog}
        onOpenChange={setShowSignOutDialog}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
            <DialogDescription>
              You will be signed out of this device.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => setShowSignOutDialog(false)}
              variant="ghost"
              type="button"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleConfirmSignOut()}
              variant="destructive"
              type="button"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
                    } catch {
                      toast.error("Failed to copy nsec");
                    }
                  }}
                  variant="outline"
                  size="sm"
                  type="button"
                >
                  {copiedNsec ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  Copy nsec
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Current account does not expose a private key. Use a local
              private-key signer account to export nsec.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
