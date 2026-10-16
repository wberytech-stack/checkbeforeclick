# syntax=docker/dockerfile:1
# Gate 006B - CheckBeforeClick web image for Azure Container Apps (Phase 1: same app, Supabase + Inngest).
#
# Build (one image per environment, because NEXT_PUBLIC_* values are inlined at build time):
#   docker build \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=<public url> \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<public anon key> \
#     [--build-arg NEXT_PUBLIC_APP_URL=https://checkbeforeclick.com] \
#     -t cbc-web:<sha>-<env> .
#
# Only PUBLIC values are build args. Secrets (SUPABASE_SERVICE_ROLE_KEY, INNGEST_*,
# GOOGLE_WEB_RISK_API_KEY) are supplied at runtime by Container Apps from Key Vault
# references and never enter the image. `.env*` files are excluded by .dockerignore.

ARG NODE_IMAGE=node:24.14.0-bookworm-slim

# ---- deps: exact lockfile install, no lifecycle scripts ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# ---- build: next build -> .next/standalone ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL=""
ARG CBC_BUILD_SHA="unknown"
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
    || (echo "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY build args are required" >&2; exit 1)
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime: minimal, non-root ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ARG CBC_BUILD_SHA="unknown"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CBC_BUILD_SHA=${CBC_BUILD_SHA}
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
