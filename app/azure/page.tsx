"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, FileSearch, History, LayoutDashboard, LogIn, LogOut, Monitor, Moon, RefreshCw, ScanSearch, ShieldCheck, Sun } from "lucide-react";
import { AZURE_THEME_STORAGE_KEY, parseAzureThemePreference, resolveAzureDarkTheme, type AzureThemePreference } from "../../src/client/azureTheme";
import {
  type AzureScanView,
  parseScanCreated,
  parseScanRead,
  scanPresentation,
  validateSubmittedUrl,
} from "../../src/client/azureScanUi";

const POLL_INTERVAL_MS = 2500;
const MAX_POLLS = 72;

export default function AzureScanPage() {
  const [input, setInput] = useState("");
  const [scanId, setScanId] = useState<string | null>(null);
  const [scan, setScan] = useState<AzureScanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loginRequired, setLoginRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const [theme, setTheme] = useState<AzureThemePreference>("system");
  const [systemDark, setSystemDark] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    try {
      setTheme(parseAzureThemePreference(window.localStorage.getItem(AZURE_THEME_STORAGE_KEY)));
    } catch {
      // Browsers may block local storage; the system theme still works.
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(media.matches);
    const onSystemThemeChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onSystemThemeChange);
    return () => media.removeEventListener("change", onSystemThemeChange);
  }, []);

  function chooseTheme(next: AzureThemePreference) {
    setTheme(next);
    try {
      window.localStorage.setItem(AZURE_THEME_STORAGE_KEY, next);
    } catch {
      // Theme remains usable for this visit even when persistence is blocked.
    }
  }

  useEffect(() => {
    if (!scanId) return;
    const current = ++generation.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;

    async function refresh() {
      try {
        const response = await fetch(`/api/azure/scans/${scanId}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (controller.signal.aborted || current !== generation.current) return;
        if (response.status === 401) {
          setLoginRequired(true);
          setError("Sign in to view your scan.");
          return;
        }
        if (!response.ok) throw new Error("Scan results are temporarily unavailable.");
        const result = parseScanRead(await response.json(), scanId!);
        if (controller.signal.aborted || current !== generation.current) return;
        setScan(result);
        setError(null);
        if (result.scan.status === "pending" || result.scan.status === "processing") {
          if (++polls >= MAX_POLLS) {
            setError("Still processing. Refresh this page later to check the result.");
            return;
          }
          timer = setTimeout(refresh, POLL_INTERVAL_MS);
        }
      } catch {
        if (!controller.signal.aborted && current === generation.current) {
          setError("Scan results are temporarily unavailable. Try again.");
        }
      }
    }
    void refresh();
    return () => {
      generation.current++;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [scanId, refreshKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const normalized = validateSubmittedUrl(input);
    if (!normalized) {
      setError("Enter a valid public http:// or https:// link (without credentials).");
      return;
    }
    generation.current++;
    setScanId(null);
    setScan(null);
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/azure/scans", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ input_type: "url", raw_input: normalized }),
      });
      if (response.status === 401) {
        setLoginRequired(true);
        setError("Sign in to submit a scan.");
        return;
      }
      if (response.status === 403) {
        setError("Your account cannot submit scans.");
        return;
      }
      if (!response.ok) throw new Error("Scan submission failed.");
      const id = parseScanCreated(await response.json());
      setScanId(id);
      setLoginRequired(false);
    } catch {
      setError("Scan submission is temporarily unavailable. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const presentation = scan ? scanPresentation(scan.scan) : null;
  const isDark = resolveAzureDarkTheme(theme, systemDark);
  const isDangerous = scan?.scan.verdict === "dangerous" && scan.scan.status === "complete";

  return (
    <div className={isDark ? "dark" : ""}>
      <a href="#security-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-blue-600 focus:px-4 focus:py-2 focus:text-white">
        Skip to main content
      </a>
      <div className="min-h-screen bg-[#f3f6fa] text-slate-900 transition-colors dark:bg-[#0b1220] dark:text-slate-100">
        <header className="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-[#111d30]">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white" aria-hidden="true"><ShieldCheck size={23} /></span>
              <div>
                <p className="text-base font-bold tracking-tight">CheckBeforeClick</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">Security Center · Azure edition</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div role="group" aria-label="Appearance" className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-1 dark:border-slate-600 dark:bg-[#19283c]">
                {([
                  { value: "light", label: "Light", Icon: Sun },
                  { value: "dark", label: "Dark", Icon: Moon },
                  { value: "system", label: "System", Icon: Monitor },
                ] as const).map(({ value, label, Icon }) => (
                  <button key={value} type="button" onClick={() => chooseTheme(value)} aria-pressed={theme === value}
                    className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${theme === value ? "bg-white text-blue-700 shadow-sm dark:bg-[#334b6c] dark:text-white" : "text-slate-600 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white"}`}>
                    <Icon size={14} aria-hidden="true" />{label}
                  </button>
                ))}
              </div>
              <a href="/auth/azure/start" className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-slate-600 dark:hover:bg-slate-700">
                <LogIn size={15} aria-hidden="true" /> Sign in
              </a>
              <form action="/auth/azure/logout" method="post">
                <button type="submit" className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-slate-600 dark:hover:bg-slate-700">
                  <LogOut size={15} aria-hidden="true" /> Sign out
                </button>
              </form>
            </div>
          </div>
        </header>
        <div className="mx-auto flex max-w-[1600px]">
          <aside className="hidden min-h-[calc(100vh-66px)] w-60 shrink-0 border-r border-slate-200 bg-white px-3 py-6 md:block dark:border-slate-700 dark:bg-[#111d30]">
            <p className="px-3 pb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Workspace</p>
            <nav aria-label="Security Center" className="space-y-1 text-sm">
              <a href="#overview" aria-current="page" className="flex items-center gap-3 rounded-lg bg-blue-50 px-3 py-2.5 font-semibold text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:bg-[#183d65] dark:text-blue-200"><LayoutDashboard size={18} aria-hidden="true" /> Overview</a>
              <a href="#analyze" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-slate-200 dark:hover:bg-[#233650]"><ScanSearch size={18} aria-hidden="true" /> Analyze URL</a>
              <a href="#investigation" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-slate-200 dark:hover:bg-[#233650]"><FileSearch size={18} aria-hidden="true" /> Investigation</a>
              <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-slate-400 dark:text-slate-500" aria-label="Scan history, coming later"><History size={18} aria-hidden="true" /> Scan history <span className="ml-auto text-[10px]">Soon</span></div>
            </nav>
            <div className="mt-10 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-relaxed text-slate-700 dark:border-[#274668] dark:bg-[#152c45] dark:text-slate-300">
              <ShieldCheck size={18} className="mb-2 text-blue-600 dark:text-blue-300" aria-hidden="true" />
              <strong className="block text-slate-900 dark:text-white">Check before you click</strong>
              A reputation result is one signal, never a guarantee that a link is safe.
            </div>
          </aside>
          <main id="security-main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <nav aria-label="Mobile navigation" className="mb-5 flex gap-2 text-xs md:hidden">
              <a href="#overview" className="rounded-md bg-blue-100 px-3 py-2 font-semibold text-blue-800 dark:bg-[#183d65] dark:text-blue-100">Overview</a>
              <a href="#analyze" className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-600">Analyze</a>
              <a href="#investigation" className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-600">Investigation</a>
            </nav>
            <div id="overview" className="mb-6">
              <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-blue-700 dark:text-blue-300">Security overview</p>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Link intelligence</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-300">Analyze a suspicious URL and inspect evidence before deciding what to do next.</p>
            </div>
            <div className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Current investigation metrics">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-[#142238]">
                <p className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400"><Activity size={15} aria-hidden="true" /> Current scan</p>
                <p className="mt-3 text-lg font-bold capitalize">{scan?.scan.status ?? (scanId ? "Loading" : "Not started")}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-[#142238]">
                <p className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400"><ShieldCheck size={15} aria-hidden="true" /> Current verdict</p>
                <p className="mt-3 text-lg font-bold">{presentation?.label ?? "Awaiting analysis"}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-[#142238]">
                <p className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400"><FileSearch size={15} aria-hidden="true" /> Evidence items</p>
                <p className="mt-3 text-lg font-bold">{scan ? scan.evidence.length : "—"}</p>
              </div>
            </div>
            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
              <section id="analyze" aria-labelledby="analyze-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-[#142238]">
                <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-700">
                  <h2 id="analyze-heading" className="flex items-center gap-2 text-base font-bold"><ScanSearch size={19} className="text-blue-600 dark:text-blue-300" aria-hidden="true" /> Analyze a URL</h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">The scanner checks reputation without opening the submitted website.</p>
                </div>
                <form onSubmit={submit} aria-busy={busy} className="space-y-4 p-5">
                  <label htmlFor="scan-url" className="block text-sm font-semibold">URL to investigate</label>
                  <input id="scan-url" type="url" inputMode="url" autoComplete="url" value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="https://example.com/path" maxLength={2048} required
                    className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-slate-600 dark:bg-[#0d192b] dark:text-white dark:placeholder:text-slate-500" />
                  <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-wait disabled:opacity-60">
                    <ScanSearch size={17} aria-hidden="true" /> {busy ? "Submitting…" : "Analyze URL"}
                  </button>
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">Do not open a suspicious link to test it. An unknown verdict is not a safety clearance.</p>
                </form>
              </section>
              <section id="investigation" aria-labelledby="investigation-heading" aria-live="polite" className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-[#142238]">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
                  <h2 id="investigation-heading" className="flex items-center gap-2 text-base font-bold"><FileSearch size={19} className="text-blue-600 dark:text-blue-300" aria-hidden="true" /> Investigation</h2>
                  {scanId && <button type="button" onClick={() => { setError(null); setRefreshKey((value) => value + 1); }}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-blue-300 dark:hover:bg-[#203752]">
                    <RefreshCw size={14} aria-hidden="true" /> Check again
                  </button>}
                </div>
                <div className="p-5">
                  {error && <div role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-[#3d2b18] dark:text-amber-100">
                    {error} {loginRequired && <a className="font-semibold underline" href="/auth/azure/start">Sign in with Microsoft</a>}
                  </div>}
                  {!scanId ? (
                    <div className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center dark:border-slate-600 dark:bg-[#0d192b]">
                      <ScanSearch size={30} className="text-slate-400" aria-hidden="true" />
                      <p className="text-sm font-semibold">Ready for your first investigation</p>
                      <p className="max-w-xs text-xs text-slate-500 dark:text-slate-400">Submit a URL to see its status, risk explanation and available evidence here.</p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Submitted URL</p>
                      <p className="mt-1 break-all text-sm font-medium">{scan?.scan.raw_input ?? input}</p>
                      {presentation ? (
                        <div className={`mt-4 rounded-lg border p-4 ${isDangerous ? "border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-[#3d202c]" : "border-blue-200 bg-blue-50 dark:border-[#35587c] dark:bg-[#152c45]"}`}>
                          <p className={`text-lg font-bold ${isDangerous ? "text-rose-800 dark:text-rose-200" : "text-slate-900 dark:text-white"}`}>{presentation.label}</p>
                          <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{presentation.description}</p>
                        </div>
                      ) : <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">Loading scan status…</p>}
                      {scan && scan.evidence.length > 0 && (
                        <div className="mt-5 space-y-3">
                          <h3 className="text-sm font-bold">Evidence ({scan.evidence.length})</h3>
                          {scan.evidence.map((item, index) => (
                            <div key={index} className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
                              <p className="font-semibold">{item.title}</p>
                              <p className="mt-1 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">{item.detail ?? "No additional details."}</p>
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="mt-5 break-all text-[11px] text-slate-500 dark:text-slate-400">Scan ID: {scanId}</p>
                    </div>
                  )}
                </div>
              </section>
            </div>
            <p className="mt-6 text-xs text-slate-500 dark:text-slate-400">This overview reflects the current investigation only. Organization-wide history and aggregate metrics are not yet connected.</p>
          </main>
        </div>
      </div>
    </div>
  );
}
