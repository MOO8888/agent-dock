$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4318/healthz' -TimeoutSec 2
  if ($health.name -eq 'AgentDock') { Write-Output 'AgentDock is already running.'; return }
} catch { }
$nativeExecutable = Join-Path $taskRoot 'native\bin\AgentDock.Native.exe'
if (-not (Test-Path -LiteralPath $nativeExecutable)) { & (Join-Path $PSScriptRoot 'build-native.ps1') }
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'run-service.ps1') + '"'
# Ask the interactive desktop shell to launch independently of this terminal.
$shell = New-Object -ComObject Shell.Application
try {
  $desktopHandle = 0
  $desktop = $shell.Windows().FindWindowSW(0, 0, 8, [ref]$desktopHandle, 1)
  if (-not $desktop) { throw 'The logged-in Windows desktop shell is unavailable.' }
  $desktop.Document.Application.ShellExecute($powershellPath, $arguments, $taskRoot, 'open', 0)
}
finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4318/healthz' -TimeoutSec 1
    if ($health.name -eq 'AgentDock') { Write-Output 'AgentDock is ready at http://127.0.0.1:4318/.'; return }
  } catch { }
  Start-Sleep -Milliseconds 250
}
throw 'AgentDock failed to start. Inspect .data/server-error.log. Start from your logged-in Windows desktop.'
