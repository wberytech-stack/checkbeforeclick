// One bounded Azure Container Apps Job invocation. No daemon or HTTP listener.
// This executable is built with tsconfig.azure-worker.json; it never imports
// legacy Supabase or Inngest paths. No raw URLs, credentials or evidence in logs.
import { runAzureUrlWorkerOnce } from "../../src/server/workers/azureUrlWorkerEntry";

void runAzureUrlWorkerOnce().then(summary => {
  console.log(JSON.stringify({
    event: "azure_url_worker_batch",
    claimed: summary.claimed, completed: summary.completed,
    leaseLost: summary.leaseLost, failed: summary.failed,
  }));
  // Nonzero exit exposes failures to the scheduler/monitoring without
  // acknowledging leases. PostgreSQL redelivers after the lease expires.
  if (summary.failed > 0 || summary.leaseLost > 0) process.exitCode = 1;
}).catch(() => {
  console.error("Azure URL worker unavailable");
  process.exitCode = 1;
});
