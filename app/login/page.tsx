"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthProvider";
import LoginMethodsCard from "@/components/auth/LoginMethodsCard";

export default function LoginPage() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (isAuthenticated) {
      router.replace("/");
    }
  }, [isAuthenticated, router]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.08),transparent_55%),var(--background)] text-foreground px-4 py-8">
      <div className="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="rounded-2xl border border-border/80 bg-card p-6">
          <p className="text-[11px] tracking-[0.08em] text-muted-foreground">
            Sign In
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Routstr Platform
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Use your Nostr identity to manage Routstr API keys and wallet settings that sync with chat.
          </p>
        </section>

        <div className="rounded-2xl border border-border/80 bg-card p-2">
          <LoginMethodsCard onLoggedIn={() => router.replace("/")} />
        </div>
      </div>
    </div>
  );
}
