<#
OFFLINE TEST PATH ONLY. Not for the founder-operated probe.
Loads ..\probe-claude.ps1 with -LoadOnly (which runs nothing), points it at a fixture sandbox repository, a temporary
review folder and the fake headless Claude, sets $TestMode and scripted approval answers (<auto> = the expected phrase).
#>
param(
  [Parameter(Mandatory = $true)][string]$TSandbox, [Parameter(Mandatory = $true)][string]$TReview,
  [Parameter(Mandatory = $true)][string]$TFakeClaude, [string]$TAnswersFile = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'probe-claude.ps1') -LoadOnly
$TestMode = $true
$SandboxRepoDir = $TSandbox; $ReviewDir = $TReview; $KitDir = Join-Path $ReviewDir 'codex-trial'; $ResultsDir = Join-Path $KitDir 'results'
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$ClaudeCommand = @($node, $TFakeClaude); $ClaudeTimeoutSec = 60
$script:Answers = @(if ($TAnswersFile -and (Test-Path -LiteralPath $TAnswersFile)) { Get-Content -LiteralPath $TAnswersFile })
exit (Invoke-ProbeMain)
