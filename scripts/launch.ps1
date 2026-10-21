$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-service.ps1')
Start-Process 'http://127.0.0.1:4318/'
