$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'app-helper.ps1') -Library
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OlangaWorkspaceNative {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Placement { public int Length, Flags, Show; public Point Min, Max; public Rect Normal; }
  [StructLayout(LayoutKind.Sequential)] public struct Monitor { public int Size; public Rect Bounds, Work; public uint Flags; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect rectangle, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref Monitor info);
  public static string Title(long window) { var text = new StringBuilder(1024); GetWindowText(new IntPtr(window), text, text.Capacity); return text.ToString(); }
  public static Placement PlacementOf(long window) { var result = new Placement(); result.Length = Marshal.SizeOf(result); if (!GetWindowPlacement(new IntPtr(window), ref result)) throw new InvalidOperationException("Window disappeared."); return result; }
  public static Rect NormalBounds(long window) {
    var r = PlacementOf(window).Normal; var handle = new IntPtr(window);
    if ((GetWindowLong(handle, -20) & 0x80) == 0) {
      var info = new Monitor(); info.Size=Marshal.SizeOf(info);
      if (!GetMonitorInfo(MonitorFromWindow(handle, 2), ref info)) throw new InvalidOperationException("Display information unavailable.");
      int x=info.Work.Left-info.Bounds.Left, y=info.Work.Top-info.Bounds.Top;
      r.Left+=x; r.Right+=x; r.Top+=y; r.Bottom+=y;
    }
    return r;
  }
  public static Rect Fit(int left, int top, int right, int bottom) {
    var r = new Rect { Left=left, Top=top, Right=right, Bottom=bottom }; var info = new Monitor(); info.Size=Marshal.SizeOf(info);
    if (!GetMonitorInfo(MonitorFromRect(ref r, 2), ref info)) throw new InvalidOperationException("Display information unavailable.");
    int width=Math.Min(right-left, info.Work.Right-info.Work.Left), height=Math.Min(bottom-top, info.Work.Bottom-info.Work.Top);
    int x=Math.Max(info.Work.Left, Math.Min(left, info.Work.Right-width)), y=Math.Max(info.Work.Top, Math.Min(top, info.Work.Bottom-height));
    return new Rect { Left=x, Top=y, Right=x+width, Bottom=y+height };
  }
}
'@
function Get-WorkspaceWindows($Apps) {
    $result = @()
    foreach ($app in @($Apps)) {
        $target = Resolve-AppTarget $app
        foreach ($window in @(Get-AppWindows $app $target)) {
            try {
                $process = Get-Process -Id $window.ProcessId -ErrorAction Stop
                $placement = [OlangaWorkspaceNative]::PlacementOf($window.Handle)
                # Normal windows use screen coordinates, including taskbar offsets.
                $bounds = [OlangaAppNative]::Bounds($window.Handle)
                if ([OlangaAppNative]::IsZoomed([IntPtr]$window.Handle) -or [OlangaAppNative]::IsIconic([IntPtr]$window.Handle)) {
                    $bounds = [OlangaWorkspaceNative]::NormalBounds($window.Handle)
                }
                if (($bounds.Right - $bounds.Left) -lt 80 -or ($bounds.Bottom - $bounds.Top) -lt 50) { continue }
                $result += @{ appId = $app.id; title = [OlangaWorkspaceNative]::Title($window.Handle); processId = $window.ProcessId; windowHandle = [string]$window.Handle; processStarted = [string]$process.StartTime.ToUniversalTime().Ticks; bounds = @{ left=$bounds.Left; top=$bounds.Top; right=$bounds.Right; bottom=$bounds.Bottom }; state = $(if ([OlangaAppNative]::IsZoomed([IntPtr]$window.Handle)) { 'maximized' } elseif ([OlangaAppNative]::IsIconic([IntPtr]$window.Handle)) { 'minimized' } else { 'normal' }) }
            } catch { }
        }
    }
    return $result
}
function Find-WorkspaceWindow($Request) {
    $found = @(Get-WorkspaceWindows @($Request.app) | Where-Object { $_.windowHandle -eq $Request.window.windowHandle -and $_.processId -eq $Request.window.processId -and $_.processStarted -eq $Request.window.processStarted })
    if ($found.Count -ne 1) { throw 'The chosen window changed. Preview this session again.' }
    return $found[0]
}
$request = $null
try {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { exit 0 }
    if ($line.Length -gt 128000) { throw 'The workspace request is too large.' }
    $request = $line | ConvertFrom-Json
    if ($request.operation -eq 'capture') {
        $result = @{ ok=$true; windows=@(Get-WorkspaceWindows $request.apps); message='Supported app windows captured.' }
    } elseif ($request.operation -eq 'restore') {
        $window = Find-WorkspaceWindow $request
        $b = $request.bounds
        foreach ($key in @('left','top','right','bottom')) { if ($null -eq $b.$key -or [Math]::Abs([double]$b.$key) -gt 100000 -or [double]$b.$key -ne [int]$b.$key) { throw 'Invalid window bounds.' } }
        if (($b.right-$b.left) -lt 80 -or ($b.bottom-$b.top) -lt 50 -or ($b.right-$b.left) -gt 30000 -or ($b.bottom-$b.top) -gt 30000) { throw 'Invalid window size.' }
        if ($request.state -notin @('normal','minimized','maximized')) { throw 'Unsupported window state.' }
        $fit = [OlangaWorkspaceNative]::Fit($b.left,$b.top,$b.right,$b.bottom)
        $handle = [IntPtr]([long]$window.windowHandle)
        $null = [OlangaAppNative]::ShowWindowAsync($handle, 4)
        Start-Sleep -Milliseconds 100
        $null = Find-WorkspaceWindow $request
        if (-not [OlangaAppNative]::SetWindowPos($handle,[IntPtr]::Zero,$fit.Left,$fit.Top,($fit.Right-$fit.Left),($fit.Bottom-$fit.Top),0x0014)) { throw 'Windows did not accept the saved layout.' }
        Start-Sleep -Milliseconds 100
        $null = Find-WorkspaceWindow $request
        if ($request.state -eq 'maximized') { $null = [OlangaAppNative]::ShowWindowAsync($handle,3) }
        elseif ($request.state -eq 'minimized') { $null = [OlangaAppNative]::ShowWindowAsync($handle,7) }
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            Start-Sleep -Milliseconds 80
            $null = Find-WorkspaceWindow $request
            $actual = [OlangaAppNative]::Bounds([long]$window.windowHandle)
            $verified = if ($request.state -eq 'maximized') { [OlangaAppNative]::IsZoomed($handle) } elseif ($request.state -eq 'minimized') { [OlangaAppNative]::IsIconic($handle) } else { -not [OlangaAppNative]::IsZoomed($handle) -and -not [OlangaAppNative]::IsIconic($handle) -and [Math]::Abs($actual.Left-$fit.Left) -le 12 -and [Math]::Abs($actual.Top-$fit.Top) -le 12 -and [Math]::Abs($actual.Right-$fit.Right) -le 12 -and [Math]::Abs($actual.Bottom-$fit.Bottom) -le 12 }
        } while (-not $verified -and [DateTime]::UtcNow -lt $deadline)
        if (-not $verified) { throw 'The window did not confirm its saved layout. Its position may have changed.' }
        $reported = if ($request.state -eq 'minimized') { $fit } else { $actual }
        $result = @{ ok=$true; verified=$true; status='restored'; appId=$request.app.id; windowHandle=$window.windowHandle; processId=$window.processId; message='Window layout restored and verified.'; bounds=@{left=$reported.Left;top=$reported.Top;right=$reported.Right;bottom=$reported.Bottom}; state=$request.state }
    } else { throw 'Unsupported workspace operation.' }
} catch { $result = @{ ok=$false; verified=$false; status='failed'; message=$_.Exception.GetBaseException().Message } }
@{ id=$request.id; result=$result } | ConvertTo-Json -Depth 12 -Compress | ForEach-Object { [Console]::WriteLine($_) }
