import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { cpus, homedir, networkInterfaces, totalmem } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';

type CpuSnapshot = { idle: number; user: number; system: number; total: number };
type LogicalCpuMetric = { index: number; usagePercent: number; userPercent: number; systemPercent: number };

function captureCpuSnapshot(): CpuSnapshot {
  return cpus().reduce(
    (snapshot, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, time) => sum + time, 0);
      return { idle: snapshot.idle + cpu.times.idle, user: snapshot.user + cpu.times.user + cpu.times.nice, system: snapshot.system + cpu.times.sys + cpu.times.irq, total: snapshot.total + total };
    },
    { idle: 0, user: 0, system: 0, total: 0 }
  );
}

/**
 * Every reading below is a rate: a counter now, less the same counter a moment ago, divided by
 * the gap. Taking that difference consumes it — the next caller finds nothing left to divide.
 * With three windows open the dashboard, the menu bar and the detail panel each asked within
 * the same second, and the first got the whole interval while the others got a sliver, so the
 * same instant read 100% in one window, 78% in another and 49% in a third.
 *
 * So a rate is worked out once per interval and everyone asking inside that interval is handed
 * the same answer. It also guarantees the divisor is a full interval rather than whatever gap
 * happened to fall between two windows' timers.
 */
const RATE_CACHE_MS = 900;

let previousCpuSnapshot = captureCpuSnapshot();
let previousLogicalCpuSnapshots = cpus().map(cpu => ({ ...cpu.times }));
const execFileAsync = promisify(execFile);
let batteryCache: { cycleCount: number | null; health: string | null; sampledAt: number } = { cycleCount: null, health: null, sampledAt: 0 };
function updateBatteryCache(value: typeof batteryCache): void { batteryCache = value; }
// Keyed by interface. Without the name, switching from Wi-Fi to Ethernet — or a VPN coming
// up — diffs one interface's lifetime total against another's and reports the gap as a
// burst of traffic that never happened.
let previousNetworkSample: { interfaceName: string; received: number; sent: number; sampledAt: number } | null = null;

// The default route names the interface traffic actually leaves by. Picking the first entry
// with a routable address instead is a coin toss: this machine lists en0 before utun4, but
// os.networkInterfaces() promises no order, and the VPN tunnel keeps its own byte counters.
// Which interface traffic leaves by changes when a cable goes in or a VPN comes up, not from
// one second to the next. The byte counters beside it are what needs asking every poll.
const DEFAULT_INTERFACE_MS = 10_000;
let defaultInterfaceCache: { name: string | null; sampledAt: number } = { name: null, sampledAt: 0 };

async function readDefaultInterface(): Promise<string | null> {
  if (defaultInterfaceCache.sampledAt > 0 && Date.now() - defaultInterfaceCache.sampledAt < DEFAULT_INTERFACE_MS) return defaultInterfaceCache.name;
  let name: string | null = null;
  try {
    const { stdout } = await execFileAsync('/sbin/route', ['-n', 'get', 'default'], { timeout: 1_000 });
    name = stdout.match(/interface:\s*(\S+)/)?.[1] ?? null;
  } catch {
    name = null;
  }
  defaultInterfaceCache = { name, sampledAt: Date.now() };
  return name;
}

// Device name to the port it belongs to, so the panel can say Wi-Fi or Ethernet from what
// the system reports. en0 is Wi-Fi on this laptop and Ethernet on a desktop.
let hardwarePortCache: { ports: Map<string, string>; sampledAt: number } = { ports: new Map(), sampledAt: 0 };

async function readHardwarePorts(): Promise<Map<string, string>> {
  if (hardwarePortCache.sampledAt > 0 && Date.now() - hardwarePortCache.sampledAt < 60_000) return hardwarePortCache.ports;
  const ports = new Map<string, string>();
  try {
    const { stdout } = await execFileAsync('/usr/sbin/networksetup', ['-listallhardwareports'], { timeout: 3_000 });
    let port: string | null = null;
    for (const line of stdout.split('\n')) {
      const portMatch = line.match(/^Hardware Port:\s*(.+)$/);
      if (portMatch) { port = portMatch[1].trim(); continue; }
      const deviceMatch = line.match(/^Device:\s*(\S+)$/);
      if (deviceMatch && port) ports.set(deviceMatch[1], port);
    }
  } catch {
    // Without the map the panel falls back to the interface name alone.
  }
  hardwarePortCache = { ports, sampledAt: Date.now() };
  return ports;
}
// SPAirPortDataType takes the better part of three seconds on a cold run, so the radio
// details are cached well past the poll interval and never hold up a sample.
let networkRadioInFlight: Promise<void> | null = null;
let networkRadioCache: { sampledAt: number; ssid: string | null; signalStrength: string | null; linkSpeed: string | null; channel: string | null; phyMode: string | null; security: string | null } =
  { sampledAt: 0, ssid: null, signalStrength: null, linkSpeed: null, channel: null, phyMode: null, security: null };

function findValue(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key)) return child;
    const nested = findValue(child, keys);
    if (nested !== undefined) return nested;

  }
  return undefined;
}

// A scan that macOS refused is not the same as an empty folder, so the two are
// reported apart: anything the walk could not open sets `denied`, which makes the
// caller publish `null` instead of a total that silently undercounts.
type DirectoryScan = { bytes: number; denied: boolean };

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

async function directorySize(path: string): Promise<DirectoryScan> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    return { bytes: 0, denied: isPermissionError(error) };
  }
  const scans = await Promise.all(entries.map(async entry => {
    const entryPath = join(path, entry.name);
    try {
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) return { bytes: 0, denied: false };
      return info.isDirectory() ? directorySize(entryPath) : { bytes: info.blocks * 512, denied: false };
    } catch (error) {
      return { bytes: 0, denied: isPermissionError(error) };
    }
  }));
  return scans.reduce<DirectoryScan>(
    (total, scan) => ({ bytes: total.bytes + scan.bytes, denied: total.denied || scan.denied }),
    { bytes: 0, denied: false }
  );
}

// Walking the Trash is far heavier than the rest of the storage snapshot, so it keeps
// its own cache instead of re-running on every poll.
const trashCacheTtlMs = 60_000;
let trashCache: { bytes: number | null; sampledAt: number } = { bytes: null, sampledAt: 0 };

/**
 * One `df` for the whole machine, shared and held briefly. The storage channel used to run it
 * twice on every poll — once for the startup volume and once for the rest — and free space
 * does not move fast enough to be worth two forks a second.
 */
const FILESYSTEM_CACHE_MS = 3_000;
let filesystemCache: { rows: string[]; sampledAt: number } = { rows: [], sampledAt: 0 };
let filesystemInFlight: Promise<string[]> | null = null;

function readFilesystems(): Promise<string[]> {
  if (filesystemCache.sampledAt > 0 && Date.now() - filesystemCache.sampledAt < FILESYSTEM_CACHE_MS) return Promise.resolve(filesystemCache.rows);
  if (filesystemInFlight) return filesystemInFlight;
  filesystemInFlight = execFileAsync('/bin/df', ['-kP'], { timeout: 2_000 })
    .then(({ stdout }) => {
      const rows = stdout.trim().split('\n').slice(1);
      filesystemCache = { rows, sampledAt: Date.now() };
      return rows;
    })
    .catch(() => filesystemCache.rows)
    .finally(() => { filesystemInFlight = null; });
  return filesystemInFlight;
}

async function readTrashBytes(): Promise<number | null> {
  if (trashCache.sampledAt > 0 && Date.now() - trashCache.sampledAt < trashCacheTtlMs) return trashCache.bytes;
  const scan = await directorySize(join(app.getPath('home'), '.Trash'));
  trashCache = { bytes: scan.denied ? null : scan.bytes, sampledAt: Date.now() };
  return trashCache.bytes;
}
// Built from electron/native/*.c by `npm run electron:native`.
//
// temperature reads the Apple Silicon thermal sensors through IOHIDEventSystemClient and
// power reads IOReport's energy counters. Both are readable by any process, where
// `powermetrics` needs root and reports no CPU die temperature on arm64 at all.
// asarUnpack keeps the binaries executable inside a packaged build.
function nativeHelper(name: string): string {
  return join(__dirname, name).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

type Temperatures = {
  cpuC: number | null;

  gpuC: number | null;
  aneC: number | null;
  socC: number | null;
  batteryC: number | null;
  /** The SSD, from the `NAND CH0 temp` sensor. */
  nandC: number | null;
  hottestName: string | null;
  hottestC: number | null;
  readableSensors: number;
};

const emptyTemperatures = (): Temperatures => ({
  cpuC: null, gpuC: null, aneC: null, socC: null, batteryC: null, nandC: null,
  hottestName: null, hottestC: null, readableSensors: 0
});
type PowerReading = { cpuWatts: number | null; gpuWatts: number | null; aneWatts: number | null };

// Enumerating the sensors is the expensive part of a temperature read. CPU, GPU and thermal
// panels share one pass; four seconds is fresh enough for a temperature that changes slowly.
const sensorCacheTtlMs = 4_000;

/** `osx-cpu-temp` is an Intel-era extra nobody has to install; one failure settles it. */
let intelFallbackMissing = false;

/**
 * Power costs far more than the rest. The helper has to watch IOReport's counters across an
 * interval to turn them into watts, and setting the subscription up either side of that
 * interval takes longer than the interval itself — the whole run is the better part of a
 * second. A watt reading does not change meaningfully inside two, so it is held for two.
 */
const powerCacheTtlMs = 2_000;

let temperatureCache: { value: Temperatures; sampledAt: number } = { value: emptyTemperatures(), sampledAt: 0 };
let powerCache: { value: PowerReading; sampledAt: number } = { value: { cpuWatts: null, gpuWatts: null, aneWatts: null }, sampledAt: 0 };

/**
 * A reading already on its way is shared rather than started again. The GPU, thermals and NPU
 * channels are polled together, so on a cache miss all three used to launch their own copy of
 * the power helper at the same instant — three subprocesses, each holding a handler open for
 * most of a second, times every window that was polling.
 */
let temperatureInFlight: Promise<Temperatures> | null = null;
let powerInFlight: Promise<PowerReading> | null = null;

function readTemperatures(): Promise<Temperatures> {
  if (temperatureCache.sampledAt > 0 && Date.now() - temperatureCache.sampledAt < sensorCacheTtlMs) return Promise.resolve(temperatureCache.value);
  if (temperatureInFlight) return temperatureInFlight;
  temperatureInFlight = sampleTemperatures().finally(() => { temperatureInFlight = null; });
  return temperatureInFlight;
}

async function sampleTemperatures(): Promise<Temperatures> {
  const value: Temperatures = emptyTemperatures();
  try {
    const { stdout } = await execFileAsync(nativeHelper('openclean-temperature'), [], { timeout: 2_000 });
    const sample = JSON.parse(stdout) as Temperatures;
    if (typeof sample.cpuC === 'number') value.cpuC = Math.round(sample.cpuC);
    if (typeof sample.gpuC === 'number') value.gpuC = Math.round(sample.gpuC);
    if (typeof sample.aneC === 'number') value.aneC = Math.round(sample.aneC);
    if (typeof sample.socC === 'number') value.socC = Math.round(sample.socC);
    if (typeof sample.batteryC === 'number') value.batteryC = Math.round(sample.batteryC);
    if (typeof sample.nandC === 'number') value.nandC = Math.round(sample.nandC);
    if (typeof sample.hottestC === 'number') value.hottestC = Math.round(sample.hottestC);
    if (typeof sample.hottestName === 'string') value.hottestName = sample.hottestName;
    if (typeof sample.readableSensors === 'number') value.readableSensors = sample.readableSensors;
  } catch {
    // The native reader is Apple Silicon only; Intel Macs fall back below.
  }
  // Only worth trying where the native reader found nothing, and only until it is clear the
  // tool is not installed — otherwise this forks a process every poll to fail the same way.
  if (value.cpuC === null && !intelFallbackMissing) {
    try {
      const { stdout } = await execFileAsync('osx-cpu-temp', ['-c'], { timeout: 1_000 });
      const match = stdout.match(/(\d+(?:\.\d+)?)\s*°?C?/i);
      const temperature = match ? Number(match[1]) : NaN;
      if (Number.isFinite(temperature) && temperature > 0 && temperature < 120) value.cpuC = Math.round(temperature);
    } catch {
      // No reader available; both stay null and the UI drops those rows.
      intelFallbackMissing = true;
    }
  }
  temperatureCache = { value, sampledAt: Date.now() };
  return value;
}

/**
 * Answers from the last sample straight away and refreshes behind the request. Waiting for the
 * helper put most of a second into whichever poll happened to find the cache stale, and since
 * the renderer asks for every channel at once and waits for all of them, that one channel held
 * up the whole sample — which is what made the charts move in steps rather than smoothly.
 *
 * The cost is that the first poll of a session reports no watts, and a reading can be up to a
 * couple of seconds old. Neither matters for a figure that is itself an average over an interval.
 */
function readPower(): Promise<PowerReading> {
  const stale = powerCache.sampledAt === 0 || Date.now() - powerCache.sampledAt >= powerCacheTtlMs;
  if (stale && !powerInFlight) {
    powerInFlight = samplePower().finally(() => { powerInFlight = null; });
    // Nothing awaits it; a failed sample leaves the previous reading in place.
    powerInFlight.catch(() => undefined);
  }
  // The very first caller has nothing to report yet, so it waits for one sample rather than
  // publishing nulls that the panels would render as "unavailable".
  if (powerCache.sampledAt === 0 && powerInFlight) return powerInFlight;
  return Promise.resolve(powerCache.value);
}

async function samplePower(): Promise<PowerReading> {
  const watts = (reading: unknown) => typeof reading === 'number' && Number.isFinite(reading) ? Number(reading.toFixed(2)) : null;
  let value: PowerReading = { cpuWatts: null, gpuWatts: null, aneWatts: null };
  try {
    const { stdout } = await execFileAsync(nativeHelper('openclean-power'), ['0.25'], { timeout: 3_000 });
    const sample = JSON.parse(stdout) as PowerReading;

    value = { cpuWatts: watts(sample.cpuWatts), gpuWatts: watts(sample.gpuWatts), aneWatts: watts(sample.aneWatts) };
  } catch {
    // IOReport is private; a rename or a refusal leaves every figure null.
  }
  powerCache = { value, sampledAt: Date.now() };
  return value;
}

async function readCpuTemperature(): Promise<number | null> {
  return (await readTemperatures()).cpuC;
}

// The CPU specification cannot change while the app runs, so it is read once and kept.
// Fields Windows shows but macOS does not implement — current and base clock speed
// (`hw.cpufrequency*` is unset on Apple Silicon), handle counts, and L3 on chips that
// use a system level cache instead — are left absent rather than faked.
type CpuInfo = {
  model: string;
  machine: string | null;
  sockets: number | null;
  physicalCores: number | null;
  logicalCores: number;
  performanceCores: number | null;
  efficiencyCores: number | null;
  virtualization: boolean | null;
  l1CacheBytes: number | null;
  l2CacheBytes: number | null;
  l3CacheBytes: number | null;
};

let cpuInfoCache: CpuInfo | null = null;

async function readSysctl(keys: string[]): Promise<Map<string, string>> {
  // sysctl exits non-zero when any key is unimplemented but still prints the rest on
  // stdout, so the failure path reads the same output the success path would.
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('/usr/sbin/sysctl', keys, { timeout: 2_000 }));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? '';
  }
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

async function readCpuInfo(): Promise<CpuInfo> {
  if (cpuInfoCache) return cpuInfoCache;
  const values = await readSysctl([
    'hw.model', 'hw.packages', 'hw.physicalcpu', 'hw.logicalcpu',
    'hw.perflevel0.physicalcpu', 'hw.perflevel1.physicalcpu', 'kern.hv_support',
    'hw.l1icachesize', 'hw.l1dcachesize', 'hw.l2cachesize', 'hw.l3cachesize'
  ]);
  const number = (key: string): number | null => {
    const parsed = Number(values.get(key));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  // Apple reports the two halves of L1 separately; Task Manager quotes a combined figure.
  const l1Instruction = number('hw.l1icachesize');
  const l1Data = number('hw.l1dcachesize');
  cpuInfoCache = {
    model: cpus()[0]?.model ?? 'Unknown CPU',
    machine: values.get('hw.model') ?? null,
    sockets: number('hw.packages'),
    physicalCores: number('hw.physicalcpu'),
    logicalCores: number('hw.logicalcpu') ?? cpus().length,
    performanceCores: number('hw.perflevel0.physicalcpu'),
    efficiencyCores: number('hw.perflevel1.physicalcpu'),
    virtualization: values.has('kern.hv_support') ? values.get('kern.hv_support') === '1' : null,
    l1CacheBytes: l1Instruction === null && l1Data === null ? null : (l1Instruction ?? 0) + (l1Data ?? 0),
    l2CacheBytes: number('hw.l2cachesize'),
    l3CacheBytes: number('hw.l3cachesize')
  };
  return cpuInfoCache;
}

// `ps -M` prints a summary line per process followed by one line per thread, and the
// thread lines are the ones indented with whitespace. That yields both counts from a
// single ~50ms call. `kern.num_threads`, which this used to read, is the kernel's thread
// ceiling rather than a live count, so it reported a constant 20480 forever. `top -l 1`
// does report a live total but costs over a second of CPU per sample, far too much for a
// two second poll.
// Installed-memory facts, read once. Apple Silicon keeps its memory on the chip package,
// so system_profiler reports only size, type and manufacturer — no clock, no slot list and
// no form factor. Intel Macs do list a DIMM per slot, hence the array handling below.
type MemoryInfo = {
  totalBytes: number;
  pageSizeBytes: number | null;
  type: string | null;
  manufacturer: string | null;
  speed: string | null;
  formFactor: string | null;
  slotsUsed: number | null;
  slotsTotal: number | null;
  upgradeable: boolean;
};

let memoryInfoCache: MemoryInfo | null = null;

async function readMemoryInfo(): Promise<MemoryInfo> {
  if (memoryInfoCache) return memoryInfoCache;
  let entries: Array<Record<string, unknown>> = [];
  try {
    const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['-json', 'SPMemoryDataType'], { timeout: 8_000 });
    const parsed = JSON.parse(stdout) as { SPMemoryDataType?: Array<Record<string, unknown>> };
    entries = parsed.SPMemoryDataType ?? [];
  } catch {
    // Leave every hardware field unknown; the UI drops the rows it cannot fill.
  }
  const sysctlValues = await readSysctl(['hw.pagesize']);
  const pageSize = Number(sysctlValues.get('hw.pagesize'));
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
  // A soldered package reports one entry with no _name; discrete DIMMs report one per slot.
  const slots = entries.filter(entry => text(entry['_name']) !== null);
  const filled = slots.filter(entry => (text(entry['dimm_size']) ?? '').toLowerCase() !== 'empty');
  const first = filled[0] ?? entries[0] ?? {};
  memoryInfoCache = {

    totalBytes: totalmem(),
    pageSizeBytes: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : null,
    type: text(first['dimm_type']),
    manufacturer: text(first['dimm_manufacturer']),
    speed: text(first['dimm_speed']),
    formFactor: text(first['dimm_form_factor']),
    slotsUsed: slots.length ? filled.length : null,
    slotsTotal: slots.length || null,
    upgradeable: slots.length > 0
  };
  return memoryInfoCache;
}

// GPU. IOAccelerator publishes live utilisation and memory to any process; the hardware
// description comes from system_profiler and is read once. Clock speed has no equivalent
// anywhere in IORegistry, and Apple Silicon has no dedicated VRAM — the "system memory"
// figures are the GPU's share of unified memory.
type GpuInfo = {
  model: string | null;
  cores: number | null;
  vendor: string | null;
  bus: string | null;
  metal: string | null;
  displays: Array<{ name: string; resolution: string | null; type: string | null; main: boolean }>;
};

let gpuInfoCache: GpuInfo | null = null;

// system_profiler returns localisation keys such as "spdisplays_builtin" for enumerated
// values. The common ones are spelled out; anything else is tidied up generically so a
// key this build has not seen still reads as words rather than as an identifier.
const SYSTEM_PROFILER_NAMES: Record<string, string> = {
  sppci_vendor_Apple: 'Apple',
  spdisplays_builtin: 'Built-in',
  spdisplays_internal: 'Internal',
  spdisplays_metal3: 'Metal 3',
  spdisplays_metal4: 'Metal 4',
  'spdisplays_built-in_retinaLCD': 'Built-in Retina LCD',
  'spdisplays_built-in_displayport': 'Built-in DisplayPort',
  spairport_security_mode_wpa2_personal: 'WPA2 Personal',
  spairport_security_mode_wpa3_personal: 'WPA3 Personal',
  spairport_security_mode_wpa3_transition: 'WPA2/WPA3 Personal',
  spairport_security_mode_wpa2_enterprise: 'WPA2 Enterprise',
  spairport_security_mode_wep: 'WEP',
  spairport_security_mode_none: 'None'
};

function readablePropertyName(value: string): string {
  const known = SYSTEM_PROFILER_NAMES[value];
  if (known) return known;
  const tail = value.replace(/^(spdisplays_|sppci_|kHW_)/, '').replace(/Item$/, '');
  const spaced = tail
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

async function readGpuInfo(): Promise<GpuInfo> {

  if (gpuInfoCache) return gpuInfoCache;
  let entry: Record<string, unknown> = {};
  let screens: Array<Record<string, unknown>> = [];
  try {
    const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['-json', 'SPDisplaysDataType'], { timeout: 15_000 });
    const parsed = JSON.parse(stdout) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
    entry = parsed.SPDisplaysDataType?.[0] ?? {};
    screens = (entry['spdisplays_ndrvs'] as Array<Record<string, unknown>> | undefined) ?? [];
  } catch {
    // Leave every field unknown; the UI drops the rows it cannot fill.
  }
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const number = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  gpuInfoCache = {
    model: text(entry['sppci_model']),
    cores: number(entry['sppci_cores']),
    vendor: text(entry['spdisplays_vendor']) ? readablePropertyName(text(entry['spdisplays_vendor'])!) : null,
    bus: text(entry['sppci_bus']) ? readablePropertyName(text(entry['sppci_bus'])!) : null,
    metal: text(entry['spdisplays_mtlgpufamilysupport']) ? readablePropertyName(text(entry['spdisplays_mtlgpufamilysupport'])!) : null,
    displays: screens.map(screen => ({
      name: text(screen['_name']) ?? 'Display',
      resolution: text(screen['_spdisplays_resolution']),
      type: text(screen['spdisplays_display_type']) ? readablePropertyName(text(screen['spdisplays_display_type'])!) : null,
      main: text(screen['spdisplays_main']) === 'spdisplays_yes'
    }))
  };
  return gpuInfoCache;
}

// IOAccelerator's PerformanceStatistics dictionary, flattened out of ioreg's text output.
async function readGpuStatistics(): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  try {
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 2_000 });
    const block = stdout.match(/"PerformanceStatistics"\s*=\s*\{([^}]*)\}/)?.[1];
    if (block) {
      for (const [, key, value] of block.matchAll(/"([^"]+)"\s*=\s*(\d+)/g)) values.set(key, Number(value));
    }
  } catch {
    // Nothing readable; every figure stays null.
  }
  return values;
}

// macOS's own thermal pressure level. It moves slowly and costs a process to read, so it
// gets a longer cache than the sensors do.
const thermalStateCacheTtlMs = 5_000;
let thermalStateCache: { value: string | null; sampledAt: number } = { value: null, sampledAt: 0 };

async function readThermalState(): Promise<string | null> {
  if (thermalStateCache.sampledAt > 0 && Date.now() - thermalStateCache.sampledAt < thermalStateCacheTtlMs) return thermalStateCache.value;
  let value: string | null = null;
  try {
    const { stdout } = await execFileAsync(nativeHelper('openclean-thermal-state'), [], { timeout: 3_000 });
    const parsed = JSON.parse(stdout) as { state?: string };
    if (typeof parsed.state === 'string' && parsed.state !== 'unknown') value = parsed.state;
  } catch {

    // Without a reading the panel shows the row as unavailable rather than guessing.
  }
  thermalStateCache = { value, sampledAt: Date.now() };
  return value;
}

// Whether the machine has fans at all, read once. A fanless Mac reports no fan anywhere in
// the SMC tree, which is a fact worth stating rather than an absence worth hiding.
let coolingCache: { fans: number | null } | null = null;

async function readCooling(): Promise<{ fans: number | null }> {
  if (coolingCache) return coolingCache;
  let fans: number | null = null;
  try {
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'AppleSMC', '-w', '0'], { timeout: 3_000 });
    const matches = stdout.match(/"F\d+Ac"/g);
    fans = matches ? new Set(matches).size : 0;
  } catch {
    // Leave it unknown rather than claiming the machine is fanless.
  }
  coolingCache = { fans };
  return coolingCache;
}

export type TopProcess = { pid: number; name: string; icon: string | null; cpuPercent: number; memoryBytes: number; pids: number[] };
export type ActivityProcessChild = { pid: number; name: string; status: string; cpuPercent: number; memoryBytes: number; diskBytesPerSecond: number | null; networkBytesPerSecond: number | null };
export type ActivityProcess = TopProcess & { kind: 'app' | 'background'; status: string; diskBytesPerSecond: number | null; networkBytesPerSecond: number | null; children: ActivityProcessChild[] };

type ProcessIo = { footprint: number; read: number; written: number };
type ProcessCounters = { disk: number; network: number; sampledAt: number };
const processCounters = new Map<string, ProcessCounters>();
const taskProcessInFlight = new Map<string, Promise<ActivityProcess[]>>();
const activityPanelSessions = new Map<string, number>();
const activityNetworkCache = new Map<string, { value: Map<number, number>; sampledAt: number }>();
const activityNetworkInFlight = new Map<string, Promise<void>>();

/** nettop can take several seconds to initialize, so it must never hold up the process list. */
function refreshActivityNetwork(panel: string, session: number): void {
  if (activityNetworkInFlight.has(panel)) return;
  const request = execFileAsync('/usr/bin/nettop', ['-L', '1', '-P', '-n', '-x', '-J', 'bytes_in,bytes_out', '-t', 'external'], { timeout: 12_000 })
    .then(({ stdout }) => {
      if ((activityPanelSessions.get(panel) ?? 0) !== session) return;
      const values = new Map<number, number>();
      for (const line of stdout.split('\n').slice(1)) {
        const [identity, received, sent] = line.split(',');
        const match = identity?.match(/\.(\d+)$/);
        if (match) {
          const pid = Number(match[1]);
          values.set(pid, (values.get(pid) ?? 0) + Number(received) + Number(sent));
        }
      }
      activityNetworkCache.set(panel, { value: values, sampledAt: Date.now() });
    })
    .catch(() => { /* Network counters can be unavailable in a sandboxed process. */ })
    .finally(() => activityNetworkInFlight.delete(panel));
  activityNetworkInFlight.set(panel, request);
}

/** Process Manager data is collected on demand, only while its page is open. */
async function readActivityProcesses(panel: string): Promise<ActivityProcess[]> {
  const inFlight = taskProcessInFlight.get(panel);
  if (inFlight) return inFlight;
  const session = activityPanelSessions.get(panel) ?? 0;
  const request = sampleActivityProcesses(panel, session).finally(() => taskProcessInFlight.delete(panel));
  taskProcessInFlight.set(panel, request);
  return request;
}

function stopActivityProcesses(panel: string): { stopped: boolean } {
  activityPanelSessions.set(panel, (activityPanelSessions.get(panel) ?? 0) + 1);
  quittable.delete(panel);
  activityNetworkCache.delete(panel);
  for (const key of processCounters.keys()) if (key.startsWith(`${panel}:`)) processCounters.delete(key);
  return { stopped: true };
}

async function sampleActivityProcesses(panel: string, session: number): Promise<ActivityProcess[]> {
  refreshActivityNetwork(panel, session);
  const [psResult, ioResult] = await Promise.allSettled([
    execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,state=,comm='], { timeout: 3_000 }),
    execFileAsync(nativeHelper('openclean-process-io'), [], { timeout: 4_000 })
  ]);
  if (psResult.status !== 'fulfilled' || ioResult.status !== 'fulfilled') return [];

  const ioByPid = new Map<number, ProcessIo>();
  for (const line of ioResult.value.stdout.split('\n').slice(1)) {
    const [pid, footprint, read, written] = line.split(',').map(Number);
    if (pid > 0) ioByPid.set(pid, { footprint, read, written });
  }

  const networkByPid = new Map<number, number>();
  const networkSample = activityNetworkCache.get(panel);
  if (networkSample) for (const [pid, bytes] of networkSample.value) networkByPid.set(pid, bytes);

  const now = Date.now();
  const records = new Map<string, { pid: number; pids: number[]; path: string; cpu: number; memory: number; diskRate: number | null; networkRate: number | null; status: string; isApp: boolean; children: ActivityProcessChild[] }>();
  for (const line of psResult.value.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const rawPath = match[6].replace(/^\((.*)\)$/, '$1');
    const appPath = appBundlePath(rawPath);
    const isApp = appPath !== null;
    const key = appPath ?? `pid:${pid}`;
    const io = ioByPid.get(pid);
    const totalDisk = io ? io.read + io.written : 0;
    const counterKey = `${panel}:${pid}`;
    const totalNetwork = networkByPid.get(pid) ?? processCounters.get(counterKey)?.network ?? 0;
    const previous = processCounters.get(counterKey);
    const elapsed = previous ? Math.max((now - previous.sampledAt) / 1000, 0.1) : 0;
    const diskRate = io ? (elapsed ? Math.max(0, totalDisk - previous!.disk) / elapsed : 0) : null;
    const networkRate = networkSample ? (elapsed ? Math.max(0, totalNetwork - previous!.network) / elapsed : 0) : null;
    processCounters.set(counterKey, { disk: totalDisk, network: totalNetwork, sampledAt: now });
    const childName = rawPath.split('/').at(-1) ?? rawPath;
    const child: ActivityProcessChild = { pid, name: childName, status: match[5].includes('R') ? 'Running' : 'Background', cpuPercent: Number(match[3]), memoryBytes: io?.footprint ?? Number(match[4]) * 1024, diskBytesPerSecond: diskRate, networkBytesPerSecond: networkRate };
    const item = records.get(key);
    if (item) {
      item.cpu += Number(match[3]);
      item.memory += io?.footprint ?? Number(match[4]) * 1024;
      item.diskRate = item.diskRate === null || diskRate === null ? null : item.diskRate + diskRate;
      item.networkRate = item.networkRate === null || networkRate === null ? null : item.networkRate + networkRate;
      item.pids.push(pid);
      item.children.push(child);
      if (child.status === 'Running') item.status = 'Running';
    } else {
      records.set(key, { pid, pids: [pid], path: appPath ?? rawPath, cpu: Number(match[3]), memory: io?.footprint ?? Number(match[4]) * 1024, diskRate, networkRate, status: match[5].includes('R') ? 'Running' : 'Background', isApp, children: [child] });
    }
  }
  const panelPrefix = `${panel}:`;
  const liveCounterKeys = new Set([...ioByPid.keys()].map(pid => `${panel}:${pid}`));
  for (const key of processCounters.keys()) if (key.startsWith(panelPrefix) && !liveCounterKeys.has(key)) processCounters.delete(key);

  const values = [...records.values()];
  const appItems = values.filter(item => item.isApp);
  const identities = await readProcessIdentities(appItems.map(item => item.path));
  const identityByPath = new Map(appItems.map((item, index) => [item.path, identities[index]]));
  const rows = values.map(item => {
    const identity = identityByPath.get(item.path);
    return {
      pid: item.pid, pids: item.pids, name: identity?.name ?? item.path.split('/').at(-1) ?? item.path,
      icon: identity?.icon ?? null, cpuPercent: Math.round(item.cpu * 10) / 10,
      memoryBytes: item.memory, diskBytesPerSecond: item.diskRate,
      networkBytesPerSecond: item.networkRate, status: item.status,
      children: item.children,
      kind: item.isApp ? 'app' as const : 'background' as const
    };
  });
  if ((activityPanelSessions.get(panel) ?? 0) === session) {
    quittable.set(panel, new Map(rows.filter(row => row.kind === 'app').map(row => [row.pid, { name: row.name, pids: row.pids }])));
  }
  return rows;
}

/**
  * Every app the panel has something to say about, rather than a fixed five. The floor keeps
  * out the four dozen macOS agents that sit at nothing for days — `WallpaperAgent`,
  * `TextInputSwitcher` and the rest — which would otherwise be most of the list.
  */
const CPU_ROW_FLOOR = 0.1;
const MEMORY_ROW_FLOOR = 50 * 1024 * 1024;



/**
 * Which apps a panel is showing, in the order it shows them. Re-sorting by usage every second
 * had the rows trading places constantly, which made the list unreadable and the Quit links a
 * hazard. A seat is held instead: an app keeps its row for as long as it is running. One of
 * these per list, since CPU and memory rank the same apps differently.
 */
/** How many rows a panel shows, busiest first. */
const TOP_PROCESS_COUNT = 10;

/**
 * The outermost `.app` on the path. A VS Code renderer runs from
 * `/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Renderer).app/...`,
 * and rolling it up to the outer bundle is what puts one "Code" row in the list rather than six.
 */
function appBundlePath(executablePath: string): string | null {
  const index = executablePath.indexOf('.app/');
  return index === -1 ? null : executablePath.slice(0, index + 4);
}

async function readProcessName(path: string): Promise<string> {
  const basename = path.split('/').at(-1) ?? path;
  if (!path.endsWith('.app')) return basename;
  // The name macOS itself shows in the Dock and the menu bar, which is "Code" where the
  // bundle is called "Visual Studio Code". Falls back to the bundle folder's own name.
  for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
    try {
      const { stdout } = await execFileAsync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')], { timeout: 2_000 });
      if (stdout.trim()) return stdout.trim();
    } catch { /* The key is absent from this bundle; try the next one. */ }
  }
  return basename.slice(0, -4);
}

/**
 * One helper run for the whole batch. `app.getFileIcon` would save the round trip, but on
 * this macOS it answers every app bundle with the same blank document icon; NSWorkspace,
 * which is what Finder asks, returns the real artwork.
 */
async function readAppIcons(paths: string[]): Promise<Array<string | null>> {
  // Not every process reports a path — macOS gives some only a bundle identifier — and there
  // is no file to ask about in that case.
  const files = paths.filter(path => path.startsWith('/'));
  if (!files.length) return paths.map(() => null);
  try {
    const { stdout } = await execFileAsync(nativeHelper('openclean-app-icon'), files, { timeout: 4_000 });
    const lines = stdout.split('\n');
    const byPath = new Map(files.map((file, index) => [file, lines[index]?.trim() ? `data:image/png;base64,${lines[index].trim()}` : null]));
    return paths.map(path => byPath.get(path) ?? null);
  } catch {
    return paths.map(() => null);
  }
}

/** Neither an app's name nor its icon changes while it runs, so each path is resolved once. */
const processIdentityCache = new Map<string, { name: string; icon: string | null }>();

async function readProcessIdentities(paths: string[]): Promise<Array<{ name: string; icon: string | null }>> {
  const missing = paths.filter(path => !processIdentityCache.has(path));
  if (missing.length) {
    const [names, icons] = await Promise.all([Promise.all(missing.map(readProcessName)), readAppIcons(missing)]);
    missing.forEach((path, index) => processIdentityCache.set(path, { name: names[index], icon: icons[index] }));
  }
  return paths.map(path => processIdentityCache.get(path) ?? { name: path, icon: null });
}

type AppGroup = { pid: number; pids: number[]; cpuPercent: number; memoryBytes: number; leadPercent: number; hasMainProcess: boolean };

/**
 * One pass over the process table, grouped by app bundle so that a browser's dozen renderers
 * read as one entry the way Activity Monitor's app list does. The CPU and memory panels poll
 * within milliseconds of each other, so the result is held briefly and they share the sample.
 */
const PROCESS_SAMPLE_MS = 700;
let appGroupCache: { groups: Map<string, AppGroup>; sampledAt: number } | null = null;
let appGroupInFlight: Promise<Map<string, AppGroup>> | null = null;

function readAppGroups(): Promise<Map<string, AppGroup>> {
  if (appGroupCache && Date.now() - appGroupCache.sampledAt < PROCESS_SAMPLE_MS) return Promise.resolve(appGroupCache.groups);
  // The CPU and memory channels are polled together and miss the cache on the same tick, so
  // without this they each ran their own copy of ps over the whole process table.
  if (appGroupInFlight) return appGroupInFlight;
  appGroupInFlight = sampleAppGroups().finally(() => { appGroupInFlight = null; });
  return appGroupInFlight;
}

async function sampleAppGroups(): Promise<Map<string, AppGroup>> {
  const groups = new Map<string, AppGroup>();
  const [processResult, ioResult] = await Promise.allSettled([
    // `comm` goes last on purpose: ps truncates every column but the final one to a fixed
    // width, which cut each executable path down to its first 16 characters.
    execFileAsync('/bin/ps', ['-axo', 'pid=,%cpu=,rss=,comm='], { timeout: 2_000 }),
    execFileAsync(nativeHelper('openclean-process-io'), [], { timeout: 4_000 })
  ]);
  if (processResult.status !== 'fulfilled') return groups;

  // Match Process Manager and macOS memory accounting by using physical footprint, which
  // avoids counting shared Chromium/framework pages repeatedly. RSS is only a fallback when
  // the native footprint reader cannot report a PID.
  const footprintByPid = new Map<number, number>();
  if (ioResult.status === 'fulfilled') {
    for (const line of ioResult.value.stdout.split('\n').slice(1)) {
      const [pid, footprint] = line.split(',').map(Number);
      if (pid > 0 && Number.isFinite(footprint)) footprintByPid.set(pid, footprint);
    }
  }

  try {
    const { stdout } = processResult.value;
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const cpuPercent = Number(match[2]);
      const memoryBytes = footprintByPid.get(pid) ?? Number(match[3]) * 1024;
      if (!Number.isFinite(cpuPercent) || !Number.isFinite(memoryBytes)) continue;
      // ps parenthesises the name where it cannot read the path — an exiting process, or one
      // it is not allowed to inspect. There is no bundle to look up, so it groups by name.
      const path = match[4].replace(/^\((.*)\)$/, '$1');
      const key = appBundlePath(path) ?? path;
      // The bundle's own executable rather than one of its helpers, which is the process a
      // Quit should reach.
      const isMainProcess = path.startsWith(`${key}/Contents/MacOS/`) || path === key;
      const group = groups.get(key);
      if (!group) groups.set(key, { pid, pids: [pid], cpuPercent, memoryBytes, leadPercent: cpuPercent, hasMainProcess: isMainProcess });
      else {
        group.cpuPercent += cpuPercent;
        group.memoryBytes += memoryBytes;
        group.pids.push(pid);
        // Failing a main process, the busiest member stands in for the group.
        if (isMainProcess && !group.hasMainProcess) { group.hasMainProcess = true; group.pid = pid; }
        else if (!group.hasMainProcess && cpuPercent > group.leadPercent) { group.leadPercent = cpuPercent; group.pid = pid; }
      }
    }
  } catch { /* An empty table leaves every panel showing no rows rather than wrong ones. */ }
  appGroupCache = { groups, sampledAt: Date.now() };
  return groups;
}

/**
 * Applications only. A list mixing `mdworker_shared` and `WindowServer` in among the apps
 * names things nobody recognises and nobody should be quitting; everything left out is still
 * accounted for, as the one background total the panel prints underneath.
 */
/**
 * The processes a panel is currently offering a Quit link for, and the name it is showing them
 * under. A quit request is checked against this rather than trusting whatever pid the renderer
 * sends, and the confirmation is worded from the name recorded here rather than one supplied
 * with the request. One list per panel, since they rank the same apps differently.
 */
const quittable = new Map<string, Map<number, { name: string; pids: number[] }>>();

function quittableProcess(pid: number): { name: string; pids: number[] } | null {
  for (const panel of quittable.values()) {
    const entry = panel.get(pid);
    if (entry !== undefined) return entry;
  }
  return null;
}

async function readTopApps(
  panel: string,
  weigh: (group: AppGroup) => number,
  floor: number
): Promise<{ topProcesses: TopProcess[]; background: number | null }> {
  const groups = await readAppGroups();
  if (!groups.size) return { topProcesses: [], background: null };

  const entries = [...groups.entries()];
  const apps = entries.filter(([path, group]) => path.endsWith('.app') && weigh(group) >= floor).sort(([, a], [, b]) => weigh(b) - weigh(a));
  // Apps under the floor are not lost, they just join everything else in the total below.
  const shown = new Set(apps.map(([path]) => path));
  const background = entries.filter(([path]) => !shown.has(path)).reduce((sum, [, group]) => sum + weigh(group), 0);

  const leaders = apps.slice(0, TOP_PROCESS_COUNT).map(([path]) => path);
  const identities = await readProcessIdentities(leaders);

  const topProcesses = leaders.map((path, index) => {
    const group = groups.get(path)!;
    return { pid: group.pid, pids: group.pids, cpuPercent: Math.round(group.cpuPercent * 10) / 10, memoryBytes: group.memoryBytes, ...identities[index] };
  });

  // Rebuilt each poll, so a pid the panel has stopped showing stops being quittable — pids are
  // reused, and a stale entry would aim a quit at whatever inherited the number.
  quittable.set(panel, new Map(topProcesses.map(process => [process.pid, { name: process.name, pids: process.pids }])));

  return { topProcesses, background };
}

/**
 * Thread and process counts come from a second, heavier pass over the table — ps has to print
 * a line per thread — and they are a figure in the spec panel, not a line on a chart. Thirty
 * seconds keeps that full process-table walk out of the normal sampling path.
 */
const PROCESS_COUNT_MS = 30_000;
let processCountCache: { processes: number; threads: number; sampledAt: number } = { processes: 0, threads: 0, sampledAt: 0 };
let processCountInFlight: Promise<void> | null = null;

function refreshProcessCounts(): void {
  if (Date.now() - processCountCache.sampledAt < PROCESS_COUNT_MS || processCountInFlight) return;
  processCountInFlight = execFileAsync('/bin/ps', ['-axM'], { timeout: 4_000 })
    .then(({ stdout }) => {
      let processes = 0;
      let threads = 0;
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        // ps -axM prints a summary line per process and then one indented line per thread.
        if (/^\s/.test(line)) threads++;
        else processes++;
      }
      // The first unindented line is the column header, not a process.
      processCountCache = { processes: Math.max(0, processes - 1), threads, sampledAt: Date.now() };
    })
    .catch(() => { processCountCache = { ...processCountCache, sampledAt: Date.now() }; })
    .finally(() => { processCountInFlight = null; });
}

/** Thread and process counts for the CPU spec panel; the consumer lists have their own channel. */
async function readProcessStats(): Promise<{ threads: number; processes: number }> {
  refreshProcessCounts();
  if (processCountCache.sampledAt === 0 && processCountInFlight) await processCountInFlight;
  return { processes: processCountCache.processes, threads: processCountCache.threads };
}

/**
 * Both consumer lists in one answer. They are a table rather than a line on a chart, so the
 * renderer asks for them on a slower beat of their own — and reading them costs a pass over
 * the whole process table plus an icon for every row, which is not worth doing every second.
 */
async function readConsumers(): Promise<{ cpu: TopProcess[]; cpuBackground: number | null; memory: TopProcess[]; memoryBackground: number | null }> {
  const [cpu, memory] = await Promise.all([
    readTopApps('cpu', group => group.cpuPercent, CPU_ROW_FLOOR),
    readTopApps('memory', group => group.memoryBytes, MEMORY_ROW_FLOOR)
  ]);
  return {
    cpu: cpu.topProcesses,
    cpuBackground: cpu.background === null ? null : Math.round(cpu.background * 10) / 10,
    memory: memory.topProcesses,
    memoryBackground: memory.background
  };
}



type CpuMetricsValue = { usagePercent: number; availablePercent: number; userPercent: number; systemPercent: number };
let cpuMetricsCache: { value: CpuMetricsValue; sampledAt: number } = { value: { usagePercent: 0, availablePercent: 100, userPercent: 0, systemPercent: 0 }, sampledAt: 0 };

function readCpuMetrics(): CpuMetricsValue {
  if (cpuMetricsCache.sampledAt > 0 && Date.now() - cpuMetricsCache.sampledAt < RATE_CACHE_MS) return cpuMetricsCache.value;
  return (cpuMetricsCache = { value: sampleCpuMetrics(), sampledAt: Date.now() }).value;
}

function sampleCpuMetrics(): CpuMetricsValue {
  const current = captureCpuSnapshot();
  const idleDelta = current.idle - previousCpuSnapshot.idle;
  const userDelta = current.user - previousCpuSnapshot.user;
  const systemDelta = current.system - previousCpuSnapshot.system;
  const totalDelta = current.total - previousCpuSnapshot.total;
  previousCpuSnapshot = current;

  if (totalDelta <= 0) return { usagePercent: 0, availablePercent: 100, userPercent: 0, systemPercent: 0 };
  const availablePercent = (idleDelta / totalDelta) * 100;
  const userPercent = (userDelta / totalDelta) * 100;
  const systemPercent = (systemDelta / totalDelta) * 100;
  return { usagePercent: Number(Math.min(100, userPercent + systemPercent).toFixed(1)), availablePercent: Number(Math.max(0, availablePercent).toFixed(1)), userPercent: Number(Math.max(0, userPercent).toFixed(1)), systemPercent: Number(Math.max(0, systemPercent).toFixed(1)) };
}

let logicalCpuCache: { value: LogicalCpuMetric[]; sampledAt: number } = { value: [], sampledAt: 0 };

function readLogicalCpuMetrics(): LogicalCpuMetric[] {
  if (logicalCpuCache.sampledAt > 0 && Date.now() - logicalCpuCache.sampledAt < RATE_CACHE_MS) return logicalCpuCache.value;
  return (logicalCpuCache = { value: sampleLogicalCpuMetrics(), sampledAt: Date.now() }).value;
}

function sampleLogicalCpuMetrics(): LogicalCpuMetric[] {
  const current = cpus();
  const metrics = current.map((cpu, index) => {
    const previous = previousLogicalCpuSnapshots[index];

    const total = Object.values(cpu.times).reduce((sum, time) => sum + time, 0);
    if (!previous) return { index: index + 1, usagePercent: 0, userPercent: 0, systemPercent: 0 };
    const idleDelta = cpu.times.idle - previous.idle;
    const userDelta = (cpu.times.user + cpu.times.nice) - (previous.user + previous.nice);
    const systemDelta = (cpu.times.sys + cpu.times.irq) - (previous.sys + previous.irq);
    const previousTotal = Object.values(previous).reduce((sum, time) => sum + time, 0);
    const totalDelta = total - previousTotal;
    if (totalDelta <= 0) return { index: index + 1, usagePercent: 0, userPercent: 0, systemPercent: 0 };
    const userPercent = Math.max(0, userDelta / totalDelta * 100);
    const systemPercent = Math.max(0, systemDelta / totalDelta * 100);
    return { index: index + 1, usagePercent: Number(Math.min(100, userPercent + systemPercent).toFixed(1)), userPercent: Number(userPercent.toFixed(1)), systemPercent: Number(systemPercent.toFixed(1)) };
  });
  previousLogicalCpuSnapshots = current.map(cpu => ({ ...cpu.times }));
  return metrics;
}

let networkCache: { value: { interfaceName: string; connectionType: string; address: string | null; ipv6Address: string | null; ssid: string | null; signalStrength: string | null; linkSpeed: string | null; channel: string | null; phyMode: string | null; security: string | null; receivedBytes: number; sentBytes: number; downloadBytesPerSecond: number; uploadBytesPerSecond: number; packetsIn: number; packetsOut: number; sampledAt: number } | null; sampledAt: number } = { value: null, sampledAt: 0 };
let networkInFlight: Promise<{ interfaceName: string; connectionType: string; address: string | null; ipv6Address: string | null; ssid: string | null; signalStrength: string | null; linkSpeed: string | null; channel: string | null; phyMode: string | null; security: string | null; receivedBytes: number; sentBytes: number; downloadBytesPerSecond: number; uploadBytesPerSecond: number; packetsIn: number; packetsOut: number; sampledAt: number }> | null = null;

function readNetworkMetrics(): Promise<{ interfaceName: string; connectionType: string; address: string | null; ipv6Address: string | null; ssid: string | null; signalStrength: string | null; linkSpeed: string | null; channel: string | null; phyMode: string | null; security: string | null; receivedBytes: number; sentBytes: number; downloadBytesPerSecond: number; uploadBytesPerSecond: number; packetsIn: number; packetsOut: number; sampledAt: number }> {
  if (networkCache.value && Date.now() - networkCache.sampledAt < RATE_CACHE_MS) return Promise.resolve(networkCache.value);
  if (networkInFlight) return networkInFlight;
  networkInFlight = sampleNetworkMetrics()
    .then(value => { networkCache = { value, sampledAt: Date.now() }; return value; })
    .finally(() => { networkInFlight = null; });
  return networkInFlight;
}

async function sampleNetworkMetrics(): Promise<{ interfaceName: string; connectionType: string; address: string | null; ipv6Address: string | null; ssid: string | null; signalStrength: string | null; linkSpeed: string | null; channel: string | null; phyMode: string | null; security: string | null; receivedBytes: number; sentBytes: number; downloadBytesPerSecond: number; uploadBytesPerSecond: number; packetsIn: number; packetsOut: number; sampledAt: number }> {
  const sampledAt = Date.now();
  const interfaces = networkInterfaces();
  const [defaultInterface, hardwarePorts] = await Promise.all([readDefaultInterface(), readHardwarePorts()]);
  const routable = ([, addresses]: [string, typeof interfaces[string]]) =>
    addresses?.some(address => !address.internal && address.family === 'IPv4');
  const active = (defaultInterface && interfaces[defaultInterface]
    ? ([defaultInterface, interfaces[defaultInterface]] as const)
    : Object.entries(interfaces).find(routable)) ?? null;
  const interfaceName = active?.[0] ?? 'No connection';
  const address = active?.[1]?.find(value => !value.internal && value.family === 'IPv4')?.address ?? null;
  const ipv6Address = active?.[1]?.find(value => !value.internal && value.family === 'IPv6')?.address?.split('%')[0] ?? null;
  const connectionType = interfaceName === 'No connection' ? 'Offline'
    : hardwarePorts.get(interfaceName) ?? (interfaceName.startsWith('utun') ? 'VPN' : 'Network');
  let receivedBytes = 0;
  let sentBytes = 0;
  let packetsIn = 0;
  let packetsOut = 0;
  // Refreshed behind the sample, never inside it. SPAirPortDataType takes the better part of a
  // second on a good run and many times that when the radio is busy scanning, and a stall
  // there costs the sampler a whole tick — the charts stop while Wi-Fi details are fetched.
  if (sampledAt - networkRadioCache.sampledAt > 60_000 && !networkRadioInFlight) {
    networkRadioInFlight = (async () => {
    try {
      const detail = await execFileAsync('/usr/sbin/system_profiler', ['SPAirPortDataType', '-json'], { timeout: 10_000 });
      const parsed = JSON.parse(detail.stdout) as unknown;
      const network = findValue(parsed, ['spairport_current_network_information']);
      if (network && typeof network === 'object') {
        const record = network as Record<string, unknown>;
        const text = (keys: string[]) => { const value = findValue(record, keys); return value === null || value === undefined ? null : String(value); };
        // Without Location Services the network name comes back as the literal string
        // "<redacted>", which is worth saying plainly rather than printing as if it were one.
        const name = text(['_name', 'spairport_network_name']);
        networkRadioCache = {
          sampledAt,
          ssid: name === '<redacted>' ? null : name,
          signalStrength: text(['spairport_signal_noise']),
          // The rate is published as spairport_network_rate; spairport_tx_rate does not exist
          // in this report and reading it left the field permanently blank.
          linkSpeed: text(['spairport_network_rate', 'spairport_tx_rate']),
          channel: text(['spairport_network_channel']),
          phyMode: text(['spairport_network_phymode']),
          security: (value => value === null ? null : readablePropertyName(value))(text(['spairport_security_mode']))
        };
      } else networkRadioCache = { ...networkRadioCache, sampledAt: Date.now() };
    } catch { networkRadioCache = { ...networkRadioCache, sampledAt: Date.now() }; }
    })().finally(() => { networkRadioInFlight = null; });
    networkRadioInFlight.catch(() => undefined);
  }
  try {
    const { stdout } = await execFileAsync('/usr/sbin/netstat', ['-ibn'], { timeout: 1_000 });
    const rows = stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(columns => columns.length >= 10 && columns[0] === interfaceName);
    const row = rows[0];
    if (row) { packetsIn = Number(row[4]) || 0; receivedBytes = Number(row[6]) || 0; packetsOut = Number(row[7]) || 0; sentBytes = Number(row[9]) || 0; }
  } catch { /* Network counters can be unavailable in a sandboxed process. */ }
  // A rate only means anything between two readings of the same interface.
  const comparable = previousNetworkSample?.interfaceName === interfaceName ? previousNetworkSample : null;
  const elapsed = comparable ? Math.max(0.25, (sampledAt - comparable.sampledAt) / 1000) : 1;
  const downloadBytesPerSecond = comparable ? Math.max(0, (receivedBytes - comparable.received) / elapsed) : 0;
  const uploadBytesPerSecond = comparable ? Math.max(0, (sentBytes - comparable.sent) / elapsed) : 0;
  previousNetworkSample = { interfaceName, received: receivedBytes, sent: sentBytes, sampledAt };
  return { interfaceName, connectionType, address, ipv6Address, ...networkRadioCache, receivedBytes, sentBytes, downloadBytesPerSecond, uploadBytesPerSecond, packetsIn, packetsOut, sampledAt };
}

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

let diskIoCache: { value: DiskIo | null; sampledAt: number } = { value: null, sampledAt: 0 };
let diskIoInFlight: Promise<DiskIo> | null = null;

function readDiskIo(): Promise<DiskIo> {
  if (diskIoCache.value && Date.now() - diskIoCache.sampledAt < RATE_CACHE_MS) return Promise.resolve(diskIoCache.value);
  if (diskIoInFlight) return diskIoInFlight;
  diskIoInFlight = sampleDiskIo()
    .then(value => { diskIoCache = { value, sampledAt: Date.now() }; return value; })
    .finally(() => { diskIoInFlight = null; });
  return diskIoInFlight;
}

async function sampleDiskIo(): Promise<DiskIo> {
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
const SNAPSHOT_CACHE_MS = 30_000;
let snapshotCache: { value: number | null; sampledAt: number } = { value: null, sampledAt: 0 };

async function countSnapshots(mountPoint: string): Promise<number | null> {
  if (snapshotCache.sampledAt > 0 && Date.now() - snapshotCache.sampledAt < SNAPSHOT_CACHE_MS) return snapshotCache.value;
  try {
    const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['apfs', 'listSnapshots', mountPoint], { timeout: 3_000 });
    snapshotCache = { value: (stdout.match(/^\+-- /gm) ?? []).length, sampledAt: Date.now() };
  } catch {
    snapshotCache = { value: null, sampledAt: Date.now() };
  }
  return snapshotCache.value;
}


export type DiskVolume = { name: string; role: string | null; usedBytes: number };
export type DiskCategory = { key: string; label: string; usedBytes: number };

export type Disk = {
  id: string;
  name: string;
  model: string | null;
  connection: string | null;
  internal: boolean | null;
  isDiskImage: boolean;
  isStartupDisk: boolean;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  /** Only the internal drive has a sensor; anything else reports nothing rather than guessing. */
  temperatureC: number | null;
  volumes: DiskVolume[];
  categories: DiskCategory[];
  mounted: boolean;
};

/** diskutil speaks plist, and plutil is the shortest honest route to something JSON.parse takes. */
function plistToJson(xml: string): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-']);
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', code => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
    child.stdin.on('error', () => resolve(null));
    child.stdin.end(xml);
  });
}

// `-plist` belongs directly after the verb; diskutil ignores it at the end of the line and
// prints its usual text, which then parses as nothing.
async function readDiskutil(args: string[]): Promise<Record<string, any> | null> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/diskutil', args, { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
    return await plistToJson(stdout);
  } catch {
    return null;
  }
}

/** Model, bus and enclosure never change while the machine is running. */
const diskEnclosureCache = new Map<string, { model: string | null; connection: string | null; internal: boolean | null; isDiskImage: boolean }>();

async function readDiskEnclosure(physicalStore: string): Promise<{ model: string | null; connection: string | null; internal: boolean | null; isDiskImage: boolean }> {
  const cached = diskEnclosureCache.get(physicalStore);
  if (cached) return cached;

  const store = await readDiskutil(['info', '-plist', physicalStore]);
  const whole = store?.['ParentWholeDisk'] ? await readDiskutil(['info', '-plist', String(store['ParentWholeDisk'])]) : null;
  const connection = typeof store?.['BusProtocol'] === 'string' ? store['BusProtocol'] : null;
  const hardware = {
    // The maker's name lives on the whole disk, not on the partition the container sits in.
    model: typeof whole?.['MediaName'] === 'string' && whole['MediaName'] ? whole['MediaName'] : null,
    connection,
    internal: typeof store?.['Internal'] === 'boolean' ? store['Internal'] : null,
    isDiskImage: connection === 'Disk Image'
  };
  diskEnclosureCache.set(physicalStore, hardware);
  return hardware;
}

/**
 * Roles that exist to boot and update the machine. A container holding nothing else is Apple's
 * own scaffolding — the 500 MB iSCPreboot container and the 5 GB Recovery one — which is not a
 * disk anybody puts anything on, so it is left out of the list entirely.
 */
const INFRASTRUCTURE_ROLES = new Set(['Preboot', 'Recovery', 'Update', 'xART', 'Hardware', 'VM']);

/** diskutil costs the better part of a second across every container, and disks fill slowly. */
const DISK_LAYOUT_MS = 10_000;
let diskCache: { disks: Disk[]; sampledAt: number } | null = null;
let diskInFlight: Promise<Disk[]> | null = null;

/**
 * One entry per APFS container rather than per volume. Every volume in a container draws on the
 * same pool of free space, so `df` reports the identical free figure against each of them and
 * a per-volume "% full" would show one disk as several, filled to different levels. The
 * container is the thing that actually fills up.
 */
async function readFilesystemStats(mountPoint: string): Promise<{ totalBytes: number; usedBytes: number; freeBytes: number } | null> {
  try {
    const { stdout } = await execFileAsync('/bin/df', ['-kP', mountPoint], { timeout: 1_000 });
    const columns = stdout.trim().split(/\n/).at(-1)?.trim().split(/\s+/) ?? [];
    const totalBytes = Number(columns[1]) * 1024;
    const usedBytes = Number(columns[2]) * 1024;
    const freeBytes = Number(columns[3]) * 1024;
    if (![totalBytes, usedBytes, freeBytes].every(Number.isFinite)) return null;
    return { totalBytes, usedBytes, freeBytes };
  } catch {
    return null;
  }
}

/** `null`, not zero: a walk that timed out or was refused has not found an empty folder. */
async function readDirectoryBytes(path: string): Promise<number | null> {
  try {
    // Generous, because nothing waits on this — it runs behind the poll, not inside it.
    const { stdout } = await execFileAsync('/usr/bin/du', ['-sk', '-x', path], { timeout: 120_000 });
    const bytes = Number(stdout.trim().split(/\s+/)[0]) * 1024;
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Walking these folders costs seconds — `/Applications` takes nine on this machine and the
 * Desktop fourteen — so it happens behind the poll rather than inside it, and the answer is
 * kept for minutes. Folder sizes do not move fast enough for that to show.
 *
 * Running it in the request path made the storage channel block for as long as the walk took,
 * and the timeout that capped it turned a scan that never finished into a folder of zero bytes.
 */
const CATEGORY_CACHE_MS = 5 * 60_000;
let categoryCache: { value: DiskCategory[]; sampledAt: number } = { value: [], sampledAt: 0 };
let categoryInFlight: Promise<void> | null = null;

function readStartupCategories(usedBytes: number): DiskCategory[] {
  const stale = categoryCache.sampledAt === 0 || Date.now() - categoryCache.sampledAt >= CATEGORY_CACHE_MS;
  if (stale && !categoryInFlight) {
    categoryInFlight = sampleStartupCategories(usedBytes)
      .then(value => { categoryCache = { value, sampledAt: Date.now() }; })
      .catch(() => undefined)
      .finally(() => { categoryInFlight = null; });
  }
  return categoryCache.value;
}

async function sampleStartupCategories(usedBytes: number): Promise<DiskCategory[]> {
  const home = homedir();
  const entries = [
    { key: 'applications', label: 'Applications', path: '/Applications' },
    { key: 'desktop', label: 'Desktop', path: join(home, 'Desktop') },
    { key: 'downloads', label: 'Downloads', path: join(home, 'Downloads') },
    { key: 'documents', label: 'Documents', path: join(home, 'Documents') }
  ];
  const sizes = await Promise.all(entries.map(async entry => ({ ...entry, usedBytes: await readDirectoryBytes(entry.path) })));
  const measured = sizes.filter((entry): entry is typeof entry & { usedBytes: number } => entry.usedBytes !== null);
  // The remainder stands against what was actually measured; a folder that could not be read
  // is left out of the ring rather than folded into it as nothing.
  const knownBytes = measured.reduce((sum, entry) => sum + entry.usedBytes, 0);
  return [...measured.map(({ key, label, usedBytes: size }) => ({ key, label, usedBytes: size })), { key: 'other', label: 'Other', usedBytes: Math.max(0, usedBytes - knownBytes) }]
    .filter(category => category.usedBytes > 0);
}

function readDisks(): Promise<Disk[]> {
  const stale = !diskCache || Date.now() - diskCache.sampledAt >= DISK_LAYOUT_MS;
  if (stale && !diskInFlight) {
    diskInFlight = sampleDisks()
      .then(disks => { diskCache = { disks, sampledAt: Date.now() }; return disks; })
      .finally(() => { diskInFlight = null; });
    diskInFlight.catch(() => undefined);
  }
  // Only the first caller of a session has nothing to show and has to wait for the walk.
  if (!diskCache && diskInFlight) return diskInFlight;
  return Promise.resolve(diskCache?.disks ?? []);
}

/**
 * diskutil costs the better part of a second across every container, so the refresh runs
 * behind the poll. Waiting for it put that pause into one storage sample every ten seconds,
 * which showed up as a stutter in the charts on a regular beat.
 */
async function sampleDisks(): Promise<Disk[]> {

  const [apfs, root, temperatures, dataFilesystem] = await Promise.all([
    readDiskutil(['apfs', 'list', '-plist']),
    readDiskutil(['info', '-plist', '/']),
    readTemperatures(),
    readFilesystemStats('/System/Volumes/Data')
  ]);
  const containers = Array.isArray(apfs?.['Containers']) ? apfs['Containers'] as Record<string, any>[] : [];
  const startupContainer = typeof root?.['APFSContainerReference'] === 'string' ? root['APFSContainerReference'] : null;

  const disks: Disk[] = [];
  for (const container of containers) {
    const rawVolumes = Array.isArray(container['Volumes']) ? container['Volumes'] as Record<string, any>[] : [];
    const roles = rawVolumes.map(volume => Array.isArray(volume['Roles']) && volume['Roles'].length ? String(volume['Roles'][0]) : null);
    if (roles.length && roles.every(role => role !== null && INFRASTRUCTURE_ROLES.has(role))) continue;

    const volumes: DiskVolume[] = rawVolumes
      .map((volume, index) => ({
        name: typeof volume['Name'] === 'string' ? volume['Name'] : String(volume['DeviceIdentifier'] ?? 'Volume'),
        role: roles[index],
        usedBytes: Number(volume['CapacityInUse'] ?? 0)
      }))
      .sort((a, b) => b.usedBytes - a.usedBytes);

    const id = String(container['ContainerReference'] ?? '');
    const isStartupDisk = id !== '' && id === startupContainer;
    const containerTotalBytes = Number(container['CapacityCeiling'] ?? 0);
    const containerFreeBytes = Number(container['CapacityFree'] ?? 0);
    const containerUsedBytes = Math.max(0, containerTotalBytes - containerFreeBytes);
    // Finder's Macintosh HD - Data view is a filesystem view, while APFS container
    // accounting includes the read-only system volume and reclaimable APFS space. Keep
    // the startup disk detail aligned with Finder by using the Data volume's df numbers.
    const filesystem = isStartupDisk ? dataFilesystem : null;
    const totalBytes = filesystem?.totalBytes ?? containerTotalBytes;
    const freeBytes = filesystem?.freeBytes ?? containerFreeBytes;
    const usedBytes = filesystem?.usedBytes ?? containerUsedBytes;

    const physicalStore = String(container['DesignatedPhysicalStore'] ?? '');
    const hardware = physicalStore ? await readDiskEnclosure(physicalStore) : { model: null, connection: null, internal: null, isDiskImage: false };

    // The name a person recognises: what the startup volume is called, or the biggest volume
    // on any other container. The system and data volumes of one disk share a name in Finder.
    const named = isStartupDisk
      ? volumes.find(volume => volume.role === 'Data') ?? volumes.find(volume => volume.role === 'System') ?? volumes[0]
      : volumes.find(volume => volume.role === 'System') ?? volumes[0];
    const categories = isStartupDisk ? readStartupCategories(usedBytes) : [];

    disks.push({
      id,
      name: isStartupDisk ? 'Macintosh HD - Data' : (named?.name ?? id),
      model: hardware.model,
      connection: hardware.connection,
      internal: hardware.internal,
      isDiskImage: hardware.isDiskImage,
      isStartupDisk,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
      temperatureC: hardware.internal && !hardware.isDiskImage ? temperatures.nandC : null,
      volumes,
      categories,
      mounted: true
    });
  }

  // Anything mounted that no APFS container accounts for: an external drive formatted HFS+,
  // exFAT or NTFS, a mounted image, a network share. df is the only thing that sees all of
  // them, and it reports a filesystem's own free space, which for a non-APFS volume is the
  // whole truth — there is no container pooling space behind it.
  const claimed = new Set<string>();
  for (const container of containers) {
    for (const volume of (Array.isArray(container['Volumes']) ? container['Volumes'] as Record<string, any>[] : [])) {
      if (volume['DeviceIdentifier']) claimed.add(String(volume['DeviceIdentifier']));
    }
  }

  try {
    for (const line of await readFilesystems()) {
      const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\/.*)$/);
      if (!match) continue;
      const device = match[1];
      const mountPoint = match[5];
      if (!device.startsWith('/dev/disk')) continue;
      if (claimed.has(device.slice('/dev/'.length))) continue;
      if (mountPoint === '/' || mountPoint.startsWith('/System/Volumes/')) continue;

      const totalBytes = Number(match[2]) * 1024;
      const usedBytes = Number(match[3]) * 1024;
      const freeBytes = Number(match[4]) * 1024;
      if (totalBytes < MINIMUM_VOLUME_BYTES) continue;

      const info = await readDiskutil(['info', '-plist', mountPoint]);
      const identifier = device.slice('/dev/'.length);
      const hardware = await readDiskEnclosure(identifier);
      disks.push({
        id: identifier,
        name: typeof info?.['VolumeName'] === 'string' && info['VolumeName'] ? info['VolumeName'] : mountPoint.split('/').at(-1) ?? identifier,
        model: hardware.model,
        connection: hardware.connection,
        internal: hardware.internal,
        isDiskImage: hardware.isDiskImage,
        isStartupDisk: false,
        totalBytes,
        usedBytes,
        freeBytes,
        usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
        temperatureC: null,
        // A single filesystem has nothing to break down into.
        volumes: [],
        categories: [],
        mounted: true
      });
    }
  } catch {
    // The APFS containers still stand on their own.
  }

  // `df` only reports mounted filesystems. Disk Utility also shows whole physical disks
  // that are currently unmounted, so add those entries with capacity but no fabricated usage.
  try {
    const list = await readDiskutil(['list', '-plist']);
    const wholeDisks = Array.isArray(list?.['WholeDisks']) ? list['WholeDisks'].map(String) : [];
    for (const identifier of wholeDisks) {
      if (disks.some(disk => disk.id === identifier || disk.name === identifier)) continue;
      const info = await readDiskutil(['info', '-plist', identifier]);
      const totalBytes = Number(info?.['Size'] ?? info?.['TotalSize'] ?? 0);
      if (!Number.isFinite(totalBytes) || totalBytes < MINIMUM_VOLUME_BYTES) continue;
      const hardware = await readDiskEnclosure(identifier);
      // The startup APFS container already represents the internal Apple SSD. Whole-disk
      // enumeration also returns its physical store, so do not show that store as a second
      // user-facing disk. The same guard prevents a mounted external partition and its whole
      // disk from appearing twice.
      if (hardware.internal === true) continue;
      if (disks.some(disk => disk.model === hardware.model && disk.connection === hardware.connection && disk.internal === hardware.internal)) continue;
      disks.push({
        id: identifier,
        name: typeof info?.['MediaName'] === 'string' && info['MediaName'] ? info['MediaName'] : identifier,
        model: hardware.model,
        connection: hardware.connection,
        internal: hardware.internal,
        isDiskImage: hardware.isDiskImage,
        isStartupDisk: false,
        totalBytes,
        usedBytes: 0,
        freeBytes: totalBytes,
        usedPercent: 0,
        temperatureC: null,
        volumes: [],
        categories: [],
        mounted: false
      });
    }
  } catch {
    // Disk Utility may be unavailable in restricted environments; mounted disks remain useful.
  }

  // The disk the machine booted from first, then real drives, then disk images.
  disks.sort((a, b) => Number(b.isStartupDisk) - Number(a.isStartupDisk) || Number(a.isDiskImage) - Number(b.isDiskImage) || b.totalBytes - a.totalBytes);
  diskCache = { disks, sampledAt: Date.now() };
  return disks;
}

// Mounts that exist to boot and update the machine rather than to hold anything a person
// put there. Listing them alongside the startup disk is noise.
const SYSTEM_MOUNT_NAMES = new Set(['Preboot', 'Update', 'xarts', 'iSCPreboot', 'Hardware', 'VM']);
const MINIMUM_VOLUME_BYTES = 2 * 1024 ** 3;



export {
  batteryCache,
  updateBatteryCache,
  execFileAsync,
  findValue,
  nativeHelper,
  readCpuMetrics,
  readLogicalCpuMetrics,
  readDisks,
  quittableProcess,
  readProcessStats,
  readConsumers,
  readActivityProcesses,
  stopActivityProcesses,
  readCpuTemperature,
  readCpuInfo,
  readMemoryInfo,
  readGpuInfo,
  readGpuStatistics,
  readTemperatures,
  readPower,
  readThermalState,
  readCooling,
  readNetworkMetrics,
  readTrashBytes,
  readFilesystems,
  readDiskIo,
  readDiskHardware,
  countSnapshots,
  SYSTEM_MOUNT_NAMES,
  MINIMUM_VOLUME_BYTES
};
