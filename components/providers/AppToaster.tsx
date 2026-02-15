"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Toaster, type ToasterProps } from "sonner";

export default function AppToaster() {
  const { resolvedTheme, theme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const toasterTheme: ToasterProps["theme"] = mounted
    ? (theme === "red" ? "dark" : resolvedTheme) === "light"
      ? "light"
      : "dark"
    : "dark";

  const siteToastPalette = {
    "--normal-bg": "var(--card)",
    "--normal-border": "var(--border)",
    "--normal-text": "var(--card-foreground)",
    "--normal-bg-hover": "color-mix(in oklch, var(--card) 88%, var(--muted))",
    "--normal-border-hover": "color-mix(in oklch, var(--border) 82%, var(--ring))",
  } as CSSProperties & Record<string, string>;

  return (
    <Toaster
      position="top-right"
      closeButton
      theme={toasterTheme}
      style={siteToastPalette}
      toastOptions={{
        duration: 3000,
      }}
    />
  );
}
