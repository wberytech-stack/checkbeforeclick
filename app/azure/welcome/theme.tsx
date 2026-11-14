"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  AZURE_THEME_STORAGE_KEY,
  parseAzureThemePreference,
  resolveAzureDarkTheme,
  type AzureThemePreference,
} from "../../../src/client/azureTheme";

/** Keep page metadata server-rendered while sharing the Security Center's preference. */
export function AzureWelcomeTheme({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<AzureThemePreference>("system");
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    try {
      setPreference(parseAzureThemePreference(window.localStorage.getItem(AZURE_THEME_STORAGE_KEY)));
    } catch {
      // Private browsing may disable storage.
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(media.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  function chooseTheme(next: AzureThemePreference) {
    setPreference(next);
    try {
      window.localStorage.setItem(AZURE_THEME_STORAGE_KEY, next);
    } catch {
      // Keep the selected preference for this visit.
    }
  }

  const isDark = resolveAzureDarkTheme(preference, systemDark);
  return (
    <div className={isDark ? "dark" : ""}>
      <div className="min-h-screen bg-[#f3f6fa] text-slate-900 transition-colors dark:bg-[#080f1c] dark:text-slate-100">
        <div className="fixed bottom-4 right-4 z-40 flex items-center gap-1 rounded-xl border border-slate-200 bg-white/95 p-1 shadow-xl dark:border-slate-600 dark:bg-[#122238]/95" role="group" aria-label="Appearance">
          {([
            { value: "light", label: "Light theme", Icon: Sun },
            { value: "dark", label: "Dark theme", Icon: Moon },
            { value: "system", label: "System theme", Icon: Monitor },
          ] as const).map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              aria-pressed={preference === value}
              title={label}
              onClick={() => chooseTheme(value)}
              className={`flex min-h-10 min-w-10 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${preference === value ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"}`}
            >
              <Icon size={18} aria-hidden="true" />
            </button>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}
