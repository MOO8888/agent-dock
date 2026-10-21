param([string]$ConfigDirectory = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigDirectory) { $ConfigDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' } }
$configPath = Join-Path $ConfigDirectory 'config.toml'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$original = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) } else { '' }
if ($original -match '(?m)^\[mcp_servers\.agent_dock\]') { throw 'agent_dock already exists in Codex config. Review it rather than overwriting it.' }
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js is required.' }
$nodeExecutable = $nodeCommand.Source.Replace('\','/')
$serverPath = (Join-Path $taskRoot 'src\mcp.mjs').Replace('\','/')
$workingPath = $taskRoot.Replace('\','/')
$addition = "`r`n`r`n# AgentDock local workbench`r`n[mcp_servers.agent_dock]`r`ncommand = `"$nodeExecutable`"`r`nargs = [`"$serverPath`"]`r`ncwd = `"$workingPath`"`r`nstartup_timeout_sec = 15`r`ntool_timeout_sec = 60`r`n"
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Path $ConfigDirectory -Force | Out-Null
$backupPath = "$configPath.agentdock-$timestamp.bak"
if (Test-Path -LiteralPath $configPath) {
    if ([IO.File]::ReadAllText($configPath) -ne $original) { throw 'Config changed while preparing. No changes applied.' }
    Copy-Item -LiteralPath $configPath -Destination $backupPath
}
[IO.File]::WriteAllText($configPath, $original + $addition, $utf8)
Write-Output ('MCP config added: ' + $configPath)
Write-Output ('Backup preserved: ' + $backupPath)
Write-Output 'Reload MCP servers or open a new local Codex session before using coordinate-project.'
