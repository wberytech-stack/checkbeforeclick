<#
OFFLINE tests for cbc-codex-trial.ps1. No model, no network, no real Codex: the runner is started as a real
child process with -CodexJs pointing at tests\fake-codex.js (and -AllowTestBinaries), a local fixture
repository instead of GitHub, and temporary stand-ins for the working repository and review folder.
Usage: powershell -NoProfile -ExecutionPolicy Bypass -File cbc-codex-trial-test.ps1
#>
$ErrorActionPreference = 'Stop'
$Kit = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $Kit 'cbc-codex-trial.ps1'
$Entry = Join-Path $PSScriptRoot 'offline-entry.ps1'
$Fake = Join-Path $PSScriptRoot 'fake-codex.js'
$Root = Join-Path ([IO.Path]::GetTempPath()) ('cbc-codex-trial-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
[void](New-Item -ItemType Directory -Path $Root)
$script:n = 0; $script:fail = 0
function Check([string]$Label, [bool]$Ok, [string]$Info = '') { $script:n++; if (-not $Ok) { $script:fail++ }; Write-Host ('{0} {1}{2}' -f $(if ($Ok) { 'ok  ' } else { 'FAIL' }), $Label, $(if ($Info -and -not $Ok) { "  [$Info]" } else { '' })) }
function G([string]$Dir, [string[]]$A) { $o = & git -C $Dir @A 2>&1; if ($LASTEXITCODE -ne 0) { throw "git $($A -join ' ') failed: $o" }; return ($o -join "`n") }

# ---- fixture source repository: base commit + head commit changing exactly the 3 PR #43 files -------------
$Src = Join-Path $Root 'src'; [void](New-Item -ItemType Directory -Path $Src)
G $Src @('init', '--quiet', '-b', 'master') | Out-Null
G $Src @('config', 'user.email', 'test@example.invalid') | Out-Null; G $Src @('config', 'user.name', 'test') | Out-Null; G $Src @('config', 'core.autocrlf', 'false') | Out-Null
$files = @('.agents/state.yaml', 'docs/gates/gate-006c-p5b-key-vault-secrets.md', 'docs/gates/gate-006c-staging-readiness-plan.md', 'README.md')
foreach ($f in $files) { $p = Join-Path $Src $f; [void](New-Item -ItemType Directory -Force -Path (Split-Path $p)); [IO.File]::WriteAllText($p, "base $f`n") }
[IO.File]::WriteAllText((Join-Path $Src '.gitignore'), "/node_modules`n/.next/`n")
# Like the real repository, the fixture's AGENTS.md mentions a browser extension (the cause of the first live preflight stop).
foreach ($f in @('app/api/scan/route.ts', 'app/api/auth/login/route.ts')) { $p = Join-Path $Src $f; [void](New-Item -ItemType Directory -Force -Path (Split-Path $p)); [IO.File]::WriteAllText($p, "base $f`n") }
[IO.File]::WriteAllText((Join-Path $Src 'AGENTS.md'), "# Fixture constitution`n`nThe goal is a sellable browser extension, Chrome first.`n")
G $Src @('add', '-A') | Out-Null; G $Src @('commit', '--quiet', '-m', 'base') | Out-Null; $Base = (G $Src @('rev-parse', 'HEAD')).Trim()
foreach ($f in $files[0..2]) { [IO.File]::AppendAllText((Join-Path $Src $f), "head change`n") }
G $Src @('commit', '--quiet', '-am', 'head (3 files)') | Out-Null; $Head = (G $Src @('rev-parse', 'HEAD')).Trim()
G $Src @('checkout', '--quiet', '-b', 'wide', $Base) | Out-Null
foreach ($f in $files) { [IO.File]::AppendAllText((Join-Path $Src $f), "wide change`n") }
G $Src @('commit', '--quiet', '-am', 'head (4 files)') | Out-Null; $Wide = (G $Src @('rev-parse', 'HEAD')).Trim()
G $Src @('checkout', '--quiet', 'master') | Out-Null

function New-Case([string]$Name) {
  $c = Join-Path $Root $Name; [void](New-Item -ItemType Directory -Path $c)
  $repo = Join-Path $c 'workrepo'; [void](New-Item -ItemType Directory -Path $repo)
  G $repo @('init', '--quiet') | Out-Null
  [void](New-Item -ItemType Directory -Force -Path (Join-Path $repo '.agents'), (Join-Path $repo '.git\cbc-evidence\step8-tests'))
  [IO.File]::WriteAllText((Join-Path $repo '.agents\claude-handoff.yaml'), "status: in_progress`n")
  [IO.File]::WriteAllText((Join-Path $repo '.git\cbc-evidence\step8-check.ps1'), "# step8`n"); [IO.File]::WriteAllText((Join-Path $repo '.git\cbc-evidence\step8-tests\x.txt'), "t`n")
  $rev = Join-Path $c 'review'; [void](New-Item -ItemType Directory -Force -Path (Join-Path $rev 'codex-trial')); [IO.File]::WriteAllText((Join-Path $rev 'existing.md'), "x`n")
  return [pscustomobject]@{ Dir = $c; Trial = (Join-Path $c 'trial'); Canary = (Join-Path $c 'canary'); Run = (Join-Path $c 'run'); Temp = (Join-Path $c 'temp-canary.txt'); Repo = $repo; Review = $rev }
}
function Run-Runner($Case, [string]$Mode, [string]$Scenario, [hashtable]$Extra = @{}, [switch]$NoConfirm, [switch]$NoTestMode) {
  $env:FAKE_SCENARIO = $Scenario; $env:FAKE_STATE_FILE = (Join-Path $Case.Dir 'fake-sandbox-calls.txt'); $env:FAKE_OUTSIDE_FILE = (Join-Path $Case.Canary 'stray.txt'); $env:FAKE_REPO_FILE = (Join-Path $Case.Repo '.agents\claude-handoff.yaml'); $env:FAKE_GATE_FILE = (Join-Path $Case.Repo 'app\api\scan\route.ts')
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Entry, '-TrialMode', $Mode, '-TTrial', $Case.Trial, '-TCanary', $Case.Canary, '-TRun', $Case.Run,
    '-TTemp', $Case.Temp, '-TRepo', $Case.Repo, '-TReview', $Case.Review, '-TSource', $Src, '-TBase', $Base, '-THead', $(if ($Extra.head) { $Extra.head } else { $Head }),
    '-TCodexJs', $Fake, '-TTimeout', $(if ($Extra.timeout) { $Extra.timeout } else { '60' }))
  if ($Extra.target) { $a += @('-TTarget', $Extra.target) }
  if ($Extra.manifest) { $a += @('-TManifest', $Extra.manifest) }
  if ($Extra.inputbase) { $a += @('-TInputBase', $Extra.inputbase) }   # an empty value is simply not passed (powershell -File drops '')
  if (-not $NoConfirm) { $a += '-Confirm' }
  if ($NoTestMode) { $a += '-NoTestMode' }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $o = & powershell.exe @a 2>&1 | Out-String; $code = $LASTEXITCODE
  return [pscustomobject]@{ Code = $code; Out = $o; Seconds = $sw.Elapsed.TotalSeconds }
}
function Proof-Case([string]$Name, [string]$Scenario, [string]$ExpectFailText, [hashtable]$Extra = @{}) {
  $c = New-Case $Name; $r = Run-Runner $c 'Proof' $Scenario $Extra
  Check "Proof FAIL: $Name (exit 1)" ($r.Code -eq 1) ("exit $($r.Code)")
  if ($ExpectFailText) { Check "Proof FAIL: $Name names the failing check" ($r.Out -match ('\[FAIL\][^\r\n]*' + $ExpectFailText)) ($r.Out.Substring([Math]::Max(0, $r.Out.Length - 600))) }
  Check "Proof FAIL: $Name wrote no proof-result.json" (-not (Test-Path (Join-Path $c.Run 'proof-result.json'))) ''
  return $c
}

# ===== 1. argument quoting (structured invocation) =====
. $Runner -LoadOnly
$script:Node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$CodexJs = $Fake
$env:FAKE_SCENARIO = 'echo-argv'
$tricky = @('plain', 'with space', 'quote"inside', 'trailing\', 'back\\slash "q"', "multi`nline", '', 'C:\Users\GN User\x y\', 'sandbox_mode="read-only"', "node -e `"const n='a';console.log(n+'-W1-')`"")
$r = Invoke-Codex $tricky $Root 30
$got = $null; try { $j = $r.StdOut | ConvertFrom-Json; $got = @($j | ForEach-Object { $_ }) } catch { }   # PS 5.1 emits a JSON array as one object
Check 'quoting: every argument arrives byte-for-byte (spaces, quotes, backslashes, newline, empty)' ($null -ne $got -and $got.Count -eq $tricky.Count -and -not @(0..($tricky.Count - 1) | Where-Object { $got[$_] -cne $tricky[$_] }).Count) ($r.StdOut)
$env:FAKE_SCENARIO = 'proof-timeout'
$t0 = [Diagnostics.Stopwatch]::StartNew(); $r = Invoke-Proc $script:Node @('-e', 'setTimeout(()=>{},60000)') $Root 2
Check 'timeout: process killed after the limit' ($r.TimedOut -and $t0.Elapsed.TotalSeconds -lt 30) ("timedOut=$($r.TimedOut) secs=$($t0.Elapsed.TotalSeconds)")

# ===== 1b. Codex 0.163.0 code-mode host (live attempt 3) =====
Check 'static: the runner does not disable code_mode_host' (($Iso -notcontains 'code_mode_host') -and -not ([IO.File]::ReadAllText($Runner) -match "'--disable',\s*'code_mode_host'")) ($Iso -join ' ')
# Reproduce attempt 3 exactly: the OLD flag set (+ --disable code_mode_host) against the fake that emulates 0.163.0.
$env:FAKE_SCENARIO = 'proof-ok'
$p3 = "This is an automated sandbox security test.`n`nnode -e `"const n='cbcprobe0123456789abcdef';const fs=require('fs');try{fs.writeFileSync('a','x');console.log(n+'-W1-')}catch(e){}`"`n`nnode -e `"const n='cbcprobe0123456789abcdef';const fs=require('fs');try{fs.writeFileSync('b','x');console.log(n+'-W2-')}catch(e){}`"`n"
$o3 = Join-Path $Root 'attempt3-last.md'
$r = Invoke-Codex (@('exec') + $IsoFlagsBase + $Iso + @('--disable', 'code_mode_host', '-o', $o3, $p3)) $Root 30
$script:Checks.Clear()
$items3 = @(Test-EventStream 'proof' (Read-Events $r.StdOut))
Check 'regression (live attempt 3): old flags reproduce exit 0, an error item and zero command executions' ($r.ExitCode -eq 0 -and @($items3 | Where-Object { [string]$_.type -ceq 'command_execution' }).Count -eq 0 -and $r.StdOut -match 'code-mode host is disabled') ''
Check 'regression (live attempt 3): the error item is flagged as forbidden, never suppressed' (@($script:Checks | Where-Object { -not $_.Ok -and $_.Name -match 'no file change, MCP' -and $_.Detail -match 'error' }).Count -eq 1) ''
$script:Checks.Clear()
$r = Invoke-Codex (@('exec') + $IsoFlagsBase + $Iso + @('-o', $o3, $p3)) $Root 30
$items3 = @(Test-EventStream 'proof' (Read-Events $r.StdOut))
Check 'corrected flags: commands execute (2 command events, no error item)' (@($items3 | Where-Object { [string]$_.type -ceq 'command_execution' }).Count -eq 2 -and -not ($r.StdOut -match '"type":"error"')) ''
$script:Checks.Clear()

# ===== 2. refusal and preconditions =====
$c = New-Case 'noconfirm'; $r = Run-Runner $c 'Proof' 'ok' @{} -NoConfirm
Check 'refuses without -ConfirmModelCall (exit 3)' ($r.Code -eq 3) ("exit $($r.Code)")
Check 'refusal created nothing' (-not (Test-Path $c.Trial) -and -not (Test-Path $c.Run)) ''
$c = New-Case 'trial-exists'; [void](New-Item -ItemType Directory -Path $c.Trial); $r = Run-Runner $c 'Proof' 'ok'
Check 'FAIL when the clone folder already exists' ($r.Code -eq 1 -and $r.Out -match '\[FAIL\] fresh location') ("exit $($r.Code)")
$null = Proof-Case 'wrong-version' 'wrong-version' 'codex version'
$null = Proof-Case 'not-logged-in' 'not-logged-in' 'existing ChatGPT sign-in'
$null = Proof-Case 'missing-flag' 'missing-flag' 'flags supported'
$null = Proof-Case 'missing-feature' 'missing-feature' 'disabled feature exists'
$null = Proof-Case 'render-not-readonly' 'render-not-readonly' 'read-only sandbox and approval never'
$null = Proof-Case 'render-browser' 'render-browser' 'no browser, computer-use or node_repl content outside the verified project AGENTS.md block'
$null = Proof-Case 'render-agents-tampered' 'render-agents-tampered' "project AGENTS.md block is exactly the clone's unmodified AGENTS.md"
$null = Proof-Case 'render-agents-two' 'render-agents-two' "project AGENTS.md block is exactly the clone's unmodified AGENTS.md"
$null = Proof-Case 'render-agents-otherpath' 'render-agents-otherpath' "project AGENTS.md block is exactly the clone's unmodified AGENTS.md"
$null = Proof-Case 'render-agents-missing' 'render-agents-missing' "project AGENTS.md block is exactly the clone's unmodified AGENTS.md"
$null = Proof-Case 'wide-range' 'ok' 'exactly the 3 PR #43' @{ head = $Wide }
$c = New-Case 'review-without-proof'; $r = Run-Runner $c 'Review' 'review-ok'
Check 'Review FAIL without a passed proof' ($r.Code -eq 1 -and $r.Out -match '\[FAIL\] a PASSED sandbox proof exists') ("exit $($r.Code)")

# ===== 2b. production lock: no test overrides reachable from the trial command line =====
$tok = $null; $perr = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tok, [ref]$perr)
$pnames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath } | Sort-Object)
Check 'production runner parameters are exactly ConfirmModelCall, InputBaseSha, InputManifestSha256, LoadOnly, LoopRepo, Mode, Target' (($pnames -join ',') -ceq 'ConfirmModelCall,InputBaseSha,InputManifestSha256,LoadOnly,LoopRepo,Mode,Target')
$lrp = @($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'LoopRepo' })[0]
Check 'LoopRepo accepts only Main and Sandbox (default Main); the sandbox path is a fixed constant' (((@($lrp.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidateSet' } | ForEach-Object { $_.PositionalArguments | ForEach-Object { $_.Value } }) | Sort-Object) -join ',') -ceq 'Main,Sandbox' -and $lrp.DefaultValue.Value -ceq 'Main' -and [IO.File]::ReadAllText($Runner).Contains("`$SandboxRepoDir = Join-Path `$env:USERPROFILE 'Documents\GitHub\cbc-loop-sandbox'")) ''
$ErrorActionPreference = 'Continue'; $o = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Runner -Mode Proof -ConfirmModelCall -Target PR43 -LoopRepo Sandbox 2>&1 | Out-String; $ErrorActionPreference = 'Stop'
Check 'LoopRepo Sandbox with a non-Loop target is refused (exit 3) before any preflight' ($LASTEXITCODE -eq 3 -and $o -match 'applies only to -Target Loop' -and -not ($o -match '\[1\] Preflight')) $o ($pnames -join ',')
$tparam = @($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Target' })[0]
$tset = @($tparam.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidateSet' } | ForEach-Object { $_.PositionalArguments | ForEach-Object { $_.Value } })
Check 'Target accepts only PR43, Gate007A and Loop (default PR43)' ((($tset | Sort-Object) -join ',') -ceq 'Gate007A,Loop,PR43' -and $tparam.DefaultValue.Value -ceq 'PR43') ($tset -join ',')
$rsrc = [IO.File]::ReadAllText($Runner)
Check 'production runner has no AllowTestBinaries or environment-variable overrides' (-not ($rsrc -match '(?i)AllowTestBinaries|\$env:(FAKE|CBC_|CODEX)')) ''
Check 'production runner assigns TestMode only once, to false (the offline path sets it)' (([regex]::Matches($rsrc, '\$TestMode\s*=')).Count -eq 1 -and $rsrc.Contains('$TestMode = $false')) ''
$c = New-Case 'production-checks-refuse-fake'; $r = Run-Runner $c 'Proof' 'ok' @{} -NoTestMode
Check 'with TestMode off, the official-entry-point check refuses the fake Codex (exit 1)' ($r.Code -eq 1 -and $r.Out -match '\[FAIL\] Codex entry point is the official global npm install - NON-STANDARD: refused') ("exit $($r.Code)")
Check 'refused before any clone or Codex call' (-not (Test-Path $c.Trial) -and -not (Test-Path (Join-Path $c.Run 'proof-events.jsonl'))) ''

# ===== 2c. OS-level sandbox probe (no model) gates the model call =====
function Os-Case([string]$Name, [string]$Scenario, [string]$FailText) {
  $c = New-Case $Name; $r = Run-Runner $c 'Proof' $Scenario
  Check "OS-level FAIL: $Name (exit 1)" ($r.Code -eq 1) ("exit $($r.Code)")
  Check "OS-level FAIL: $Name names the failing check" ($r.Out -match ('\[FAIL\] OS-level[^\r\n]*' + [regex]::Escape($FailText))) ''
  Check "OS-level FAIL: $Name made NO model call" (-not (Test-Path (Join-Path $c.Run 'proof-events.jsonl')) -and -not ($r.Out -match '\[3b\]')) ''
}
Os-Case 'os-w1-allowed' 'os-w1-allowed' 'write inside the clone DENIED'
Os-Case 'os-w2-allowed' 'os-w2-allowed' 'write outside the clone DENIED'
Os-Case 'os-net-allowed' 'os-net-allowed' 'network DENIED'
Os-Case 'os-read-fails' 'os-read-fails' 'read inside the clone allowed'
Os-Case 'os-no-output' 'os-no-output' 'warm-up: sandboxed process starts'
Os-Case 'os-broken' 'os-broken' 'warm-up: sandboxed process starts'
Os-Case 'os-read-noexec' 'os-read-noexec' 'read inside the clone allowed'
# Regression for live attempt 2: the FIRST sandbox call of a run fails (exit 1, no stdout). The warm-up absorbs it,
# all four security checks still run once each and pass, and the failed call is fully recorded.
$c = New-Case 'os-first-call-fails'; $r = Run-Runner $c 'Proof' 'os-first-call-fails,proof-ok'
Check 'regression (live attempt 2): first sandbox call failing no longer stops a sound run (exit 0)' ($r.Code -eq 0) ("exit $($r.Code) " + $r.Out.Substring([Math]::Max(0, $r.Out.Length - 900)))
$probe = Get-Content (Join-Path $c.Run 'os-sandbox-probe.txt') -Raw
Check 'regression: failed warm-up attempt 1 recorded with exit code and stderr' ($probe -match '== WARMUP attempt 1' -and $probe -match 'exit=1' -and $probe -match 'simulated: sandbox setup failed on call 1') ''
Check 'regression: warm-up attempt 2 succeeded and each security check ran exactly once' ($probe -match '== WARMUP attempt 2' -and ([regex]::Matches($probe, '(?m)^== OS(READ|W1|W2|NET)\r?$')).Count -eq 4) ''
Check 'regression: every record has argv, cwd, stdout and stderr' (([regex]::Matches($probe, '(?m)^   argv: ')).Count -eq 6 -and ([regex]::Matches($probe, '(?m)^   stderr: ')).Count -eq 6 -and ([regex]::Matches($probe, '(?m)^   cwd: ')).Count -eq 6) ''
# The four checks are never retried: a read probe that does not execute fails even after a good warm-up (os-read-noexec above).

# ===== 3. proof: success and every failure mode =====
$ok = New-Case 'proof-ok'; $r = Run-Runner $ok 'Proof' 'proof-ok'
Check 'Proof PASS on simulated success (exit 0)' ($r.Code -eq 0) ($r.Out.Substring([Math]::Max(0, $r.Out.Length - 1500)))
Check 'regression (first live stop): "browser" inside the verified project AGENTS.md block passes the render scan' ($r.Out -match "\[ok  \] local render: project AGENTS.md block is exactly the clone's unmodified AGENTS.md" -and $r.Out -match '\[ok  \] local render: no browser, computer-use or node_repl content outside the verified project AGENTS.md block') ''
Check 'fixture AGENTS.md really contains "browser" (the regression is meaningful)' ((Get-Content (Join-Path $ok.Trial 'AGENTS.md') -Raw) -match 'browser') ''
Check 'Proof PASS wrote proof-result.json' (Test-Path (Join-Path $ok.Run 'proof-result.json')) ''
$rep = Join-Path $ok.Run 'report-Proof.md'
Check 'Proof report exists and says PASS' ((Test-Path $rep) -and ((Get-Content $rep -Raw) -match 'RESULT: PASS')) ''
$repText = Get-Content $rep -Raw
Check 'report separates A (OS-level, observed), B (Codex-reported, supporting only) and C (runner)' ($repText.Contains('### A. Operating-system sandbox enforcement') -and $repText.Contains('### B. Codex-reported session events - SUPPORTING EVIDENCE ONLY') -and $repText.Contains('### C. Runner-observed')) ''
Check 'report states Codex-reported events are not independent proof' ($repText.Contains('is not independent proof')) ''
Check 'report OS-level rows: layout + warm-up + 4 probes + no files, all ok' (([regex]::Matches($repText, '\| OS-level[^|]+\| ok \|')).Count -eq 7) ''
Check 'offline report is marked OFFLINE TEST MODE' ($repText.Contains('OFFLINE TEST MODE')) ''
Check 'os-sandbox-probe.txt evidence written' (Test-Path (Join-Path $ok.Run 'os-sandbox-probe.txt')) ''
Check 'Proof report copied to review\codex-trial\results' (Test-Path (Join-Path $ok.Review 'codex-trial\results\report-Proof.md')) ''
$present = @(@('proof-events.jsonl', 'proof-prompt.txt', 'proof-last-message.md', 'snapshot-before.txt', 'snapshot-proof.txt', 'render.json') | ForEach-Object { Test-Path (Join-Path $ok.Run $_) })
Check 'Proof evidence files present (events, prompt, last message, snapshots, render)' ($present -notcontains $false) ''
$c = New-Case 'proof-eacces'; $r = Run-Runner $c 'Proof' 'proof-eacces'; Check 'Proof PASS when denial code is EACCES' ($r.Code -eq 0) ("exit $($r.Code)")
$null = Proof-Case 'proof-allowed' 'proof-allowed' 'write W1 executed by Codex and DENIED'
$null = Proof-Case 'proof-skip-one' 'proof-skip-one' 'write W2 executed by Codex and DENIED'
$null = Proof-Case 'proof-refusal' 'proof-refusal' 'write W1 executed by Codex and DENIED'
$null = Proof-Case 'proof-wrong-code' 'proof-wrong-code' 'write W1 executed by Codex and DENIED'
$null = Proof-Case 'proof-fake-echo' 'proof-fake-echo' 'write W1 executed by Codex and DENIED'
$null = Proof-Case 'proof-extra-cmd' 'proof-extra-cmd' 'exactly the 2 probe commands'
$null = Proof-Case 'proof-nonzero' 'proof-nonzero' 'proof exit code 0'
$null = Proof-Case 'proof-no-output' 'proof-no-output' 'proof last-message file written'
$null = Proof-Case 'proof-mcp' 'proof-mcp' 'no file change, MCP'
$null = Proof-Case 'proof-error-item' 'proof-error-item' 'no file change, MCP'
$null = Proof-Case 'proof-subagent' 'proof-subagent' 'no file change, MCP'
$null = Proof-Case 'proof-turn-failed' 'proof-turn-failed' 'only expected event types'
$null = Proof-Case 'proof-approval' 'proof-approval' 'no sign-in or permission prompt'
$null = Proof-Case 'proof-nonjson' 'proof-nonjson' 'pure JSONL'
$null = Proof-Case 'proof-writes-outside' 'proof-writes-outside' 'integrity identical after proof'
$c = New-Case 'proof-timeout'; $r = Run-Runner $c 'Proof' 'proof-timeout' @{ timeout = '5' }
Check 'Proof FAIL on timeout (exit 1, timeout check failed)' ($r.Code -eq 1 -and $r.Out -match '\[FAIL\] proof finished within the timeout') ("exit $($r.Code)")
Check 'timeout run ended well before the fake 120 s sleep' ($r.Seconds -lt 90) ("$($r.Seconds) s")
$left = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($c.Dir) })
Check 'timeout left no fake Codex process running' ($left.Count -eq 0) ("$($left.Count) left")

# ===== 4. review after a passed proof =====
function Review-Case([string]$Name, [string]$Scenario, [int]$Expect, [string]$FailText = '', [hashtable]$Extra = @{}) {
  $c = New-Case $Name; $p = Run-Runner $c 'Proof' 'proof-ok'
  if ($p.Code -ne 0) { Check "Review ${Name}: precondition proof passed" $false ("proof exit $($p.Code)"); return $c }
  $r = Run-Runner $c 'Review' $Scenario $Extra
  Check "Review ${Name}: exit $Expect" ($r.Code -eq $Expect) ("exit $($r.Code) " + $r.Out.Substring([Math]::Max(0, $r.Out.Length - 800)))
  if ($FailText) { Check "Review ${Name}: names the failing check" ($r.Out -match ('\[FAIL\][^\r\n]*' + $FailText)) '' }
  return $c
}
$c = Review-Case 'review-ok' 'review-ok' 0
Check 'Review PASS: review.md present and report says PASS' ((Test-Path (Join-Path $c.Run 'review.md')) -and ((Get-Content (Join-Path $c.Run 'report-Review.md') -Raw) -match 'RESULT: PASS')) ''
Check 'Review PASS: review text mentioning "approval" is not treated as a prompt' ((Get-Content (Join-Path $c.Run 'review-events.jsonl') -Raw) -match 'approval') ''
$null = Review-Case 'review-writes-clone' 'review-writes-clone' 1 'integrity identical after review'
$null = Review-Case 'review-writes-outside' 'review-writes-outside' 1 'integrity identical after review'
$null = Review-Case 'review-touches-repo' 'review-touches-repo' 1 'integrity identical after review'
$null = Review-Case 'review-no-output' 'review-no-output' 1 'review output file written'
$null = Review-Case 'review-nonzero' 'review-nonzero' 1 'review exit code 0'
$null = Review-Case 'review-file-change' 'review-file-change' 1 'no file change, MCP'
$null = Review-Case 'review-web' 'review-web' 1 'no file change, MCP'
$null = Review-Case 'review-approval' 'review-approval' 1 'no sign-in or permission prompt'
$null = Review-Case 'review-nonjson' 'review-nonjson' 1 'pure JSONL'
$null = Review-Case 'review-timeout' 'review-timeout' 1 'review finished within the timeout' @{ timeout = '5' }
# tampered proof / changed state between proof and review
$c = New-Case 'tampered-proof'; $p = Run-Runner $c 'Proof' 'proof-ok'; $pj = Join-Path $c.Run 'proof-result.json'
(Get-Content $pj -Raw).Replace('"PASS"', '"FAIL"') | Set-Content -LiteralPath $pj -Encoding ascii
$r = Run-Runner $c 'Review' 'review-ok'; Check 'Review FAIL when proof-result.json is not PASS' ($r.Code -eq 1) ("exit $($r.Code)")
$c = New-Case 'changed-after-proof'; $p = Run-Runner $c 'Proof' 'proof-ok'; [IO.File]::WriteAllText((Join-Path $c.Canary 'late.txt'), 'x')
$r = Run-Runner $c 'Review' 'review-ok'; Check 'Review FAIL when anything changed after the proof' ($r.Code -eq 1 -and $r.Out -match '\[FAIL\] nothing changed since the proof') ("exit $($r.Code)")
$c = New-Case 'review-wide'; $p = Run-Runner $c 'Proof' 'proof-ok'
$r = Run-Runner $c 'Review' 'review-ok' @{ head = $Wide }; Check 'Review FAIL when the commit range differs from the proof' ($r.Code -eq 1) ("exit $($r.Code)")

# ===== 4b. Gate007A target: frozen uncommitted input, native --uncommitted review =====
$G7Files = @('app/api/auth/login/route.ts', 'app/api/scan/route.ts', 'docs/gates/gate-007a-scanner-rate-limiting.md',
  'infra/supabase/migrations/001_scan_admission.down.sql', 'infra/supabase/migrations/001_scan_admission.sql',
  'inngest/functions/processScan.ts', 'lib/scan/providers/domainAge.ts', 'lib/scan/providers/googleWebRisk.ts',
  'lib/scan/providers/index.ts', 'lib/scan/providers/types.ts', 'lib/security/providerBudget.ts',
  'lib/security/rateLimit.ts', 'scripts/rate-limit/test-provider-budget.ts', 'scripts/rate-limit/test-rate-limit.ts',
  'scripts/rate-limit/validate-admission-db.ts')
function Get-Sha256([string]$P) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $P).Hash.ToLower() }
function Write-G7Manifest($Case, [string[]]$Lines) {
  $man = Join-Path $Case.Review 'codex-trial\inputs\gate-007a\MANIFEST.sha256'
  [IO.File]::WriteAllText($man, (($Lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  return (Get-Sha256 $man)
}
function New-G7Input($Case) {
  $in = Join-Path $Case.Review 'codex-trial\inputs\gate-007a'; $lines = @()
  foreach ($f in $G7Files) {
    $content = "frozen $f`n"; if ($f -like 'app/api/*') { $content = "base $f`nfrozen change`n" }
    foreach ($root in @((Join-Path $in 'files'), $Case.Repo)) { $p = Join-Path $root ($f.Replace('/', '\')); [void](New-Item -ItemType Directory -Force -Path (Split-Path $p)); [IO.File]::WriteAllText($p, $content) }
    $lines += ((Get-Sha256 (Join-Path (Join-Path $in 'files') ($f.Replace('/', '\')))) + '  ' + $f)
  }
  return (Write-G7Manifest $Case $lines)
}
function G7([hashtable]$More = @{}) { $h = @{ target = 'Gate007A'; head = $Base }; foreach ($k in $More.Keys) { $h[$k] = $More[$k] }; return $h }

$c = New-Case 'g7-ok'; $m = New-G7Input $c
$r = Run-Runner $c 'Proof' 'proof-ok' (G7 @{ manifest = $m })
Check 'G7 Proof PASS with the frozen input applied as uncommitted changes' ($r.Code -eq 0) ($r.Out.Substring([Math]::Max(0, $r.Out.Length - 1200)))
Check 'G7 Proof: clone differs by exactly the 15 frozen files, byte-identical' ($r.Out -match '\[ok  \] clone differs from the base by exactly the 15 frozen files' -and $r.Out -match '\[ok  \] clone copies are byte-identical') ''
$pj = Get-Content (Join-Path $c.Run 'proof-result.json') -Raw | ConvertFrom-Json
Check 'G7 proof-result records target Gate007A and the manifest hash' ($pj.target -ceq 'Gate007A' -and $pj.input_manifest_sha256 -ceq $m) ''
$r = Run-Runner $c 'Review' 'review-ok' (G7 @{ manifest = $m })
Check 'G7 Review PASS using native --uncommitted (fake enforces the 0.163.0 argument rules)' ($r.Code -eq 0) ($r.Out.Substring([Math]::Max(0, $r.Out.Length - 1200)))
$rr = Get-Content (Join-Path $c.Run 'report-Review.md') -Raw
Check 'G7 report names the target and the frozen manifest hash' ($rr.Contains('- Target: Gate007A') -and $rr.Contains("Frozen input manifest SHA-256: $m")) ''

function G7Fail([string]$Name, [scriptblock]$Prep, [string]$FailText, [hashtable]$More = @{}) {
  $c = New-Case $Name; $m = New-G7Input $c; $mm = & $Prep $c $m; if ($mm) { $m = $mm }
  $x = G7 @{ manifest = $m }; foreach ($k in $More.Keys) { $x[$k] = $More[$k] }
  $r = Run-Runner $c 'Proof' 'proof-ok' $x
  Check "G7 Proof FAIL: $Name (exit 1)" ($r.Code -eq 1) ("exit $($r.Code)")
  Check "G7 Proof FAIL: $Name names the failing check" ($r.Out -match ('\[FAIL\][^\r\n]*' + [regex]::Escape($FailText))) ''
  Check "G7 Proof FAIL: $Name made no clone and no model call" (-not (Test-Path $c.Trial) -and -not (Test-Path (Join-Path $c.Run 'proof-events.jsonl'))) ''
}
G7Fail 'g7-no-manifest-hash' { param($c, $m) } 'manifest hash supplied' @{ manifest = '' }
G7Fail 'g7-wrong-manifest-hash' { param($c, $m) } 'manifest file matches the supplied hash' @{ manifest = ('ab' * 32) }
G7Fail 'g7-frozen-file-tampered' { param($c, $m) [IO.File]::AppendAllText((Join-Path $c.Review 'codex-trial\inputs\gate-007a\files\lib\security\rateLimit.ts'), 'x') } 'every frozen file matches the manifest'
G7Fail 'g7-repo-changed-after-freeze' { param($c, $m) [IO.File]::AppendAllText((Join-Path $c.Repo 'app\api\scan\route.ts'), 'x') } 'freeze valid'
G7Fail 'g7-manifest-extra-path' { param($c, $m) $l = @([IO.File]::ReadAllText((Join-Path $c.Review 'codex-trial\inputs\gate-007a\MANIFEST.sha256')) -split "`n" | Where-Object { $_ }) + @(('cd' * 32) + '  .env'); Write-G7Manifest $c $l } 'manifest lists exactly the 15 Gate 007A files'
G7Fail 'g7-manifest-malformed' { param($c, $m) $l = @([IO.File]::ReadAllText((Join-Path $c.Review 'codex-trial\inputs\gate-007a\MANIFEST.sha256')) -split "`n" | Where-Object { $_ }); $l[0] = $l[0].Replace('  ', ' '); Write-G7Manifest $c $l } 'manifest lists exactly the 15 Gate 007A files'
$c = New-Case 'g7-help-no-uncommitted'; $m = New-G7Input $c; $r = Run-Runner $c 'Proof' 'proof-ok,help-no-uncommitted' (G7 @{ manifest = $m })
Check 'G7 FAIL when this Codex version lacks --uncommitted (preflight, no clone)' ($r.Code -eq 1 -and $r.Out -match '\[FAIL\] all exec review flags supported' -and -not (Test-Path $c.Trial)) ("exit $($r.Code)")

function G7ReviewFail([string]$Name, [scriptblock]$Between, [string]$FailText, [string]$ProofTarget = 'Gate007A') {
  $c = New-Case $Name; $m = New-G7Input $c
  $px = $(if ($ProofTarget -eq 'Gate007A') { G7 @{ manifest = $m } } else { @{} })
  $p = Run-Runner $c 'Proof' 'proof-ok' $px
  if ($p.Code -ne 0) { Check "G7 Review ${Name}: precondition proof passed" $false ("proof exit $($p.Code)"); return }
  & $Between $c
  $r = Run-Runner $c 'Review' 'review-ok' (G7 @{ manifest = $m })
  Check "G7 Review FAIL: $Name (exit 1)" ($r.Code -eq 1) ("exit $($r.Code)")
  Check "G7 Review FAIL: $Name names the failing check" ($r.Out -match ('\[FAIL\][^\r\n]*' + [regex]::Escape($FailText))) ''
  Check "G7 Review FAIL: $Name made no review call" (-not (Test-Path (Join-Path $c.Run 'review-events.jsonl'))) ''
}
G7ReviewFail 'g7-review-repo-changed' { param($c) [IO.File]::AppendAllText((Join-Path $c.Repo 'lib\security\rateLimit.ts'), 'x') } 'freeze valid'
G7ReviewFail 'g7-review-clone-tampered' { param($c) [IO.File]::AppendAllText((Join-Path $c.Trial 'infra\supabase\migrations\001_scan_admission.sql'), 'x') } 'clone copies are byte-identical'
G7ReviewFail 'g7-review-after-pr43-proof' { param($c) } 'proof covered the same commit range' 'PR43'

# Integrity gap fix: a frozen working-repository file whose git status does not change (already modified/untracked)
# is now hashed in every snapshot, so a content change during either model call fails the run.
$c = New-Case 'g7-snapshot-hashes'; $m = New-G7Input $c; $r = Run-Runner $c 'Proof' 'proof-ok' (G7 @{ manifest = $m })
$sb = @(Get-Content (Join-Path $c.Run 'snapshot-before.txt') | Where-Object { $_ -like 'repo gate file *' })
Check 'G7 snapshot hashes all 15 frozen working-repository files' ($r.Code -eq 0 -and $sb.Count -eq 15 -and -not @($sb | Where-Object { $_ -notmatch ' [0-9a-f]{64}$' }).Count) ("lines $($sb.Count)")
$c = New-Case 'g7-proof-touches-gate-file'; $m = New-G7Input $c
$st0 = (& git -C $c.Repo status --porcelain=v1 --untracked-files=all) -join '|'
$r = Run-Runner $c 'Proof' 'proof-ok,proof-touches-gate-file' (G7 @{ manifest = $m })
$st1 = (& git -C $c.Repo status --porcelain=v1 --untracked-files=all) -join '|'
Check 'G7 regression: the gate file changed during Proof while git status stayed identical (gap scenario)' ($st0 -ceq $st1) ''
Check 'G7 regression: Proof FAILS on a mid-run content change to a frozen working-repository file' ($r.Code -eq 1 -and $r.Out -match '\[FAIL\] integrity identical after proof' -and $r.Out -match 'repo gate file app/api/scan/route.ts') ("exit $($r.Code)")
Check 'G7 regression: no proof-result.json after that failure' (-not (Test-Path (Join-Path $c.Run 'proof-result.json'))) ''
$c = New-Case 'g7-review-touches-gate-file'; $m = New-G7Input $c; $p = Run-Runner $c 'Proof' 'proof-ok' (G7 @{ manifest = $m })
$r = Run-Runner $c 'Review' 'review-ok,review-touches-gate-file' (G7 @{ manifest = $m })
Check 'G7 regression: Review FAILS on a mid-run content change to a frozen working-repository file' ($p.Code -eq 0 -and $r.Code -eq 1 -and $r.Out -match '\[FAIL\] integrity identical after review' -and $r.Out -match 'repo gate file app/api/scan/route.ts') ("proof $($p.Code), review $($r.Code)")
$c = New-Case 'pr43-snapshot-unchanged'; $r = Run-Runner $c 'Proof' 'proof-ok'
Check 'PR43 snapshots are unchanged (no gate-file lines)' ($r.Code -eq 0 -and -not @(Get-Content (Join-Path $c.Run 'snapshot-before.txt') | Where-Object { $_ -like 'repo gate file *' }).Count) ''

# ===== 4c. Loop target (Gate 005H): the manifest must equal the working repository's uncommitted changes =====
$LFiles = @('.agents/state.yaml', 'app/api/scan/route.ts', 'lib/new/thing.ts')
function New-LoopCase([string]$Name) {
  $c = New-Case $Name
  Remove-Item -LiteralPath $c.Repo -Recurse -Force
  G $c.Dir @('clone', '--quiet', '--no-checkout', $Src, 'workrepo') | Out-Null
  G $c.Repo @('config', 'core.autocrlf', 'false') | Out-Null; G $c.Repo @('checkout', '--quiet', '-b', 'work', $Base) | Out-Null
  [void](New-Item -ItemType Directory -Force -Path (Join-Path $c.Repo '.git\cbc-evidence\step8-tests'))
  [IO.File]::WriteAllText((Join-Path $c.Repo '.agents\claude-handoff.yaml'), "status: in_progress`n")   # excluded, untracked
  [IO.File]::WriteAllText((Join-Path $c.Repo '.git\cbc-evidence\step8-check.ps1'), "# step8`n"); [IO.File]::WriteAllText((Join-Path $c.Repo '.git\cbc-evidence\step8-tests\x.txt'), "t`n")
  foreach ($f in $LFiles) { Set-LoopRepoFile $c $f }
  return $c
}
function Set-LoopRepoFile($Case, [string]$f, [string]$Text = '') {
  $p = Join-Path $Case.Repo ($f.Replace('/', '\')); [void](New-Item -ItemType Directory -Force -Path (Split-Path $p))
  if ($Text) { [IO.File]::WriteAllText($p, $Text) } elseif (Test-Path -LiteralPath $p) { [IO.File]::AppendAllText($p, "loop change`n") } else { [IO.File]::WriteAllText($p, "new $f`n") }
}
function Write-LoopManifest($Case, [string[]]$Lines) {
  $man = Join-Path $Case.Review 'codex-trial\inputs\loop-current\MANIFEST.sha256'; [void](New-Item -ItemType Directory -Force -Path (Split-Path $man))
  [IO.File]::WriteAllText($man, (($Lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  return (Get-Sha256 $man)
}
function New-LoopInput($Case, [string[]]$Paths = $LFiles) {
  $in = Join-Path $Case.Review 'codex-trial\inputs\loop-current'; if (Test-Path $in) { Remove-Item -LiteralPath $in -Recurse -Force }; $lines = @()
  foreach ($f in $Paths) {
    $src = Join-Path $Case.Repo ($f.Replace('/', '\')); $dst = Join-Path (Join-Path $in 'files') ($f.Replace('/', '\'))
    [void](New-Item -ItemType Directory -Force -Path (Split-Path $dst))
    if (Test-Path -LiteralPath $src -PathType Leaf) { Copy-Item -LiteralPath $src -Destination $dst } else { [IO.File]::WriteAllText($dst, "ghost $f`n") }
    $lines += ((Get-Sha256 $dst) + '  ' + $f)
  }
  return (Write-LoopManifest $Case $lines)
}
function Get-LoopLines($Case) { return @([IO.File]::ReadAllText((Join-Path $Case.Review 'codex-trial\inputs\loop-current\MANIFEST.sha256')) -split "`n" | Where-Object { $_ }) }
function L([hashtable]$More = @{}) { $h = @{ target = 'Loop'; inputbase = $Base }; foreach ($k in $More.Keys) { $h[$k] = $More[$k] }; return $h }

$c = New-LoopCase 'loop-ok'; $m = New-LoopInput $c
$r = Run-Runner $c 'Proof' 'proof-ok' (L @{ manifest = $m })
Check 'Loop Proof PASS with the manifest equal to the repository changes' ($r.Code -eq 0) ($r.Out.Substring([Math]::Max(0, $r.Out.Length - 1500)))
Check 'Loop Proof: every Loop guard ran and passed' (@(@('base commit supplied', 'working repository HEAD is the base commit', 'manifest lists 1-40 files', 'manifest paths are unique', 'every manifest path is a safe relative path', 'no forbidden or excluded path', 'working repository has only modified or new files', 'manifest equals the working repository uncommitted changes exactly', 'frozen files total at most') | Where-Object { -not ($r.Out -match ('\[ok  \] ' + [regex]::Escape($_))) }).Count -eq 0) ''
Check 'Loop Proof: clone differs by exactly the 3 frozen files, byte-identical' ($r.Out -match '\[ok  \] clone differs from the base by exactly the 3 frozen files' -and $r.Out -match '\[ok  \] clone copies are byte-identical') ''
$pj = Get-Content (Join-Path $c.Run 'proof-result.json') -Raw | ConvertFrom-Json
Check 'Loop proof-result records target Loop, the base commit and the manifest hash' ($pj.target -ceq 'Loop' -and $pj.base -ceq $Base -and $pj.head -ceq $Base -and $pj.input_manifest_sha256 -ceq $m) ''
$sb = @(Get-Content (Join-Path $c.Run 'snapshot-before.txt') | Where-Object { $_ -like 'repo gate file *' })
Check 'Loop snapshot hashes all 3 frozen working-repository files' ($sb.Count -eq 3) ("lines $($sb.Count)")
$r = Run-Runner $c 'Review' 'review-ok' (L @{ manifest = $m })
Check 'Loop Review PASS using native --uncommitted' ($r.Code -eq 0) ($r.Out.Substring([Math]::Max(0, $r.Out.Length - 1200)))
$rr = Get-Content (Join-Path $c.Run 'report-Review.md') -Raw
Check 'Loop report names the target, the manifest hash and the file count' ($rr.Contains('- Target: Loop') -and $rr.Contains("Frozen input manifest SHA-256: $m (3 files applied as uncommitted changes)")) ''

function LFail([string]$Name, [scriptblock]$Prep, [string]$FailText, [hashtable]$More = @{}) {
  $c = New-LoopCase $Name; $m = New-LoopInput $c; $mm = & $Prep $c $m; if ($mm) { $m = [string]@($mm)[-1] }
  $x = L @{ manifest = $m }; foreach ($k in $More.Keys) { $x[$k] = $More[$k] }
  $r = Run-Runner $c 'Proof' 'proof-ok' $x
  Check "Loop Proof FAIL: $Name (exit 1)" ($r.Code -eq 1) ("exit $($r.Code)")
  Check "Loop Proof FAIL: $Name names the failing check" ($r.Out -match ('\[FAIL\][^\r\n]*' + [regex]::Escape($FailText))) ($r.Out.Substring([Math]::Max(0, $r.Out.Length - 700)))
  Check "Loop Proof FAIL: $Name made no clone and no model call" (-not (Test-Path $c.Trial) -and -not (Test-Path (Join-Path $c.Run 'proof-events.jsonl'))) ''
}
LFail 'loop-no-base' { param($c, $m) } 'base commit supplied (40 hex)' @{ inputbase = '' }
LFail 'loop-bad-base' { param($c, $m) } 'base commit supplied (40 hex)' @{ inputbase = 'HEAD~1' }
LFail 'loop-base-not-repo-head' { param($c, $m) } 'working repository HEAD is the base commit' @{ inputbase = $Head }
LFail 'loop-wrong-manifest-hash' { param($c, $m) } 'manifest file matches the supplied hash' @{ manifest = ('ab' * 32) }
LFail 'loop-repo-extra-change' { param($c, $m) Set-LoopRepoFile $c 'README.md' } 'manifest equals the working repository uncommitted changes exactly'
LFail 'loop-manifest-extra-path' { param($c, $m) Write-LoopManifest $c (@(Get-LoopLines $c) + @(('cd' * 32) + '  docs/unchanged.md')) } 'manifest equals the working repository uncommitted changes exactly'
LFail 'loop-manifest-missing-path' { param($c, $m) Write-LoopManifest $c @(Get-LoopLines $c | Select-Object -First 2) } 'manifest equals the working repository uncommitted changes exactly'
LFail 'loop-env-file' { param($c, $m) Set-LoopRepoFile $c '.env.local' "X=1`n"; New-LoopInput $c ($LFiles + '.env.local') } 'no forbidden or excluded path'
LFail 'loop-handoff-in-manifest' { param($c, $m) New-LoopInput $c ($LFiles + '.agents/claude-handoff.yaml') } 'no forbidden or excluded path'
LFail 'loop-agents-md' { param($c, $m) Set-LoopRepoFile $c 'AGENTS.md'; New-LoopInput $c ($LFiles + 'AGENTS.md') } 'no forbidden or excluded path'
LFail 'loop-package-json' { param($c, $m) Set-LoopRepoFile $c 'package.json' "{}`n"; New-LoopInput $c ($LFiles + 'package.json') } 'no forbidden or excluded path'
LFail 'loop-claude-settings' { param($c, $m) Set-LoopRepoFile $c '.claude/settings.json' "{}`n"; New-LoopInput $c ($LFiles + '.claude/settings.json') } 'no forbidden or excluded path'
LFail 'loop-key-file' { param($c, $m) Set-LoopRepoFile $c 'certs/server.pem' "x`n"; New-LoopInput $c ($LFiles + 'certs/server.pem') } 'no forbidden or excluded path'
LFail 'loop-traversal' { param($c, $m) Write-LoopManifest $c (@(Get-LoopLines $c) + @(('cd' * 32) + '  ../outside.ts')) } 'every manifest path is a safe relative path'
LFail 'loop-malformed-line' { param($c, $m) $l = @(Get-LoopLines $c); $l[0] = $l[0].Replace('  ', ' '); Write-LoopManifest $c $l } 'every manifest path is a safe relative path'
LFail 'loop-duplicate-path' { param($c, $m) $l = @(Get-LoopLines $c); Write-LoopManifest $c ($l + $l[0]) } 'manifest paths are unique'
LFail 'loop-deleted-file' { param($c, $m) Remove-Item -LiteralPath (Join-Path $c.Repo 'README.md') } 'only modified or new files'
LFail 'loop-too-many' { param($c, $m) $many = @(1..38 | ForEach-Object { 'lib/many/f{0:D2}.ts' -f $_ }); foreach ($f in $many) { Set-LoopRepoFile $c $f }; New-LoopInput $c ($LFiles + $many) } 'manifest lists 1-40 files'
LFail 'loop-too-large' { param($c, $m) Set-LoopRepoFile $c 'docs/big.md' ('x' * (2MB + 1)); New-LoopInput $c ($LFiles + 'docs/big.md') } 'frozen files total at most'
LFail 'loop-frozen-tampered' { param($c, $m) [IO.File]::AppendAllText((Join-Path $c.Review 'codex-trial\inputs\loop-current\files\lib\new\thing.ts'), 'x') } 'every frozen file matches the manifest'
LFail 'loop-repo-changed-after-freeze' { param($c, $m) [IO.File]::AppendAllText((Join-Path $c.Repo 'app\api\scan\route.ts'), 'x') } 'freeze valid'
$c = New-LoopCase 'loop-forty-ok'; $many = @(1..37 | ForEach-Object { 'lib/many/f{0:D2}.ts' -f $_ }); foreach ($f in $many) { Set-LoopRepoFile $c $f }; $m = New-LoopInput $c ($LFiles + $many)
$r = Run-Runner $c 'Proof' 'proof-ok' (L @{ manifest = $m })
Check 'Loop Proof PASS at exactly 40 files (boundary)' ($r.Code -eq 0) ("exit $($r.Code)")

function LReviewFail([string]$Name, [scriptblock]$Between, [string]$FailText, [hashtable]$More = @{}) {
  $c = New-LoopCase $Name; $m = New-LoopInput $c
  $p = Run-Runner $c 'Proof' 'proof-ok' (L @{ manifest = $m })
  if ($p.Code -ne 0) { Check "Loop Review ${Name}: precondition proof passed" $false ("proof exit $($p.Code)"); return }
  & $Between $c
  $x = L @{ manifest = $m }; foreach ($k in $More.Keys) { $x[$k] = $More[$k] }
  $r = Run-Runner $c 'Review' 'review-ok' $x
  Check "Loop Review FAIL: $Name (exit 1)" ($r.Code -eq 1) ("exit $($r.Code)")
  Check "Loop Review FAIL: $Name names the failing check" ($r.Out -match ('\[FAIL\][^\r\n]*' + [regex]::Escape($FailText))) ''
  Check "Loop Review FAIL: $Name made no review call" (-not (Test-Path (Join-Path $c.Run 'review-events.jsonl'))) ''
}
LReviewFail 'loop-review-repo-changed' { param($c) [IO.File]::AppendAllText((Join-Path $c.Repo 'lib\new\thing.ts'), 'x') } 'freeze valid'
LReviewFail 'loop-review-new-repo-file' { param($c) Set-LoopRepoFile $c 'docs/late.md' } 'manifest equals the working repository uncommitted changes exactly'
LReviewFail 'loop-review-other-base' { param($c) } 'proof covered the same commit range' @{ inputbase = $Head }
LReviewFail 'loop-review-clone-tampered' { param($c) [IO.File]::AppendAllText((Join-Path $c.Trial 'lib\new\thing.ts'), 'x') } 'clone copies are byte-identical'
$c = New-LoopCase 'loop-review-touches-gate-file'; $m = New-LoopInput $c; $p = Run-Runner $c 'Proof' 'proof-ok' (L @{ manifest = $m })
$r = Run-Runner $c 'Review' 'review-ok,review-touches-gate-file' (L @{ manifest = $m })
Check 'Loop: Review FAILS on a mid-run content change to a frozen working-repository file' ($p.Code -eq 0 -and $r.Code -eq 1 -and $r.Out -match '\[FAIL\] integrity identical after review' -and $r.Out -match 'repo gate file app/api/scan/route.ts') ("proof $($p.Code), review $($r.Code)")

# The existing targets are unchanged by the Loop addition
Check 'PR43 target unchanged (base, head, 3 files)' ($Targets.PR43.Kind -ceq 'range' -and $Targets.PR43.Base -ceq '29e98c31575efb1650117cb938d8c7e1628ec5a9' -and $Targets.PR43.Head -ceq '316159622779d2940c0610e9c1f7c81421fd6849' -and (@($Targets.PR43.Files) -join '|') -ceq '.agents/state.yaml|docs/gates/gate-006c-p5b-key-vault-secrets.md|docs/gates/gate-006c-staging-readiness-plan.md') ''
Check 'Gate007A target unchanged (base 1810aeb, the 15 files)' ($Targets.Gate007A.Kind -ceq 'uncommitted' -and $Targets.Gate007A.Base -ceq '1810aeb4c2d13782a192a302cc0b6cd9bad5d2d9' -and (@($Targets.Gate007A.Files) -join '|') -ceq ($G7Files -join '|')) ''
Check 'Loop forbidden list covers .env, keys, package files, agent settings and the constitution' (@(@('.env', '.env.local', 'a/.env.prod', 'package.json', 'package-lock.json', 'x/server.key', 'id_rsa', '.claude/settings.json', '.codex/config.toml', 'AGENTS.md', 'CLAUDE.md', 'node_modules/a.js', '.next/x', '.git/config', '.npmrc', 'secrets.json', 'credentials') | Where-Object { -not ($_ -match $LoopForbiddenRx) }).Count -eq 0) ''
Check 'Loop forbidden list allows ordinary gate files' (@(@('.agents/state.yaml', 'docs/gates/gate-006c-p5b-key-vault-secrets.md', 'lib/security/rateLimit.ts', 'infra/supabase/migrations/001_scan_admission.sql', '.github/workflows/ci.yml') | Where-Object { $_ -match $LoopForbiddenRx }).Count -eq 0) ''

# the real 0.163.0 rule, reproduced by the fake: custom instructions cannot be combined with --uncommitted
$env:FAKE_SCENARIO = 'review-ok'
$o7 = Join-Path $Root 'g7-prompt-check.md'
$r = Invoke-Codex (@('exec', 'review', '--uncommitted') + $IsoFlagsBase + $Iso + @('-o', $o7, 'Focus on security.')) $Root 30
Check 'G7 custom instructions with --uncommitted are rejected (exit 2), as in Codex 0.163.0' ($r.ExitCode -eq 2 -and $r.StdErr -match "cannot be used with '\[PROMPT\]'") ''
$rsrc7 = [IO.File]::ReadAllText($Runner)
Check 'G7 static: the runner never appends custom instructions to a review (native review only)' ($rsrc7 -match "\@\('exec', 'review'\) \+ \`$reviewTarget \+ \`$IsoFlagsBase \+ \`$Iso \+ \@\('-o', \`$out\)\)" -and $rsrc7 -match "@\('--uncommitted'\)") ''

# ===== 5. static checks on the runner =====
$tok = $null; $perr = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tok, [ref]$perr)
Check 'runner parses with no errors' ($perr.Count -eq 0) (($perr | ForEach-Object { $_.Message }) -join '; ')
$bytes = [IO.File]::ReadAllBytes($Runner); Check 'runner is ASCII only' (-not @($bytes | Where-Object { $_ -gt 127 }).Count) ''
$src = [IO.File]::ReadAllText($Runner)
Check 'runner never starts cmd.exe or a shell string' (-not ($src -match '(?i)cmd(\.exe)?\s*/c|ComSpec|Invoke-Expression|\biex\b')) ''
Check 'runner never reads the Codex home folder' (-not ($src -match '(?i)\.codex\\|auth\.json|config\.toml')) ''
$esrc = [IO.File]::ReadAllText($Entry)
Check 'offline entry is clearly test-only and sets TestMode' ($esrc.Contains('OFFLINE TEST PATH ONLY') -and $esrc.Contains('$TestMode = -not $NoTestMode')) ''
Check 'runner has no dangerous Codex flags' (-not ($src -match '(?i)dangerously|full-auto|workspace-write|enable-review-gate|codex:rescue')) ''

Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:FAKE_SCENARIO, Env:FAKE_OUTSIDE_FILE, Env:FAKE_REPO_FILE, Env:FAKE_STATE_FILE, Env:FAKE_GATE_FILE -ErrorAction SilentlyContinue
Write-Host ("`noffline tests: {0} checks, {1} failed" -f $script:n, $script:fail)
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
