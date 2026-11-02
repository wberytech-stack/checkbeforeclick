#!/usr/bin/env bash
# Gate 008A - disposable PostgreSQL 16 validation of migrations 001-008 and the Azure data-plane code.
#
# Creates a throwaway cluster in a temporary directory, listening ONLY on 127.0.0.1 (no Unix socket outside
# the temp directory), with random one-time passwords. Applies the migrations as the cluster owner, creates
# the least-privileged runtime role cbc_app, runs scripts/azure-data/validate-data-plane-db.ts as cbc_app,
# then stops the cluster and deletes the directory (also on failure). Touches no other database.
#
# Usage:  scripts/azure-data/run-disposable-db.sh
# Env:    PG_BIN (default /usr/lib/postgresql/16/bin), CBC_TEST_PG_PORT (default 55433),
#         CBC_TEST_PG_OS_USER (default postgres; initdb refuses to run as root)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${CBC_TEST_PG_PORT:-55433}"
OS_USER="${CBC_TEST_PG_OS_USER:-postgres}"
ISSUER="https://cbc-test.ciamlogin.example/00000000-0000-4000-8000-000000000001/v2.0"

if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "port $PORT is in use; set CBC_TEST_PG_PORT" >&2; exit 2; fi

WORK="$(mktemp -d)"
chmod 700 "$WORK"
cleanup() {
  as_pg "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
  unset CBC_DATABASE_URL CBC_DATABASE_SSL CBC_TEST_OWNER_URL CBC_TEST_WORKER_URL CBC_TEST_ISSUER PGPASSWORD
}
trap cleanup EXIT

as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u "$OS_USER" -- "$@"; else "$@"; fi; }
if [ "$(id -u)" = 0 ]; then chown "$OS_USER" "$WORK"; fi

OWNER_PW="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
APP_PW="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
WORKER_PW="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n' "$OWNER_PW" > "$WORK/pw"; chmod 600 "$WORK/pw"
if [ "$(id -u)" = 0 ]; then chown "$OS_USER" "$WORK/pw"; fi

as_pg "$PG_BIN/initdb" -D "$WORK/data" -U cbc_owner --pwfile="$WORK/pw" --auth=scram-sha-256 -E UTF8 >/dev/null
rm -f "$WORK/pw"
as_pg "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/log" -w \
  -o "-c listen_addresses=127.0.0.1 -c port=$PORT -c unix_socket_directories=$WORK" start >/dev/null

export PGPASSWORD="$OWNER_PW"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U cbc_owner)
"${PSQL[@]}" -d postgres -c "CREATE DATABASE cbc_test"
# Runtime role BEFORE 002, so 002's conditional grants apply (as on a real server).
"${PSQL[@]}" -d cbc_test -c "CREATE ROLE cbc_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '$APP_PW'" \
  -c "REVOKE ALL ON DATABASE cbc_test FROM PUBLIC" -c "GRANT CONNECT ON DATABASE cbc_test TO cbc_app" \
  -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC" \
  -c "CREATE ROLE cbc_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '$WORKER_PW'" \
  -c "GRANT CONNECT ON DATABASE cbc_test TO cbc_worker"
for m in "$ROOT"/infra/db/migrations/00[1-8]_*.sql; do
  echo "apply $(basename "$m")"
  PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d cbc_test -f "$m"
done
"${PSQL[@]}" -d cbc_test -c "INSERT INTO public.trusted_identity_issuers (issuer, description) VALUES ('$ISSUER', 'disposable test issuer')"

export CBC_DATABASE_URL="postgres://cbc_app:$APP_PW@127.0.0.1:$PORT/cbc_test"
export CBC_DATABASE_SSL=false
export CBC_TEST_OWNER_URL="postgres://cbc_owner:$OWNER_PW@127.0.0.1:$PORT/cbc_test"
export CBC_TEST_WORKER_URL="postgres://cbc_worker:$WORKER_PW@127.0.0.1:$PORT/cbc_test"
export CBC_TEST_ISSUER="$ISSUER"
unset PGPASSWORD
cd "$ROOT"
node --conditions=react-server --experimental-transform-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning scripts/azure-data/validate-data-plane-db.ts

# Separate, short-lived runtime-role tests for the OIDC one-time replay ledger.
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-data/validate-oidc-state-db.ts

# Session security: durable identity binding, expiry, revocation, and atomic rotation.
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-data/validate-auth-sessions-db.ts

# Worker-only transactional outbox, concurrent claims and lease replay protection.
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-data/validate-scan-outbox-db.ts
