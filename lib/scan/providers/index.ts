import "server-only"
import type { ScanProvider, ProviderInputType } from "./types"
import { googleWebRiskProvider } from "./googleWebRisk"
import { domainAgeProvider } from "./domainAge"

// Provider registry — ordered list of all scan providers
// Add new providers here. Set enabled: false to disable without code changes.
// Fast path providers run synchronously in /api/scan
// Async path providers run in Inngest worker

const allProviders: ScanProvider[] = [
  googleWebRiskProvider,
  domainAgeProvider,
]

// Returns all enabled providers for a given path and input type
export function getProviders(
  path: "fast" | "async",
  inputType: ProviderInputType
): ScanProvider[] {
  return allProviders.filter(
    (p) =>
      p.enabled &&
      p.path === path &&
      p.supportedInputTypes.includes(inputType)
  )
}

// Returns all enabled fast-path providers for a given input type
export function getFastProviders(inputType: ProviderInputType): ScanProvider[] {
  return getProviders("fast", inputType)
}

// Returns all enabled async-path providers for a given input type
export function getAsyncProviders(inputType: ProviderInputType): ScanProvider[] {
  return getProviders("async", inputType)
}
