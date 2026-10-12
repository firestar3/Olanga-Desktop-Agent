param(
  [string]$IconPath = (Join-Path $PSScriptRoot '..\assets\icons\tray.ico'),
  [string]$PreviewDirectory
)
$ErrorActionPreference = 'Stop'
$nativeSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class OlangaNativeIconCheck {
  [StructLayout(LayoutKind.Sequential)] struct IconInfo {
    public int Icon; public uint X, Y; public IntPtr Mask, Color;
  }
  [StructLayout(LayoutKind.Sequential)] struct BitmapHeader {
    public uint Size; public int Width, Height; public ushort Planes, Bits;
    public uint Compression, ImageSize; public int XPels, YPels; public uint Used, Important;
  }
  [StructLayout(LayoutKind.Sequential)] struct BitmapInfo {
    public BitmapHeader Header; public uint Color0, Color1;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadImageW(IntPtr instance, string name, uint type, int width, int height, uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [DllImport("user32.dll", SetLastError=true)] static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr bitmap);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr bitmap);
  [DllImport("gdi32.dll", SetLastError=true)] static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, byte[] bytes, ref BitmapInfo info, uint usage);
  [DllImport("gdi32.dll", SetLastError=true)] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
  public sealed class Result {
    public int Size, TransparentPixels, AntialiasedPixels, OpaquePixels, PreservedBackgroundPixels;
    public bool CornersTransparent, LightBackgroundPassed, DarkBackgroundPassed;
  }
  static BitmapInfo Info(int size) {
    return new BitmapInfo { Header = new BitmapHeader { Size=40, Width=size, Height=-size, Planes=1, Bits=32, ImageSize=(uint)(size*size*4) } };
  }
  static void Check(bool success, string message) {
    if (!success) throw new Exception(message + " (Win32 " + Marshal.GetLastWin32Error() + ")");
  }
  static void SaveBitmap(string path, int size, byte[] pixels) {
    using (var file = new BinaryWriter(File.Create(path))) {
      file.Write((ushort)0x4d42); file.Write(54+pixels.Length); file.Write(0); file.Write(54);
      file.Write(40); file.Write(size); file.Write(-size); file.Write((ushort)1); file.Write((ushort)32);
      file.Write(0); file.Write(pixels.Length); file.Write(0); file.Write(0); file.Write(0); file.Write(0); file.Write(pixels);
    }
  }
  static byte[] Draw(IntPtr icon, int size, byte background, string preview) {
    var dc = CreateCompatibleDC(IntPtr.Zero); Check(dc != IntPtr.Zero, "CreateCompatibleDC failed");
    IntPtr bits, old=IntPtr.Zero; var info=Info(size);
    var bitmap=CreateDIBSection(dc, ref info, 0, out bits, IntPtr.Zero, 0);
    try {
      Check(bitmap != IntPtr.Zero && bits != IntPtr.Zero, "CreateDIBSection failed");
      old=SelectObject(dc,bitmap); var pixels=new byte[size*size*4];
      for(int i=0;i<pixels.Length;i+=4) { pixels[i]=pixels[i+1]=pixels[i+2]=background; pixels[i+3]=255; }
      Marshal.Copy(pixels,0,bits,pixels.Length);
      Check(DrawIconEx(dc,0,0,icon,size,size,0,IntPtr.Zero,3),"DrawIconEx failed");
      Marshal.Copy(bits,pixels,0,pixels.Length);
      if (!String.IsNullOrEmpty(preview)) SaveBitmap(preview,size,pixels);
      return pixels;
    } finally { if(old!=IntPtr.Zero) SelectObject(dc,old); if(bitmap!=IntPtr.Zero) DeleteObject(bitmap); DeleteDC(dc); }
  }
  public static Result Verify(string path,int size,string previews) {
    var icon=LoadImageW(IntPtr.Zero,path,1,size,size,0x10);
    Check(icon!=IntPtr.Zero,"LoadImageW failed for "+size+"px");
    var info=new IconInfo(); var dc=IntPtr.Zero;
    try {
      Check(GetIconInfo(icon,out info),"GetIconInfo failed");
      Check(info.Color!=IntPtr.Zero && info.Mask!=IntPtr.Zero,"Native icon must contain both color and mask bitmaps");
      dc=CreateCompatibleDC(IntPtr.Zero); var format=Info(size); var color=new byte[size*size*4];
      Check(GetDIBits(dc,info.Color,0,(uint)size,color,ref format,0)==size,"GetDIBits color failed");
      var mask=new byte[color.Length]; format=Info(size);
      Check(GetDIBits(dc,info.Mask,0,(uint)size,mask,ref format,0)==size,"GetDIBits mask failed");
      var result=new Result { Size=size,CornersTransparent=true };
      foreach(int pixel in new int[] {0,size-1,size*(size-1),size*size-1}) result.CornersTransparent &= color[pixel*4+3]==0;
      Check(result.CornersTransparent,"Native icon corners lost alpha");
      for(int i=0;i<color.Length;i+=4) {
        if(color[i+3]==0) { result.TransparentPixels++; Check(mask[i]==255,"Native AND mask lost a transparent pixel"); }
        else if(color[i+3]==255) result.OpaquePixels++; else result.AntialiasedPixels++;
      }
      Check(result.OpaquePixels>size*size*0.55 && result.AntialiasedPixels>0,"Native icon lost its opaque core or antialiasing");
      foreach(byte background in new byte[] {255,24}) {
        string preview=String.IsNullOrEmpty(previews)?null:Path.Combine(previews,"tray-native-"+size+"-"+(background==255?"light":"dark")+".bmp");
        var rendered=Draw(icon,size,background,preview);
        for(int i=0;i<color.Length;i+=4) if(color[i+3]==0) {
          Check(rendered[i]==background && rendered[i+1]==background && rendered[i+2]==background,"Native drawing replaced a transparent pixel with a matte");
          result.PreservedBackgroundPixels++;
        }
        int center=((size/2)*size+size/2)*4;
        Check(rendered[center]>rendered[center+1] && rendered[center]>rendered[center+2],"Native rendered center must remain purple");
        if(background==255) result.LightBackgroundPassed=true; else result.DarkBackgroundPassed=true;
      }
      return result;
    } finally { if(dc!=IntPtr.Zero) DeleteDC(dc); if(info.Color!=IntPtr.Zero) DeleteObject(info.Color); if(info.Mask!=IntPtr.Zero) DeleteObject(info.Mask); DestroyIcon(icon); }
  }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp
$resolvedIcon = (Resolve-Path -LiteralPath $IconPath).Path
if ($PreviewDirectory) {
  $PreviewDirectory = [IO.Path]::GetFullPath($PreviewDirectory)
  [IO.Directory]::CreateDirectory($PreviewDirectory) | Out-Null
}
$results = @(16, 20, 24, 32, 40, 48, 64, 128, 256) | ForEach-Object { [OlangaNativeIconCheck]::Verify($resolvedIcon, $_, $PreviewDirectory) }
if ($PreviewDirectory) {
  Add-Type -AssemblyName System.Drawing
  foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 128, 256)) {
    foreach ($background in @('light', 'dark')) {
      $previewBase = Join-Path $PreviewDirectory "tray-native-$size-$background"
      $bitmap = [System.Drawing.Bitmap]::new($previewBase + '.bmp')
      try { $bitmap.Save($previewBase + '.png', [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
    }
  }
}
[PSCustomObject]@{ Passed = $true; IconPath = $resolvedIcon; Sizes = $results } | ConvertTo-Json -Depth 4
