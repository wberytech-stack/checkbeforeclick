<#
OFFLINE TEST PATH ONLY. Not for the founder-operated loop.
Loads ..\cbc-review-loop.ps1 with -LoadOnly (which runs nothing), replaces its fixed configuration with test values
(fixture repository, temporary trial paths and review folder, the runner's own offline entry with fake Codex, a fake
headless Claude, scripted approval answers) and sets $TestMode so every log says "OFFLINE TEST MODE".
An answer of <auto> types the expected phrase; any other answer is compared exactly, as in production.
#>
param(
  [Parameter(Mandatory = $true)][string]$TGate, [int]$TMaxRounds = 3,
  [Parameter(Mandatory = $true)][string]$TRepo, [Parameter(Mandatory = $true)][string]$TReview,
  [Parameter(Mandatory = $true)][string]$TTrial, [Parameter(Mandatory = $true)][string]$TCanary, [Parameter(Mandatory = $true)][string]$TRun, [Parameter(Mandatory = $true)][string]$TTemp,
  [Parameter(Mandatory = $true)][string]$TSource, [Parameter(Mandatory = $true)][string]$TBase, [Parameter(Mandatory = $true)][string]$TCodexJs,
  [Parameter(Mandatory = $true)][string]$TFakeClaude, [Parameter(Mandatory = $true)][string]$TToolsDir, [string]$TAnswersFile = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'cbc-review-loop.ps1') -LoadOnly
$Gate = $TGate; $MaxRounds = $TMaxRounds
$TestMode = $true
$LoopHere = $TToolsDir
$RepoDir = $TRepo; $ReviewDir = $TReview; $KitDir = Join-Path $ReviewDir 'codex-trial'
$InputDir = Join-Path $KitDir 'inputs\loop-current'; $ResultsDir = Join-Path $KitDir 'results'
$TrialPaths = [pscustomobject]@{ Trial = $TTrial; Canary = $TCanary; Run = $TRun; Temp = $TTemp }
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$ClaudeCommand = @($node, $TFakeClaude)
$ClaudeTimeoutSec = 60; $RunnerTimeoutSec = 300; $TestTimeoutSec = 60
$script:Answers = @(if ($TAnswersFile -and (Test-Path -LiteralPath $TAnswersFile)) { Get-Content -LiteralPath $TAnswersFile })
$script:TestRunnerEntry = Join-Path $PSScriptRoot 'offline-entry.ps1'
$script:TestRunnerArgs = @('-TTrial', $TTrial, '-TCanary', $TCanary, '-TRun', $TRun, '-TTemp', $TTemp, '-TRepo', $TRepo, '-TReview', $TReview,
  '-TSource', $TSource, '-TBase', $TBase, '-THead', $TBase, '-TCodexJs', $TCodexJs, '-TTimeout', '60')
exit (Invoke-LoopMain)
