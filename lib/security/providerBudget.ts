// Gate 007A - execution-time budget for PAID provider calls (Codex cycle 3 P2 fix).
// Pure module: no imports, no env vars, no I/O. The reservation call and the provider call are injected, so the
// one-reservation-to-at-most-one-request contract is testable offline (scripts/rate-limit/test-provider-budget.ts).
//
// Contract of guardedPaidCall:
//   1. reserve(provider, admissionId) is called exactly once (public.cbc_reserve_provider_call, made with the
//      signed-in user's own session; one reservation per admission, 1000 per rolling 24 hours).
//   2. Anything other than an unambiguous grant (refusal, error, unexpected shape, thrown call) => the paid call is
//      NOT made and the caller gets a 503 decision (fail closed: never a "safe" verdict from an incomplete check).
//   3. On a grant, call() is invoked exactly once. There is no retry anywhere in this path.
//   4. Deadline (review CBC-007A-R1-01): when the caller's AbortSignal is aborted
//      - before the reservation: no reservation and no call;
//      - while the reservation is in flight: the signal is passed to reserve(), which cancels the HTTP request where
//        supported; a grant that still arrives late is NOT used (the unit is consumed, the request is never made);
//      - after a grant: call() is not invoked;
//      - during the call: the signal is passed to call(), which aborts the provider request.
//      Every aborted case is a "deadline_exceeded" 503 decision, so it can never become a verdict.

export const WEB_RISK_PROVIDER = "google_web_risk"
export const PROVIDER_BUDGET_24H = 1000   // informational mirror; the SQL function enforces it

export type ReservationDecision =
  | { granted: true; reservationId: string }
  | { granted: false; status: 503; reason: string; retryAfterSeconds: number }

export type GuardedOutcome<T> =
  | { called: true; result: T; reservationId: string }
  | { called: false; decision: { granted: false; status: 503; reason: string; retryAfterSeconds: number } }

const UNAVAILABLE = { granted: false as const, status: 503 as const, reason: "provider_budget_unavailable", retryAfterSeconds: 60 }

export function interpretReservation(data: unknown, error: unknown): ReservationDecision {
  if (error) return UNAVAILABLE
  const row = (Array.isArray(data) ? data[0] : data) as
    | { granted?: unknown; reason?: unknown; retry_after_seconds?: unknown; reservation_id?: unknown }
    | null
    | undefined
  if (!row || typeof row !== "object" || typeof row.granted !== "boolean" || typeof row.reason !== "string") return UNAVAILABLE
  if (row.granted === true) {
    const id = row.reservation_id
    if (row.reason !== "granted" || (typeof id !== "number" && typeof id !== "string") || String(id).length === 0) return UNAVAILABLE
    return { granted: true, reservationId: String(id) }
  }
  if (row.reason === "provider_budget_exhausted") {
    const r = Number(row.retry_after_seconds)
    return { granted: false, status: 503, reason: "provider_budget_exhausted", retryAfterSeconds: Number.isFinite(r) && r > 0 ? Math.ceil(r) : 60 }
  }
  // unauthenticated, unknown_provider, admission_not_valid, already_reserved or anything unknown
  return UNAVAILABLE
}

export const DEADLINE_EXCEEDED = { granted: false as const, status: 503 as const, reason: "deadline_exceeded", retryAfterSeconds: 60 }

export async function guardedPaidCall<T>(args: {
  provider: string
  admissionId: string | undefined
  reserve: (provider: string, admissionId: string, signal?: AbortSignal) => Promise<{ data: unknown; error: unknown }>
  call: (signal?: AbortSignal) => Promise<T>
  signal?: AbortSignal
}): Promise<GuardedOutcome<T>> {
  if (typeof args.admissionId !== "string" || !/^[0-9]{1,19}$/.test(args.admissionId)) {
    return { called: false, decision: UNAVAILABLE }
  }
  if (args.signal?.aborted) return { called: false, decision: DEADLINE_EXCEEDED }
  let reservation: ReservationDecision
  try {
    const r = await args.reserve(args.provider, args.admissionId, args.signal)
    reservation = interpretReservation(r.data, r.error)
  } catch {
    reservation = UNAVAILABLE
  }
  // Checked AFTER the reservation settles: a grant that arrives after the deadline never starts a request.
  if (args.signal?.aborted) return { called: false, decision: DEADLINE_EXCEEDED }
  if (!reservation.granted) return { called: false, decision: reservation }
  const result = await args.call(args.signal)
  return { called: true, result, reservationId: reservation.reservationId }
}
