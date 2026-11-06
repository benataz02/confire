<# : batch part - PowerShell reads this block as a comment
@echo off
rem Tests confire-print.exe on the SAP server, without the agent. Put this file beside
rem confire-print.exe, edit the settings below in Notepad, save, then double-click it.
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText('%~f0'))"
echo.
pause
exit /b
#>

# ---- Settings: edit these ------------------------------------------------------------
$env:SQL_SERVER = "SQLHOST"       # the SQL Server instance B1 runs on (e.g. SAPSRV or SAPSRV\SQL2019)
$env:SQL_USER   = "sa"
$env:COMPANY_DB = "SBO_COMPANY"   # the company database
$Layout   = "QUT20009"            # the document's default layout (Report and Layout Manager)
$DocEntry = 5                     # the document's DocEntry
$ObjectId = 23                    # 23 quotation, 17 order, 15 delivery, 13 invoice
# --------------------------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$exe = Join-Path $env:HERE "confire-print.exe"
if (-not (Test-Path $exe)) { "confire-print.exe is not in $env:HERE"; return }

# Asked, never saved: the password exists only in this window's environment.
$sec = Read-Host "SQL password for $env:SQL_USER" -AsSecureString
$env:SQL_PASS = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

"`n1) Check: SQL login, RDOC, Crystal runtime"
& $exe --check
if ($LASTEXITCODE -ne 0) { "`nCheck failed (above). Fix the settings and run this again."; return }

"`n2) Print $Layout, DocEntry $DocEntry"
$request = '{"layout":"' + $Layout + '","docEntry":' + $DocEntry + ',"objectId":' + $ObjectId + '}'
$clock = [Diagnostics.Stopwatch]::StartNew()
$reply = $request | & $exe
$secs = "{0:N1}" -f $clock.Elapsed.TotalSeconds
if ("$reply" -match '^\{"pdf":"([^"]+)"\}$') {
  $pdf = Join-Path $env:HERE "$Layout-$DocEntry.pdf"
  [IO.File]::WriteAllBytes($pdf, [Convert]::FromBase64String(($Matches[1] -replace '\\/', '/')))
  "OK in $secs s (cold: loads Crystal and the layout): $pdf"
  Invoke-Item $pdf
} else {
  "FAILED after $secs s:"
  "$reply"
}
