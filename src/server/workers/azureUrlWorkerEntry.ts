// Azure Container Apps Job entrypoint: the platform scheduler invokes this
// function explicitly. Importing the module performs no network or DB I/O.
// It uses a separate cbc_worker managed identity and PostgreSQL role.
import { runAzureWorkerJob } from "./azureWorkerPg";
import { createUrlReputationProcessor } from "./azureUrlProcessor";
import { createWebRiskLookup } from "./azureWebRiskLookup";

export async function runAzureUrlWorkerOnce() {
  const key = process.env.CBC_WEB_RISK_API_KEY;
  if (!key) throw new Error("Azure URL worker unavailable");
  const lookup = createWebRiskLookup({ apiKey: key });
  return runAzureWorkerJob(createUrlReputationProcessor(lookup));
}
