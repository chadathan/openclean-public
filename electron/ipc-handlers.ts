import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { access, constants, statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { registerMetricsLoop } from './metrics-loop';
import {
  batteryCache, countSnapshots, quittableProcess, execFileAsync, findValue, MINIMUM_VOLUME_BYTES, nativeHelper,
  readCooling, readCpuInfo, readCpuMetrics, readCpuTemperature, readDiskHardware, readDiskIo,
  readGpuInfo, readGpuStatistics, readLogicalCpuMetrics, readMemoryInfo, readNetworkMetrics,
  readActivityProcesses, stopActivityProcesses, readConsumers, readDisks, readFilesystems, readPower, readProcessStats, readTemperatures, readThermalState, readTrashBytes,
  SYSTEM_MOUNT_NAMES, updateBatteryCache
} from './system-metrics';

export async function registerSystemIpc(openMainWindowFromAlert?: () => void): Promise<void> {
/** The swap file's size and how much of it is in use both move by the minute. */
const SWAP_CACHE_MS = 10_000;
const PMSET_CACHE_MS = 10_000;
let pmsetCache = { stdout: '', sampledAt: 0 };
let swapCache = { total: 0, used: 0, sampledAt: 0 };

ipcMain.handle('system:summary', () => ({ platform: process.platform, model: 'MacBook Pro', available: true }));

ipcMain.handle('system:open-privacy-settings', async () => {
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  return { opened: true };
});
ipcMain.handle('system:open-login-items-settings', async () => {
  await shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
  return { opened: true };
});
ipcMain.handle('system:check-full-disk-access', async () => {
  try {
    await access(join(app.getPath('home'), 'Library/Mail'), constants.R_OK);
    return { granted: true };
  } catch {
    return { granted: false };
  }
});
ipcMain.handle('system:choose-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return { granted: !result.canceled, path: result.canceled ? null : result.filePaths[0] ?? null };
});
const readCpuChannel = async () => ({
  ...readCpuMetrics(),
  logical: readLogicalCpuMetrics(),
  ...await readProcessStats(),
  logicalCores: cpus().length,
  model: cpus()[0]?.model ?? 'Unknown CPU',
  temperatureC: await readCpuTemperature(),
  uptimeSeconds: Math.floor(uptime()),
  sampledAt: Date.now()
});
/**
 * Quits an app from a Top Consumers row. SIGTERM rather than SIGKILL, so the app runs its own
 * shutdown; macOS still gives it no chance to ask about unsaved work the way the Quit menu
 * item would, which is why this confirms first — and the default button is Cancel.
 *
 * Only a pid a panel is currently listing can be named, and the wording comes from the name
 * that panel recorded, never from anything the request carried. Every process the row stands
 * for is signalled: an app's helpers keep its row alive on their own.
 */
ipcMain.handle('system:quit-process', async (event, pid: unknown) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return { quit: false, reason: 'invalid' };
  const target = quittableProcess(pid);
  if (target === null) return { quit: false, reason: 'not-listed' };

  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const { response } = await dialog.showMessageBox(parent as BrowserWindow, {
    type: 'warning',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Quit ${target.name}?`,
    detail: 'It is asked to close straight away. Anything it has not saved may be lost.'
  });
  if (response !== 0) return { quit: false, reason: 'cancelled' };

  const failures: string[] = [];
  let signalled = 0;
  for (const member of [pid, ...target.pids.filter(other => other !== pid)]) {
    try {
      process.kill(member, 'SIGTERM');
      signalled++;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ESRCH just means it went away between the list and the click.
      if (code !== 'ESRCH') failures.push(code ?? 'failed');
    }
  }
  if (signalled > 0) return { quit: true };
  if (!failures.length) return { quit: false, reason: 'gone' };

  await dialog.showMessageBox(parent as BrowserWindow, {
    type: 'error',
    message: `${target.name} could not be quit`,
    detail: failures[0] === 'EPERM' ? 'macOS does not allow this process to be closed by OpenClean.' : failures[0]
  });
  return { quit: false, reason: failures[0] };
});

ipcMain.handle('system:network', readNetworkMetrics);
ipcMain.handle('system:cpu-info', readCpuInfo);
ipcMain.handle('system:memory-info', readMemoryInfo);
ipcMain.handle('system:gpu-info', readGpuInfo);
// Neural Engine. macOS publishes no utilisation figure for it — not through IOKit, not
// through IOReport, not even through powermetrics — so activity is inferred from the energy
// counter, which is the one thing that does move when the ANE is working.
// The Neural Engine sits at zero unless something asks it to work, which makes the panel
// impossible to tell apart from a broken one. This runs a short Vision workload so the
// reading has something to show. It is fire-and-forget: the caller should not wait out the
// load, and the panel picks the change up on its next poll like any other movement.
let npuLoadUntil = 0;

const readThermalsChannel = async () => {
  const [temperatures, power, thermalState, cooling] = await Promise.all([
    readTemperatures(), readPower(), readThermalState(), readCooling()
  ]);
  return {
    cpuC: temperatures.cpuC,
    gpuC: temperatures.gpuC,
    aneC: temperatures.aneC,
    socC: temperatures.socC,
    batteryC: temperatures.batteryC,
    hottestName: temperatures.hottestName,
    hottestC: temperatures.hottestC,
    readableSensors: temperatures.readableSensors,
    thermalState,
    fans: cooling.fans,
    // The parts as well as the total: the Energy card is about where the watts are going, and
    // a single package figure cannot answer that.
    cpuWatts: power.cpuWatts,
    gpuWatts: power.gpuWatts,
    aneWatts: power.aneWatts,
    packageWatts: power.cpuWatts === null && power.gpuWatts === null ? null
      : Number(((power.cpuWatts ?? 0) + (power.gpuWatts ?? 0) + (power.aneWatts ?? 0)).toFixed(2)),
    sampledAt: Date.now()
  };
};
ipcMain.handle('system:npu-selftest', async () => {
  const seconds = 12;
  if (Date.now() < npuLoadUntil) return { started: false, endsAt: npuLoadUntil };
  try {
    const child = spawn(nativeHelper('openclean-ane-load'), [`${seconds}`], { stdio: 'ignore', detached: true });
    child.unref();
    child.on('error', () => { npuLoadUntil = 0; });
  } catch {
    return { started: false, endsAt: 0 };
  }
  npuLoadUntil = Date.now() + seconds * 1_000;
  return { started: true, endsAt: npuLoadUntil };
});
const readNpuChannel = async () => {
  const [temperatures, power] = await Promise.all([readTemperatures(), readPower()]);
  const watts = power.aneWatts;
  return {
    watts,
    temperatureC: temperatures.aneC,
    // The sensor gates off below a trickle, so a small floor keeps idle from reading active.
    active: watts !== null && watts >= 0.05,
    available: watts !== null,
    sampledAt: Date.now()
  };
};
const readGpuChannel = async () => {
  const [statistics, temperatures, power] = await Promise.all([readGpuStatistics(), readTemperatures(), readPower()]);
  const value = (key: string): number | null => statistics.get(key) ?? null;
  return {
    usagePercent: value('Device Utilization %'),
    rendererPercent: value('Renderer Utilization %'),
    tilerPercent: value('Tiler Utilization %'),
    inUseBytes: value('In use system memory'),
    allocatedBytes: value('Alloc system memory'),
    parameterBufferBytes: value('Allocated PB Size'),
    recoveryCount: value('recoveryCount'),
    temperatureC: temperatures.gpuC,
    watts: power.gpuWatts,
    sampledAt: Date.now()
  };
};
const readMemoryChannel = async () => {
  const totalBytes = totalmem();
  let usedBytes = 0;
  let activeBytes = 0;
  let appBytes = 0;
  let wiredBytes = 0;
  let compressedBytes = 0;
  let cachedBytes = 0;
  let purgeableBytes = 0;
  let swapUsedBytes = 0;
  let swapTotalBytes = 0;
  try {
    const { stdout } = await execFileAsync('/usr/bin/vm_stat', [], { timeout: 1_000 });
    const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1] ?? 16_384);
    const pages = (label: string): number => Number(stdout.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
    // CleanMyMac/Activity Monitor's available-memory view is active + wired + compressed.
    const purgeablePages = pages('Pages purgeable');
    // App Memory in Activity Monitor is anonymous pages less the purgeable ones. The
    // active count is not the same thing — it also holds file-backed pages that are in
    // use, which left Memory Used more than a gigabyte short of Activity Monitor's.
    appBytes = Math.max(0, pages('Anonymous pages') - purgeablePages) * pageSize;
    activeBytes = pages('Pages active') * pageSize;
    wiredBytes = pages('Pages wired down') * pageSize;
    compressedBytes = pages('Pages occupied by compressor') * pageSize;
    // "Cached Files": file contents the system can reclaim, purgeable pages included.
    cachedBytes = (pages('File-backed pages') + purgeablePages) * pageSize;
    purgeableBytes = purgeablePages * pageSize;
    usedBytes = appBytes + wiredBytes + compressedBytes;
  } catch {
    usedBytes = Math.max(0, totalBytes - freemem());
  }
  // The nearest reading to Task Manager's Committed: how much of the backing store the
  // system is actually leaning on. macOS has no commit charge as such.
  if (Date.now() - swapCache.sampledAt < SWAP_CACHE_MS) {
    swapTotalBytes = swapCache.total;
    swapUsedBytes = swapCache.used;
  } else try {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 1_000 });
    const megabytes = (label: string): number => {
      const value = Number(stdout.match(new RegExp(`${label}\\s*=\\s*([0-9.]+)M`))?.[1] ?? NaN);
      return Number.isFinite(value) ? Math.round(value * 1_048_576) : 0;
    };
    swapTotalBytes = megabytes('total');
    swapUsedBytes = megabytes('used');
    swapCache = { total: swapTotalBytes, used: swapUsedBytes, sampledAt: Date.now() };
  } catch {
    // Swap stays at zero when the sysctl is unavailable.
  }
  // Keep the displayed percentage consistent with the "in use / total" figures.
  // memory_pressure's free percentage describes pressure/reclaimability, not the
  // fraction of installed RAM represented by usedBytes.
  const pressurePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
  return { usedBytes, totalBytes, availableBytes: Math.max(0, totalBytes - usedBytes), appBytes, activeBytes, wiredBytes, compressedBytes, cachedBytes, purgeableBytes, swapUsedBytes, swapTotalBytes, pressurePercent, sampledAt: Date.now() };
};
// Disk throughput. IOBlockStorageDriver keeps lifetime byte counters per physical device;
// the difference between two readings is the rate. The counters live on the hardware, not
// on the volumes stacked above it, so this is whole-machine I/O rather than per volume.
let previousDiskIo: { read: number; written: number; readOps: number; writeOps: number; readTime: number; writeTime: number; sampledAt: number } | null = null;

type DiskIo = {
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  readBytes: number | null;
  writtenBytes: number | null;
  readOpsPerSecond: number | null;
  writeOpsPerSecond: number | null;
  readLatencyMs: number | null;
  writeLatencyMs: number | null;
};

async function readDiskIo(): Promise<DiskIo> {
  const empty: DiskIo = {
    readBytesPerSecond: null, writeBytesPerSecond: null, readBytes: null, writtenBytes: null,
    readOpsPerSecond: null, writeOpsPerSecond: null, readLatencyMs: null, writeLatencyMs: null
  };
  try {
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-w', '0'], { timeout: 2_000 });
    const totals = { read: 0, written: 0, readOps: 0, writeOps: 0, readTime: 0, writeTime: 0 };
    for (const [, block] of stdout.matchAll(/"Statistics"\s*=\s*\{([^}]*)\}/g)) {
      const value = (key: string) => Number(block.match(new RegExp(`"${key}"=(\\d+)`))?.[1] ?? 0);
      totals.read += value('Bytes \\(Read\\)');
      totals.written += value('Bytes \\(Write\\)');
      totals.readOps += value('Operations \\(Read\\)');
      totals.writeOps += value('Operations \\(Write\\)');
      totals.readTime += value('Total Time \\(Read\\)');
      totals.writeTime += value('Total Time \\(Write\\)');
    }
    const sampledAt = Date.now();
    const previous = previousDiskIo;
    previousDiskIo = { ...totals, sampledAt };
    if (!previous) return { ...empty, readBytes: totals.read, writtenBytes: totals.written };
    const elapsed = Math.max(0.25, (sampledAt - previous.sampledAt) / 1_000);
    const readOps = totals.readOps - previous.readOps;
    const writeOps = totals.writeOps - previous.writeOps;
    // Service time is cumulative nanoseconds, so dividing by the operations in the same
    // window gives the average time one of them took — over the window, not since boot.
    const latency = (time: number, ops: number) => ops > 0 ? Number((time / ops / 1e6).toFixed(2)) : null;
    return {
      readBytesPerSecond: Math.max(0, (totals.read - previous.read) / elapsed),
      writeBytesPerSecond: Math.max(0, (totals.written - previous.written) / elapsed),
      readBytes: totals.read,
      writtenBytes: totals.written,
      readOpsPerSecond: Math.max(0, readOps / elapsed),
      writeOpsPerSecond: Math.max(0, writeOps / elapsed),
      readLatencyMs: latency(totals.readTime - previous.readTime, readOps),
      writeLatencyMs: latency(totals.writeTime - previous.writeTime, writeOps)
    };
  } catch {
    return empty;
  }
}

// The drive behind the startup volume, resolved rather than assumed: the APFS container
// names its physical store, and that names the disk. Read once — none of it changes.
type DiskHardware = {
  model: string | null;
  protocol: string | null;
  location: string | null;
  solidState: boolean | null;
  smartStatus: string | null;
  physicalBytes: number | null;
};

let diskHardwareCache: DiskHardware | null = null;

async function readDiskHardware(): Promise<DiskHardware> {
  if (diskHardwareCache) return diskHardwareCache;
  const empty: DiskHardware = { model: null, protocol: null, location: null, solidState: null, smartStatus: null, physicalBytes: null };
  try {
    const container = await execFileAsync('/usr/sbin/diskutil', ['info', '/System/Volumes/Data'], { timeout: 3_000 });
    const store = container.stdout.match(/APFS Physical Store:\s*(\S+)/)?.[1];
    if (!store) { diskHardwareCache = empty; return empty; }
    const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['info', store.replace(/s\d+$/, '')], { timeout: 3_000 });
    const text = (label: string) => stdout.match(new RegExp(`${label}:\\s*(.+)`))?.[1]?.trim() ?? null;
    const bytes = Number(stdout.match(/Disk Size:.*?\((\d+) Bytes\)/)?.[1] ?? NaN);
    diskHardwareCache = {
      model: text('Device / Media Name'),
      protocol: text('Protocol'),
      location: text('Device Location'),
      solidState: text('Solid State') === null ? null : text('Solid State') === 'Yes',
      smartStatus: text('SMART Status'),
      physicalBytes: Number.isFinite(bytes) ? bytes : null
    };
  } catch {
    diskHardwareCache = empty;
  }
  return diskHardwareCache;
}

// Local snapshots hold onto space that free-space figures already account for, but knowing
// they exist explains where a chunk of a full disk went.
async function countSnapshots(mountPoint: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['apfs', 'listSnapshots', mountPoint], { timeout: 3_000 });
    return (stdout.match(/^\+-- /gm) ?? []).length;
  } catch {
    return null;
  }
}

// Mounts that exist to boot and update the machine rather than to hold anything a person
// put there. Listing them alongside the startup disk is noise.
const SYSTEM_MOUNT_NAMES = new Set(['Preboot', 'Update', 'xarts', 'iSCPreboot', 'Hardware', 'VM']);
const MINIMUM_VOLUME_BYTES = 2 * 1024 ** 3;

/** Format and SMART verdict per mount point; both are fixed for as long as it is mounted. */
const volumeFactCache = new Map<string, { fileSystem: string | null; health: string | null }>();

const readStorageChannel = async () => {
  let totalBytes: number;
  let usedBytes: number;
  let availableBytes: number;
  try {
    const row = (await readFilesystems()).find(line => line.trim().split(/\s+/).slice(5).join(' ') === '/System/Volumes/Data');
    const columns = row?.trim().split(/\s+/) ?? [];
    totalBytes = Number(columns[1]) * 1024;
    availableBytes = Number(columns[3]) * 1024;
    usedBytes = Math.max(0, totalBytes - availableBytes);
    if (![totalBytes, usedBytes, availableBytes].every(Number.isFinite)) throw new Error('Unable to parse df output');
  } catch {
    const stats = await statfs(app.getPath('home'));
    totalBytes = Number(stats.blocks) * Number(stats.bsize);
    availableBytes = Number(stats.bavail) * Number(stats.bsize);
    usedBytes = Math.max(0, totalBytes - availableBytes);
  }
  const trashBytes = await readTrashBytes();
  // One card per APFS container, not per volume. Every volume in a container reports the
  // container's size and free space as its own, so listing them separately showed the
  // startup disk five times over — and the read-only system volume, at 13 GB of a 494 GB
  // container, read as a disk that was 3% full while the machine was at 90%.
  type Volume = { name: string; mountPoint: string; usedBytes: number; totalBytes: number; availableBytes: number; usedPercent: number; fileSystem: string | null; health: string | null; trashBytes: number | null };
  const containers = new Map<string, Volume>();
  try {
    for (const line of await readFilesystems()) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 6 || !columns[0].startsWith('/dev/disk')) continue;
      const total = Number(columns[1]) * 1024;
      const available = Number(columns[3]) * 1024;
      const mountPoint = columns.slice(5).join(' ');
      if (!Number.isFinite(total) || total < MINIMUM_VOLUME_BYTES || !mountPoint.startsWith('/')) continue;
      if (SYSTEM_MOUNT_NAMES.has(mountPoint.split('/').at(-1) ?? '')) continue;
      // /dev/disk3s1 and /dev/disk3s3s1 are both in container disk3.
      const container = columns[0].replace('/dev/', '').replace(/s\d+(s\d+)?$/, '');
      const used = Math.max(0, total - available);
      const isBootVolume = mountPoint === '/' || mountPoint === '/System/Volumes/Data';
      const existing = containers.get(container);
      // The boot volume names its container; otherwise the first mount seen does.
      if (existing && !isBootVolume) continue;
      containers.set(container, {
        name: isBootVolume ? 'Macintosh HD' : mountPoint.split('/').at(-1) || mountPoint,
        mountPoint: isBootVolume ? '/System/Volumes/Data' : mountPoint,
        usedBytes: used,
        totalBytes: total,
        availableBytes: available,
        usedPercent: Math.round((used / total) * 100),
        fileSystem: null,
        health: null,
        trashBytes: isBootVolume ? trashBytes : null
      });
    }
  } catch { /* Keep the primary volume when df is restricted. */ }
  const volumes = [...containers.values()].sort((a, b) => b.totalBytes - a.totalBytes);
  if (!volumes.length) volumes.push({ name: 'Macintosh HD', mountPoint: '/System/Volumes/Data', usedBytes, totalBytes, availableBytes, usedPercent: totalBytes > 0 ? Math.round(usedBytes / totalBytes * 100) : 0, fileSystem: null, health: null, trashBytes });
  // A volume's format and SMART verdict do not change while it stays mounted, and asking
  // diskutil for them cost about a tenth of a second per volume on every single poll.
  await Promise.all(volumes.map(async volume => {
    const cached = volumeFactCache.get(volume.mountPoint);
    if (cached) { volume.fileSystem = cached.fileSystem; volume.health = cached.health; return; }
    try {
      const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['info', volume.mountPoint], { timeout: 1_000 });
      volume.fileSystem = stdout.match(/File System Personality:\s*(.+)/)?.[1]?.trim() ?? stdout.match(/Type \(Bundle\):\s*(.+)/)?.[1]?.trim() ?? null;
      volume.health = stdout.match(/SMART Status:\s*(.+)/)?.[1]?.trim() ?? null;
      volumeFactCache.set(volume.mountPoint, { fileSystem: volume.fileSystem, health: volume.health });
    } catch { /* Some synthetic or protected mounts do not expose diskutil metadata. */ }
  }));
  const [io, hardware, snapshots] = await Promise.all([readDiskIo(), readDiskHardware(), countSnapshots('/')]);
  const disks = await readDisks();
  return { volumeName: 'Macintosh HD', usedBytes, totalBytes, availableBytes, trashBytes, hardware, snapshots, usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0, volumes, disks, ...io, sampledAt: Date.now() };
};

const readBatteryChannel = async () => {
  // Charge, state and time remaining all move by the minute. The watt figure the chart plots
  // comes from AppleSmartBattery below, not from here, so holding this does not stale a line.
  if (Date.now() - pmsetCache.sampledAt >= PMSET_CACHE_MS) {
    const fresh = await execFileAsync('/usr/bin/pmset', ['-g', 'batt'], { timeout: 1_000 });
    pmsetCache = { stdout: fresh.stdout, sampledAt: Date.now() };
  }
  const { stdout } = pmsetCache;
  const percent = Number(stdout.match(/(\d+)%/)?.[1] ?? 0);
  const stateMatch = stdout.match(/;\s*(charging|discharging|charged|finishing charge|AC attached)/i);
  const state = (stateMatch?.[1] ?? 'unknown').toLowerCase();
  const timeMatch = stdout.match(/;\s*(\d+:\d+)\s*remaining/i);
  let cycleCount = batteryCache.cycleCount;
  let health = batteryCache.health;
  let temperatureC: number | null = null;
  if (Date.now() - batteryCache.sampledAt > 60_000) {
    try {
      const detail = await execFileAsync('/usr/sbin/system_profiler', ['SPPowerDataType', '-json'], { timeout: 5_000 });
      const parsed = JSON.parse(detail.stdout) as unknown;
      const cycle = findValue(parsed, ['Cycle Count', 'sppower_battery_cycle_count']);
      cycleCount = typeof cycle === 'number' ? cycle : Number(cycle) || null;
      const healthValue = findValue(parsed, ['sppower_battery_health_maximum_capacity', 'sppower_battery_health']);
      health = healthValue ? String(healthValue) : null;
    } catch {
      cycleCount = null;
    }
    updateBatteryCache({ cycleCount, health, sampledAt: Date.now() });
  }
  // AppleSmartBattery carries the charge, the pack voltage and the instantaneous current,
  // which together give the real draw — no privileged helper needed for any of it.
  let chargeMah: number | null = null;
  let maxChargeMah: number | null = null;
  let designMah: number | null = null;
  let nominalMah: number | null = null;
  let volts: number | null = null;
  let milliamps: number | null = null;
  let externalConnected = false;
  let isCharging = false;
  let adapterWatts: number | null = null;
  let adapterVolts: number | null = null;
  try {
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'AppleSmartBattery', '-w', '0'], { timeout: 1_000 });
    const integer = (key: string): number | null => {
      const value = Number(stdout.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`))?.[1] ?? NaN);
      return Number.isFinite(value) ? value : null;
    };
    const temperature = integer('Temperature');
    temperatureC = temperature === null ? null : Math.round((temperature / 100) * 10) / 10;
    chargeMah = integer('AppleRawCurrentCapacity');
    maxChargeMah = integer('AppleRawMaxCapacity');
    designMah = integer('DesignCapacity');
    nominalMah = integer('NominalChargeCapacity');
    const millivolts = integer('Voltage');
    volts = millivolts === null ? null : millivolts / 1_000;
    // Negative while discharging, positive while charging, zero when the pack is just
    // sitting on mains power.
    //
    // ioreg's text output prints 64-bit integers unsigned, so a discharging pack's negative
    // Amperage arrives as 2^64 minus the real reading — about 1.8e19, which multiplied by the
    // pack voltage made the panel report a battery drawing 231 petawatts. BigInt first,
    // because a value that size does not survive being parsed as a double.
    const signedInteger = (key: string): number | null => {
      const raw = stdout.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`))?.[1];
      if (raw === undefined) return null;
      try {
        const value = BigInt(raw);
        return Number(value >= 1n << 63n ? value - (1n << 64n) : value);
      } catch {
        return null;
      }
    };
    milliamps = signedInteger('InstantAmperage') ?? signedInteger('Amperage');
    externalConnected = /"ExternalConnected"\s*=\s*Yes/.test(stdout);
    isCharging = /"IsCharging"\s*=\s*Yes/.test(stdout);
    const adapter = stdout.match(/"AdapterDetails"\s*=\s*\{([^}]*)\}/)?.[1] ?? '';
    const adapterInteger = (key: string): number | null => {
      const value = Number(adapter.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`))?.[1] ?? NaN);
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    adapterWatts = adapterInteger('Watts');
    const adapterMillivolts = adapterInteger('AdapterVoltage');
    adapterVolts = adapterMillivolts === null ? null : adapterMillivolts / 1_000;
  } catch {
    temperatureC = null;
  }
  const watts = volts === null || milliamps === null ? null : Number(Math.abs((volts * milliamps) / 1_000).toFixed(2));
  return {
    percent, state, timeRemaining: timeMatch?.[1] ?? null, cycleCount, health, temperatureC,
    chargeMah, maxChargeMah, designMah, nominalMah,
    volts: volts === null ? null : Number(volts.toFixed(2)),
    milliamps, watts, externalConnected, isCharging,
    adapterWatts, adapterVolts,
    sampledAt: Date.now()
  };
};

ipcMain.handle('system:cpu', readCpuChannel);
ipcMain.handle('system:memory', readMemoryChannel);
ipcMain.handle('system:gpu', readGpuChannel);
ipcMain.handle('system:npu', readNpuChannel);
ipcMain.handle('system:thermals', readThermalsChannel);
ipcMain.handle('system:storage', readStorageChannel);
ipcMain.handle('system:battery', readBatteryChannel);
ipcMain.handle('system:consumers', readConsumers);
ipcMain.handle('system:process-activity', (event) => readActivityProcesses(`process-manager-${event.sender.id}`));
ipcMain.handle('system:stop-process-activity', (event) => stopActivityProcesses(`process-manager-${event.sender.id}`));
// The sampler and the channels call the same functions, so they can never drift into two
// different ways of reading the same thing.
await registerMetricsLoop({
  cpu: readCpuChannel, memory: readMemoryChannel, gpu: readGpuChannel, npu: readNpuChannel,
  thermals: readThermalsChannel, battery: readBatteryChannel, network: readNetworkMetrics,
  diskIo: readDiskIo, storage: readStorageChannel, consumers: readConsumers
}, openMainWindowFromAlert);
}
