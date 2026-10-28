<#
  Gate 006C - library for Initialize-StagingAuthTest.ps1 (founder-run bootstrap of the
  staging-auth-test environment and its two staging test accounts).

  All I/O goes through two guarded functions, Invoke-Gh and Invoke-CbcHttp, so the
  offline tests can replace them. Each refuses anything outside a fixed allow-list:
    - gh: the founder's own login, this repository, three staging repository variables,
      the staging-auth-test environment, its branch policy, its four secrets (values on
      stdin, never in arguments) and two variables. No workflow command exists here.
    - HTTPS: on the staging Supabase project only POST /auth/v1/signup, POST
      /auth/v1/logout, GET /auth/v1/settings and a GET of the caller's own users row; on
      the staging app only POST /api/auth/login, GET /api/scan/<uuid>/status and GET
      /auth/signout. No admin endpoint, no service-role key, no direct database access.
  Passwords are generated here (CSPRNG), sent only to the signup endpoint, the app login
  and GitHub's encrypted secret store, and never printed or written to a file.
  Windows PowerShell 5.1 compatible.
#>

$script:Cbc = @{
  Repo          = 'wberytech-stack/checkbeforeclick'
  Founder       = 'wberytech-stack'
  StagingRef    = 'zgxmvpbvvakpsnzcymsf'
  ProductionRef = 'qnjqwmcsfpmpnvlnomat'
  Environment   = 'staging-auth-test'
  AppHost       = '^ca-cbc-web-stg-cc-001\.[a-z0-9-]+\.canadacentral\.azurecontainerapps\.io$'
  Uuid          = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

class CbcStop : System.Exception { CbcStop([string]$m) : base($m) {} }
# A user was created but its credential pair is incomplete: never a success, founder
# recovery required (see Get-PartialRecovery).
class CbcPartial : CbcStop { CbcPartial([string]$m) : base($m) {} }
function Stop-Bootstrap([string]$Message) { throw [CbcStop]::new($Message) }
function Stop-Partial([string]$Message) { throw [CbcPartial]::new($Message) }
function Get-PartialRecovery([string]$Label, [int]$Generation) {
  return "Founder recovery: rerun with -Replace -Generation $($Generation + 1) (creates and verifies a fresh account $Label and overwrites both of its secrets), then delete the orphaned staging user for account $Label in Supabase (Authentication, Users; address +cbc-stg-test-$($Label.ToLowerInvariant())-g<earlier generation>)."
}

# ------------------------------------------------------------------ guarded gh
function Test-GhAllowed([string[]]$GhArgs) {
  $r = [regex]::Escape($script:Cbc.Repo); $e = [regex]::Escape($script:Cbc.Environment)
  $line = $GhArgs -join ' '
  $allowed = @(
    '^api user$',
    "^api repos/$r$",
    "^api repos/$r/actions/variables/CBC_STG_NEXT_PUBLIC_(SUPABASE_URL|SUPABASE_ANON_KEY|APP_URL)$",
    "^api repos/$r/environments/$e$",
    "^api -i repos/$r/environments/$e$",
    "^api -X PUT repos/$r/environments/$e --input -$",
    "^api repos/$r/environments/$e/deployment-branch-policies$",
    "^api -X POST repos/$r/environments/$e/deployment-branch-policies -f name=master -f type=branch$",
    "^secret set CBC_TEST_[AB]_(EMAIL|PASSWORD) --env $e --repo $r$",
    "^secret list --env $e --repo $r --json name$",
    "^variable set CBC_TEST_[AB]_ORG_ID --env $e --repo $r --body [0-9a-f-]{36}$",
    "^variable list --env $e --repo $r --json name,value$"
  )
  return @($allowed | Where-Object { $line -match $_ }).Count -eq 1
}

# Runs gh with the given arguments; StdIn (a secret value) is written to gh's standard
# input and never appears in the command line. Returns @{ Code; Out }.
function Invoke-Gh([string[]]$GhArgs, [string]$StdIn = $null) {
  if (-not (Test-GhAllowed $GhArgs)) { Stop-Bootstrap "refused gh call outside the bootstrap allow-list: $($GhArgs[0..1] -join ' ')" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'gh'
  $psi.Arguments = ($GhArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  if ($null -ne $StdIn) { $p.StandardInput.Write($StdIn) }
  $p.StandardInput.Close()
  $out = $p.StandardOutput.ReadToEnd(); $null = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return @{ Code = $p.ExitCode; Out = $out.Trim() }
}

# ------------------------------------------------------------------ guarded HTTPS
function Test-HttpAllowed([string]$Method, [string]$Url, [string]$AppHost) {
  try { $u = [Uri]$Url } catch { return $false }
  if ($u.Scheme -ne 'https') { return $false }
  $sb = "$($script:Cbc.StagingRef).supabase.co"
  $path = $u.AbsolutePath; $q = $u.Query
  if ($u.Host -eq $sb) {
    if ($Method -eq 'POST' -and ($path -eq '/auth/v1/signup' -or $path -eq '/auth/v1/logout') -and $q -eq '') { return $true }
    if ($Method -eq 'GET' -and $path -eq '/auth/v1/settings' -and $q -eq '') { return $true }
    if ($Method -eq 'GET' -and $path -eq '/rest/v1/users' -and $q -match "^\?select=id,organization_id&id=eq\.[0-9a-f-]{36}$") { return $true }
    return $false
  }
  if ($AppHost -and $u.Host -eq $AppHost -and $u.Host -match $script:Cbc.AppHost) {
    if ($Method -eq 'POST' -and $path -eq '/api/auth/login' -and $q -eq '') { return $true }
    if ($Method -eq 'GET' -and $path -match '^/api/scan/[0-9a-f-]{36}/status$' -and $q -eq '') { return $true }
    if ($Method -eq 'GET' -and $path -eq '/auth/signout' -and $q -eq '') { return $true }
  }
  return $false
}

# One HTTPS request; no redirects, no cookie store, 20 s timeout. Returns
# @{ Status; Body; SetCookie }.
function Invoke-CbcHttp([string]$Method, [string]$Url, [hashtable]$Headers = @{}, [string]$Body = $null, [string]$AppHost = $null) {
  if (-not (Test-HttpAllowed $Method $Url $AppHost)) { Stop-Bootstrap "refused $Method outside the bootstrap allow-list" }
  Add-Type -AssemblyName System.Net.Http
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $h = New-Object System.Net.Http.HttpClientHandler
  $h.AllowAutoRedirect = $false; $h.UseCookies = $false
  $c = New-Object System.Net.Http.HttpClient($h)
  $c.Timeout = [TimeSpan]::FromSeconds(20)
  try {
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($Method), $Url)
    foreach ($k in $Headers.Keys) { $null = $req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) }
    if ($null -ne $Body) { $req.Content = New-Object System.Net.Http.StringContent($Body, [Text.Encoding]::UTF8, 'application/json') }
    $res = $c.SendAsync($req).GetAwaiter().GetResult()
    $text = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $cookies = @(); $vals = $null
    if ($res.Headers.TryGetValues('Set-Cookie', [ref]$vals)) { $cookies = @($vals) }
    return @{ Status = [int]$res.StatusCode; Body = $text; SetCookie = $cookies }
  } finally { $c.Dispose() }
}

# ------------------------------------------------------------------ helpers
# PowerShell 5.1 ConvertFrom-Json emits a JSON array as ONE object; assigning it and then
# returning the variable enumerates it, so callers' @(...) sees each element once.
function ConvertFrom-JsonSafe([string]$Text) {
  if (-not $Text) { return $null }
  try { $o = ConvertFrom-Json -InputObject $Text } catch { return $null }
  return $o
}

function Get-JwtClaims([string]$Token) {
  try {
    $p = $Token.Split('.')[1].Replace('-', '+').Replace('_', '/')
    switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
    return ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)))
  } catch { return $null }
}

# 32 characters from a CSPRNG, at least one of each class; never printed.
function New-CbcPassword {
  $sets = @('ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+-=?@^_')
  $all = -join $sets
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $pick = { param($s) $b = New-Object byte[] 4; $rng.GetBytes($b); $s[[BitConverter]::ToUInt32($b, 0) % $s.Length] }
  do {
    $chars = 1..32 | ForEach-Object { & $pick $all }
    $pw = -join $chars
  } until (($sets | Where-Object { $set = $_; ($pw.ToCharArray() | Where-Object { $set.Contains([string]$_) }).Count -gt 0 }).Count -eq 4)
  $rng.Dispose()
  return $pw
}

function Get-TestEmail([string]$Base, [string]$Label, [int]$Generation) {
  if ($Base -notmatch '^([A-Za-z0-9._%-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$') { Stop-Bootstrap '-EmailBase must be an address you control, like you@yourdomain.com (no + part)' }
  return "$($Matches[1])+cbc-stg-test-$Label-g$Generation@$($Matches[2])".ToLowerInvariant()
}

# ------------------------------------------------------------------ environment validation
# Read-only. Returns @{ Problems; Policies }. Compatible means: exactly one
# required-reviewers rule whose reviewers are exactly the founder; deployments restricted
# to selected branches (custom policies on, protected-branches mode off); branch policies
# empty or exactly branch:master; no protection rule types other than required_reviewers,
# wait_timer and branch_policy. Stricter settings that are present (a wait timer,
# prevent_self_review) are left untouched, never removed.
function Get-EnvProblems($EnvResponse, [string]$R, [string]$E, [long]$FounderId) {
  $problems = New-Object System.Collections.ArrayList
  $envObj = ConvertFrom-JsonSafe $EnvResponse.Out
  if ($EnvResponse.Code -ne 0 -or -not $envObj) { [void]$problems.Add('environment could not be read'); return @{ Problems = $problems; Policies = @() } }
  $rules = @($envObj.protection_rules | Where-Object { $_ })
  $unknown = @($rules | Where-Object { $_.type -notin 'required_reviewers', 'wait_timer', 'branch_policy' } | ForEach-Object { [string]$_.type })
  if ($unknown.Count) { [void]$problems.Add("unexpected protection rule type(s): $($unknown -join ', ')") }
  $rev = @($rules | Where-Object { $_.type -eq 'required_reviewers' })
  $ids = @($rev | ForEach-Object { @($_.reviewers) } | Where-Object { $_ } | ForEach-Object { "$($_.type):$($_.reviewer.id)" })
  if ($rev.Count -ne 1 -or ($ids -join ',') -ne "User:$FounderId") { [void]$problems.Add('required reviewers are not exactly you') }
  $dbp = $envObj.deployment_branch_policy
  if ($null -eq $dbp -or $dbp.protected_branches -ne $false -or $dbp.custom_branch_policies -ne $true) {
    [void]$problems.Add('deployments are not restricted to selected branches (custom branch policies)')
  }
  $policies = @()
  $pr = Invoke-Gh @('api', "repos/$R/environments/$E/deployment-branch-policies")
  if ($pr.Code -ne 0) { [void]$problems.Add('branch policies could not be read') }
  else {
    $policies = @(@((ConvertFrom-JsonSafe $pr.Out).branch_policies) | Where-Object { $_ } | ForEach-Object { "$(if ($_.type) { $_.type } else { 'branch' }):$($_.name)" })
    $other = @($policies | Where-Object { $_ -ne 'branch:master' })
    if ($other.Count) { [void]$problems.Add("deployment policies other than branch master: $($other -join ', ')") }
  }
  return @{ Problems = $problems; Policies = $policies }
}

# Does the environment exist? Read-only, with the HTTP status line (`gh api -i`), because a
# nonzero gh exit code alone cannot tell "absent" from 403, 500, an auth or network error.
# Only two answers are accepted:
#   absent : status line 404, gh exit nonzero, JSON body {"message":"Not Found"}
#   present: status line 200, gh exit 0, JSON body naming this environment
# Anything else (no status line, any other status, a malformed body, or a status that
# contradicts the exit code) stops the run; it is never read as permission to create.
# Returns @{ Code = 0 (present) or 404 (absent); Out = the JSON body }.
function Get-EnvLookup([string]$R, [string]$E) {
  $res = Invoke-Gh @('api', '-i', "repos/$R/environments/$E")
  $text = ([string]$res.Out) -replace "`r`n", "`n"
  $m = [regex]::Match($text, '^HTTP/[0-9.]+ (\d{3})\b')
  if (-not $m.Success) { Stop-Bootstrap "environment lookup returned no HTTP status (gh exit $($res.Code)); nothing was changed. Check 'gh auth status' and the network, then rerun" }
  $status = [int]$m.Groups[1].Value
  $sep = $text.IndexOf("`n`n")
  $body = if ($sep -ge 0) { $text.Substring($sep + 2).Trim() } else { '' }
  $json = ConvertFrom-JsonSafe $body
  if ($status -eq 404 -and $res.Code -ne 0 -and $json -and $json.message -eq 'Not Found') { return @{ Code = 404; Out = $body } }
  if ($status -eq 200 -and $res.Code -eq 0 -and $json -and $json.name -eq $E) { return @{ Code = 0; Out = $body } }
  Stop-Bootstrap "environment lookup was not a clear 200 or 404 (HTTP $status, gh exit $($res.Code)); nothing was changed. The environment's existence is unknown, so it will not be created or modified"
}

# ------------------------------------------------------------------ bootstrap
function Invoke-StagingAuthBootstrap {
  param(
    [Parameter(Mandatory = $true)][string]$EmailBase,
    [int]$Generation = 1,
    [string]$OrgIdA = '',
    [string]$OrgIdB = '',
    # Accounts whose two secrets already exist cannot be re-verified here (secret values
    # are never read back). Choose one explicitly: -Replace creates and verifies a fresh
    # pair and overwrites the secrets; -AttestExisting keeps them on founder attestation
    # (with -OrgIdA/-OrgIdB) and the outcome is ATTESTED, not VERIFIED.
    [switch]$AttestExisting,
    [switch]$Replace,
    [scriptblock]$Log = { param($m) Write-Host $m }
  )
  $R = $script:Cbc.Repo; $E = $script:Cbc.Environment
  $report = [ordered]@{
    Created = New-Object System.Collections.ArrayList; Verification = $null; OrgEvidence = $null
    Accounts = [ordered]@{ A = $null; B = $null }; Outcome = $null; Notes = New-Object System.Collections.ArrayList
  }
  $script:LastReport = $report
  $note = { param($m) [void]$report.Created.Add($m); & $Log "  created: $m" }

  # ---- preflight: nothing is written until all of these pass
  & $Log '== Preflight (read-only)'
  $u = Invoke-Gh @('api', 'user'); $user = ConvertFrom-JsonSafe $u.Out
  if ($u.Code -ne 0 -or -not $user) { Stop-Bootstrap 'GitHub CLI is not signed in. Run: gh auth login' }
  if ($user.login -ne $script:Cbc.Founder) { Stop-Bootstrap "GitHub CLI is signed in as '$($user.login)', not $($script:Cbc.Founder)" }
  $repo = ConvertFrom-JsonSafe (Invoke-Gh @('api', "repos/$R")).Out
  if (-not $repo -or $repo.full_name -ne $R) { Stop-Bootstrap "repository is not exactly $R" }
  & $Log "  ok  GitHub user $($user.login); repository $R"

  $var = { param($n) $x = ConvertFrom-JsonSafe (Invoke-Gh @('api', "repos/$R/actions/variables/$n")).Out; if ($x) { [string]$x.value } else { '' } }
  $sbUrl = & $var 'CBC_STG_NEXT_PUBLIC_SUPABASE_URL'
  $anon = & $var 'CBC_STG_NEXT_PUBLIC_SUPABASE_ANON_KEY'
  $appUrl = & $var 'CBC_STG_NEXT_PUBLIC_APP_URL'
  if ($sbUrl -ne "https://$($script:Cbc.StagingRef).supabase.co") { Stop-Bootstrap "CBC_STG_NEXT_PUBLIC_SUPABASE_URL is not the staging project $($script:Cbc.StagingRef)" }
  $claims = Get-JwtClaims $anon
  if (-not $claims -or $claims.role -ne 'anon' -or $claims.ref -ne $script:Cbc.StagingRef) { Stop-Bootstrap 'the staging public key is not an anon key for the staging project' }
  $appHost = ''; try { $appHost = ([Uri]$appUrl).Host } catch { }
  if ($appHost -notmatch $script:Cbc.AppHost -or $appUrl -ne "https://$appHost") { Stop-Bootstrap 'CBC_STG_NEXT_PUBLIC_APP_URL is not the staging Container App origin' }
  & $Log "  ok  Supabase project $($script:Cbc.StagingRef); staging app $appHost"

  $sb = $sbUrl
  $settings = ConvertFrom-JsonSafe (Invoke-CbcHttp 'GET' "$sb/auth/v1/settings" @{ apikey = $anon }).Body
  if (-not $settings -or $settings.external.email -ne $true -or $settings.disable_signup -eq $true -or $settings.mailer_autoconfirm -ne $true) {
    Stop-Bootstrap 'staging Auth does not allow confirmed email signup (needs email provider on, signup enabled, email autoconfirm on). Create the two users in the Supabase dashboard instead (gate document, step 3.1)'
  }
  & $Log '  ok  staging Auth: email signup enabled with autoconfirm'

  $emails = @{ A = (Get-TestEmail $EmailBase 'a' $Generation); B = (Get-TestEmail $EmailBase 'b' $Generation) }
  foreach ($k in @('OrgIdA', 'OrgIdB')) { $v = (Get-Variable $k -ValueOnly); if ($v -and $v -notmatch $script:Cbc.Uuid) { Stop-Bootstrap "-$k must be a lowercase UUID" } }

  # Code 0 = confirmed present, 404 = confirmed absent; anything else has already stopped.
  $envNow = Get-EnvLookup $R $E
  $secretNames = @(); $vars = @{}
  if ($envNow.Code -eq 0) {
    $secretNames = @((ConvertFrom-JsonSafe (Invoke-Gh @('secret', 'list', '--env', $E, '--repo', $R, '--json', 'name')).Out) | ForEach-Object { $_.name })
    foreach ($v in @(ConvertFrom-JsonSafe (Invoke-Gh @('variable', 'list', '--env', $E, '--repo', $R, '--json', 'name,value')).Out)) { if ($v) { $vars[$v.name] = [string]$v.value } }
  }
  if ($AttestExisting -and $Replace) { Stop-Bootstrap 'use either -Replace or -AttestExisting, not both' }
  $state = @{}
  foreach ($x in @('A', 'B')) {
    $present = @("CBC_TEST_$($x)_EMAIL", "CBC_TEST_$($x)_PASSWORD" | Where-Object { $secretNames -contains $_ })
    if ($present.Count -eq 1) {
      # R2: an earlier run created the user but stored only one secret.
      if (-not $Replace) {
        Stop-Partial "PARTIAL: environment holds only $($present[0]) for account $x (an earlier run created the user but did not store both credentials). This is not a completed bootstrap. $(Get-PartialRecovery $x $Generation)"
      }
      & $Log "  account ${x}: incomplete credential pair will be replaced (-Replace)"
      $state[$x] = 'new'
    } elseif ($present.Count -eq 2) {
      # R1: two secret names prove nothing about authentication or the profile.
      if ($Replace) { $state[$x] = 'new'; & $Log "  account ${x}: stored credentials will be replaced (-Replace)" }
      elseif ($AttestExisting) { $state[$x] = 'attested' }
      else {
        Stop-Bootstrap "account $x already has stored credentials, which this script cannot verify without reading secrets. Choose one: rerun with -Replace -Generation $($Generation + 1) (creates and verifies a fresh account, overwrites its secrets), or rerun with -AttestExisting -OrgIdA <uuid> -OrgIdB <uuid> (your attestation; outcome ATTESTED, verified only by the first staging-auth-journeys run)"
      }
    } else { $state[$x] = 'new' }
  }
  if ($AttestExisting) {
    if (@($state.Values | Where-Object { $_ -eq 'attested' }).Count -eq 0) { Stop-Bootstrap '-AttestExisting was given but no account has stored credentials' }
    foreach ($x in @('A', 'B')) {
      if ($state[$x] -eq 'attested' -and -not (Get-Variable "OrgId$x" -ValueOnly)) { Stop-Bootstrap "-AttestExisting needs -OrgId$x (organization_id from the read-only SQL in the gate document, step 3.2)" }
    }
  }
  $envPlan = 'create'
  if ($envNow.Code -eq 0) {
    $check = Get-EnvProblems $envNow $R $E ([long]$user.id)
    if ($check.Problems.Count -gt 0) {
      Stop-Bootstrap "existing environment $E is not compatible, so nothing was changed: $(@($check.Problems) -join '; '). Fix it in GitHub (Settings, Environments) or delete the environment so this script can create it, then rerun"
    }
    $envPlan = if ($check.Policies.Count -eq 0) { 'add-master' } else { 'keep' }
  }
  & $Log "  ok  environment $E $(if ($envNow.Code -eq 0) { "exists and is compatible ($envPlan)" } else { 'does not exist yet' }); account A $($state.A), account B $($state.B)"

  # ---- environment: founder as required reviewer, deployments from master only.
  # The existing environment was validated read-only in preflight. An existing
  # environment is never PUT (a PUT would replace its protections); the only writes are
  # creating an absent environment, or adding the master policy to a compliant one.
  & $Log "== GitHub environment $E"
  if ($envPlan -eq 'create') {
    $body = @{ reviewers = @(@{ type = 'User'; id = [long]$user.id }); deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true } } | ConvertTo-Json -Depth 5 -Compress
    if ((Invoke-Gh @('api', '-X', 'PUT', "repos/$R/environments/$E", '--input', '-') $body).Code -ne 0) { Stop-Bootstrap "could not create environment $E" }
    & $note "environment $E"
  }
  if ($envPlan -in 'create', 'add-master') {
    if ((Invoke-Gh @('api', '-X', 'POST', "repos/$R/environments/$E/deployment-branch-policies", '-f', 'name=master', '-f', 'type=branch')).Code -ne 0) { Stop-Bootstrap 'could not restrict deployments to master' }
    & $note 'deployment branch policy master'
    # Re-validate immediately after writing, before any account is touched.
    $after = Get-EnvProblems (Invoke-Gh @('api', "repos/$R/environments/$E")) $R $E ([long]$user.id)
    if ($after.Problems.Count -gt 0 -or $after.Policies.Count -ne 1) { Stop-Bootstrap "environment $E is not as expected after setup: $(@($after.Problems) -join '; ')" }
  }
  & $Log $(if ($envPlan -eq 'keep') { '  ok  existing environment already compliant; not modified' } else { '  ok  required reviewer and master-only deployments set' })

  # ---- accounts
  $observed = @{ A = $null; B = $null }
  foreach ($x in @('A', 'B')) {
    & $Log "== Account $x ($($emails[$x]))"
    if ($state[$x] -eq 'attested') {
      $report.Accounts[$x] = 'ATTESTED'
      & $Log '  stored credentials kept on founder attestation; sign-in and profile NOT verified by this run (J1-J4 of the first staging-auth-journeys run verify them)'
      continue
    }
    $pw = New-CbcPassword
    $su = Invoke-CbcHttp 'POST' "$sb/auth/v1/signup" @{ apikey = $anon } (@{ email = $emails[$x]; password = $pw } | ConvertTo-Json -Compress)
    $sj = ConvertFrom-JsonSafe $su.Body
    if ($su.Status -in 400, 422 -and $sj -and ("$($sj.error_code)$($sj.code)$($sj.msg)$($sj.message)" -match 'already|exists|registered')) {
      Stop-Bootstrap "a user $($emails[$x]) already exists but its credentials are not stored. Delete it in Supabase (Authentication, Users) or rerun with -Generation $($Generation + 1)"
    }
    $token = if ($sj) { [string]$sj.access_token } else { '' }
    $uid = if ($sj -and $sj.user) { [string]$sj.user.id } else { '' }
    if ($su.Status -ne 200 -or -not $token -or $uid -notmatch $script:Cbc.Uuid -or -not $sj.user.email_confirmed_at) { Stop-Bootstrap "signup for account $x did not return a confirmed user with a session (status $($su.Status)); nothing stored for it" }
    & $note "staging user $($emails[$x])"
    # Store the credentials at once, so a later failure cannot lose them. If only one of
    # the two is stored, the result is PARTIAL (R2), never an ordinary failure or success.
    $stored = @()
    foreach ($pair in @(@("CBC_TEST_$($x)_EMAIL", $emails[$x]), @("CBC_TEST_$($x)_PASSWORD", $pw))) {
      if ((Invoke-Gh @('secret', 'set', $pair[0], '--env', $E, '--repo', $R) $pair[1]).Code -ne 0) {
        $pw = $null; $token = $null
        if ($stored.Count -eq 0) { Stop-Bootstrap "user $($emails[$x]) was created but no credential could be stored. Delete it in Supabase (Authentication, Users) or rerun with -Generation $($Generation + 1)" }
        Stop-Partial "PARTIAL: user $($emails[$x]) was created and $($stored -join ', ') stored, but $($pair[0]) could not be stored. $(Get-PartialRecovery $x $Generation)"
      }
      $stored += $pair[0]
      & $note "secret $($pair[0])"
    }
    if ($Replace) { [void]$report.Notes.Add("account ${x}: credentials replaced; delete the earlier staging user for account $x in Supabase (Authentication, Users)") }
    # Profile and organization: the account's own users row, read with its own token.
    $row = Invoke-CbcHttp 'GET' "$sb/rest/v1/users?select=id,organization_id&id=eq.$uid" @{ apikey = $anon; authorization = "Bearer $token"; accept = 'application/json' }
    $rows = @(ConvertFrom-JsonSafe $row.Body)
    if ($row.Status -eq 200 -and $rows.Count -eq 1 -and $rows[0] -and $rows[0].id -eq $uid -and ([string]$rows[0].organization_id) -match $script:Cbc.Uuid) {
      $observed[$x] = ([string]$rows[0].organization_id).ToLowerInvariant()
      & $Log '  ok  own users row with an organization (observed)'
    } else {
      # Not readable under RLS: confirm the profile exists through the app instead
      # (the status API answers 403 without a profile, 404 with one).
      $login = Invoke-CbcHttp 'POST' "$appUrl/api/auth/login" @{ accept = 'application/json' } (@{ email = $emails[$x]; password = $pw } | ConvertTo-Json -Compress) $appHost
      $cookie = (@($login.SetCookie | ForEach-Object { ($_ -split ';')[0] }) -join '; ')
      if ($login.Status -ne 200 -or -not $cookie) { Stop-Bootstrap "account $x could not sign in to the staging app (status $($login.Status))" }
      $probe = Invoke-CbcHttp 'GET' "$appUrl/api/scan/$([guid]::NewGuid())/status" @{ cookie = $cookie } $null $appHost
      $null = Invoke-CbcHttp 'GET' "$appUrl/auth/signout" @{ cookie = $cookie } $null $appHost
      if ($probe.Status -eq 403) { Stop-Bootstrap "account $x has no public.users profile or organization (the Auth trigger did not map it)" }
      if ($probe.Status -ne 404) { Stop-Bootstrap "could not confirm account $x's profile (status $($probe.Status))" }
      & $Log '  ok  profile and organization exist (confirmed through the app; organization id not readable under RLS)'
    }
    $null = Invoke-CbcHttp 'POST' "$sb/auth/v1/logout" @{ apikey = $anon; authorization = "Bearer $token" } '{}'
    $pw = $null; $token = $null
    $report.Accounts[$x] = 'VERIFIED'
  }

  # ---- organizations: distinct, observed where possible, otherwise founder evidence
  & $Log '== Organizations'
  $given = @{ A = $OrgIdA; B = $OrgIdB }
  $final = @{}
  foreach ($x in @('A', 'B')) {
    $cands = @($observed[$x], $given[$x], $vars["CBC_TEST_$($x)_ORG_ID"]) | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique
    if (@($cands).Count -gt 1) { Stop-Bootstrap "organization evidence for account $x is inconsistent (observed, -OrgId$x and the stored variable disagree)" }
    if (@($cands).Count -eq 0) { Stop-Bootstrap "account $x's organization could not be read under RLS. Run the read-only SQL in the gate document (step 3.2) and rerun with -OrgId$x <uuid>" }
    $final[$x] = @($cands)[0]
  }
  if ($final.A -eq $final.B) { Stop-Bootstrap 'accounts A and B are in the SAME organization; cross-tenant tests would be meaningless' }
  $report.OrgEvidence = if ($observed.A -and $observed.B) { 'VERIFIED (observed from each account''s own users row)' } else { 'ATTESTED (founder evidence or stored variable for at least one account)' }
  foreach ($x in @('A', 'B')) {
    if ($vars["CBC_TEST_$($x)_ORG_ID"] -ne $final[$x]) {
      if ((Invoke-Gh @('variable', 'set', "CBC_TEST_$($x)_ORG_ID", '--env', $E, '--repo', $R, '--body', $final[$x])).Code -ne 0) { Stop-Bootstrap "could not set CBC_TEST_$($x)_ORG_ID" }
      & $note "variable CBC_TEST_$($x)_ORG_ID"
    }
  }
  & $Log "  ok  distinct organizations: $($report.OrgEvidence)"

  # ---- verification (read-only; no workflow is dispatched)
  & $Log '== Verification'
  $env2 = ConvertFrom-JsonSafe (Invoke-Gh @('api', "repos/$R/environments/$E")).Out
  $rev = @($env2.protection_rules | Where-Object { $_.type -eq 'required_reviewers' } | ForEach-Object { $_.reviewers } | ForEach-Object { $_.reviewer.id })
  $pol2 = @((ConvertFrom-JsonSafe (Invoke-Gh @('api', "repos/$R/environments/$E/deployment-branch-policies")).Out).branch_policies | Where-Object { $_ } | ForEach-Object { "$($_.type):$($_.name)" })
  $sec2 = @((ConvertFrom-JsonSafe (Invoke-Gh @('secret', 'list', '--env', $E, '--repo', $R, '--json', 'name')).Out) | ForEach-Object { $_.name })
  $var2 = @{}; foreach ($v in @(ConvertFrom-JsonSafe (Invoke-Gh @('variable', 'list', '--env', $E, '--repo', $R, '--json', 'name,value')).Out)) { if ($v) { $var2[$v.name] = [string]$v.value } }
  $checks = [ordered]@{
    'founder is the required reviewer'               = ($rev -contains [long]$user.id)
    'deployments limited to master'                  = ($env2.deployment_branch_policy.custom_branch_policies -eq $true -and ($pol2 -join ',') -eq 'branch:master')
    'four credential secrets present'                = (@('CBC_TEST_A_EMAIL', 'CBC_TEST_A_PASSWORD', 'CBC_TEST_B_EMAIL', 'CBC_TEST_B_PASSWORD' | Where-Object { $sec2 -contains $_ }).Count -eq 4)
    'organization variables set, distinct, as found' = ($var2['CBC_TEST_A_ORG_ID'] -eq $final.A -and $var2['CBC_TEST_B_ORG_ID'] -eq $final.B -and $final.A -ne $final.B)
  }
  foreach ($k in $checks.Keys) { & $Log ("  {0}  {1}" -f $(if ($checks[$k]) { 'ok  ' } else { 'FAIL' }), $k) }
  $report.Verification = $checks
  if (@($checks.Values | Where-Object { -not $_ }).Count -gt 0) { Stop-Bootstrap 'verification failed; see the lines above' }
  # VERIFIED only if this run signed up and checked both accounts and observed both
  # organizations; anything resting on founder evidence is ATTESTED.
  $report.Outcome = if ($report.Accounts.A -eq 'VERIFIED' -and $report.Accounts.B -eq 'VERIFIED' -and $report.OrgEvidence -like 'VERIFIED*') { 'VERIFIED' } else { 'ATTESTED' }
  return $report
}
