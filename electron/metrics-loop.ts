// One sampler for the whole app.
//
// Every window used to run its own timer and ask for every metric itself, so with the
// dashboard, the menu bar panel and a detail panel open the machine was measured three times
// a second to draw one set of lines. Worse, the readings are rates — a counter now less the
// same counter a moment ago — so whichever window asked first consumed the interval and the
// others divided by whatever sliver was left. The same instant showed 100% in one window and
// 49% in another.
//
// So the loop lives here, runs once, and its results are pushed to every window that asked to
// be kept informed. The history lives here too, which means a panel opened a minute from now
// starts with the last minute already drawn rather than an empty chart.
import { app, BrowserWindow, ipcMain, Notification, webContents } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shouldRunMetrics } from './metrics-policy';

export type MetricSample = {
  cpuUsage: number; cpuAvailable: number; cpuUser: number; cpuSystem: number;
  memoryPressure: number; memoryApp: number; memoryWired: number; memoryCompressed: number;
  gpuUsage: number; gpuRenderer: number; gpuTiler: number;
  npuWatts: number;
  cpuC: number; socC: number; batteryC: number;
  batteryPercent: number; batteryWatts: number; packageWatts: number;
  logicalCores: number[];
  networkDownload: number; networkUpload: number;
  diskRead: number; diskWrite: number;
};

type Readers = {
  cpu: () => Promise<any>;
  memory: () => Promise<any>;
  gpu: () => Promise<any>;
  npu: () => Promise<any>;
  thermals: () => Promise<any>;
  battery: () => Promise<any>;
  network: () => Promise<any>;
  /** Throughput only: one ioreg read, cheap enough for every tick. */
  diskIo: () => Promise<any>;
  /** How full the disks are, and what is on them. Slow to read, slow to change. */
  storage: () => Promise<any>;
  consumers: () => Promise<any>;
};

/** Sixty seconds of chart at a one-second cadence, plus the sample being drawn. */
const HISTORY_LENGTH = 61;
const SAMPLE_MS = 1_000;
const LOW_STORAGE_POLL_MS = 30_000;

/**
 * Capacity and the app lists share a slower beat. Reading how full the disks are costs about
 * 205ms and five forks — on its own more than every other metric put together — while free
 * space moves by the minute; the app lists cost a pass over the whole process table and are
 * read as a table rather than followed as a line. Disk throughput is not in here: that is one
 * cheap ioreg read and it draws a chart, so it stays on the fast beat.
 */
const SLOW_MS = 10_000;

let readers: Readers | null = null;
let sampleTimer: ReturnType<typeof setInterval> | undefined;
let slowTimer: ReturnType<typeof setInterval> | undefined;
let lowStorageTimer: ReturnType<typeof setInterval> | undefined;
let sampling = false;
let readingSlow = false;
let readingAlertStorage = false;

/** webContents ids that asked to be kept informed. */
const subscribers = new Set<number>();

let latest: Record<string, unknown> = {};
let consumers: Record<string, unknown> = { cpu: [], cpuBackground: null, memory: [], memoryBackground: null };
let storage: Record<string, unknown> | null = null;
let history: MetricSample[] = [];
let unavailable = false;
let backgroundMonitoring = false;
let runGeneration = 0;
const DEFAULT_LOW_STORAGE_THRESHOLD = 20 * 1024 ** 3;
let lowStorageAlert = { enabled: false, thresholdBytes: DEFAULT_LOW_STORAGE_THRESHOLD };
let lowStorageAlertActive = false;
let openMainWindowFromAlert: () => void = () => undefined;

function shouldRun(): boolean { return shouldRunMetrics(backgroundMonitoring, subscribers.size); }

async function saveBackgroundPreference(enabled: boolean): Promise<void> {
  const path = join(app.getPath('userData'), 'background-monitoring.json');
  await writeFile(path, JSON.stringify({ enabled }), 'utf8');
}

async function loadBackgroundPreference(): Promise<boolean> {
  try {
    const raw = await readFile(join(app.getPath('userData'), 'background-monitoring.json'), 'utf8');
    return (JSON.parse(raw) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

async function saveLowStorageAlert(): Promise<void> {
  await writeFile(join(app.getPath('userData'), 'low-storage-alert.json'), JSON.stringify(lowStorageAlert), 'utf8');
}

async function loadLowStorageAlert(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(join(app.getPath('userData'), 'low-storage-alert.json'), 'utf8')) as { enabled?: unknown; thresholdBytes?: unknown };
    const allowed = [5, 10, 20, 50].map(gb => gb * 1024 ** 3);
    lowStorageAlert = {
      enabled: raw.enabled === true,
      thresholdBytes: typeof raw.thresholdBytes === 'number' && allowed.includes(raw.thresholdBytes) ? raw.thresholdBytes : DEFAULT_LOW_STORAGE_THRESHOLD
    };
  } catch {
    lowStorageAlert = { enabled: false, thresholdBytes: DEFAULT_LOW_STORAGE_THRESHOLD };
  }
}

function displayBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
}

function checkLowStorage(storageMetrics: Record<string, any>): void {
  if (!lowStorageAlert.enabled) { lowStorageAlertActive = false; return; }
  const available = Number(storageMetrics.availableBytes);
  const below = Number.isFinite(available) && available < lowStorageAlert.thresholdBytes;
  if (!below) { lowStorageAlertActive = false; return; }
  if (lowStorageAlertActive) return;
  lowStorageAlertActive = true;
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: 'Low disk space',
    body: `${displayBytes(available)} free on ${String(storageMetrics.volumeName ?? 'your startup disk')}. Open OpenClean to review storage.`
  });
  notification.on('click', () => openMainWindowFromAlert());
  notification.show();
}

async function readStorageForAlert(): Promise<void> {
  if (readingAlertStorage || !readers) return;
  readingAlertStorage = true;
  try { checkLowStorage(await readers.storage()); }
  catch (error) { console.error('Unable to check low storage alert', error); }
  finally { readingAlertStorage = false; }
}

function syncLowStoragePolling(): void {
  const needed = lowStorageAlert.enabled && !shouldRun();
  if (needed && !lowStorageTimer) {
    void readStorageForAlert();
    lowStorageTimer = setInterval(() => void readStorageForAlert(), LOW_STORAGE_POLL_MS);
  } else if (!needed && lowStorageTimer) {
    clearInterval(lowStorageTimer);
    lowStorageTimer = undefined;
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const id of subscribers) {
    const contents = webContents.fromId(id);
    // A window can go away between ticks; drop it rather than letting the set grow.
    if (!contents || contents.isDestroyed()) { subscribers.delete(id); continue; }
    contents.send(channel, payload);
  }
}

function toSample(metrics: Record<string, any>): MetricSample {
  const { cpu, memory, gpu, npu, thermals, battery, network, diskIo } = metrics;
  const share = (bytes: number) => memory.totalBytes > 0 ? (bytes / memory.totalBytes) * 100 : 0;
  return {
    cpuUsage: cpu.usagePercent,
    cpuAvailable: cpu.availablePercent,
    cpuUser: cpu.userPercent,
    cpuSystem: cpu.systemPercent,
    memoryPressure: memory.pressurePercent,
    memoryApp: share(memory.appBytes),
    memoryWired: share(memory.wiredBytes),
    memoryCompressed: share(memory.compressedBytes),
    gpuUsage: gpu.usagePercent ?? 0,
    gpuRenderer: gpu.rendererPercent ?? 0,
    gpuTiler: gpu.tilerPercent ?? 0,
    npuWatts: npu.watts ?? 0,
    cpuC: thermals.cpuC ?? 0,
    socC: thermals.socC ?? 0,
    batteryC: thermals.batteryC ?? 0,
    batteryPercent: battery.percent,
    batteryWatts: battery.watts ?? 0,
    packageWatts: thermals.packageWatts ?? 0,
    logicalCores: (cpu.logical ?? []).map((core: { usagePercent: number }) => core.usagePercent),
    networkDownload: network.downloadBytesPerSecond,
    networkUpload: network.uploadBytesPerSecond,
    diskRead: diskIo?.readBytesPerSecond ?? 0,
    diskWrite: diskIo?.writeBytesPerSecond ?? 0
  };
}

async function takeSample(): Promise<void> {
  if (sampling || !readers) return;
  const generation = runGeneration;
  sampling = true;
  try {
    // All eight at once rather than one after another: they spend their time waiting on
     // subprocesses, so the waits overlap — measured at 66ms together against 80ms apart.
    const [cpu, memory, gpu, npu, thermals, battery, network, diskIo] = await Promise.all([
      readers.cpu(), readers.memory(), readers.gpu(), readers.npu(),
      readers.thermals(), readers.battery(), readers.network(), readers.diskIo()
    ]);
    if (generation !== runGeneration || !shouldRun()) return;
    latest = { cpu, memory, gpu, npu, thermals, battery, network, diskIo };
    history = [...history, toSample(latest)].slice(-HISTORY_LENGTH);
    unavailable = false;
    broadcast('metrics:sample', { ...latest, sample: history[history.length - 1], unavailable });
  } catch (error) {
    // One failed round does not throw away what the panels are already showing; they are told
    // the reading is unavailable and keep the last values until it comes back.
    if (generation === runGeneration && shouldRun()) {
      unavailable = true;
      broadcast('metrics:sample', { ...latest, sample: null, unavailable });
      console.error('Unable to sample system metrics', error);
    }
  } finally {
    sampling = false;
    if (generation !== runGeneration && shouldRun()) void takeSample();
  }
}

async function takeSlow(): Promise<void> {
  if (readingSlow || !readers) return;
  const generation = runGeneration;
  readingSlow = true;
  try {
    const [nextStorage, nextConsumers] = await Promise.all([readers.storage(), readers.consumers()]);
    if (generation !== runGeneration || !shouldRun()) return;
    storage = nextStorage;
    consumers = nextConsumers;
    checkLowStorage(nextStorage);
    broadcast('metrics:slow', { storage, consumers });
  } catch (error) {
    // Both keep their last contents rather than emptying on one failed read.
    if (generation === runGeneration && shouldRun()) console.error('Unable to read storage and top consumers', error);
  } finally {
    readingSlow = false;
    if (generation !== runGeneration && shouldRun()) void takeSlow();
  }
}

function start(): void {
  syncLowStoragePolling();
  if (sampleTimer) return;
  void takeSample();
  void takeSlow();
  sampleTimer = setInterval(() => void takeSample(), SAMPLE_MS);
  slowTimer = setInterval(() => void takeSlow(), SLOW_MS);
}

function stop(): void {
  runGeneration++;
  if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = undefined; }
  if (slowTimer) { clearInterval(slowTimer); slowTimer = undefined; }
  // A later subscriber starts a new timeline; old points are no longer the last minute.
  history = [];
  latest = {};
  storage = null;
  consumers = { cpu: [], cpuBackground: null, memory: [], memoryBackground: null };
  unavailable = false;
  syncLowStoragePolling();
}

export async function registerMetricsLoop(sources: Readers, openMainWindow?: () => void): Promise<void> {
  readers = sources;
  openMainWindowFromAlert = openMainWindow ?? (() => undefined);
  // Load the saved choice before the first window subscribes so background mode can begin
  // sampling before the menu bar popover is opened.
  backgroundMonitoring = await loadBackgroundPreference();
  await loadLowStorageAlert();
  if (backgroundMonitoring) start();

  ipcMain.handle('metrics:subscribe', event => {
    subscribers.add(event.sender.id);
    syncLowStoragePolling();
    // A visible monitor view joins the shared loop; background mode may already be running it.
    start();
    const contents = event.sender;
    contents.once('destroyed', () => {
      subscribers.delete(contents.id);
      if (!shouldRun()) stop();
    });
    return { subscribed: true };
  });

  ipcMain.handle('metrics:unsubscribe', event => {
    subscribers.delete(event.sender.id);
    if (!shouldRun()) stop();
    else syncLowStoragePolling();
    return { subscribed: false };
  });

  ipcMain.handle('metrics:get-background-monitoring', () => ({ enabled: backgroundMonitoring }));

  ipcMain.handle('metrics:set-background-monitoring', async (_event, enabled: unknown) => {
    const next = enabled === true;
    await saveBackgroundPreference(next);
    backgroundMonitoring = next;
    if (shouldRun()) start();
    else stop();
    syncLowStoragePolling();
    return { enabled: backgroundMonitoring };
  });

  ipcMain.handle('metrics:get-low-storage-alert', () => ({ ...lowStorageAlert, supported: Notification.isSupported() }));
  ipcMain.handle('metrics:set-low-storage-alert', async (_event, request: unknown) => {
    if (!request || typeof request !== 'object') return { ...lowStorageAlert, supported: Notification.isSupported() };
    const value = request as { enabled?: unknown; thresholdBytes?: unknown };
    const allowed = [5, 10, 20, 50].map(gb => gb * 1024 ** 3);
    if (typeof value.enabled !== 'boolean' || typeof value.thresholdBytes !== 'number' || !allowed.includes(value.thresholdBytes)) {
      return { ...lowStorageAlert, supported: Notification.isSupported() };
    }
    const previous = lowStorageAlert;
    lowStorageAlert = { enabled: value.enabled, thresholdBytes: value.thresholdBytes };
    try { await saveLowStorageAlert(); }
    catch (error) { lowStorageAlert = previous; throw error; }
    lowStorageAlertActive = false;
    if (storage) checkLowStorage(storage);
    syncLowStoragePolling();
    return { ...lowStorageAlert, supported: Notification.isSupported() };
  });

  // Everything a window needs to draw immediately, including the history it missed.
  ipcMain.handle('metrics:snapshot', () => ({ ...latest, storage, history, consumers, unavailable }));
  syncLowStoragePolling();
}

/** Closing every window stops the loop unless the saved background preference keeps it alive. */
export function stopMetricsLoopIfIdle(): void {
  if (!BrowserWindow.getAllWindows().length && !backgroundMonitoring) stop();
}
