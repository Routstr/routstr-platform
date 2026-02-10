export function clearAllStorage() {
  if (typeof window === "undefined") return;

  const activeAccount = localStorage.getItem("activeAccount");
  const accounts = localStorage.getItem("accounts");

  localStorage.clear();

  if (accounts) localStorage.setItem("accounts", accounts);
  if (activeAccount) localStorage.setItem("activeAccount", activeAccount);
}

export function getStorageBoolean(key: string, fallback = false): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "true";
}

export function setStorageBoolean(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, String(value));
}
