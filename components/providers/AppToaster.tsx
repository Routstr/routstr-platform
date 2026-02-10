"use client";

import { useEffect, useState } from "react";
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

  return (
    <Toaster
      position="top-right"
      closeButton
      theme={toasterTheme}
      toastOptions={{
        duration: 3000,
      }}
    />
  );
}
