param([string]$SkillDirectory = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$skillSource = Join-Path $taskRoot 'skills\coordinate-project'
if (-not $SkillDirectory) {
    $codexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $SkillDirectory = Join-Path $codexDirectory 'skills'
}
$targetDirectory = Join-Path ([IO.Path]::GetFullPath($SkillDirectory)) 'coordinate-project'
if (Test-Path -LiteralPath $targetDirectory) { throw 'The skill already exists. Review the existing files before replacing it.' }
New-Item -ItemType Directory -Path $SkillDirectory -Force | Out-Null
Copy-Item -LiteralPath $skillSource -Destination $targetDirectory -Recurse
Write-Output ('Skill installed: ' + $targetDirectory)
Write-Output 'Add the MCP configuration shown in the workbench, then open a new Codex session.'
