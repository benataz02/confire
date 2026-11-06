<# : batch part - PowerShell reads this block as a comment
@echo off
rem Tests confire-print.exe on the SAP server, without the agent. Put this file beside
rem confire-print.exe and double-click it: it asks for everything, nothing needs editing.
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText('%~f0'))"
echo.
pause
exit /b
#>

$ErrorActionPreference = "Stop"
$exe = Join-Path $env:HERE "confire-print.exe"
if (-not (Test-Path $exe)) { "confire-print.exe is not in $env:HERE"; return }

function Ask($label, $default) {
  $v = Read-Host "$label [$default]"
  if ($v) { return $v.Trim() }
  return $default
}

$env:SQL_SERVER = Ask "SQL Server instance (e.g. SAPSRV or SAPSRV\SQL2019)" $env:COMPUTERNAME
$env:SQL_USER = Ask "SQL user" "sa"
# Asked, never saved: the password exists only in this window's environment.
$sec = Read-Host "SQL password" -AsSecureString
$env:SQL_PASS = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$env:COMPANY_DB = ""
while (-not $env:COMPANY_DB) { $env:COMPANY_DB = Ask "Company database (e.g. SBO_COMPANY)" "" }

""
"1) Check: SQL login, RDOC, Crystal runtime"
& $exe --check
if ($LASTEXITCODE -ne 0) { ""; "Check failed (above). Run this again with other answers."; return }

# One print service for every print, as the agent runs it: the first print loads Crystal and the
# layout (slow), a repeat shows the speed Confire will see.
$psi = New-Object Diagnostics.ProcessStartInfo $exe
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$child = [Diagnostics.Process]::Start($psi)
$objectIds = @{ QUT = 23; RDR = 17; DLN = 15; INV = 13 }
$layout = "QUT20009"
while ($true) {
  ""
  "2) Print a document (empty DocEntry = finish)"
  $layout = (Ask "Layout (QUT.. quotation, RDR.. order, DLN.. delivery, INV.. invoice)" $layout).ToUpper()
  $docEntry = Ask "DocEntry" ""
  if (-not $docEntry) { break }
  $prefix = $layout.Substring(0, [Math]::Min(3, $layout.Length))
  if (-not $objectIds.ContainsKey($prefix)) { "The layout must start with QUT, RDR, DLN or INV."; continue }
  $n = $docEntry -as [long]
  if (-not $n -or $n -lt 1) { "DocEntry must be a number."; continue }
  $request = '{"layout":"' + $layout + '","docEntry":' + $n + ',"objectId":' + $objectIds[$prefix] + '}'
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $child.StandardInput.WriteLine($request)
  $reply = $child.StandardOutput.ReadLine()
  $secs = "{0:N1}" -f $clock.Elapsed.TotalSeconds
  if ($reply -eq $null) { "The print service stopped (its error is above)."; break }
  if ($reply -match '^\{"pdf":"([^"]+)"\}$') {
    $pdf = Join-Path $env:HERE ($layout + "-" + $docEntry + ".pdf")
    [IO.File]::WriteAllBytes($pdf, [Convert]::FromBase64String(($Matches[1] -replace '\\/', '/')))
    "OK in $secs s: $pdf"
    Invoke-Item $pdf
  } else {
    "FAILED after $secs s:"
    $reply
  }
}
$child.StandardInput.Close()
$child.WaitForExit(5000) | Out-Null
