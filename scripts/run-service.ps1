$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$runtimePath = if ($runtimeCommand) { $runtimeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $runtimePath)) { throw 'Install Node.js 22 or newer to start AgentDock.' }
$dataDirectory = Join-Path $taskRoot '.data'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$serverPath = Join-Path $taskRoot 'src\server.mjs'
$server = Start-Process -FilePath $runtimePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDirectory 'server.log') -RedirectStandardError (Join-Path $dataDirectory 'server-error.log') -PassThru
$server.WaitForExit()
exit $server.ExitCode
