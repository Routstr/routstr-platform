"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthProvider";
import LoginMethodsCard from "@/components/auth/LoginMethodsCard";
import PlatformShell from "@/components/platform/PlatformShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

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
              <Card className="gap-0 bg-muted/15 py-0 shadow-none">
                <CardContent className="p-4">
                <p className="text-sm font-medium">API key control</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Create, import, top up, refund, and sync keys.
                </p>
                </CardContent>
              </Card>
              <Card className="gap-0 bg-muted/15 py-0 shadow-none">
                <CardContent className="p-4">
                <p className="text-sm font-medium">NIP-60 wallet tools</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Deposit, pay invoices, send tokens, and track history.
                </p>
                </CardContent>
              </Card>
              <Card className="gap-0 bg-muted/15 py-0 shadow-none sm:col-span-2">
                <CardContent className="p-4">
                <p className="text-sm font-medium">Node-aware endpoint routing</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose a routable node and generate request snippets instantly.
                </p>
                </CardContent>
              </Card>
            </div>

            <Button asChild variant="secondary" className="w-fit">
              <Link href="/login">Open dedicated login page</Link>
            </Button>
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
