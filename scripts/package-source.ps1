$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$result = & $nodeCommand.Source (Join-Path $PSScriptRoot 'export-source.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Source export failed. No archive created.' }
$export = $result | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($export.folder, $export.archive, [IO.Compression.CompressionLevel]::Optimal, $true)
$archiveStream = [IO.File]::OpenRead($export.archive)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $digest = [BitConverter]::ToString($sha256.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant()
} finally {
    $archiveStream.Dispose()
    $sha256.Dispose()
}
[IO.File]::WriteAllText($export.archive + '.sha256', $digest + '  ' + [IO.Path]::GetFileName($export.archive) + [Environment]::NewLine)
Write-Output ('Source folder: ' + $export.folder)
Write-Output ('ZIP: ' + $export.archive)
Write-Output ('Files: ' + $export.files)
Write-Output ('SHA256: ' + $digest)
