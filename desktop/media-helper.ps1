$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
// Core Audio's endpoint volume controls the Windows output volume. A successful
// setter is followed by a separate read in PowerShell before reporting success.
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class OlangaDeviceEnumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOlangaDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IOlangaDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOlangaDevice {
  [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOlangaEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
  [PreserveSig] int GetChannelCount(out uint channels);
  [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
  [PreserveSig] int GetMasterVolumeLevel(out float level);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
public sealed class OlangaVolumeState {
  public double Level { get; set; }
  public bool Muted { get; set; }
}
public sealed class OlangaSystemAudio : IDisposable {
  private IOlangaDeviceEnumerator enumerator;
  private IOlangaDevice device;
  private IOlangaEndpointVolume endpoint;
  public OlangaSystemAudio() {
    try {
      enumerator = (IOlangaDeviceEnumerator)new OlangaDeviceEnumerator();
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
      Guid iid = typeof(IOlangaEndpointVolume).GUID;
      object instance;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out instance));
      endpoint = (IOlangaEndpointVolume)instance;
    } catch { Dispose(); throw; }
  }
  public OlangaVolumeState Read() {
    float level; bool muted;
    Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out level));
    Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
    return new OlangaVolumeState { Level = Math.Round(level * 100.0, 2), Muted = muted };
  }
  public void SetLevel(double level) {
    if (Double.IsNaN(level) || Double.IsInfinity(level) || level < 0 || level > 100) throw new ArgumentOutOfRangeException("level");
    Guid context = Guid.Empty;
    Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar((float)(level / 100.0), ref context));
    if (level > 0) Marshal.ThrowExceptionForHR(endpoint.SetMute(false, ref context));
  }
  public void SetMuted(bool muted) {
    Guid context = Guid.Empty;
    Marshal.ThrowExceptionForHR(endpoint.SetMute(muted, ref context));
  }
  public void Dispose() {
    if (endpoint != null) { Marshal.ReleaseComObject(endpoint); endpoint = null; }
    if (device != null) { Marshal.ReleaseComObject(device); device = null; }
    if (enumerator != null) { Marshal.ReleaseComObject(enumerator); enumerator = null; }
  }
}
'@
$manager = $null
$asTask = $null

function Initialize-MediaRuntime {
    if ($script:asTask) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
}

function Await-Media($Operation, [Type]$ResultType) {
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(3500)) { throw 'Windows media control timed out.' }
    return $task.Result
}

function Get-MediaSession([bool]$SpotifyOnly) {
    Initialize-MediaRuntime
    if (-not $script:manager) {
        $script:manager = Await-Media ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    if ($SpotifyOnly) {
        return $script:manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match '^(?:Spotify\.exe|Spotify(?:AB)?\.SpotifyMusic_[^!]+!Spotify)$' } | Select-Object -First 1
    }
    return $script:manager.GetCurrentSession()
}

function Get-MediaState($Session) {
    if (-not $Session) { return @{ status = 'Closed'; title = ''; artist = '' } }
    $properties = Await-Media ($Session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    return @{ status = [string]$Session.GetPlaybackInfo().PlaybackStatus; title = [string]$properties.Title; artist = [string]$properties.Artist }
}

function Get-SpotifyRoot {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $process = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($process) { return [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle) }
    return $null
}

function Open-Spotify {
    Start-Process -FilePath 'spotify:' | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        $window = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($window) { return @{ ok = $true; verified = $true; message = 'Spotify is open.'; source = 'spotify'; processId = $window.Id } }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    return @{ ok = $false; verified = $false; message = 'I sent the launch request, but Spotify did not show a window. Check that it is installed and can open.' }
}

function Invoke-VolumeRequest($Request) {
    $audio = [OlangaSystemAudio]::new()
    try {
        $before = $audio.Read()
        if ($Request.action -eq 'VOLUME_STATUS') {
            $message = 'System volume is ' + $before.Level + '%.'
            if ($before.Muted) { $message += ' Muted.' }
            return @{ ok = $true; verified = $true; message = $message; volume = $before.Level; muted = $before.Muted; source = 'system' }
        }
        $target = $before.Level
        $muted = $before.Muted
        switch ($Request.action) {
            'VOLUME_SET' { if ($null -eq $Request.level) { throw 'A volume percentage is required.' }; $target = [double]$Request.level }
            'VOLUME_UP' { $target = [Math]::Min(100, $before.Level + 10) }
            'VOLUME_DOWN' { $target = [Math]::Max(0, $before.Level - 10) }
            'VOLUME_MUTE' { $muted = -not $before.Muted }
            default { throw 'Unsupported volume command.' }
        }
        if ($Request.action -eq 'VOLUME_MUTE') { $audio.SetMuted($muted) }
        else { $audio.SetLevel($target); if ($target -gt 0) { $muted = $false } }
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            $after = $audio.Read()
            if ([Math]::Abs($after.Level - $target) -le 0.5 -and $after.Muted -eq $muted) {
                $message = 'System volume is ' + $after.Level + '%.'
                if ($Request.action -eq 'VOLUME_MUTE') { if ($after.Muted) { $message = 'System audio is muted.' } else { $message = 'System audio is unmuted.' } }
                elseif ($after.Muted) { $message += ' Muted.' }
                return @{ ok = $true; verified = $true; message = $message; volume = $after.Level; muted = $after.Muted; source = 'system' }
            }
            Start-Sleep -Milliseconds 80
        } while ([DateTime]::UtcNow -lt $deadline)
        return @{ ok = $false; verified = $false; message = 'Windows did not confirm the requested volume. It reports ' + $after.Level + '%.'; volume = $after.Level; muted = $after.Muted; source = 'system' }
    } finally { $audio.Dispose() }
}

function Get-SpotifyButtons($Root) {
    if (-not $Root) { return @() }
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    return @($Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled })
}

function Invoke-SpotifyControl($Control) {
    $pattern = $null
    if ($Control.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return }
    if ($Control.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); return }
    throw 'Spotify did not expose an accessible action for that item.'
}

function Wait-Playback([bool]$SpotifyOnly, [string]$Expected, [string]$PreviousTitle = '') {
    $deadline = [DateTime]::UtcNow.AddSeconds(4)
    do {
        $state = Get-MediaState (Get-MediaSession $SpotifyOnly)
        if ($state.status -eq $Expected -and (-not $PreviousTitle -or $state.title -ne $PreviousTitle)) { return $state }
        Start-Sleep -Milliseconds 120
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

function Play-SpotifyCollection($Request) {
    $target = [string]$Request.term
    $uri = 'spotify:search:' + [Uri]::EscapeDataString($target)
    if ($Request.action -eq 'LIKED') { $target = 'Liked Songs'; $uri = 'spotify:collection:tracks' }
    if ($Request.action -eq 'LIBRARY') { $uri = 'spotify:collection:playlists' }
    Start-Process -FilePath $uri | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(9)
    $selected = $Request.action -ne 'LIBRARY'
    $invoked = $false
    $playingLabel = '^Pause\s+' + [regex]::Escape($target) + '(?:\s+by\s+.+)?$'
    $playLabel = '^Play\s+' + [regex]::Escape($target) + '(?:\s+by\s+.+)?$'
    do {
        $root = Get-SpotifyRoot
        if ($root) {
            if (-not $selected) {
                $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
                $libraryLabel = '^' + [regex]::Escape($target) + '\s+(?:Pinned\s+)?Playlist\s+'
                $matches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -match $libraryLabel })
                if ($matches.Count -eq 1) { Invoke-SpotifyControl $matches[0]; $selected = $true }
                elseif ($matches.Count -gt 1) { return @{ ok = $false; message = "There is more than one library item named $target. Open the one you want, then ask me to resume playback." } }
            } else {
                $buttons = @(Get-SpotifyButtons $root)
                $playing = @($buttons | Where-Object { $_.Current.Name -match $playingLabel })
                if ($playing.Count -gt 0) {
                    $state = Wait-Playback $true 'Playing'
                    if ($state) {
                        $message = "$target is playing now."
                        if ($Request.action -eq 'LIKED') { $message = 'Your liked songs are playing now.' }
                        return @{ ok = $true; verified = $true; message = $message; title = $state.title; artist = $state.artist; source = 'spotify' }
                    }
                    break
                }
                if (-not $invoked) {
                    $play = @($buttons | Where-Object { $_.Current.Name -match $playLabel })
                    if ($play.Count -eq 1 -or ($play.Count -gt 1 -and $Request.action -in @('LIKED', 'LIBRARY'))) { Invoke-SpotifyControl $play[0]; $invoked = $true }
                    elseif ($play.Count -gt 1) { return @{ ok = $false; message = "Spotify shows multiple matches for $target. Tell me the artist or exact playlist name." } }
                }
            }
        }
        Start-Sleep -Milliseconds 160
    } while ([DateTime]::UtcNow -lt $deadline)
    return @{ ok = $false; verified = $false; message = "I opened Spotify, but couldn't verify playback of $target. Check that you're signed in and that its Play button is available." }
}

function Invoke-MediaRequest($Request) {
    if ($Request.action -eq 'OPEN') { return Open-Spotify }
    if ($Request.action -in @('LIKED', 'SONG', 'ALBUM', 'PLAYLIST', 'ARTIST', 'LIBRARY')) { return Play-SpotifyCollection $Request }
    if ($Request.action -in @('VOLUME_SET', 'VOLUME_STATUS', 'VOLUME_UP', 'VOLUME_DOWN', 'VOLUME_MUTE')) { return Invoke-VolumeRequest $Request }
    if ($Request.action -eq 'RELOAD') {
        $oldProcesses = @(Get-Process -Name Spotify -ErrorAction SilentlyContinue)
        $oldProcesses | Stop-Process -Force
        foreach ($oldProcess in $oldProcesses) { $null = $oldProcess.WaitForExit(1500) }
        Start-Process -FilePath 'spotify:' | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(8)
        do {
            $session = Get-MediaSession $true
            if ($session -and (Get-SpotifyRoot)) { break }
            Start-Sleep -Milliseconds 150
        } while ([DateTime]::UtcNow -lt $deadline)
    } else { $session = Get-MediaSession ([bool]$Request.spotifyOnly) }
    if (-not $session) { return @{ ok = $false; message = 'No active music player is available. Open Spotify, sign in, and choose a song first.' } }
    $state = Get-MediaState $session
    if ($Request.action -eq 'STATUS') {
        if (-not $state.title) { return @{ ok = $false; message = 'The player is not reporting a song right now.' } }
        $message = $state.title
        if ($state.artist) { $message += ' by ' + $state.artist }
        if ($state.status -eq 'Playing') { $message = 'Playing ' + $message + '.' } else { $message += ' is paused.' }
        return @{ ok = $true; verified = $true; message = $message; title = $state.title; artist = $state.artist }
    }
    $expected = 'Playing'
    $previousTitle = ''
    if (($Request.action -eq 'PAUSE' -and $state.status -eq 'Paused') -or ($Request.action -eq 'PLAY' -and $state.status -eq 'Playing')) {
        $message = 'Playback is already paused.'
        if ($state.status -eq 'Playing') { $message = 'Music is already playing.' }
        return @{ ok = $true; verified = $true; message = $message; title = $state.title; artist = $state.artist }
    }
    switch ($Request.action) {
        'PAUSE' { $operation = $session.TryPauseAsync(); $expected = 'Paused' }
        'PLAY' { $operation = $session.TryPlayAsync() }
        'RELOAD' { $operation = $session.TryPlayAsync() }
        'PLAY_PAUSE' { if ($state.status -eq 'Playing') { $operation = $session.TryPauseAsync(); $expected = 'Paused' } else { $operation = $session.TryPlayAsync() } }
        'NEXT' { $operation = $session.TrySkipNextAsync(); $previousTitle = $state.title }
        'PREV' { $operation = $session.TrySkipPreviousAsync(); $previousTitle = $state.title }
        default { throw 'Unsupported media command.' }
    }
    $accepted = Await-Media $operation ([bool])
    $confirmed = Wait-Playback ([bool]$Request.spotifyOnly) $expected $previousTitle
    if (-not $accepted -or -not $confirmed) { return @{ ok = $false; message = 'The player did not confirm that change. Check Spotify for a sign-in prompt or playback restriction.' } }
    $message = 'Playback resumed.'
    if ($expected -eq 'Paused') { $message = 'Playback paused.' }
    elseif ($confirmed.title) { $message = 'Playing ' + $confirmed.title + '.' }
    return @{ ok = $true; verified = $true; message = $message; title = $confirmed.title; artist = $confirmed.artist }
}

while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
        $request = $line | ConvertFrom-Json
        $result = Invoke-MediaRequest $request
    } catch {
        $result = @{ ok = $false; verified = $false; message = 'Media control failed: ' + $_.Exception.GetBaseException().Message }
    }
    @{ id = $request.id; result = $result } | ConvertTo-Json -Compress -Depth 6 | ForEach-Object { [Console]::WriteLine($_) }
}
