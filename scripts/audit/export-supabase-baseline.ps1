<#
.SYNOPSIS
    Phase 0A - Reproducible Supabase production schema baseline export.

.DESCRIPTION
    Captures an authoritative, schema-only snapshot of the linked Supabase
    production database as the first controlled step of the approved Azure
    transition. This script is SAFE BY DEFAULT:

      - It performs strict preflight validation and refuses to continue if any
        check fails.
      - It NEVER exports table data (schema and roles only).
      - It NEVER commits, pushes, or mutates git history.
      - It NEVER prints secrets or connection strings.
      - It does NOT change production. A schema dump is a read-only operation
        against the database; this script issues no DDL/DML against production.

    The actual export only runs when the operator intentionally passes
    -RunExport. Without that switch the script validates the environment and
    stops, so it can be reviewed and dry-run before any export occurs.

.PARAMETER RunExport
    When supplied, performs the schema + roles export after all preflight
    checks pass. When omitted (default), the script validates only and stops.

.PARAMETER ExpectedProjectRef
    The Supabase project reference the linked project MUST match. Defaults to
    the known production reference. The script refuses to run against any other
    linked project, preventing an accidental dump of the wrong database.

.NOTES
    Phase 0A constraints: no staging, no production changes, no Docker install,
    no branch creation, no commit/push. This file only authors the workflow;
    running it later is a deliberate, separate operator action.
#>

[CmdletBinding()]
param(
    [switch]$RunExport,
    [string]$ExpectedProjectRef = "qnjqwmcsfpmpnvlnomat"
)

# Fail fast and loudly. Treat unexpected errors as terminating.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Constants -------------------------------------------------------------
$RequiredBranch = "audit/azure-current-state"
$ExportDir      = Join-Path "audit" (Join-Path "database" "export")
# Generated artifact paths are built ONCE inside the export block using a single
# shared UTC timestamp (see Correction: timestamped, collision-safe filenames).

# --- Small helpers ---------------------------------------------------------
function Write-Step  { param([string]$Message) Write-Host "[ .. ] $Message" }
function Write-Ok    { param([string]$Message) Write-Host "[ OK ] $Message" -ForegroundColor Green }
function Fail {
    param([string]$Message)
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    Write-Host "Validation failed. No export was performed and nothing was changed." -ForegroundColor Red
    exit 1
}

Write-Host "=== Phase 0A - Supabase schema baseline (preflight) ===" -ForegroundColor Cyan

# --- 1. Must run from repository root --------------------------------------
# Repository root is where the .git directory lives. Refuse otherwise so the
# relative export paths and git checks are meaningful.
Write-Step "Verifying repository-root execution"
if (-not (Test-Path ".git" -PathType Container)) {
    Fail "This script must be run from the repository root (no .git directory found here)."
}
Write-Ok "Running from repository root"

# --- 2. Must be on the audit branch ----------------------------------------
Write-Step "Verifying current git branch is '$RequiredBranch'"
try {
    $currentBranch = (& git rev-parse --abbrev-ref HEAD 2>$null).Trim()
} catch {
    Fail "Unable to determine the current git branch. Is git installed and is this a git repo?"
}
if ($currentBranch -ne $RequiredBranch) {
    Fail "Current branch is '$currentBranch'. This task requires branch '$RequiredBranch'. Switch branches before running."
}
Write-Ok "On required branch '$RequiredBranch'"

# --- 3. Reject tracked working-tree modifications --------------------------
# A dirty tree means the export would be taken against an ambiguous state.
# Untracked files are allowed (the export dir itself may be untracked); only
# modifications to TRACKED files block execution.
Write-Step "Checking for tracked working-tree modifications"
$trackedChanges = & git status --porcelain --untracked-files=no
if ($null -ne $trackedChanges -and ($trackedChanges | Where-Object { $_ -ne "" }).Count -gt 0) {
    Write-Host "Tracked changes detected:" -ForegroundColor Red
    $trackedChanges | ForEach-Object { Write-Host "    $_" }
    Fail "Working tree has tracked modifications. Commit or stash them first (this script will not)."
}
Write-Ok "No tracked working-tree modifications"

# --- 4. Verify Docker exists and is running --------------------------------
# The Supabase CLI uses a local container to perform the dump. We verify it is
# present and the daemon responds. We do NOT install Docker.
Write-Step "Verifying Docker is installed and running"
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($null -eq $dockerCmd) {
    Fail "Docker is not installed or not on PATH. Install/start Docker Desktop, then retry. (This script will not install it.)"
}
try {
    # 'docker info' fails non-zero if the daemon is not running.
    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Fail "Docker is installed but the daemon is not running. Start Docker Desktop and retry."
    }
} catch {
    Fail "Docker is installed but did not respond. Start Docker Desktop and retry."
}
Write-Ok "Docker is installed and running"

# --- 5. Verify 'npx supabase' works ----------------------------------------
# Use the project-local CLI via npx (NOT a global install) for reproducibility.
Write-Step "Verifying 'npx supabase' is available"
try {
    $supabaseVersion = (& npx --yes supabase --version 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($supabaseVersion)) {
        Fail "'npx supabase --version' did not succeed. Ensure Node/npx are installed and network access is available."
    }
} catch {
    Fail "Unable to run 'npx supabase'. Ensure Node.js and npx are installed."
}
Write-Ok "npx supabase available (version: $supabaseVersion)"

# --- 6. Verify the linked project reference EXACTLY ------------------------
# Authoritative source of truth: the Supabase CLI writes the linked project
# reference to 'supabase/.temp/project-ref' when 'supabase link' succeeds.
# We compare that file's contents EXACTLY to the expected reference. This is
# ground truth, not an inference from the formatting of 'projects list' output.
#
# Project references are identifiers, not secrets, so printing expected/actual
# for diagnosis is acceptable. We still never print keys or connection strings.
$ProjectRefFile = Join-Path "supabase" (Join-Path ".temp" "project-ref")
Write-Step "Verifying linked project reference via '$ProjectRefFile' equals '$ExpectedProjectRef'"

if (-not (Test-Path $ProjectRefFile -PathType Leaf)) {
    Fail "Linked-project file '$ProjectRefFile' is missing. Run 'npx supabase link --project-ref $ExpectedProjectRef' first. Refusing to continue."
}

try {
    $actualRef = (Get-Content -LiteralPath $ProjectRefFile -Raw -ErrorAction Stop).Trim()
} catch {
    Fail "Unable to read linked-project file '$ProjectRefFile': $($_.Exception.Message). Refusing to continue."
}

if ([string]::IsNullOrWhiteSpace($actualRef)) {
    Fail "Linked-project file '$ProjectRefFile' is empty. Re-link with 'npx supabase link --project-ref $ExpectedProjectRef'. Refusing to continue."
}

if ($actualRef -cne $ExpectedProjectRef) {
    # -cne = case-sensitive inequality; refs are case-sensitive identifiers.
    Fail "Linked project reference mismatch. Expected '$ExpectedProjectRef' but found '$actualRef'. Refusing to continue."
}
Write-Ok "Linked project reference confirmed (exact match): $ExpectedProjectRef"

# Optional, NON-AUTHORITATIVE diagnostic only. Failure here does not block:
# the authoritative check above already passed. We never rely on this output
# to decide the linked project.
try {
    $projectsRaw = & npx --yes supabase projects list 2>$null | Out-String
    if (-not [string]::IsNullOrWhiteSpace($projectsRaw)) {
        Write-Host "       (diagnostic) 'supabase projects list' returned project rows for reference." -ForegroundColor DarkGray
    }
} catch {
    Write-Host "       (diagnostic) 'supabase projects list' unavailable; non-blocking." -ForegroundColor DarkGray
}

Write-Host ""
Write-Ok "All preflight validations passed."

# --- 7. Export (only when intentionally requested) -------------------------
if (-not $RunExport) {
    Write-Host ""
    Write-Host "Preflight complete. No export was performed." -ForegroundColor Yellow
    Write-Host "To perform the schema + roles export later, re-run with -RunExport." -ForegroundColor Yellow
    Write-Host "No production systems or data were changed." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "=== Performing schema-only baseline export ===" -ForegroundColor Cyan

# --- 6b. Dump-flag preflight (BEFORE any dump command) ---------------------
# The Supabase CLI's flags vary across versions. Before creating directories or
# running any dump, confirm 'supabase db dump' supports every flag the export
# workflow relies on. Refuse to continue if the help command fails or any
# required flag is absent. This runs no database dump.
Write-Step "Preflight: verifying 'supabase db dump' supports required flags"
$RequiredDumpFlags = @("--linked", "--file", "--role-only")
try {
    $dumpHelp = & npx --yes supabase db dump --help 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dumpHelp)) {
        Fail "'supabase db dump --help' did not succeed. Cannot verify dump flags. Refusing to continue."
    }
} catch {
    Fail "Unable to run 'supabase db dump --help': $($_.Exception.Message). Refusing to continue."
}
$missingFlags = @()
foreach ($flag in $RequiredDumpFlags) {
    if ($dumpHelp -notmatch [Regex]::Escape($flag)) { $missingFlags += $flag }
}
if ($missingFlags.Count -gt 0) {
    Fail "Installed Supabase CLI is missing required dump flag(s): $($missingFlags -join ', '). Refusing to continue."
}
Write-Ok "Dump flags supported: $($RequiredDumpFlags -join ', ')"

# Ensure the export directory exists.
Write-Step "Ensuring export directory exists: $ExportDir"
New-Item -ItemType Directory -Force -Path $ExportDir | Out-Null
Write-Ok "Export directory ready"

# --- Timestamped, collision-safe artifact filenames ------------------------
# Generate ONE shared UTC timestamp per run and reuse it for all three
# artifacts, so they are grouped and sortable. Never silently overwrite an
# existing export: if any target already exists, append a short uniqueness
# suffix so a prior baseline is preserved.
$RunTimestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$baseName     = $RunTimestamp
$SchemaFile   = Join-Path $ExportDir "$baseName-schema.sql"
$RolesFile    = Join-Path $ExportDir "$baseName-roles.sql"
$SummaryFile  = Join-Path $ExportDir "$baseName-structural-summary.txt"

if ((Test-Path $SchemaFile) -or (Test-Path $RolesFile) -or (Test-Path $SummaryFile)) {
    # Collision (same-second re-run): derive a unique suffix rather than
    # overwrite. We do not destroy an existing baseline.
    $suffix = 1
    do {
        $candidateBase = "$RunTimestamp-$suffix"
        $SchemaFile  = Join-Path $ExportDir "$candidateBase-schema.sql"
        $RolesFile   = Join-Path $ExportDir "$candidateBase-roles.sql"
        $SummaryFile = Join-Path $ExportDir "$candidateBase-structural-summary.txt"
        $suffix++
    } while (((Test-Path $SchemaFile) -or (Test-Path $RolesFile) -or (Test-Path $SummaryFile)) -and $suffix -lt 1000)

    if ((Test-Path $SchemaFile) -or (Test-Path $RolesFile) -or (Test-Path $SummaryFile)) {
        Fail "Could not derive a collision-free export filename after many attempts. Refusing to overwrite an existing baseline."
    }
    Write-Ok "Existing export detected; using collision-safe names with base '$candidateBase'"
} else {
    Write-Ok "Using timestamped export base '$baseName'"
}

# 7a. Schema only - NEVER data. The dump is read-only against production.
Write-Step "Exporting schema (structure only, no table data)"
try {
    & npx --yes supabase db dump --linked --file $SchemaFile
    if ($LASTEXITCODE -ne 0) { Fail "Schema dump returned a non-zero exit code. Export aborted." }
} catch {
    Fail "Schema dump failed: $($_.Exception.Message)"
}
if (-not (Test-Path $SchemaFile)) { Fail "Schema dump completed but '$SchemaFile' was not created." }
Write-Ok "Schema exported to $SchemaFile"

# 7b. Roles / grants only.
# IMPORTANT: roles.sql is a PRIVATE audit artifact. It may contain sensitive
# role-related definitions (role attributes, memberships, grants). It MUST NOT
# be committed until it has been manually reviewed and sanitized. The output
# directory is git-ignored to protect it; do not weaken that protection.
Write-Step "Exporting roles and grants"
try {
    & npx --yes supabase db dump --linked --role-only --file $RolesFile
    if ($LASTEXITCODE -ne 0) { Fail "Roles dump returned a non-zero exit code. Export aborted." }
} catch {
    Fail "Roles dump failed: $($_.Exception.Message)"
}
if (-not (Test-Path $RolesFile)) { Fail "Roles dump completed but '$RolesFile' was not created." }
Write-Ok "Roles exported to $RolesFile"

# --- 8. Structural summary -------------------------------------------------
# The summary lists the ACTUAL declaration lines for each schema-review
# category (not just counts), so a reviewer can see what exists.
#
# SAFETY: we extract ONLY the single declaration line for each object
# (the line bearing the CREATE/ENABLE keyword). We deliberately do NOT include
# statement bodies, column data, function source, role passwords, connection
# strings, or any unrelated SQL. Declaration lines are the safe, reviewable
# unit: they reveal object names/targets without exposing sensitive content.
Write-Step "Generating structural summary"
$schemaLines = Get-Content $SchemaFile

# Each category: a label and a line-matching regex (anchored to the statement).
$categories = [ordered]@{
    "Tables"                      = '^\s*CREATE\s+TABLE\b'
    "Policies"                    = '^\s*CREATE\s+POLICY\b'
    "Functions"                   = '^\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b'
    "Triggers"                    = '^\s*CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b'
    "RLS enablement statements"   = '^\s*ALTER\s+TABLE\b.*ENABLE\s+ROW\s+LEVEL\s+SECURITY'
}

$summaryLines = @()
$summaryLines += "Phase 0A - Structural summary of schema baseline"
$summaryLines += ("=" * 56)
$summaryLines += ("Generated (UTC)     : {0}" -f $RunTimestamp)
$summaryLines += ("Linked project ref  : {0}" -f $ExpectedProjectRef)
$summaryLines += ("Source schema file  : {0}" -f (Split-Path $SchemaFile -Leaf))
$summaryLines += ""
$summaryLines += "Scope note: declaration lines only. No table data, no statement"
$summaryLines += "bodies, no secrets, no connection strings, no role passwords."
$summaryLines += ""

foreach ($label in $categories.Keys) {
    $pattern = $categories[$label]
    # Match against the dump's actual lines; trim trailing whitespace for tidiness.
    $matched = @($schemaLines | Where-Object { $_ -match $pattern } | ForEach-Object { $_.TrimEnd() })
    $summaryLines += ("--- {0} (count: {1}) ---" -f $label, $matched.Count)
    if ($matched.Count -eq 0) {
        $summaryLines += "  (none found)"
    } else {
        foreach ($line in $matched) { $summaryLines += ("  " + $line) }
    }
    $summaryLines += ""
}

$summaryLines += "NOTE: Zero Policies or zero RLS enablement statements on a"
$summaryLines += "multi-tenant database is a RED FLAG. Review before trusting this baseline."
$summaryLines | Set-Content -Path $SummaryFile -Encoding utf8
Write-Ok "Structural summary written to $SummaryFile"

# --- 9. Report generated paths + SHA-256 hashes ----------------------------
# Hashes make the baseline attributable and tamper-evident.
Write-Host ""
Write-Host "=== Generated artifacts ===" -ForegroundColor Cyan
foreach ($f in @($SchemaFile, $RolesFile, $SummaryFile)) {
    if (Test-Path $f) {
        $hash = (Get-FileHash -Path $f -Algorithm SHA256).Hash
        Write-Host ("  {0}" -f (Resolve-Path $f).Path)
        Write-Host ("    SHA-256: {0}" -f $hash)
    }
}

Write-Host ""
Write-Host "Structural summary:" -ForegroundColor Cyan
Get-Content $SummaryFile | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Ok "Baseline export complete."
Write-Host "This script did NOT commit, push, or change any production system or data." -ForegroundColor Yellow
Write-Host "Review the generated files, then commit them deliberately as a separate step." -ForegroundColor Yellow
Write-Host ""
Write-Host "WARNING: '$RolesFile' is a PRIVATE audit artifact." -ForegroundColor Red
Write-Host "         It may contain sensitive role-related definitions." -ForegroundColor Red
Write-Host "         Do NOT commit it until it has been manually reviewed and sanitized." -ForegroundColor Red
Write-Host "         The output directory is git-ignored to protect it; keep that protection." -ForegroundColor Red
