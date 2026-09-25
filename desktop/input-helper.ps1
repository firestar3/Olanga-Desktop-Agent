# Fixed, packaged Win32 bridge. JSON stdin is data; never evaluate it as PowerShell.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$references = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location)
Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
public static class OlangaDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT monitor,work; public uint flags; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  public class Bounds { public int x,y,width,height; }
  public class Window { public string handle,title,processName; public int processId; public Bounds bounds; }
  public class Control { public string name,controlType,runtimeId; public Bounds bounds; public bool isPassword,isEditable; public int processId; }
  public class Snapshot { public Window foreground; public Window[] windows; public Bounds primaryBounds; public Control focusedControl; }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int show);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr param);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT point,uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor,ref MONITORINFO info);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  static OlangaDesktop() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) { throw new Exception("Desktop actions need Windows 10 version 1703 or newer."); } }
  static IntPtr Handle(string value) { return new IntPtr(Int64.Parse(value)); }
  static Bounds Rect(RECT r) { return new Bounds { x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top }; }
  static Window Read(IntPtr hwnd) {
    if(hwnd==IntPtr.Zero || !IsWindow(hwnd)) return null;
    uint pid; GetWindowThreadProcessId(hwnd,out pid);
    var title=new StringBuilder(1024); GetWindowText(hwnd,title,title.Capacity);
    RECT rect; if(!GetWindowRect(hwnd,out rect)) return null;
    string name=""; try { name=Process.GetProcessById((int)pid).ProcessName; } catch { return null; }
    return new Window { handle=hwnd.ToInt64().ToString(),title=title.ToString(),processName=name,processId=(int)pid,bounds=Rect(rect) };
  }
  static Control FocusedControl() {
    try {
      var element=System.Windows.Automation.AutomationElement.FocusedElement;
      var info=element.Current;
      var r=info.BoundingRectangle;
      if(r.IsEmpty || r.Width<=0 || r.Height<=0) return null;
      object valuePattern,textPattern;
      bool hasValue=element.TryGetCurrentPattern(System.Windows.Automation.ValuePattern.Pattern,out valuePattern);
      bool hasText=element.TryGetCurrentPattern(System.Windows.Automation.TextPattern.Pattern,out textPattern);
      bool readOnly=hasValue && ((System.Windows.Automation.ValuePattern)valuePattern).Current.IsReadOnly;
      bool editable=info.IsEnabled && !readOnly && (info.ControlType==System.Windows.Automation.ControlType.Edit || info.ControlType==System.Windows.Automation.ControlType.Document || hasValue || hasText);
      string name=info.IsPassword?"Password field":info.Name;
      if(name.Length>500) name=name.Substring(0,500);
      return new Control { name=name, controlType=info.ControlType.ProgrammaticName, runtimeId=String.Join(".",element.GetRuntimeId()), isEditable=editable, isPassword=info.IsPassword, processId=info.ProcessId,
        bounds=new Bounds { x=(int)Math.Floor(r.X), y=(int)Math.Floor(r.Y), width=(int)Math.Ceiling(r.Right)-(int)Math.Floor(r.X), height=(int)Math.Ceiling(r.Bottom)-(int)Math.Floor(r.Y) } };
    } catch { return null; }
  }
  static string approvedControl=null;
  public static void CheckRegion(int pid,int x,int y,int width,int height) {
    var control=FocusedControl();
    if(control==null || control.isPassword || !control.isEditable || String.IsNullOrEmpty(control.runtimeId) || control.processId!=pid || control.bounds.x<x || control.bounds.y<y || control.bounds.x+control.bounds.width>x+width || control.bounds.y+control.bounds.height>y+height)
      throw new Exception("The focused control cannot be verified inside the approved editor region. Click inside that editor, enable its accessibility support, and observe again.");
    if(approvedControl==null) approvedControl=control.runtimeId;
    else if(approvedControl!=control.runtimeId) throw new Exception("Focus left the approved editor control. A new capture and permission are required.");
  }
  public static void CheckPassword() {
    var control=FocusedControl();
    if(control!=null && control.isPassword) throw new Exception("Password fields are not supported by desktop actions.");
  }
  public static Snapshot Inspect() {
    var list=new List<Window>();
    EnumWindows(delegate(IntPtr hwnd,IntPtr unused) { if(IsWindowVisible(hwnd)) { var w=Read(hwnd); if(w!=null && w.title.Length>0 && list.Count<100) list.Add(w); } return true; },IntPtr.Zero);
    var info=new MONITORINFO(); info.cbSize=Marshal.SizeOf(info);
    if(!GetMonitorInfo(MonitorFromPoint(new POINT { X=0,Y=0 },1),ref info)) throw new Exception("Cannot read primary display.");
    return new Snapshot { foreground=Read(GetForegroundWindow()),windows=list.ToArray(),primaryBounds=Rect(info.monitor),focusedControl=FocusedControl() };
  }
  static IntPtr Check(string handle,int pid) {
    var hwnd=Handle(handle); uint current;
    GetWindowThreadProcessId(hwnd,out current);
    if(!IsWindow(hwnd) || current!=(uint)pid || GetForegroundWindow()!=hwnd) throw new Exception("The foreground window changed. Observe the screen again before continuing.");
    return hwnd;
  }
  static void IdleKeys() {
    foreach(int key in new[]{1,2,4,16,17,18,91,92}) if((GetAsyncKeyState(key)&0x8000)!=0) throw new Exception("A mouse button or modifier is held. Release it and observe the screen again.");
  }
  static void Send(INPUT[] inputs) {
    if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)))!=(uint)inputs.Length) throw new Exception("Windows blocked input. Elevated or secure windows are unsupported.");
  }
  static INPUT Mouse(uint flags,int x=0,int y=0,int data=0) { return new INPUT { type=0,data=new INPUTUNION { mouse=new MOUSEINPUT { dx=x,dy=y,mouseData=unchecked((uint)data),dwFlags=flags } } }; }
  static INPUT Key(ushort vk,ushort scan,uint flags) {
    // Navigation keys are enhanced keyboard keys; preserve that bit for key-up too.
    if((vk>=33 && vk<=40) || vk==45 || vk==46) flags|=1;
    return new INPUT { type=1,data=new INPUTUNION { key=new KEYBDINPUT { vk=vk,scan=scan,flags=flags } } };
  }
  public static void Focus(string handle,int pid) {
    var hwnd=Handle(handle); uint current; GetWindowThreadProcessId(hwnd,out current);
    if(!IsWindow(hwnd) || current!=(uint)pid) throw new Exception("The observed window no longer exists.");
    if(IsIconic(hwnd)) ShowWindow(hwnd,9);
    SetForegroundWindow(hwnd);
    for(int i=0;i<10 && GetForegroundWindow()!=hwnd;i++) Thread.Sleep(40);
    Check(handle,pid);
  }
  public static void CheckTarget(string handle,int pid) { Check(handle,pid); }
  public static void CheckPointerRegion(int x,int y,int width,int height) {
    POINT point;
    if(!GetCursorPos(out point) || point.X<x || point.Y<y || point.X>=x+width || point.Y>=y+height) throw new Exception("The pointer is outside the approved editor region.");
  }
  public static void CheckPointRegion(int px,int py,int x,int y,int width,int height) {
    if(px<x || py<y || px>=x+width || py>=y+height) throw new Exception("The click is outside the approved editor region.");
  }
  public static void Click(string handle,int pid,int x,int y,string button,int count,int bx,int by,int bw,int bh) {
    var hwnd=Check(handle,pid); IdleKeys(); RECT rect;
    if(!GetWindowRect(hwnd,out rect) || rect.Left!=bx || rect.Top!=by || rect.Right-rect.Left!=bw || rect.Bottom-rect.Top!=bh) throw new Exception("The target window moved or resized. Observe the screen again.");
    var point=new POINT { X=x,Y=y };
    if(GetAncestor(WindowFromPoint(point),2)!=hwnd) throw new Exception("The click is outside the confirmed foreground window or is covered by another window.");
    int vx=GetSystemMetrics(76),vy=GetSystemMetrics(77),vw=GetSystemMetrics(78),vh=GetSystemMetrics(79);
    int ax=(int)Math.Round((x-vx)*65535.0/Math.Max(1,vw-1)),ay=(int)Math.Round((y-vy)*65535.0/Math.Max(1,vh-1));
    var inputs=new List<INPUT>(); inputs.Add(Mouse(0xC001,ax,ay));
    uint down=button=="right"?8u:2u,up=button=="right"?16u:4u;
    for(int i=0;i<count;i++) { inputs.Add(Mouse(down)); inputs.Add(Mouse(up)); }
    Check(handle,pid); Send(inputs.ToArray());
  }
  public static void Type(string handle,int pid,string text,bool restricted,int x,int y,int width,int height) {
    // One small atomic batch per character keeps cancellation and focus changes bounded.
    foreach(char c in text) {
      Check(handle,pid); IdleKeys();
      if(restricted) CheckRegion(pid,x,y,width,height); else CheckPassword();
      // Chromium and several native editors ignore a Unicode CR packet.
      // Deliver an actual Return pair for each approved line break.
      if(c=='\n' || c=='\r') Send(new[]{Key(13,0,0),Key(13,0,2)});
      else Send(new[]{Key(0,c,4),Key(0,c,6)});
    }
  }
  public static void Hotkey(string handle,int pid,int[] keys) {
    Check(handle,pid); IdleKeys(); var inputs=new List<INPUT>();
    foreach(int k in keys) inputs.Add(Key((ushort)k,0,0));
    for(int i=keys.Length-1;i>=0;i--) inputs.Add(Key((ushort)keys[i],0,2));
    Send(inputs.ToArray());
  }
  public static void Scroll(string handle,int pid,int amount) {
    var hwnd=Check(handle,pid); IdleKeys(); POINT point;
    if(!GetCursorPos(out point) || GetAncestor(WindowFromPoint(point),2)!=hwnd) throw new Exception("Move the pointer over the confirmed window before scrolling.");
    Send(new[]{Mouse(0x0800,0,0,-amount*120)});
  }
}
'@

while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    if ($line.Length -gt 24000) { throw 'Request too large.' }
    $request = $line | ConvertFrom-Json
    $result = $null
    if ($request.region) {
      $region = $request.region
      if ($request.kind -eq 'type' -or $request.kind -eq 'hotkey') { [OlangaDesktop]::CheckRegion([int]$request.processId,[int]$region.x,[int]$region.y,[int]$region.width,[int]$region.height) }
      if ($request.kind -eq 'scroll') { [OlangaDesktop]::CheckPointerRegion([int]$region.x,[int]$region.y,[int]$region.width,[int]$region.height) }
      if ($request.kind -eq 'click') { [OlangaDesktop]::CheckPointRegion([int]$request.x,[int]$request.y,[int]$region.x,[int]$region.y,[int]$region.width,[int]$region.height) }
    }
    if ($request.kind -eq 'hotkey') { [OlangaDesktop]::CheckPassword() }
    switch ($request.kind) {
      'inspect' { $result = [OlangaDesktop]::Inspect() }
      'focus' { [OlangaDesktop]::Focus([string]$request.handle, [int]$request.processId) }
      'check' { [OlangaDesktop]::CheckTarget([string]$request.handle, [int]$request.processId) }
      'click' { [OlangaDesktop]::Click([string]$request.handle,[int]$request.processId,[int]$request.x,[int]$request.y,[string]$request.button,[int]$request.count,[int]$request.bounds.x,[int]$request.bounds.y,[int]$request.bounds.width,[int]$request.bounds.height) }
      'type' { [OlangaDesktop]::Type([string]$request.handle,[int]$request.processId,[string]$request.text,[bool]$request.region,[int]$request.region.x,[int]$request.region.y,[int]$request.region.width,[int]$request.region.height) }
      'hotkey' { [OlangaDesktop]::Hotkey([string]$request.handle,[int]$request.processId,[int[]]$request.keys) }
      'scroll' { [OlangaDesktop]::Scroll([string]$request.handle,[int]$request.processId,[int]$request.amount) }
      default { throw 'Unknown desktop operation.' }
    }
    [Console]::WriteLine((@{ id=$request.id; ok=$true; result=$result } | ConvertTo-Json -Compress -Depth 8))
  } catch {
    $message = $_.Exception.Message
    if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
    [Console]::WriteLine((@{ id=$request.id; ok=$false; error=$message } | ConvertTo-Json -Compress -Depth 4))
  }
}
