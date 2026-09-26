$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public sealed class OlangaAppWindow { public long Handle; public int ProcessId; }
public static class OlangaAppNative {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder name);
  public static void UsePhysicalPixels() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {} }
  public static string ClassName(IntPtr window) { var text = new StringBuilder(256); GetClassName(window, text, text.Capacity); return text.ToString(); }
  public static int ProcessId(IntPtr window) { uint id; GetWindowThreadProcessId(window, out id); return (int)id; }
  public static string AppId(int id) {
    IntPtr process = OpenProcess(0x1000, false, id); if (process == IntPtr.Zero) return "";
    try { uint length = 0; if (GetApplicationUserModelId(process, ref length, null) != 122 || length > 4096) return ""; var text = new StringBuilder((int)length); return GetApplicationUserModelId(process, ref length, text) == 0 ? text.ToString() : ""; }
    finally { CloseHandle(process); }
  }
  public static OlangaAppWindow[] Windows(int[] processes, string[] classes) {
    var ids = new HashSet<int>(processes); var found = new List<OlangaAppWindow>();
    EnumWindows((window, unused) => {
      if (!IsWindowVisible(window)) return true;
      if (classes.Length > 0 && Array.IndexOf(classes, ClassName(window)) < 0) return true;
      int matched = ProcessId(window);
      if (!ids.Contains(matched)) {
        matched = 0;
        EnumChildWindows(window, (child, ignored) => { int id = ProcessId(child); if (IsWindowVisible(child) && ids.Contains(id)) { matched = id; return false; } return true; }, IntPtr.Zero);
      }
      if (matched != 0) found.Add(new OlangaAppWindow { Handle = window.ToInt64(), ProcessId = matched });
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  public static bool Focus(long handle) { var window = new IntPtr(handle); if (IsIconic(window)) ShowWindowAsync(window, 9); SetForegroundWindow(window); return GetForegroundWindow() == window; }
  public static Rect Bounds(long handle) { Rect bounds; if (!GetWindowRect(new IntPtr(handle), out bounds)) throw new InvalidOperationException("The app window disappeared."); return bounds; }
  public static Rect WorkArea(long handle) { var info = new MonitorInfo(); info.Size = Marshal.SizeOf(info); if (!GetMonitorInfo(MonitorFromWindow(new IntPtr(handle), 2), ref info)) throw new InvalidOperationException("The app display could not be inspected."); return info.Work; }
}
'@
[OlangaAppNative]::UsePhysicalPixels()
$script:startApps = $null

function Resolve-AppPath($Candidate) {
    $root = switch ([string]$Candidate.root) {
        'AppData' { [Environment]::GetFolderPath('ApplicationData') }
        'LocalAppData' { [Environment]::GetFolderPath('LocalApplicationData') }
        'ProgramFiles' { [Environment]::GetFolderPath('ProgramFiles') }
        'ProgramFilesX86' { [Environment]::GetFolderPath('ProgramFilesX86') }
        'System' { [Environment]::GetFolderPath('System') }
        'Windows' { [Environment]::GetFolderPath('Windows') }
        # Absolute paths are accepted only from the application-owned catalog
        # (also used by the disposable native test fixture), never user input.
        'Absolute' { '' }
        default { return $null }
    }
    if ([string]$Candidate.root -eq 'Absolute') { if (-not [IO.Path]::IsPathRooted([string]$Candidate.path)) { return $null }; return [IO.Path]::GetFullPath([string]$Candidate.path) }
    if (-not $root) { return $null }
    return [IO.Path]::GetFullPath((Join-Path $root ([string]$Candidate.path)))
}

function Resolve-AppTarget($App) {
    foreach ($executable in @($App.appPaths)) {
        if (-not $executable) { continue }
        foreach ($base in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
            $key = Get-Item -LiteralPath (Join-Path $base $executable) -ErrorAction SilentlyContinue
            if (-not $key) { continue }
            $file = [Environment]::ExpandEnvironmentVariables(([string]$key.GetValue('')).Trim('"'))
            if ([IO.Path]::IsPathRooted($file) -and [IO.Path]::GetExtension($file) -ieq '.exe' -and (Test-Path -LiteralPath $file -PathType Leaf)) { return @{ kind = 'executable'; path = [IO.Path]::GetFullPath($file); args = @() } }
        }
    }
    foreach ($candidate in @($App.paths)) {
        $file = Resolve-AppPath $candidate
        if ($file -and [IO.Path]::GetExtension($file) -ieq '.exe' -and (Test-Path -LiteralPath $file -PathType Leaf)) { return @{ kind = 'executable'; path = $file; args = @($candidate.args) } }
    }
    if (@($App.packages).Count -gt 0 -and $App.packages) {
        if ($null -eq $script:startApps) { $script:startApps = @(Get-StartApps -ErrorAction SilentlyContinue) }
        $matches = @($script:startApps | Where-Object {
            $id = [string]$_.AppID
            @($App.packages | Where-Object { $id.StartsWith(([string]$_ + '_'), [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        })
        if ($matches.Count -eq 1) { return @{ kind = 'package'; appId = [string]$matches[0].AppID; args = @() } }
        if ($matches.Count -gt 1) { return @{ kind = 'ambiguous' } }
    }
    return $null
}

function Get-AppWindows($App, $Target) {
    $ids = [System.Collections.Generic.List[int]]::new()
    $knownPaths = @($App.paths | ForEach-Object { Resolve-AppPath $_ })
    $knownRoots = @($App.processRoots | ForEach-Object { Resolve-AppPath $_ })
    foreach ($name in @($App.processes)) {
        foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $image = ''
            try { $image = $process.MainModule.FileName } catch {}
            $identity = $image -and (($Target.kind -eq 'executable' -and $image -ieq $Target.path) -or @($knownPaths | Where-Object { $_ -and $image -ieq $_ }).Count -gt 0)
            if (-not $identity -and $image) { $identity = @($knownRoots | Where-Object { $_ -and $image.StartsWith(($_.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 }
            if (-not $identity -and $App.packages) {
                $appId = [OlangaAppNative]::AppId($process.Id)
                $identity = @($App.packages | Where-Object { $appId.StartsWith(([string]$_ + '_'), [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
            }
            if ($identity) { $ids.Add($process.Id) }
        }
    }
    return @([OlangaAppNative]::Windows($ids.ToArray(), [string[]]@($App.windowClasses | Where-Object { $_ })))
}

function New-AppFailure($App, [string]$Status, [string]$Message, [bool]$Dispatched = $false) {
    return @{ ok = $false; verified = $false; appId = $App.id; status = $Status; message = $Message; dispatched = $Dispatched }
}

function Send-Dispatched($Request) {
    @{ id = $Request.id; event = 'dispatched' } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
}

function Test-SameAppWindow($App, $Target, $Window) {
    $current = @(Get-AppWindows $App $Target)
    return $current.Count -eq 1 -and $current[0].Handle -eq $Window.Handle -and $current[0].ProcessId -eq $Window.ProcessId
}

function Invoke-KnownApp($Request) {
    $app = $Request.app
    $originalForeground = [OlangaAppNative]::GetForegroundWindow()
    $target = Resolve-AppTarget $app
    $windows = @(Get-AppWindows $app $target)
    if ($Request.operation -eq 'arrange') {
        if ($windows.Count -eq 0) { return New-AppFailure $app 'missing-window' ($app.name + ' has no verified open window to arrange.') }
        if ($windows.Count -ne 1) { return New-AppFailure $app 'ambiguous-window' ($app.name + ' has multiple windows. Keep only the window you want to arrange open, then try again.') }
        if ($Request.layout -notin @('left', 'right', 'maximize')) { return New-AppFailure $app 'unsupported-layout' 'Choose left, right, or maximize.' }
        $window = $windows[0]
        $handle = [IntPtr]$window.Handle
        $work = [OlangaAppNative]::WorkArea($window.Handle)
        if (-not (Test-SameAppWindow $app $target $window)) { return New-AppFailure $app 'window-changed' ('The ' + $app.name + ' window changed before arrangement. Check its windows and try again.') }
        Send-Dispatched $Request
        if ($Request.layout -eq 'maximize') { $null = [OlangaAppNative]::ShowWindowAsync($handle, 3) }
        else {
            $null = [OlangaAppNative]::ShowWindowAsync($handle, 9)
            Start-Sleep -Milliseconds 100
            if (-not (Test-SameAppWindow $app $target $window)) { return New-AppFailure $app 'window-changed' ('The ' + $app.name + ' window changed during arrangement. Check its current position before trying again.') $true }
            $half = [int][Math]::Floor(($work.Right - $work.Left) / 2)
            $x = $work.Left
            $width = $half
            if ($Request.layout -eq 'right') { $x += $half; $width = $work.Right - $x }
            $null = [OlangaAppNative]::SetWindowPos($handle, [IntPtr]::Zero, $x, $work.Top, $width, ($work.Bottom - $work.Top), 0x0014)
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            if (-not (Test-SameAppWindow $app $target $window)) { return New-AppFailure $app 'window-changed' ('The ' + $app.name + ' window changed during arrangement. Its final layout could not be verified.') $true }
            $bounds = [OlangaAppNative]::Bounds($window.Handle)
            $confirmed = if ($Request.layout -eq 'maximize') { [OlangaAppNative]::IsZoomed($handle) } else { [Math]::Abs($bounds.Left - $x) -le 2 -and [Math]::Abs($bounds.Top - $work.Top) -le 2 -and [Math]::Abs(($bounds.Right - $bounds.Left) - $width) -le 2 -and [Math]::Abs($bounds.Bottom - $work.Bottom) -le 2 }
            if ($confirmed) {
                return @{ ok = $true; verified = $true; appId = $app.id; status = 'arranged'; message = $app.name + $(if ($Request.layout -eq 'maximize') { ' is maximized.' } else { ' is arranged on the ' + $Request.layout + '.' }); layout = $Request.layout; processId = $window.ProcessId; windowHandle = [string]$window.Handle; windowCount = 1; bounds = @{ left = $bounds.Left; top = $bounds.Top; right = $bounds.Right; bottom = $bounds.Bottom }; dispatched = $true }
            }
            Start-Sleep -Milliseconds 80
        } while ([DateTime]::UtcNow -lt $deadline)
        return New-AppFailure $app 'layout-unverified' ('Windows did not confirm the requested layout for ' + $app.name + '.') $true
    }
    $alreadyOpen = $windows.Count -gt 0
    $dispatched = $false
    if (-not $alreadyOpen) {
        if (-not $target) { return New-AppFailure $app 'missing-app' ($app.name + ' is not installed at a known launch target.') }
        if ($target.kind -eq 'ambiguous') { return New-AppFailure $app 'ambiguous-app' ($app.name + ' has multiple registered launch targets; open the version you want first.') }
        Send-Dispatched $Request
        $dispatched = $true
        if ($target.kind -eq 'package') { Start-Process -FilePath (Join-Path ([Environment]::GetFolderPath('Windows')) 'explorer.exe') -ArgumentList ('shell:AppsFolder\' + $target.appId) | Out-Null }
        elseif (@($target.args | Where-Object { $null -ne $_ }).Count -gt 0) { Start-Process -FilePath $target.path -ArgumentList $target.args | Out-Null }
        else { Start-Process -FilePath $target.path | Out-Null }
        $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Min(12000, [Math]::Max(100, [int]$Request.startupTimeoutMs)))
        do {
            $windows = @(Get-AppWindows $app $target)
            if ($windows.Count -gt 0) { break }
            Start-Sleep -Milliseconds 120
        } while ([DateTime]::UtcNow -lt $deadline)
    }
    if ($windows.Count -eq 0) { return New-AppFailure $app 'window-timeout' ('I launched ' + $app.name + ', but its expected window did not appear.') $dispatched }
    $window = $windows[0]
    $focused = $false
    # Multiple windows prove the app is open, but do not authorize choosing one.
    $currentForeground = [OlangaAppNative]::GetForegroundWindow()
    if ($windows.Count -eq 1 -and ($alreadyOpen -or $currentForeground -eq $originalForeground -or $currentForeground.ToInt64() -eq $window.Handle)) { $focused = [OlangaAppNative]::Focus($window.Handle) }
    $message = $app.name + ' is open.'
    if ($windows.Count -gt 1) { $message += ' It has multiple windows open.' }
    elseif (-not $focused) { $message += ' Windows kept the current app in front.' }
    return @{ ok = $true; verified = $true; appId = $app.id; status = $(if ($alreadyOpen) { 'already-open' } else { 'opened' }); message = $message; processId = $window.ProcessId; windowHandle = [string]$window.Handle; windowCount = $windows.Count; alreadyOpen = $alreadyOpen; focused = $focused; dispatched = $dispatched }
}

function Test-SearchForeground {
    $window = [OlangaAppNative]::GetForegroundWindow()
    $process = Get-Process -Id ([OlangaAppNative]::ProcessId($window)) -ErrorAction SilentlyContinue
    return $process -and ($process.ProcessName -in @('SearchHost', 'SearchApp', 'SearchUI', 'StartMenuExperienceHost') -or ($process.ProcessName -eq 'explorer' -and [OlangaAppNative]::ClassName($window) -in @('DV2ControlHost', 'ImmersiveLauncher')))
}

function Invoke-SearchFallback($Request) {
    $name = [string]$Request.name
    if (-not $name -or $name.Length -gt 120 -or $name -match '[\x00-\x1f\x7f:/\\;|&<>`$]' -or $name -match '(?:^|\s)-|\.exe\s') { throw 'Search requires an app name without paths, arguments, or commands.' }
    $escaped = ''
    foreach ($character in $name.ToCharArray()) {
        switch ($character) {
            '{' { $escaped += '{{}' }
            '}' { $escaped += '{}}' }
            default { if ('+^%~()[]'.Contains([string]$character)) { $escaped += '{' + $character + '}' } else { $escaped += $character } }
        }
    }
    $shell = New-Object -ComObject WScript.Shell
    Send-Dispatched $Request
    $shell.SendKeys('^{ESC}')
    $deadline = [DateTime]::UtcNow.AddMilliseconds(1600)
    do { Start-Sleep -Milliseconds 100; $ready = Test-SearchForeground } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { return @{ ok = $false; verified = $false; status = 'search-unavailable'; dispatched = $true; message = 'Windows Search did not receive focus. No app name was typed.' } }
    $shell.SendKeys($escaped)
    Start-Sleep -Milliseconds 650
    if (-not (Test-SearchForeground)) { return @{ ok = $false; verified = $false; status = 'focus-changed'; dispatched = $true; message = 'Focus changed during Windows Search. I stopped before opening a result.' } }
    $shell.SendKeys('{ENTER}')
    return @{ ok = $true; verified = $false; status = 'dispatched'; dispatched = $true; source = 'windows-search'; message = 'I requested ' + $name + ' to open through Windows Search, but could not verify its window.' }
}

$request = $null
try {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { exit 0 }
    if ($line.Length -gt 128000) { throw 'The app request is too large.' }
    $request = $line | ConvertFrom-Json
    switch ($request.operation) {
        'discover' {
            $apps = @($request.apps | ForEach-Object {
                $target = Resolve-AppTarget $_
                $windows = @(Get-AppWindows $_ $target)
                $installed = $null -ne $target -and $target.kind -ne 'ambiguous'
                $available = $installed -or $windows.Count -gt 0
                @{ id = $_.id; installed = $installed; available = $available; windowCount = $windows.Count; status = $(if ($windows.Count -gt 0) { 'running' } elseif ($installed) { 'installed' } elseif ($target.kind -eq 'ambiguous') { 'ambiguous' } else { 'missing' }); reason = $(if (-not $available) { 'No single known installed target or verified open window was found.' } else { '' }) }
            })
            $result = @{ ok = $true; message = 'App capabilities checked.'; apps = $apps }
        }
        'open' { $result = Invoke-KnownApp $request }
        'arrange' { $result = Invoke-KnownApp $request }
        'search' { $result = Invoke-SearchFallback $request }
        default { throw 'Unsupported app operation.' }
    }
} catch { $result = @{ ok = $false; verified = $false; status = 'helper-error'; message = 'App control failed: ' + $_.Exception.GetBaseException().Message } }
@{ id = $request.id; result = $result } | ConvertTo-Json -Compress -Depth 12 | ForEach-Object { [Console]::WriteLine($_) }
