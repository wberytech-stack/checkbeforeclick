// Gate 008A - transactions and transaction-local tenant context (pure: the pool is injected).
//
// AGENTS.md section 10: tenant context reaches the database ONLY through
//   set_config('app.current_user_id' | 'app.current_organization_id', <value>, true)
// on the same client, inside the same transaction, as the statements it authorizes. The `true` makes
// both settings transaction-local: COMMIT or ROLLBACK clears them, so a pooled connection never carries
// one request's tenant into the next.

export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}
export type PooledClient = Queryable & { release: (destroy?: boolean | Error) => void }
export type PoolLike = { connect: () => Promise<PooledClient> }

export type TenantContext = { userId: string; organizationId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TenantContextError"
  }
}

export function assertTenantContext(ctx: unknown): asserts ctx is TenantContext {
  const c = ctx as Partial<TenantContext> | null
  if (!c || typeof c.userId !== "string" || typeof c.organizationId !== "string" || !UUID.test(c.userId) || !UUID.test(c.organizationId)) {
    throw new TenantContextError("tenant context must be two lowercase UUIDs")
  }
}

// BEGIN ... COMMIT on one client. Any error rolls back. If the rollback itself fails, the connection is
// destroyed (never returned to the pool in an unknown transaction state) and the ORIGINAL error is rethrown.
export async function runTransaction<T>(pool: PoolLike, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let broken: Error | undefined
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try {
      await client.query("ROLLBACK")
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error("rollback failed")
    }
    throw error
  } finally {
    client.release(broken)
  }
}

// A transaction whose statements run as the given user in the given organization. The context is validated
// BEFORE the connection is used, and set on the same client as the callback's statements.
export async function runTenantTransaction<T>(
  pool: PoolLike,
  ctx: TenantContext,
  fn: (client: Queryable) => Promise<T>
): Promise<T> {
  assertTenantContext(ctx)
  return runTransaction(pool, async (client) => {
    await client.query(
      "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_organization_id', $2, true)",
      [ctx.userId, ctx.organizationId]
    )
    return fn(client)
  })
}
