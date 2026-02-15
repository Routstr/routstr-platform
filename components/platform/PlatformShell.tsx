"use client";

import { useEffect, useState } from "react";
import {
  Code2,
  ExternalLink,
  Flame,
  Home,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Sun,
  Wallet,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useAuth } from "@/context/AuthProvider";
import { DEFAULT_BASE_URL } from "@/lib/utils";
import DeveloperHome from "@/components/platform/DeveloperHome";
import PlaygroundPanel from "@/components/platform/PlaygroundPanel";
import ApiKeysPanel from "@/components/platform/ApiKeysPanel";
import Nip60WalletPanel from "@/components/platform/Nip60WalletPanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

type PlatformTab = "home" | "playground" | "api-keys" | "wallet";

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

export default function PlatformShell() {
  const { logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<PlatformTab>("home");
  const [themeMounted, setThemeMounted] = useState(false);
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
    const handleTabNavigation = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: PlatformTab }>;
      const requestedTab = customEvent.detail?.tab;
      if (
        requestedTab === "home" ||
        requestedTab === "playground" ||
        requestedTab === "api-keys" ||
        requestedTab === "wallet"
      ) {
        setActiveTab(requestedTab);
      }
    };

    window.addEventListener("platform:navigate-tab", handleTabNavigation);
    return () => {
      window.removeEventListener("platform:navigate-tab", handleTabNavigation);
    };
  }, []);

  useEffect(() => {
    setThemeMounted(true);
  }, []);

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

  return (
    <div className="min-h-screen bg-[linear-gradient(var(--platform-tint),var(--platform-tint)),radial-gradient(circle_at_10%_0%,var(--platform-glow-top),transparent_38%),radial-gradient(circle_at_90%_100%,var(--platform-glow-bottom),transparent_45%),var(--background)] text-foreground">
      <div className="mx-auto w-full max-w-6xl px-3 py-4 sm:px-5 sm:py-5">
        <div className="grid items-start gap-4 md:grid-cols-[11.5rem_minmax(0,1fr)] md:gap-0">
          <aside className="space-y-5 md:sticky md:top-5 md:flex md:min-h-[calc(100vh-2.5rem)] md:flex-col md:self-start">
            <div className="space-y-2 px-1">
              <Button
                onClick={() => setActiveTab("home")}
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
                  const isActive = activeTab === tab.id;
                  return (
                    <Button
                      key={tab.id}
                      variant={isActive ? "secondary" : "ghost"}
                      size="lg"
                      className="w-full justify-start"
                      onClick={() => setActiveTab(tab.id)}
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
              <Button
                onClick={() => void logout()}
                variant="ghost"
                className="mt-3 w-full justify-start"
                type="button"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </Button>
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
            {activeTab === "home" && (
              <DeveloperHome
                baseUrl={baseUrl}
                onBaseUrlChange={handleBaseUrlChange}
              />
            )}
            {activeTab === "playground" && (
              <PlaygroundPanel
                baseUrl={baseUrl}
                onBaseUrlChange={handleBaseUrlChange}
              />
            )}
            {activeTab === "api-keys" && <ApiKeysPanel baseUrl={baseUrl} />}
            {activeTab === "wallet" && <Nip60WalletPanel baseUrl={baseUrl} />}
          </section>
        </div>
      </div>
    </div>
  );
}
