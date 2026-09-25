param()
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OverlayTestInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
[void][OverlayTestInput]::SetThreadDpiAwarenessContext([IntPtr](-4))
$testOriginal = New-Object OverlayTestInput+POINT
[void][OverlayTestInput]::GetCursorPos([ref]$testOriginal)
try {
  while ($null -ne ($testLine = [Console]::In.ReadLine())) {
    try {
      $testInput = $testLine | ConvertFrom-Json
      $testHwnd = [IntPtr]::new([long]$testInput.handle)
      $testWindowPid = [uint32]0
      [void][OverlayTestInput]::GetWindowThreadProcessId($testHwnd, [ref]$testWindowPid)
      if ($testWindowPid -ne [uint32]$testInput.pid -or -not [OverlayTestInput]::IsWindowVisible($testHwnd)) { throw 'Test window identity or visibility changed' }
      if ($testInput.action -eq 'escape') {
        if ([OverlayTestInput]::GetForegroundWindow() -ne $testHwnd) { throw 'Test window is not foreground; no key sent' }
        [OverlayTestInput]::keybd_event(27, 0, 0, [UIntPtr]::Zero)
        [OverlayTestInput]::keybd_event(27, 0, 2, [UIntPtr]::Zero)
      } elseif ($testInput.action -eq 'click') {
        if ($testInput.x -lt 0 -or $testInput.x -gt 1 -or $testInput.y -lt 0 -or $testInput.y -gt 1) { throw 'Invalid test point' }
        $testRect = New-Object OverlayTestInput+RECT
        if (-not [OverlayTestInput]::GetClientRect($testHwnd, [ref]$testRect)) { throw 'Could not read test client bounds' }
        $testPoint = New-Object OverlayTestInput+POINT
        $testPoint.X = [int]($testRect.Left + ($testRect.Right - $testRect.Left) * $testInput.x)
        $testPoint.Y = [int]($testRect.Top + ($testRect.Bottom - $testRect.Top) * $testInput.y)
        if (-not [OverlayTestInput]::ClientToScreen($testHwnd, [ref]$testPoint)) { throw 'Could not map test point to screen' }
        if (-not [OverlayTestInput]::SetCursorPos($testPoint.X, $testPoint.Y)) { throw 'Could not move cursor to test target' }
        Start-Sleep -Milliseconds 120
        $testActual = New-Object OverlayTestInput+POINT
        [void][OverlayTestInput]::GetCursorPos([ref]$testActual)
        if ($testActual.X -ne $testPoint.X -or $testActual.Y -ne $testPoint.Y) { throw 'Cursor moved away from test target; no click sent' }
        $testHit = [OverlayTestInput]::GetAncestor([OverlayTestInput]::WindowFromPoint($testPoint), 2)
        if ($testHit -ne $testHwnd) {
          $testActual = New-Object OverlayTestInput+POINT
          [void][OverlayTestInput]::GetCursorPos([ref]$testActual)
          throw "Test target is obscured or ignores mouse input; no click sent (target=$testHwnd hit=$testHit rect=$($testRect.Left),$($testRect.Top),$($testRect.Right),$($testRect.Bottom) point=$($testPoint.X),$($testPoint.Y) cursor=$($testActual.X),$($testActual.Y))"
        }
        [OverlayTestInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
        [OverlayTestInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      } else { throw 'Unsupported test operation' }
      [Console]::Out.WriteLine('{"ok":true}')
    } catch {
      [Console]::Out.WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    }
  }
} finally {
  [void][OverlayTestInput]::SetCursorPos($testOriginal.X, $testOriginal.Y)
}
