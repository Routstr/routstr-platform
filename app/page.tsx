"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthProvider";
import LoginMethodsCard from "@/components/auth/LoginMethodsCard";
import PlatformShell from "@/components/platform/PlatformShell";

export default function PlatformPage() {
  const { isAuthenticated, authChecked } = useAuth();

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_10%_0%,rgba(148,163,184,0.14),transparent_40%),radial-gradient(circle_at_90%_100%,rgba(148,163,184,0.1),transparent_45%),var(--background)] text-foreground">
        <main className="mx-auto grid max-w-5xl gap-6 px-4 py-8 sm:px-6 xl:grid-cols-[1.15fr_0.85fr] xl:px-8">
          <section className="space-y-6 rounded-2xl border border-border/60 bg-card/80 p-6">
            <div className="space-y-2">
              <p className="text-[11px] tracking-[0.08em] text-muted-foreground">
                Developer Console
              </p>
              <h1 className="text-3xl font-semibold tracking-tight">
                Routstr Platform
              </h1>
              <p className="max-w-xl text-sm text-muted-foreground">
                Manage API keys across nodes, monitor routing endpoints, and run wallet operations from one workspace.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-muted/15 p-4">
                <p className="text-sm font-medium">API key control</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Create, import, top up, refund, and sync keys.
                </p>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/15 p-4">
                <p className="text-sm font-medium">NIP-60 wallet tools</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Deposit, pay invoices, send tokens, and track history.
                </p>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/15 p-4 sm:col-span-2">
                <p className="text-sm font-medium">Node-aware endpoint routing</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose a routable node and generate request snippets instantly.
                </p>
              </div>
            </div>

            <Link
              href="/login"
              className="inline-flex items-center rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/55"
            >
              Open dedicated login page
            </Link>
          </section>

          <div className="rounded-2xl border border-border/60 bg-card/80 p-2">
            <LoginMethodsCard />
          </div>
        </main>
      </div>
    );
  }

  return <PlatformShell />;
}
