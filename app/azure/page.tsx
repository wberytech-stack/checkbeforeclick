"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
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
  }, [scanId]);

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

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-900">
      <div className="mx-auto max-w-2xl space-y-7">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold tracking-wide text-slate-600">CHECKBEFORECLICK</p>
            <h1 className="text-3xl font-bold tracking-tight">Check a link before opening it</h1>
          </div>
          <div className="flex gap-3 text-sm">
            <a href="/auth/azure/start" className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-medium">Sign in</a>
            <form action="/auth/azure/logout" method="post">
              <button type="submit" className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-medium">Sign out</button>
            </form>
          </div>
        </header>
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <form onSubmit={submit} className="space-y-4">
            <label htmlFor="scan-url" className="block text-sm font-semibold">Suspicious URL</label>
            <input id="scan-url" type="url" inputMode="url" autoComplete="url"
              value={input} onChange={(event) => setInput(event.target.value)}
              placeholder="https://example.com/path" maxLength={2048} required
              className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-blue-600" />
            <button type="submit" disabled={busy}
              className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? "Submitting…" : "Check URL"}
            </button>
          </form>
          <p className="mt-4 text-xs text-slate-500">
            A reputation check is not a guarantee of safety. Do not open a suspicious link to test it.
          </p>
        </section>
        {error && (
          <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            {error} {loginRequired && <a className="underline" href="/auth/azure/start">Sign in with Microsoft</a>}
          </div>
        )}
        {scanId && (
          <section aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Scan result</h2>
            <p className="mt-2 break-all text-sm text-slate-600">{scan?.scan.raw_input ?? input}</p>
            {presentation ? (
              <>
                <p className="mt-4 text-xl font-semibold">{presentation.label}</p>
                <p className="mt-2 text-sm text-slate-700">{presentation.description}</p>
                {scan && scan.evidence.length > 0 && (
                  <div className="mt-5 space-y-3">
                    <h3 className="font-semibold">Evidence</h3>
                    {scan.evidence.map((item, index) => (
                      <div key={index} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <p className="font-medium">{item.title}</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-slate-600">{item.detail ?? "No additional details."}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : <p className="mt-3 text-sm text-slate-600">Loading scan status…</p>}
            <p className="mt-4 text-xs text-slate-500">Scan ID: {scanId}</p>
          </section>
        )}
      </div>
    </main>
  );
}
