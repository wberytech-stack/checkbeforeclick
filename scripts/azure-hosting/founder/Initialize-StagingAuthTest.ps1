<#
.SYNOPSIS
  Gate 006C - founder-run bootstrap of the staging-auth-test GitHub environment and its
  two dedicated STAGING test accounts.

.DESCRIPTION
  Creates two email-confirmed staging-only users through the public Supabase Auth signup
  endpoint of project zgxmvpbvvakpsnzcymsf with the staging public key. It uses no Admin
  API, no service-role key (AGENTS.md section 12) and no direct database writes. It then
  checks each account's profile and organization, creates the environment with you as
  required reviewer and master-only deployments, and stores the four credentials as
  encrypted environment secrets and both organization ids as environment variables.
  Finally it verifies the configuration. It never dispatches a workflow, never prints or
  writes a password, key or token.

  Stored credentials cannot be re-verified here (secret values are never read back), so a
  rerun with stored accounts stops unless you choose -Replace or -AttestExisting.

  Outcome and exit code:
    0  VERIFIED  this run created and verified both accounts and observed both organizations
    2  ATTESTED  configuration complete, but part of it rests on your attestation
                 (-AttestExisting or -OrgIdA/-OrgIdB); the first staging-auth-journeys run
                 (J1-J4) is what verifies it
    3  PARTIAL   a user was created but only one of its two secrets is stored; founder
                 recovery required (the message says how). Never a success.
    1  STOP      a precondition failed; anything created is listed

  Requires: `gh auth login` as wberytech-stack. No Supabase login is needed.

.PARAMETER EmailBase
  An address you control, e.g. you@yourdomain.com. The accounts become
  you+cbc-stg-test-a-g1@yourdomain.com and you+cbc-stg-test-b-g1@yourdomain.com.
.PARAMETER Generation
  Part of the account addresses; increase it for a fresh pair (with -Replace).
.PARAMETER OrgIdA
  organization_id from the read-only SQL in the gate document (step 3.2), when RLS hides
  the accounts' own users rows or with -AttestExisting. Same for OrgIdB.
.PARAMETER Replace
  Create and verify a fresh pair (use a new -Generation) and overwrite stored secrets,
  including an incomplete pair. Then delete the earlier users in Supabase.
.PARAMETER AttestExisting
  Keep stored credentials on your attestation (requires -OrgIdA/-OrgIdB). Outcome ATTESTED.

.EXAMPLE
  .\Initialize-StagingAuthTest.ps1 -EmailBase you@yourdomain.com
.EXAMPLE
  .\Initialize-StagingAuthTest.ps1 -EmailBase you@yourdomain.com -Replace -Generation 2
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EmailBase,
  [int]$Generation = 1,
  [string]$OrgIdA = '',
  [string]$OrgIdB = '',
  [switch]$Replace,
  [switch]$AttestExisting
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'staging-auth-bootstrap.lib.ps1')

function Write-Created {
  $c = if ($script:LastReport) { @($script:LastReport.Created) } else { @() }
  Write-Host "Created this run: $(if ($c.Count) { $c -join '; ' } else { 'nothing' })"
}

try {
  $report = Invoke-StagingAuthBootstrap -EmailBase $EmailBase -Generation $Generation -OrgIdA $OrgIdA -OrgIdB $OrgIdB -Replace:$Replace -AttestExisting:$AttestExisting
  Write-Host ''
  Write-Created
  Write-Host "Accounts: A $($report.Accounts.A), B $($report.Accounts.B). Organization evidence: $($report.OrgEvidence)"
  foreach ($n in $report.Notes) { Write-Host "Note: $n" }
  if ($report.Outcome -eq 'VERIFIED') {
    Write-Host 'RESULT: PASS (VERIFIED). No workflow was dispatched. The first staging-auth-journeys run needs your separate approval.'
    exit 0
  }
  Write-Host 'RESULT: ATTESTED. Configuration is complete, but part of it rests on your attestation, not on this run. The first staging-auth-journeys run (J1-J4) verifies it. No workflow was dispatched.' -ForegroundColor Yellow
  exit 2
} catch {
  # CbcPartial is defined in the dot-sourced library, so it is matched by name here.
  $partial = $_.Exception.GetType().Name -eq 'CbcPartial'
  Write-Host ''
  if ($partial) {
    Write-Host "PARTIAL  $($_.Exception.Message)" -ForegroundColor Red
    Write-Created
    Write-Host 'RESULT: PARTIAL. Not a completed bootstrap; do not dispatch staging-auth-journeys until the recovery above is done.' -ForegroundColor Red
    exit 3
  }
  Write-Host "STOP  $($_.Exception.Message)" -ForegroundColor Red
  Write-Created
  Write-Host 'RESULT: STOP. Rerunning is safe.' -ForegroundColor Red
  exit 1
}
