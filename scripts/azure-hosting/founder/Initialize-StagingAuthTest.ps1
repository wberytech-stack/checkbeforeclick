<#
.SYNOPSIS
  Gate 006C - founder-run, idempotent bootstrap of the staging-auth-test GitHub
  environment and its two dedicated STAGING test accounts.

.DESCRIPTION
  Creates (or confirms) two email-confirmed staging-only users through the public
  Supabase Auth signup endpoint of project zgxmvpbvvakpsnzcymsf with the staging public
  key. It uses no Admin API, no service-role key (AGENTS.md section 12) and no direct
  database writes. It then checks each account's profile and organization, creates the
  environment with you as required reviewer and master-only deployments, and stores the
  four credentials as encrypted environment secrets and both organization ids as
  environment variables. Finally it verifies the configuration. It never dispatches a
  workflow, never prints or writes a password, key or token, and is safe to rerun: stored
  accounts are not recreated.

  Requires: `gh auth login` as wberytech-stack. No Supabase login is needed.

.PARAMETER EmailBase
  An address you control, e.g. you@yourdomain.com. The accounts become
  you+cbc-stg-test-a-g1@yourdomain.com and you+cbc-stg-test-b-g1@yourdomain.com.
.PARAMETER Generation
  Increase to create a fresh pair if an earlier pair was orphaned (delete the old users
  in the Supabase dashboard).
.PARAMETER OrgIdA
  Only if RLS hides the accounts' own users rows: organization_id from the read-only SQL
  in the gate document (step 3.2). Same for OrgIdB.

.EXAMPLE
  .\Initialize-StagingAuthTest.ps1 -EmailBase you@yourdomain.com
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EmailBase,
  [int]$Generation = 1,
  [string]$OrgIdA = '',
  [string]$OrgIdB = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'staging-auth-bootstrap.lib.ps1')

try {
  $report = Invoke-StagingAuthBootstrap -EmailBase $EmailBase -Generation $Generation -OrgIdA $OrgIdA -OrgIdB $OrgIdB
  Write-Host ''
  Write-Host "Created this run: $(if ($report.Created.Count) { $report.Created -join '; ' } else { 'nothing (already bootstrapped)' })"
  Write-Host "Organization evidence: $($report.OrgEvidence)"
  Write-Host 'RESULT: PASS. No workflow was dispatched. The next step (one staging-auth-journeys run) needs your separate approval.'
  exit 0
} catch {
  Write-Host ''
  Write-Host "STOP  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Anything created before this point is listed above as "created:"; rerunning is safe.' -ForegroundColor Red
  exit 1
}
