"use client";

import { cn } from "@/lib/utils";
import type { BitcoinConnectStatus } from "@/hooks/useBitcoinConnect";
import { Button } from "@/components/ui/button";

interface BitcoinConnectStatusRowProps {
  status: BitcoinConnectStatus;
  balance?: number | null;
  onConnect: () => void | Promise<void>;
  label?: string;
  connectedLabel?: string;
  showBalance?: boolean;
  className?: string;
}

export default function BitcoinConnectStatusRow({
  status,
  balance = null,
  onConnect,
  label = "Wallet (NWC)",
  connectedLabel = "Connected",
  showBalance = true,
  className,
}: BitcoinConnectStatusRowProps) {
  return (
    <div
      className={cn(
        "bg-muted/50 border border-border rounded-lg p-2 flex items-center justify-between gap-3",
        className
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      {status === "connected" ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-foreground/85">{connectedLabel}</span>
          {showBalance && balance !== null && (
            <span className="text-muted-foreground">
              • {balance.toLocaleString()} sats
            </span>
          )}
        </div>
      ) : (
        <Button
          onClick={onConnect}
          variant="secondary"
          size="sm"
          type="button"
        >
          {status === "connecting" ? "Connecting..." : "Connect wallet"}
        </Button>
      )}
    </div>
  );
}
