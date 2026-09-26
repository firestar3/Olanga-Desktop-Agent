$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OlangaCloseNative {
    delegate bool EnumProc(IntPtr window, IntPtr unused);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    public static int ProcessId(long window) { uint id; GetWindowThreadProcessId(new IntPtr(window), out id); return (int)id; }
    public static long[] VisibleWindows(int processId) {
        var windows = new List<long>();
        if (!EnumWindows((window, unused) => { if (IsWindowVisible(window) && ProcessId(window.ToInt64()) == processId) windows.Add(window.ToInt64()); return true; }, IntPtr.Zero)) throw new InvalidOperationException("Windows could not enumerate app windows.");
        return windows.ToArray();
    }
}
'@

function Get-CloseCandidates([string[]]$Names) {
    # Enumerate and compare literal names: Get-Process -Name treats wildcards specially.
    foreach ($process in @(Get-Process)) {
        try {
            if ($Names -notcontains $process.ProcessName.ToLowerInvariant()) { continue }
            $process.Refresh()
            $windows = @([OlangaCloseNative]::VisibleWindows($process.Id))
            if ($windows.Count -eq 0) { continue }
            $handle = $process.MainWindowHandle.ToInt64()
            if ($handle -eq 0 -or $windows -notcontains $handle) { throw 'The app has visible windows but its main window cannot be verified.' }
            [pscustomobject]@{ ProcessId = $process.Id; ProcessName = $process.ProcessName; StartTime = $process.StartTime.ToUniversalTime().Ticks; WindowHandle = $handle; WindowCount = $windows.Count }
        } catch {
            # An app that exited during enumeration has no remaining close target.
            try { if ($process.HasExited) { continue } } catch {}
            throw
        } finally { $process.Dispose() }
    }
}

function Get-SameCloseProcess($Candidate) {
    $process = Get-Process -Id $Candidate.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    try {
        $process.Refresh()
        $handle = $process.MainWindowHandle.ToInt64()
        if ($process.ProcessName -ine $Candidate.ProcessName -or $process.StartTime.ToUniversalTime().Ticks -ne $Candidate.StartTime -or $handle -ne $Candidate.WindowHandle -or -not [OlangaCloseNative]::IsWindow([IntPtr]$handle) -or -not [OlangaCloseNative]::IsWindowVisible([IntPtr]$handle) -or [OlangaCloseNative]::ProcessId($handle) -ne $Candidate.ProcessId) { $process.Dispose(); return $null }
        return $process
    } catch { $process.Dispose(); return $null }
}

function New-CloseReceipt([string]$Status, [string]$Message, [int]$Matched, [int]$Requested, [int]$Remaining, [bool]$Dispatched, [string]$Name) {
    $ok = $Status -in @('closed', 'pending') -and $Requested -gt 0
    return @{ ok = $ok; verified = $Status -eq 'closed' -and $ok; pending = $Remaining -gt 0 -or ($Dispatched -and -not $ok); status = $Status; reason = $Status; message = $Message; matched = $Matched; requested = $Requested; remaining = $Remaining; dispatched = $Dispatched; forced = $false; closed = $(if ($ok) { $Name } else { '' }) }
}

function Send-CloseDispatched($Request) {
    @{ id = $Request.id; event = 'dispatched' } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
}

function Invoke-CloseRequest($Request) {
    $names = @($Request.processNames)
    $blocked = @('explorer', 'olanga', 'electron', 'dwm', 'winlogon', 'csrss', 'wininit', 'services', 'lsass', 'smss', 'svchost', 'fontdrvhost', 'sihost', 'ctfmon', 'searchhost', 'shellexperiencehost', 'startmenuexperiencehost', 'textinputhost', 'applicationframehost', 'systemsettings', 'lockapp', 'runtimebroker', 'audiodg', 'conhost')
    if ($names.Count -lt 1 -or $names.Count -gt 8 -or @($names | Where-Object { $_ -isnot [string] -or $_ -notmatch '^[a-z0-9][a-z0-9._ -]{0,119}$' -or $blocked -contains $_ }).Count -gt 0) { return New-CloseReceipt 'invalid-app' 'The exact app process name is invalid or protected.' 0 0 0 $false '' }
    $matched = 0; $requested = 0; $dispatched = $false
    try {
        $candidates = @(Get-CloseCandidates $names)
        $matched = $candidates.Count
        if ($matched -eq 0) { return New-CloseReceipt 'not-running' ('No visible main window for ' + $Request.name + ' is open.') 0 0 0 $false '' }
        foreach ($candidate in $candidates) {
            $process = Get-SameCloseProcess $candidate
            if (-not $process) { return New-CloseReceipt 'target-changed' 'The app window or process changed before closing. Check it before trying again.' $matched $requested $matched $dispatched '' }
            try {
                Send-CloseDispatched $Request
                $dispatched = $true
                if (-not $process.CloseMainWindow()) { return New-CloseReceipt 'close-refused' 'The app did not accept a graceful close request. It has not been force-closed.' $matched $requested $matched $true '' }
                $requested++
            } finally { $process.Dispose() }
        }
        $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Min(5000, [Math]::Max(0, [int]$Request.settleMs)))
        do {
            # Re-scan exact names, including new/main-window replacements. An app
            # remaining in the tray is closed only when it has no visible windows.
            $remaining = @(Get-CloseCandidates $names).Count
            if ($remaining -eq 0) { return New-CloseReceipt 'closed' ($Request.name + ' has no remaining visible app windows.') $matched $requested 0 $true $Request.name }
            if ([DateTime]::UtcNow -ge $deadline) { break }
            Start-Sleep -Milliseconds 80
        } while ($true)
        return New-CloseReceipt 'pending' ('Close requested for ' + $Request.name + '. A window remains open; check for a save prompt.') $matched $requested $remaining $true $Request.name
    } catch { return New-CloseReceipt 'verification-failed' 'Windows could not safely verify the app close request. Check the app before trying again.' $matched $requested $matched $dispatched '' }
}

$line = [Console]::ReadLine()
if ($line) {
    $request = $null
    try {
        $request = $line | ConvertFrom-Json
        $result = Invoke-CloseRequest $request
        @{ id = $request.id; result = $result } | ConvertTo-Json -Depth 6 -Compress | ForEach-Object { [Console]::WriteLine($_) }
    } catch {
        @{ id = $request.id; result = (New-CloseReceipt 'invalid-request' 'Windows app closing received an invalid request.' 0 0 0 $false '') } | ConvertTo-Json -Depth 6 -Compress | ForEach-Object { [Console]::WriteLine($_) }
    }
}
