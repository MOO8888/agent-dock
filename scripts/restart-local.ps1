$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDirectory = Join-Path $taskRoot '.data'
$run = Get-Content -LiteralPath (Join-Path $dataDirectory 'run.json') -Raw | ConvertFrom-Json
$bridgeSecret = (Get-Content -LiteralPath (Join-Path $dataDirectory 'bridge-token') -Raw).Trim()
$serverPath = Join-Path $taskRoot 'src\server.mjs'
$process = Get-Process -Id $run.pid -ErrorAction SilentlyContinue
$metadata = if ($process) { Get-CimInstance Win32_Process -Filter "ProcessId=$($run.pid)" } else { $null }
$startedAt = if ($run.startedAt -is [DateTime]) { $run.startedAt.ToUniversalTime() } else { [DateTimeOffset]::Parse([string]$run.startedAt).UtcDateTime }
if ($process) {
  if ($process.ProcessName -ne 'node' -or [Math]::Abs(($process.StartTime.ToUniversalTime() - $startedAt).TotalSeconds) -gt 20 -or -not $metadata.CommandLine.Contains($serverPath)) { throw '运行记录与进程不符，未终止任何进程。' }
}
$state = if ($process) { Invoke-RestMethod -Uri "http://127.0.0.1:$($run.port)/api/state" -Headers @{Authorization="Bearer $bridgeSecret"} } else { Get-Content -LiteralPath (Join-Path $dataDirectory 'state.json') -Raw | ConvertFrom-Json }
if ($state.projects | Where-Object { $_.takeover.active }) { throw '用户正在人工接管，不能重启工作台。' }
if ($process) { Stop-Process -Id $process.Id }
$nativePath = Join-Path $taskRoot 'native\bin\AgentDock.Native.exe'
foreach ($helper in @(Get-Process -Name 'AgentDock.Native' -ErrorAction SilentlyContinue)) {
  if ($helper.Path -eq $nativePath -and -not $helper.HasExited) {
    try { $helper.Kill(); $helper.WaitForExit(3000) | Out-Null }
    catch { if (-not $helper.HasExited) { throw } }
  }
}
& (Join-Path $PSScriptRoot 'build-native.ps1')
& (Join-Path $PSScriptRoot 'start-service.ps1')
Write-Output '工作台已独立启动；官方客户端未关闭。'

