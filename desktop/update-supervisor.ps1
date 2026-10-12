param([Parameter(Mandatory = $true)][string]$RequestPath, [switch]$Bootstrap)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Bootstrap) {
    # Start-Process creates an independent hidden Windows console. A direct
    # Node detached console can exit before running PowerShell, while sharing
    # the app console makes the helper die with the app. This bootstrap remains
    # alive for readiness; the supervisor itself survives the app's exit.
    $workerArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -RequestPath "' + $RequestPath + '"'
    $worker = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $workerArguments -WindowStyle Hidden -PassThru
    $worker.WaitForExit()
    exit $worker.ExitCode
}

# This script is copied into the update cache. Neither its working directory nor
# its executable resides in the installation that NSIS needs to replace.
$attemptDirectory = [System.IO.Path]::GetDirectoryName($RequestPath)
$readyPath = Join-Path $attemptDirectory 'ready.json'
$cancelPath = Join-Path $attemptDirectory 'cancel'
$resultPath = Join-Path ([System.IO.Path]::GetDirectoryName($attemptDirectory)) 'install-result.json'
$request = $null
$parentExited = $false
$installerExitCode = $null
$installedVersion = $null
$progressForm = $null
$progressStatus = $null
$progressDetail = $null
$allowProgressClose = $false

function Initialize-Progress {
    if (-not $request.showProgress) { return }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type 'using System; using System.Runtime.InteropServices; public static class OlangaUpdateWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command); }'
    $script:progressForm = New-Object System.Windows.Forms.Form
    $progressForm.Text = 'Updating Olanga'
    $progressForm.ClientSize = New-Object System.Drawing.Size(430, 152)
    $progressForm.StartPosition = 'CenterScreen'
    $progressForm.FormBorderStyle = 'FixedDialog'
    $progressForm.ControlBox = $false
    $progressForm.add_FormClosing({ param($sender, $eventArgs) if (-not $script:allowProgressClose) { $eventArgs.Cancel = $true } })
    $progressForm.BackColor = [System.Drawing.Color]::FromArgb(24, 23, 33)
    $progressForm.ForeColor = [System.Drawing.Color]::FromArgb(242, 239, 255)
    $progressForm.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    try { $progressForm.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($request.appExe) } catch {}
    $script:progressStatus = New-Object System.Windows.Forms.Label
    $progressStatus.Location = New-Object System.Drawing.Point(24, 20)
    $progressStatus.Size = New-Object System.Drawing.Size(385, 25)
    $progressStatus.Text = 'Installing Olanga ' + $request.version
    $bar = New-Object System.Windows.Forms.ProgressBar
    $bar.Location = New-Object System.Drawing.Point(24, 58)
    $bar.Size = New-Object System.Drawing.Size(382, 7)
    $bar.Style = 'Marquee'
    $bar.MarqueeAnimationSpeed = 25
    $script:progressDetail = New-Object System.Windows.Forms.Label
    $progressDetail.Location = New-Object System.Drawing.Point(24, 81)
    $progressDetail.Size = New-Object System.Drawing.Size(385, 54)
    $progressDetail.Text = 'Olanga will reopen automatically when the update is complete.'
    $progressForm.Controls.AddRange(@($progressStatus, $bar, $progressDetail))
}

function Refresh-Progress {
    if ($null -ne $progressForm) { [System.Windows.Forms.Application]::DoEvents() }
}

function Write-JsonFile([string]$FilePath, $Value) {
    $temporaryPath = $FilePath + '.' + $PID + '.tmp'
    [System.IO.File]::WriteAllText($temporaryPath, ($Value | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryPath -Destination $FilePath -Force
}

function Write-Result([string]$Stage, [string]$Code) {
    Write-JsonFile $resultPath @{
        schema = 1; version = $request.version; stage = $Stage; code = $Code
        exitCode = $installerExitCode; installedVersion = $installedVersion
        supervisorPid = $PID
        updatedAt = [DateTime]::UtcNow.ToString('o')
    }
}

function Assert-AbsoluteFile([string]$FilePath) {
    if (-not [System.IO.Path]::IsPathRooted($FilePath) -or $FilePath.IndexOfAny([char[]]@(0, 10, 13)) -ge 0) { throw 'invalid-path' }
    $item = Get-Item -LiteralPath $FilePath -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'invalid-file' }
}

function Get-AppVersion {
    return (Get-Item -LiteralPath $request.appExe).VersionInfo.FileVersion
}

function Start-Olanga([string]$LaunchArgument) {
    Assert-AbsoluteFile $request.appExe
    # Use the exact executable, not a stale shortcut or an Explorer shell broker.
    # This is the user-facing app. Passing Hidden here can suppress its first
    # window even when the renderer calls show(), leaving an invisible restart.
    $launchedApp = Start-Process -FilePath $request.appExe -ArgumentList $LaunchArgument -WorkingDirectory ([System.IO.Path]::GetDirectoryName($request.appExe)) -WindowStyle Normal -PassThru
    if ($launchedApp.WaitForExit(3000)) {
        # A second-instance handoff may exit normally. It is valid only if the
        # intended executable has a real main window in this Windows session.
        # Orphan Electron renderer/GPU processes must not count as a restart.
        $currentSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        $sameApp = @(Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($request.appExe)) -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -eq $request.appExe -and $_.SessionId -eq $currentSession -and $_.MainWindowHandle -ne [IntPtr]::Zero -and -not $_.HasExited } catch { $false }
        })
        if ($sameApp.Count -eq 0) { throw 'app-restart-failed' }
    }
}

try {
    $request = [System.IO.File]::ReadAllText($RequestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($request.schema -ne 1 -or $request.token -notmatch '^[a-f0-9]{48}$' -or $request.version -notmatch '^\d+\.\d+\.\d+$' -or $request.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'invalid-request' }
    if ([System.IO.Path]::GetFileName($request.installer) -ne ('Olanga-Setup-' + $request.version + '.exe')) { throw 'invalid-installer' }
    Assert-AbsoluteFile $request.installer
    Assert-AbsoluteFile $request.appExe
    $hashStream = [System.IO.File]::OpenRead($request.installer)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
    finally { $hashStream.Dispose(); $hasher.Dispose() }
    if ($actualHash -ne $request.sha256) { throw 'installer-changed' }
    if (Test-Path -LiteralPath $cancelPath) { exit 2 }
    $parent = [System.Diagnostics.Process]::GetProcessById([int]$request.parentPid)
    if ($parent.MainModule.FileName -ne $request.parentExe) { throw 'parent-process-mismatch' }
    Initialize-Progress
    Write-JsonFile $readyPath @{ token = $request.token; ready = $true; supervisorPid = $PID }
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    while (-not $parent.WaitForExit(100)) {
        if (Test-Path -LiteralPath $cancelPath) { exit 2 }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'app-did-not-close' }
    }
    if (Test-Path -LiteralPath $cancelPath) { exit 2 }
    $parentExited = $true
    if ($null -ne $progressForm) {
        $progressForm.Show()
        # The console is hidden, but its inherited SW_HIDE must not suppress the
        # first native progress window. Show the form's own HWND explicitly.
        [OlangaUpdateWindow]::ShowWindow($progressForm.Handle, 5) | Out-Null
        $progressForm.Activate()
        Refresh-Progress
    }
    Write-Result 'installing' 'installer-starting'
    # NSIS retains per-user/all-user mode and directory from its registry.
    # Restart belongs to this supervisor, not NSIS's unchecked ExecShellAsUser.
    $installer = Start-Process -FilePath $request.installer -ArgumentList @('--updated', '/S') -WorkingDirectory $attemptDirectory -WindowStyle Hidden -PassThru
    $installStarted = [DateTime]::UtcNow
    while (-not $installer.WaitForExit(100)) {
        if ($null -ne $progressForm -and ([DateTime]::UtcNow - $installStarted).TotalMinutes -ge 2) {
            $progressStatus.Text = 'The installer is still working...'
            $progressDetail.Text = 'Finish any Windows installer or security prompt. Olanga will reopen when installation finishes.'
        }
        Refresh-Progress
    }
    $installerExitCode = $installer.ExitCode
    if ($installerExitCode -ne 0) { throw 'installer-exit-code' }
    $installedVersion = Get-AppVersion
    if ([version]$installedVersion -lt [version]$request.version) { throw 'installed-version-mismatch' }
    Write-Result 'installed' 'version-verified'
    if ($null -ne $progressForm) { $progressStatus.Text = 'Opening Olanga ' + $installedVersion; Refresh-Progress }
    Start-Olanga '--updated'
    Write-Result 'restarted' 'complete'
    exit 0
} catch {
    if ($null -ne $request) {
        try { Write-Result 'failed' $_.Exception.Message } catch {}
        if (-not (Test-Path -LiteralPath $readyPath)) {
            try { Write-JsonFile $readyPath @{ token = $request.token; ready = $false } } catch {}
        }
        if ($parentExited) {
            try { Start-Olanga '--update-recovery' } catch {
                if ($null -ne $progressForm) {
                    $progressForm.Hide()
                    [System.Windows.Forms.MessageBox]::Show('Olanga could not reopen after the update. Open Olanga from the Start menu. If it still does not open, download the installer again from the Olanga GitHub Releases page.', 'Olanga update needs attention', 'OK', 'Error') | Out-Null
                }
            }
        }
    }
    exit 1
} finally {
    $allowProgressClose = $true
    if ($null -ne $progressForm) { $progressForm.Dispose() }
}
