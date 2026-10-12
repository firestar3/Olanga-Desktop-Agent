param([Parameter(Mandatory=$true)][string]$Executable, [int]$Samples=20, [int]$IntervalMs=1000, [switch]$AllowMissingPrivateWorkingSet)
$ErrorActionPreference='Stop'
$expected=[IO.Path]::GetFullPath($Executable)
$last=@{}
$records=@()
$watch=[Diagnostics.Stopwatch]::StartNew()
$previous=0.0
for($index=0;$index -le $Samples;$index++){
  $procs=@(Get-Process Olanga -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected })
  if($procs.Count -eq 0){throw 'Benchmark app exited'}
  $now=$watch.Elapsed.TotalSeconds
  $elapsed=$now-$previous
  $cpu=0.0
  $private=0L
  $working=0L
  $rows=@()
  foreach($proc in $procs){
    $proc.Refresh()
    $seconds=$proc.TotalProcessorTime.TotalSeconds
    if($last.ContainsKey($proc.Id)){$cpu += [Math]::Max(0.0, [double]($seconds-$last[$proc.Id]))}
    $last[$proc.Id]=$seconds
    $private += $proc.PrivateMemorySize64
    $working += $proc.WorkingSet64
    $rows += @{pid=$proc.Id;cpuSeconds=$seconds;privateBytes=$proc.PrivateMemorySize64;workingSetBytes=$proc.WorkingSet64}
  }
  if($index -gt 0){$records += @{elapsed=$now;cpuCorePercent=100*$cpu/$elapsed;privateBytes=$private;workingSetBytes=$working;processes=$rows}}
  $previous=$now
  if($index -lt $Samples){Start-Sleep -Milliseconds $IntervalMs}
}
# Query the private resident bytes once, after the timed CPU samples. CIM has
# meaningful overhead, so querying it inside every interval would perturb the
# application whose CPU usage we are measuring. Shared working-set pages are
# excluded by WorkingSetPrivate; PrivateMemorySize64 above is committed memory.
$privateWorkingSetSnapshot=$null
$privateWorkingSetError=$null
try{
  # The benchmark starts Windows PowerShell 5.1 from a possibly newer shell.
  # Avoid accidentally loading incompatible PowerShell 7 CIM modules.
  $env:PSModulePath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
  $snapshotWatch=[Diagnostics.Stopwatch]::StartNew()
  for($attempt=0;$attempt -lt 2;$attempt++){
    $snapshotProcs=@(Get-Process Olanga -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected })
    if($snapshotProcs.Count -eq 0){throw 'Benchmark app exited before the private working-set snapshot'}
    $identities=@{}
    foreach($proc in $snapshotProcs){$identities[$proc.Id]=$proc.StartTime.ToUniversalTime().Ticks}
    $filter=($snapshotProcs | ForEach-Object { 'IDProcess = '+$_.Id }) -join ' OR '
    $counters=@(Get-CimInstance -ClassName Win32_PerfRawData_PerfProc_Process -Filter $filter -Property IDProcess,WorkingSetPrivate)
    $currentProcs=@(Get-Process Olanga -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected })
    $stable=$currentProcs.Count -eq $snapshotProcs.Count
    foreach($proc in $currentProcs){
      if(!$identities.ContainsKey($proc.Id) -or $identities[$proc.Id] -ne $proc.StartTime.ToUniversalTime().Ticks){$stable=$false}
    }
    # A process may start/exit during the provider query. Retry the whole
    # snapshot once rather than silently publishing a partial application sum.
    if(!$stable){if($attempt -eq 0){continue};throw 'App process set changed during both private working-set snapshots'}
    $byPid=@{}
    foreach($counter in $counters){$byPid[[int]$counter.IDProcess]=$counter.WorkingSetPrivate}
    $snapshotRows=@()
    $privateWorkingSet=0L
    foreach($proc in $currentProcs){
      if(!$byPid.ContainsKey($proc.Id) -or $null -eq $byPid[$proc.Id]){throw ('Missing private working-set counter for app PID '+$proc.Id)}
      $bytes=[long]$byPid[$proc.Id]
      if($bytes -lt 0){throw ('Invalid private working-set counter for app PID '+$proc.Id)}
      $privateWorkingSet+=$bytes
      $snapshotRows+=@{pid=$proc.Id;privateWorkingSetBytes=$bytes}
    }
    $privateWorkingSetSnapshot=@{elapsed=$watch.Elapsed.TotalSeconds;queryMs=$snapshotWatch.Elapsed.TotalMilliseconds;privateWorkingSetBytes=$privateWorkingSet;processes=$snapshotRows;source='Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate';sampling='end-of-phase snapshot, after CPU samples'}
    break
  }
}catch{
  if(!$AllowMissingPrivateWorkingSet){throw}
  $privateWorkingSetError=$_.Exception.Message
}
@{logicalProcessors=[Environment]::ProcessorCount;samples=$records;privateWorkingSetSnapshot=$privateWorkingSetSnapshot;privateWorkingSetError=$privateWorkingSetError} | ConvertTo-Json -Depth 5 -Compress
