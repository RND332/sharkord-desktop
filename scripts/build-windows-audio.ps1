$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Build the Windows audio helper on Windows with the Visual Studio C++ build tools and Windows SDK installed.'
}

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        throw 'Visual Studio C++ build tools and Windows SDK are required to package Windows audio capture.'
    }
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'No Visual Studio C++ installation was found.' }
    Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
    Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
}

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    New-Item -ItemType Directory -Force native\out | Out-Null
    & cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /DUNICODE /D_UNICODE native\windows\win-audio-capture.cpp /Fo:native\out\win-audio-capture.obj /Fe:native\out\win-audio-capture.exe /link ole32.lib mmdevapi.lib user32.lib
    if ($LASTEXITCODE -ne 0) { throw "Windows audio helper compilation failed ($LASTEXITCODE)." }
    if (-not (Test-Path native\out\win-audio-capture.exe)) { throw 'The Windows audio helper was not produced.' }
} finally {
    Pop-Location
}
