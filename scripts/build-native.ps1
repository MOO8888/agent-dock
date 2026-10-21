$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$frameworkPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compilerPath = Join-Path $frameworkPath 'csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw 'Windows .NET Framework 4.x compiler is required.' }
$outputDirectory = Join-Path $taskRoot 'native\bin'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$sourcePath = Join-Path $taskRoot 'native\AgentDock.Native.cs'
$outputPath = Join-Path $outputDirectory 'AgentDock.Native.exe'
$references = @('System.dll','System.Core.dll','System.Drawing.dll','System.Web.Extensions.dll',(Join-Path $frameworkPath 'WPF\UIAutomationClient.dll'),(Join-Path $frameworkPath 'WPF\UIAutomationTypes.dll'),(Join-Path $frameworkPath 'WPF\WindowsBase.dll'))
$compileArguments = @('/nologo','/target:exe','/platform:x64',"/out:$outputPath") + ($references | ForEach-Object { "/reference:$_" }) + @($sourcePath)
& $compilerPath @compileArguments
if ($LASTEXITCODE -ne 0) { throw 'Native bridge build failed.' }
$probeSource = Join-Path $taskRoot 'native\ProbeWindow.cs'
$probeOutput = Join-Path $outputDirectory 'AgentDock.Probe.exe'
& $compilerPath '/nologo' '/target:winexe' '/platform:x64' "/out:$probeOutput" '/reference:System.dll' '/reference:System.Drawing.dll' '/reference:System.Windows.Forms.dll' $probeSource
if ($LASTEXITCODE -ne 0) { throw 'Probe window build failed.' }
$desktopSource = Join-Path $taskRoot 'native\DesktopControl.cs'
$desktopOutput = Join-Path $outputDirectory 'AgentDock.Desktop.exe'
& $compilerPath '/nologo' '/target:winexe' '/platform:x64' "/out:$desktopOutput" '/reference:System.dll' '/reference:System.Drawing.dll' '/reference:System.Windows.Forms.dll' $desktopSource
if ($LASTEXITCODE -ne 0) { throw 'Desktop control build failed.' }
Write-Output 'Windows native bridge built.'
