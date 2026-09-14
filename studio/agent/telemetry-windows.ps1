$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$notes = [System.Collections.Generic.List[string]]::new()
$engines = @(); $memory = @(); $adapters = @(); $processes = @(); $network = $null; $disk = $null
try { $engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Select-Object Name,UtilizationPercentage) } catch { $notes.Add('GPU engine counters unavailable') }
try { $memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name,DedicatedUsage,SharedUsage) } catch { $notes.Add('GPU memory counters unavailable') }
try {
  $devices = @(Get-CimInstance Win32_VideoController)
  $drivers = @(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' -ErrorAction SilentlyContinue)
  $adapters = @($devices | ForEach-Object {
    $device = $_
    $driver = $drivers | Where-Object DriverDesc -eq $device.Name | Select-Object -First 1
    # Win32_VideoController.AdapterRAM is uint32 and truncates modern VRAM.
    $bytes = $driver.'HardwareInformation.qwMemorySize'
    [pscustomobject]@{ name = $device.Name; total = if ($bytes -is [ValueType] -and $bytes -gt 0) { [double]$bytes } else { $null } }
  })
} catch { $notes.Add('GPU device information unavailable') }
try {
  $processes = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 30 | ForEach-Object {
    [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; ram = $_.WorkingSet64; cpuSeconds = $_.CPU }
  })
} catch { $notes.Add('Process memory information unavailable') }
try {
  $interfaces = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface)
  $network = @{ receive = ($interfaces | Measure-Object BytesReceivedPersec -Sum).Sum; send = ($interfaces | Measure-Object BytesSentPersec -Sum).Sum }
} catch { $notes.Add('Network counters unavailable') }
try {
  $volume = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object Name -eq '_Total'
  if ($volume) { $disk = @{ read = $volume.DiskReadBytesPersec; write = $volume.DiskWriteBytesPersec } }
} catch { $notes.Add('Disk counters unavailable') }
@{ engines = $engines; memory = $memory; adapters = $adapters; processes = $processes; network = $network; disk = $disk; notes = @($notes) } | ConvertTo-Json -Depth 5 -Compress
