<#
OFFLINE TEST PATH ONLY. Not for the founder-operated trial.
Loads ..\cbc-codex-trial.ps1 with -LoadOnly (which runs nothing), replaces its fixed configuration with test
values (fake Codex, local fixture repository, temporary folders) and marks the run as $TestMode so every
report says "OFFLINE TEST MODE: NOT A TRIAL RESULT". -NoTestMode exists only to test that the production
checks refuse a non-official Codex entry point.
#>
param(
  [ValidateSet('', 'Proof', 'Review')][string]$TrialMode = '',
  [switch]$Confirm,
  [Parameter(Mandatory = $true)][string]$TTrial, [Parameter(Mandatory = $true)][string]$TCanary, [Parameter(Mandatory = $true)][string]$TRun,
  [Parameter(Mandatory = $true)][string]$TTemp, [Parameter(Mandatory = $true)][string]$TRepo, [Parameter(Mandatory = $true)][string]$TReview,
  [Parameter(Mandatory = $true)][string]$TSource, [Parameter(Mandatory = $true)][string]$TBase, [Parameter(Mandatory = $true)][string]$THead,
  [Parameter(Mandatory = $true)][string]$TCodexJs, [int]$TTimeout = 60, [switch]$NoTestMode,
  [ValidateSet('PR43', 'Gate007A', 'Loop')][string]$TTarget = 'PR43', [string]$TManifest = '', [string]$TInputBase = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'cbc-codex-trial.ps1') -LoadOnly
$Target = $TTarget; $InputManifestSha256 = $TManifest; $InputBaseSha = $TInputBase
$TrialDir = $TTrial; $CanaryDir = $TCanary; $RunDir = $TRun; $TempCanary = $TTemp; $RepoDir = $TRepo; $ReviewDir = $TReview
$SourceRepo = $TSource; $BaseSha = $TBase; $HeadSha = $THead; $CodexJs = $TCodexJs; $TimeoutSeconds = $TTimeout
$TestMode = -not $NoTestMode
$Mode = $TrialMode; $ConfirmModelCall = [bool]$Confirm
exit (Invoke-TrialMain)
