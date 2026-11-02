import { Injectable, OnDestroy, signal } from '@angular/core';

export interface MetricSample {
  cpuUsage: number;
  cpuAvailable: number;
  cpuUser: number;
  cpuSystem: number;
  memoryPressure: number;
  memoryApp: number;
  memoryWired: number;
  memoryCompressed: number;
  gpuUsage: number;
  gpuRenderer: number;
  gpuTiler: number;
  npuWatts: number;
  cpuC: number;
  socC: number;
  batteryC: number;
  batteryPercent: number;
  batteryWatts: number;
  packageWatts: number;
  logicalCores: number[];
  networkDownload: number;
  networkUpload: number;
  diskRead: number;
  diskWrite: number;
}

@Injectable({ providedIn: 'root' })
export class SystemMonitorService implements OnDestroy {
  readonly cpu = signal<CpuMetrics | null>(null);
  readonly cpuUnavailable = signal(false);
  readonly cpuInfo = signal<CpuInfo | null>(null);
  readonly memory = signal<MemoryMetrics | null>(null);
  readonly memoryUnavailable = signal(false);
  readonly memoryInfo = signal<MemoryInfo | null>(null);
  readonly gpu = signal<GpuMetrics | null>(null);
  readonly gpuInfo = signal<GpuInfo | null>(null);
  readonly npu = signal<NpuMetrics | null>(null);
  readonly thermals = signal<ThermalMetrics | null>(null);
  readonly storage = signal<StorageMetrics | null>(null);
  readonly storageUnavailable = signal(false);
  readonly battery = signal<BatteryMetrics | null>(null);
  readonly batteryUnavailable = signal(false);
  readonly network = signal<NetworkMetrics | null>(null);
  /**
   * The app lists have a much slower beat of their own. They are a table, not a line on a
   * chart — nobody reads which app is busiest several times a second — and fetching them
   * costs a pass over the whole process table plus an icon for every row.
   */
  readonly cpuConsumers = signal<TopProcess[]>([]);
  readonly cpuBackground = signal<number | null>(null);
  readonly memoryConsumers = signal<TopProcess[]>([]);
  readonly memoryBackground = signal<number | null>(null);

  /** Rolling window the charts plot from. One entry per poll, newest last. */
  readonly history = signal<MetricSample[]>([]);

  private removeSampleListener?: () => void;
  private removeConsumerListener?: () => void;
  private subscribed = false;
  private pollingSession = 0;

  constructor() {
    void this.loadCpuInfo();
    void this.loadMemoryInfo();
    void this.loadGpuInfo();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  /**
   * Joins the one sampler running in the main process rather than starting a timer here. Every
   * window used to poll for itself, which measured the machine once per window every two seconds and
   * — because the readings are rates — handed each window a different answer for the same
   * instant. The snapshot also arrives with the history already filled, so a panel opened now
   * draws the last minute instead of starting from an empty chart.
   */
  startPolling(): void {
    if (this.subscribed || !window.electronAPI) return;
    this.subscribed = true;
    const session = ++this.pollingSession;
    this.removeSampleListener = window.electronAPI.onMetricsSample(payload => this.applySample(payload));
    this.removeConsumerListener = window.electronAPI.onMetricsSlow(slow => this.applySlow(slow));
    void window.electronAPI.subscribeMetrics();
    void window.electronAPI.getMetricsSnapshot().then(snapshot => {
      if (!this.subscribed || session !== this.pollingSession) return;
      this.history.set(snapshot.history ?? []);
      this.applySlow({ storage: snapshot.storage ?? null, consumers: snapshot.consumers });
      if (snapshot.cpu) this.applySample({ ...snapshot, sample: null } as MetricsSample);
    }).catch(error => console.error('Unable to read the metrics snapshot', error));
  }

  stopPolling(): void {
    if (!this.subscribed) return;
    this.subscribed = false;
    this.pollingSession++;
    this.removeSampleListener?.();
    this.removeConsumerListener?.();
    this.removeSampleListener = undefined;
    this.removeConsumerListener = undefined;
    void window.electronAPI?.unsubscribeMetrics();
  }

  private applySample(payload: MetricsSample): void {
    const unavailable = payload.unavailable === true;
    this.cpuUnavailable.set(unavailable);
    this.memoryUnavailable.set(unavailable);
    this.storageUnavailable.set(unavailable);
    this.batteryUnavailable.set(unavailable);
    if (payload.cpu) this.cpu.set(payload.cpu);
    if (payload.memory) this.memory.set(payload.memory);
    if (payload.gpu) this.gpu.set(payload.gpu);
    if (payload.npu) this.npu.set(payload.npu);
    if (payload.thermals) this.thermals.set(payload.thermals);
    if (payload.battery) this.battery.set(payload.battery);
    if (payload.network) this.network.set(payload.network);
    // Throughput arrives every tick; it is merged into the capacity figures the slow round
    // last published so the Disks rail stays live without re-reading how full the disk is.
    if (payload.diskIo) this.storage.update(current => current ? { ...current, ...payload.diskIo } : current);
    // The main process owns the window; this only appends what it was just handed.
    if (payload.sample) this.history.update(samples => [...samples, payload.sample!].slice(-61));
  }

  /** Capacity and the app lists, on their own ten-second beat. */
  private applySlow(slow: SlowMetrics): void {
    if (slow.storage) this.storage.set(slow.storage);
    const consumers = slow.consumers;
    if (!consumers) return;
    this.cpuConsumers.set(consumers.cpu);
    this.cpuBackground.set(consumers.cpuBackground);
    this.memoryConsumers.set(consumers.memory);
    this.memoryBackground.set(consumers.memoryBackground);
  }

  private async loadGpuInfo(): Promise<void> {
    if (!window.electronAPI) return;
    try {
      this.gpuInfo.set(await window.electronAPI.getGpuInfo());
    } catch (error) {
      console.error('Unable to read GPU information', error);
    }
  }

  private async loadCpuInfo(): Promise<void> {
    if (!window.electronAPI) return;
    try {
      this.cpuInfo.set(await window.electronAPI.getCpuInfo());
    } catch (error) {
      console.error('Unable to read CPU information', error);
    }
  }

  private async loadMemoryInfo(): Promise<void> {
    if (!window.electronAPI) return;
    try {
      this.memoryInfo.set(await window.electronAPI.getMemoryInfo());
    } catch (error) {
      console.error('Unable to read memory information', error);
    }
  }

}
