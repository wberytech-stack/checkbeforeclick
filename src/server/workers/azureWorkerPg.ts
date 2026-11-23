// Azure Container Apps Job / Functions host integration. Importing this module
// never opens a connection or starts work. The scheduler calls runAzureWorkerJob.
// Do NOT reuse the web pool, app identity or a schema-owner connection.
import { Pool } from "pg";
import { parseDatabaseConfig } from "../db/config";
import { createManagedIdentityTokenProvider } from "../db/entraToken";
import { runAzureScanWorkerBatch, type ScanProcessor, type WorkerSummary } from "./azureScanWorker";
import { runAzureWorkerRuntime, WorkerRuntimeError, type WorkerPoolSettings } from "./azureWorkerRuntime";

export async function runAzureWorkerJob(
  processScan: ScanProcessor,
  onEvent?: (event: "completed" | "lease_lost" | "timeout" | "provider_error" | "storage_error") => void,
): Promise<WorkerSummary> {
  const env = process.env;
  // Dedicated settings are mandatory. No implicit fallback to CBC_DATABASE_URL,
  // AZURE_CLIENT_ID or password authentication used by the web app.
  if (!env.CBC_WORKER_DATABASE_URL || !env.CBC_WORKER_AZURE_CLIENT_ID) throw new WorkerRuntimeError();
  try {
    const config = parseDatabaseConfig({
      CBC_DATABASE_URL: env.CBC_WORKER_DATABASE_URL,
      CBC_DATABASE_AUTH: "entra",
      CBC_DATABASE_SSL: env.CBC_WORKER_DATABASE_SSL,
    });
    const tokenProvider = createManagedIdentityTokenProvider({
      env: { ...env, AZURE_CLIENT_ID: env.CBC_WORKER_AZURE_CLIENT_ID },
      fetch: (url, init) => fetch(url, init), now: () => Date.now(),
    });
    return await runAzureWorkerRuntime({
      config, identityClientId: env.CBC_WORKER_AZURE_CLIENT_ID,
      webIdentityClientId: env.AZURE_CLIENT_ID,
      tokenProvider,
      createPool: (settings: WorkerPoolSettings) => new Pool(settings),
      process: processScan, runBatch: runAzureScanWorkerBatch, onEvent,
    });
  } catch {
    throw new WorkerRuntimeError();
  }
}
