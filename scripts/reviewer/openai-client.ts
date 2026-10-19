/**
 * Gate 005G - OpenAI Responses API ReviewerClient (Node built-in fetch, no SDK).
 *
 * NOT EXERCISED in Gate 005G: tests use a fixture client and no live call is made.
 * The request/response shape follows the public Responses API (structured JSON
 * output via text.format json_schema); it must be confirmed in the founder-run
 * live smoke gate (005H) before relying on it.
 *
 * The credential is read from CBC_REVIEWER_API_KEY only inside review(), only in
 * the GitHub Actions reviewer job (AGENTS.md section 11 as amended by 005F). It is
 * never logged, returned, stored, or included in errors.
 */
import type { ReviewerClient, ReviewerInput, ReviewerResponse } from "./adapter.ts";

export function openAiReviewerClient(opts: { endpoint?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): ReviewerClient {
  const endpoint = opts.endpoint ?? "https://api.openai.com/v1/responses";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async review(input: ReviewerInput): Promise<ReviewerResponse> {
      const key = process.env.CBC_REVIEWER_API_KEY;
      if (!key) throw new Error("reviewer credential not available in this job");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          signal: ctl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: input.model,
            store: false,
            max_output_tokens: input.max_output_tokens,
            input: [
              { role: "system", content: input.system },
              { role: "user", content: input.user },
            ],
            text: { format: { type: "json_schema", name: "cbc_review", strict: true, schema: input.output_schema } },
          }),
        });
      } catch {
        throw new Error("reviewer request failed or timed out");
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`reviewer HTTP ${res.status}`);
      const body = (await res.json()) as {
        id?: string; status?: string;
        output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      let raw = "";
      let refusal: string | undefined;
      for (const item of body.output ?? []) {
        if (item.type !== "message") continue;
        for (const c of item.content ?? []) {
          if (c.type === "output_text" && typeof c.text === "string") raw += c.text;
          if (c.type === "refusal") refusal = c.refusal ?? "refused";
        }
      }
      const u = body.usage;
      return {
        raw,
        complete: body.status === "completed",
        refusal,
        response_id: typeof body.id === "string" ? body.id : undefined,
        usage: u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
          ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens } : undefined,
      };
    },
  };
}
