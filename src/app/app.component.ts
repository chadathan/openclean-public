import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal } from '@angular/core';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { faBatteryHalf, faBolt, faBrain, faBroom, faChartLine, faFolderOpen, faGear, faGlobe, faHardDrive, faHouse, faListUl, faMemory, faMicrochip, faShieldHalved, faTableCells, faTemperatureHalf } from '@fortawesome/free-solid-svg-icons';
import { formatBinaryBytes } from './dashboard/metric-format';
import { CpuViewComponent } from './dashboard/cpu-view.component';
import { GpuViewComponent } from './dashboard/gpu-view.component';
import { NpuViewComponent } from './dashboard/npu-view.component';
import { ThermalsViewComponent } from './dashboard/thermals-view.component';
import { MemoryViewComponent } from './dashboard/memory-view.component';
import { EnergyViewComponent } from './dashboard/energy-view.component';
import { NetworkViewComponent } from './dashboard/network-view.component';
import { StorageViewComponent } from './dashboard/storage-view.component';
import { MetricChartComponent } from './dashboard/metric-chart.component';
import { MonitorCardComponent } from './dashboard/monitor-card.component';
import { MonitorCard } from './dashboard/models/monitor-card.model';
import { SystemMonitorService } from './dashboard/system-monitor.service';
import { PrivacyComponent as PermissionCenterComponent } from './privacy/privacy.component';
import { CleanupComponent } from './cleanup/cleanup.component';
import { ApplicationsComponent } from './applications/applications.component';
import { FileManagerComponent } from './files/file-manager.component';
import { MenuBarPopoverComponent } from './menu-bar-popover.component';
import { ProcessManagerComponent } from './processes/process-manager.component';

type GraphMetric = 'cpu' | 'memory' | 'gpu' | 'npu' | 'disks' | 'network' | 'energy' | 'thermals';

// The view toggles are a per-machine preference, so they ride in localStorage rather than
// anywhere the main process would have to persist. Storage can throw in a locked-down
// profile, so neither direction is allowed to take the dashboard down with it.
const STORAGE_PREFIX = 'openclean.';

function readStored<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(STORAGE_PREFIX + key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch {
    // A preference that cannot be saved is not worth interrupting the dashboard for.
  }
}

@Component({
  selector: 'app-root', standalone: true,
  imports: [CpuViewComponent, GpuViewComponent, NpuViewComponent, ThermalsViewComponent, MemoryViewComponent, EnergyViewComponent, NetworkViewComponent, StorageViewComponent, MetricChartComponent, MonitorCardComponent, PermissionCenterComponent, CleanupComponent, ApplicationsComponent, FileManagerComponent, MenuBarPopoverComponent, ProcessManagerComponent, FontAwesomeModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (menuBarMode) { <oc-menu-bar-popover /> } @else {
    <div class="window-drag-region" aria-hidden="true"></div>
    <main class="shell">
      <aside class="sidebar"><div class="brand"><span class="brand-mark"><img src="assets/brand/openclean-mark.png" alt="" /></span><span>OpenClean</span></div>
        <nav><a [class.active]="activeTab() === 'overview'" (click)="setTab('overview')"><span><fa-icon [icon]="faHouse" /></span>Overview</a><a [class.active]="activeTab() === 'processes'" (click)="setTab('processes')"><span><fa-icon [icon]="faListUl" /></span>Processes</a><a [class.active]="activeTab() === 'cleanup'" (click)="setTab('cleanup')"><span><fa-icon [icon]="faBroom" /></span>Cleanup</a><a [class.active]="activeTab() === 'applications'" (click)="setTab('applications')"><span><fa-icon [icon]="faTableCells" /></span>Applications</a><a [class.active]="activeTab() === 'files'" (click)="setTab('files')"><span><fa-icon [icon]="faFolderOpen" /></span>File Manager</a><a [class.active]="activeTab() === 'privacy'" (click)="setTab('privacy')"><span><fa-icon [icon]="faShieldHalved" /></span>Privacy</a></nav>
        <div class="sidebar-bottom"><a [class.active]="activeTab() === 'settings'" (click)="setTab('settings')"><span><fa-icon [icon]="faGear" /></span>Settings</a></div>
      </aside>
      <section class="content">
        @if (activeTab() === 'privacy') { <oc-privacy /> } @else if (activeTab() === 'processes') { <oc-process-manager /> } @else if (activeTab() === 'cleanup') { <oc-cleanup (openPrivacy)="setTab('privacy')" /> } @else if (activeTab() === 'applications') { <oc-applications /> } @else if (activeTab() === 'files') { <oc-file-manager /> } @else if (activeTab() === 'settings') {
          <section class="settings-page">
            <header class="settings-heading"><p class="eyebrow">PREFERENCES</p><h1>Settings</h1><p class="muted">Manage system monitoring preferences.</p></header>
            <section class="settings-group"><h3 class="settings-group-title">Monitoring &amp; alerts</h3>
              <div class="settings-row"><div class="settings-icon tone-violet"><fa-icon [icon]="faChartLine" /></div><div class="settings-copy"><h2>Background monitoring</h2><p>Keep collecting system data while the dashboard and popover are closed.</p><small class="settings-status" [class.on]="backgroundMonitoring()"><i></i>{{ backgroundMonitoring() ? 'Monitoring stays active in the menu bar.' : 'Monitoring runs only while a monitor view is open.' }}</small></div><button class="switch" type="button" role="switch" aria-label="Background monitoring" [attr.aria-checked]="backgroundMonitoring()" [attr.aria-busy]="backgroundSettingSaving()" [disabled]="!electronAvailable || !backgroundSettingReady() || backgroundSettingSaving()" (click)="toggleBackgroundMonitoring()"><span></span></button></div>
              <div class="settings-row"><div class="settings-icon tone-teal"><fa-icon [icon]="faHardDrive" /></div><div class="settings-copy"><h2>Low storage alert</h2><p>Get a macOS notification when the startup disk runs low. OpenClean never deletes files automatically.</p>
                  <div class="threshold" [class.dimmed]="!lowStorageAlertEnabled()"><span id="threshold-label">Alert below</span><div class="segmented" role="radiogroup" aria-labelledby="threshold-label">@for (gb of thresholdOptions; track gb) { <button type="button" role="radio" [attr.aria-checked]="lowStorageThresholdGb() === gb" [disabled]="!electronAvailable || !lowStorageAlertReady() || lowStorageAlertSaving() || !lowStorageAlertSupported()" (click)="setLowStorageThreshold(gb)">{{ gb }} GB</button> }</div></div>
                  <small class="settings-status" [class.on]="lowStorageAlertEnabled() && lowStorageAlertSupported()"><i></i>{{ !lowStorageAlertSupported() ? 'System notifications are unavailable on this Mac.' : lowStorageAlertEnabled() ? 'Notifies when free space drops below ' + lowStorageThresholdGb() + ' GB, and again after it recovers.' : 'Alert is off.' }}</small></div><button class="switch" type="button" role="switch" aria-label="Low storage alert" [attr.aria-checked]="lowStorageAlertEnabled()" [attr.aria-busy]="lowStorageAlertSaving()" [disabled]="!electronAvailable || !lowStorageAlertReady() || lowStorageAlertSaving() || !lowStorageAlertSupported()" (click)="toggleLowStorageAlert()"><span></span></button></div>
            </section>
          </section>
        } @else {
        <div class="section-heading"><h2>Monitor</h2><div class="section-actions">@if (viewMode() === 'graph' && selectedMetric() === 'cpu') { <button class="view-mode-button logical-cpu-button" type="button" (click)="toggleLogicalCpu()"><fa-icon [icon]="faMicrochip" />{{ logicalCpuVisible() ? 'Hide logical CPU' : 'View logical CPU' }}</button> }<button class="view-mode-button" type="button" (click)="toggleViewMode()"><fa-icon [icon]="viewMode() === 'cards' ? faChartLine : faTableCells" />{{ viewMode() === 'cards' ? 'View graph' : 'View cards' }}</button></div></div>
        @if (viewMode() === 'cards') { <section class="grid" aria-label="Mac monitor status">@for (card of cards(); track card.title) {<oc-monitor-card [card]="card" (actionClicked)="onCardAction($event)" />}</section> }
        @else { <section class="graph-layout" aria-label="Mac monitor graphs"><aside class="graph-nav"><div class="performance-title"><fa-icon [icon]="faChartLine" />Performance</div><div class="graph-nav-item" [class.selected]="selectedMetric() === 'cpu'" (click)="selectMetric('cpu')"><fa-icon [icon]="faMicrochip" /><span>CPU<small>{{ monitor.cpu()?.usagePercent ?? '—' }}% · {{ monitor.cpu()?.logicalCores ?? '—' }} logical processors</small></span></div><div class="graph-nav-item" [class.selected]="selectedMetric() === 'memory'" (click)="selectMetric('memory')"><fa-icon [icon]="faMemory" /><span>Memory<small>{{ monitor.memory() ? formatBytes(monitor.memory()!.usedBytes) : '—' }} / {{ monitor.memory() ? formatBytes(monitor.memory()!.totalBytes) : '—' }} · {{ monitor.memory()?.pressurePercent ?? '—' }}%</small></span></div><div class="graph-nav-item" [class.selected]="selectedMetric() === 'gpu'" (click)="selectMetric('gpu')"><fa-icon [icon]="faMicrochip" /><span>GPU<small>{{ monitor.gpuInfo()?.model ?? '—' }} · {{ monitor.gpu()?.usagePercent ?? '—' }}%</small></span></div><div class="graph-nav-item" [class.selected]="selectedMetric() === 'npu'" (click)="selectMetric('npu')"><fa-icon [icon]="faBrain" /><span>NPU<small>Apple Neural Engine · {{ npuSummary() }}</small></span></div><div class="graph-nav-item" [class.selected]="selectedMetric() === 'disks'" (click)="selectMetric('disks')"><fa-icon [icon]="faHardDrive" /><span>Disks<small>{{ storage?.usedPercent ?? '—' }}% used</small></span></div><div class="graph-nav-item" [class.selected]="selectedMetric() === 'network'" (click)="selectMetric('network')"><fa-icon [icon]="faGlobe" /><span>Network<small>Interfaces combined</small></span></div><div class="graph-nav-item" [class.selected]="selectedMetric() === 'energy'" (click)="selectMetric('energy')"><fa-icon [icon]="faBolt" /><span>Battery<small>{{ energyNavDetail() }}</small></span></div><div class="graph-nav-item" [class.selected]="selectedMetric() === 'thermals'" (click)="selectMetric('thermals')"><fa-icon [icon]="faTemperatureHalf" /><span>Thermals<small>{{ monitor.thermals()?.cpuC ?? '—' }}°C CPU · {{ monitor.thermals()?.socC ?? '—' }}°C SoC</small></span></div></aside><article class="graph-card"><div class="graph-card-heading"><div><p class="graph-label">LIVE PERFORMANCE</p><h3>{{ graphTitle() }}</h3><span class="graph-subtitle">{{ graphDetail() }}</span></div></div><div class="graph-legend"><span><i class="legend-memory"></i>{{ graphTitle() }} <strong>{{ graphValue() }}</strong></span><span class="graph-live"><i></i> Live · 1s</span></div>@if (selectedMetric() === 'cpu') {<oc-cpu-view [showLogicalCores]="logicalCpuVisible()" />} @else if (selectedMetric() === 'memory') {<oc-memory-view />} @else if (selectedMetric() === 'gpu') {<oc-gpu-view />} @else if (selectedMetric() === 'npu') {<oc-npu-view />} @else if (selectedMetric() === 'thermals') {<oc-thermals-view />} @else if (selectedMetric() === 'energy') {<oc-energy-view />} @else if (selectedMetric() === 'network') {<oc-network-view />} @else if (selectedMetric() === 'disks') {<oc-storage-view />} @else {<oc-metric-chart [label]="graphTitle()" [series]="chartSeries()" [rail]="railFacts()" />}<div class="graph-axis"><span>Now</span><span>−15s</span><span>−30s</span><span>−45s</span><span>−60s</span></div></article></section> }
        }
      </section>
    </main> }
  `
})
export class AppComponent {
  readonly menuBarMode = typeof window !== 'undefined' && window.location.search.includes('menubar=1');
  readonly faHouse = faHouse;
  readonly faBroom = faBroom;
  readonly faTableCells = faTableCells;
  readonly faChartLine = faChartLine;
  readonly faMicrochip = faMicrochip;
  readonly faMemory = faMemory;
  readonly faHardDrive = faHardDrive;
  readonly faBrain = faBrain;
  readonly faGlobe = faGlobe;
  readonly faBolt = faBolt;
  readonly faTemperatureHalf = faTemperatureHalf;
  readonly faShieldHalved = faShieldHalved;
  readonly faFolderOpen = faFolderOpen;
  readonly faGear = faGear;
  readonly faListUl = faListUl;
  readonly activeTab = signal<'overview' | 'processes' | 'cleanup' | 'applications' | 'files' | 'privacy' | 'settings'>('overview');
  readonly viewMode = signal<'cards' | 'graph'>(readStored('viewMode', 'cards'));
  readonly selectedMetric = signal<GraphMetric>(readStored<GraphMetric>('metric', 'cpu'));
  readonly logicalCpuVisible = signal(readStored<string>('logicalCpu', 'off') === 'on');
  readonly monitor = inject(SystemMonitorService);
  readonly backgroundMonitoring = signal(false);
  readonly backgroundSettingReady = signal(false);
  readonly backgroundSettingSaving = signal(false);
  readonly lowStorageAlertEnabled = signal(false);
  readonly lowStorageThresholdGb = signal(20);
  readonly thresholdOptions = [5, 10, 20, 50] as const;
  readonly lowStorageAlertSupported = signal(true);
  readonly lowStorageAlertReady = signal(false);
  readonly lowStorageAlertSaving = signal(false);
  readonly electronAvailable = typeof window !== 'undefined' && Boolean(window.electronAPI);
  private windowFocused = typeof document === 'undefined' || document.hasFocus();
  readonly formatBytes = formatBytes;
  get storageUnavailable(): boolean { return this.monitor.storageUnavailable(); }
  get storage() { return this.monitor.storage(); }

  constructor() {
    this.syncMonitoring();
    void this.loadBackgroundMonitoring();
    void this.loadLowStorageAlert();
  }

  @HostListener('document:visibilitychange')
  onVisibilityChange(): void { this.syncMonitoring(); }

  @HostListener('window:blur')
  onWindowBlur(): void { this.windowFocused = false; this.syncMonitoring(); }

  @HostListener('window:focus')
  onWindowFocus(): void { this.windowFocused = true; this.syncMonitoring(); }

  private syncMonitoring(): void {
    if (this.menuBarMode) return;
    // Background mode keeps the dashboard subscribed while it is hidden or another app is
    // focused. The main process can keep sampling without subscribers, but it only broadcasts
    // live updates to subscribed windows.
    if (this.activeTab() === 'overview' && (this.backgroundMonitoring() || (!document.hidden && this.windowFocused))) this.monitor.startPolling();
    else this.monitor.stopPolling();
  }

  private async loadBackgroundMonitoring(): Promise<void> {
    try {
      const result = await window.electronAPI?.getBackgroundMonitoring();
      if (result) { this.backgroundMonitoring.set(result.enabled); this.syncMonitoring(); }
    } catch (error) { console.error('Unable to load background monitoring preference', error); }
    finally { this.backgroundSettingReady.set(true); }
  }

  async toggleBackgroundMonitoring(): Promise<void> {
    if (this.backgroundSettingSaving() || !this.backgroundSettingReady()) return;
    const previous = this.backgroundMonitoring();
    const next = !previous;
    this.backgroundMonitoring.set(next);
    this.syncMonitoring();
    this.backgroundSettingSaving.set(true);
    try {
      const result = await window.electronAPI?.setBackgroundMonitoring(next);
      if (!result) throw new Error('Background monitoring is unavailable');
      this.backgroundMonitoring.set(result.enabled);
      this.syncMonitoring();
    } catch (error) {
      this.backgroundMonitoring.set(previous);
      this.syncMonitoring();
      console.error('Unable to save background monitoring preference', error);
    } finally { this.backgroundSettingSaving.set(false); }
  }

  private async loadLowStorageAlert(): Promise<void> {
    try {
      const result = await window.electronAPI?.getLowStorageAlert();
      if (result) {
        this.lowStorageAlertEnabled.set(result.enabled);
        this.lowStorageThresholdGb.set(Math.round(result.thresholdBytes / 1024 ** 3));
        this.lowStorageAlertSupported.set(result.supported);
      }
    } catch (error) { console.error('Unable to load low storage alert preference', error); }
    finally { this.lowStorageAlertReady.set(true); }
  }

  toggleLowStorageAlert(): void { void this.saveLowStorageAlert(!this.lowStorageAlertEnabled(), this.lowStorageThresholdGb()); }
  setLowStorageThreshold(value: number): void { void this.saveLowStorageAlert(this.lowStorageAlertEnabled(), value); }

  private async saveLowStorageAlert(enabled: boolean, thresholdGb: number): Promise<void> {
    if (!this.lowStorageAlertReady() || this.lowStorageAlertSaving()) return;
    const previousEnabled = this.lowStorageAlertEnabled();
    const previousThreshold = this.lowStorageThresholdGb();
    this.lowStorageAlertEnabled.set(enabled);
    this.lowStorageThresholdGb.set(thresholdGb);
    this.lowStorageAlertSaving.set(true);
    try {
      const result = await window.electronAPI?.setLowStorageAlert({ enabled, thresholdBytes: thresholdGb * 1024 ** 3 });
      if (!result) throw new Error('Low storage alerts are unavailable');
      this.lowStorageAlertEnabled.set(result.enabled);
      this.lowStorageThresholdGb.set(Math.round(result.thresholdBytes / 1024 ** 3));
      this.lowStorageAlertSupported.set(result.supported);
    } catch (error) {
      this.lowStorageAlertEnabled.set(previousEnabled);
      this.lowStorageThresholdGb.set(previousThreshold);
      console.error('Unable to save low storage alert preference', error);
    } finally { this.lowStorageAlertSaving.set(false); }
  }

  /** A watt reading the hardware did not report is blank, not a zero. */
  private readonly watts = (value: number | null | undefined): string => value == null ? '—' : `${value.toFixed(2)} W`;

  /** What the wattage beside the charge actually measures. */
  private readonly powerLabel = (battery: BatteryMetrics): string => battery.externalConnected ? 'Chips' : 'Draw';


  readonly cards = computed<MonitorCard[]>(() => {
    const cpu = this.monitor.cpu();
    const cpuUnavailable = this.monitor.cpuUnavailable();
    const memory = this.monitor.memory();
    const memoryUnavailable = this.monitor.memoryUnavailable();
    const storage = this.monitor.storage();
    const storageUnavailable = this.monitor.storageUnavailable();
    const battery = this.monitor.battery();
    const batteryUnavailable = this.monitor.batteryUnavailable();
    const gpu = this.monitor.gpu();
    const gpuInfo = this.monitor.gpuInfo();
    const npu = this.monitor.npu();
    const network = this.monitor.network();
    const thermals = this.monitor.thermals();

    return [
      {
        icon: faMicrochip,
        title: 'CPU',
        value: cpuUnavailable ? 'Unavailable' : cpu ? `${cpu.usagePercent}%` : 'Reading…',
        detail: cpu ? cpu.model : 'Waiting for system data',
        temperature: cpu ? { value: cpu.temperatureC === null ? 'Temperature unavailable' : `${cpu.temperatureC}°C`, status: cpu.temperatureC !== null && cpu.temperatureC >= 70 ? 'danger' : cpu.temperatureC !== null && cpu.temperatureC >= 60 ? 'warning' : undefined } : undefined,
        breakdown: cpu ? [{ label: 'Available', value: `${cpu.availablePercent}%` }, { label: 'User', value: `${cpu.userPercent}%` }, { label: 'System', value: `${cpu.systemPercent}%` }] : undefined,
        tone: 'orange',
        status: cpu && cpu.usagePercent > 80 ? 'danger' : cpu && cpu.usagePercent > 65 ? 'warning' : undefined
      },
      { icon: faMemory, title: 'Memory', value: memoryUnavailable ? 'Unavailable' : memory ? `${memory.pressurePercent}%` : 'Reading…', detail: memory ? `${formatBytes(memory.availableBytes)} of ${formatBytes(memory.totalBytes)} available` : 'Waiting for system data', breakdown: memory ? [{ label: 'App', value: formatBinaryBytes(memory.appBytes) ?? '—' }, { label: 'Wired', value: formatBinaryBytes(memory.wiredBytes) ?? '—' }, { label: 'Compressed', value: formatBinaryBytes(memory.compressedBytes) ?? '—' }] : undefined, tone: 'blue', status: memory && memory.pressurePercent > 80 ? 'danger' : memory && memory.pressurePercent > 65 ? 'warning' : undefined },
      { icon: faHardDrive, title: 'Storage', value: storageUnavailable ? 'Unavailable' : storage ? `${storage.usedPercent}%` : 'Reading…', detail: storage ? `${formatStorageBytes(storage.availableBytes)} available · ${storage.volumeName}` : 'Waiting for system data', breakdown: storage ? [{ label: 'Used', value: formatStorageBytes(storage.usedBytes) }, { label: 'Free', value: formatStorageBytes(storage.availableBytes) }, { label: 'Total', value: formatStorageBytes(storage.totalBytes) }] : undefined, tone: 'purple', status: storage && storage.usedPercent > 80 ? 'danger' : storage && storage.usedPercent > 65 ? 'warning' : undefined },
      { icon: faBatteryHalf, title: 'Battery', value: batteryUnavailable ? 'Unavailable' : battery ? `${battery.percent}%` : 'Reading…', detail: battery ? `${battery.state === 'discharging' ? 'Discharging' : battery.state === 'charging' ? 'Charging' : battery.state} · ${battery.timeRemaining ? `${battery.timeRemaining} remaining` : 'Time unavailable'}` : 'Waiting for system data', temperature: battery ? { value: battery.temperatureC === null ? 'Temperature unavailable' : `${battery.temperatureC}°C`, status: battery.temperatureC !== null && battery.temperatureC >= 70 ? 'danger' : battery.temperatureC !== null && battery.temperatureC >= 60 ? 'warning' : undefined } : undefined, charging: battery?.isCharging || battery?.state === 'charging', breakdown: battery ? [{ label: 'Cycles', value: battery.cycleCount === null ? '—' : `${battery.cycleCount}` }, { label: 'Health', value: battery.health ?? '—' }, { label: this.powerLabel(battery), value: this.watts(thermals?.packageWatts) }] : undefined, tone: 'green', status: battery && battery.percent < 20 ? 'danger' : battery && battery.percent < 35 ? 'warning' : undefined },
      ...this.performanceCards()
    ];
  });

  readonly performanceCards = computed<MonitorCard[]>(() => {
    const gpu = this.monitor.gpu();
    const gpuInfo = this.monitor.gpuInfo();
    const npu = this.monitor.npu();
    const network = this.monitor.network();
    const battery = this.monitor.battery();
    const thermals = this.monitor.thermals();
    return [
      { icon: faMicrochip, title: 'GPU', value: gpu ? (gpu.usagePercent === null ? 'Unavailable' : `${gpu.usagePercent}%`) : 'Reading…', detail: gpuInfo ? `${gpuInfo.model ?? 'Apple GPU'} · ${gpuInfo.cores ?? '—'} cores` : 'Waiting for system data', temperature: gpu?.temperatureC == null ? undefined : { value: `${gpu.temperatureC}°C` }, breakdown: gpu ? [{ label: 'Renderer', value: gpu.rendererPercent == null ? '—' : `${gpu.rendererPercent}%` }, { label: 'Tiler', value: gpu.tilerPercent == null ? '—' : `${gpu.tilerPercent}%` }] : undefined, tone: 'orange' },
      { icon: faBrain, title: 'NPU', value: npu?.available ? (npu.active ? 'Active' : 'Idle') : 'Unavailable', detail: npu?.available ? `${npu.watts?.toFixed(2) ?? '—'} W · Apple Neural Engine` : 'No live reading', tone: 'pink' },
      { icon: faGlobe, title: 'Network', value: network ? formatRate(network.downloadBytesPerSecond) : 'Reading…', detail: network ? `${network.interfaceName} · ${network.address ?? 'No address'}` : 'Waiting for network data', breakdown: network ? [{ label: 'Upload', value: formatRate(network.uploadBytesPerSecond) }, { label: 'Received', value: formatStorageBytes(network.receivedBytes) }, { label: 'Sent', value: formatStorageBytes(network.sentBytes) }] : undefined, tone: 'teal' },
      { icon: faTemperatureHalf, title: 'Thermals', value: thermals ? `${thermals.cpuC ?? '—'}°C` : 'Reading…', detail: thermals ? `${thermals.socC ?? '—'}°C SoC` : 'Waiting for thermal data', breakdown: thermals ? [{ label: 'Battery', value: thermals.batteryC == null ? '—' : `${thermals.batteryC}°C` }, { label: 'State', value: thermals.thermalState ?? '—' }] : undefined, tone: 'pink' }
    ];
  });

  // Windows reports current speed, base speed and handle counts; macOS implements none of
  // them, and Apple Silicon has no L3. Rows without a value are dropped rather than shown
  // blank, so this list is shorter on some Macs than on others.

  // Windows lists paged and non-paged pool, hardware reserved and a DIMM clock. macOS has
  // no equivalent of the first three, and a soldered package reports no clock, slot list or
  // form factor — Intel Macs do, and those rows appear there.

  // What the plot draws, and what the rail beside it lists. Both key off the same series
  // name, so a colour cannot end up on the wrong row.
  // Metrics without a view of their own fall back to a single flat series.
  readonly chartSeries = computed(() => [{ key: 'metric', points: this.graphPoints() }]);

  readonly railFacts = computed(() => [{ key: 'usage', label: 'Usage', value: this.graphValue() }]);

  onCardAction(card: MonitorCard): void { console.info(`Dashboard action: ${card.action} (${card.title})`); }
  setTab(tab: 'overview' | 'processes' | 'cleanup' | 'applications' | 'files' | 'privacy' | 'settings'): void {
    this.activeTab.set(tab);
    this.syncMonitoring();
  }
  toggleViewMode(): void { this.viewMode.update(mode => mode === 'cards' ? 'graph' : 'cards'); writeStored('viewMode', this.viewMode()); }
  /**
   * Energy is about where the watts are going; Battery is about the pack. They were printing
   * the same charge percentage, state and cycle count as each other, so one card said nothing
   * the other had not already said.
   */
  readonly energyNavDetail = computed(() => {
    const battery = this.monitor.battery();
    const thermals = this.monitor.thermals();
    const charge = battery ? `${battery.percent}%` : '—';
    return thermals?.packageWatts == null ? charge : `${charge} · ${thermals.packageWatts.toFixed(2)} W`;
  });

  selectMetric(metric: GraphMetric): void { this.selectedMetric.set(metric); writeStored('metric', metric); }
  toggleLogicalCpu(): void { this.logicalCpuVisible.update(visible => !visible); writeStored('logicalCpu', this.logicalCpuVisible() ? 'on' : 'off'); }
  readonly npuSummary = computed(() => {
    const npu = this.monitor.npu();
    if (!npu?.available) return 'no reading';
    return `${npu.active ? 'active' : 'idle'} · ${npu.watts?.toFixed(2) ?? '—'} W`;
  });
  readonly graphTitle = computed(() => ({ cpu: 'CPU', memory: 'Memory', gpu: 'GPU', npu: 'NPU', disks: 'Disks', network: 'Network', energy: 'Battery', thermals: 'Thermals' }[this.selectedMetric()]));
  readonly graphValue = computed(() => { const metric = this.selectedMetric(); const cpu = this.monitor.cpu(); const memory = this.monitor.memory(); const storage = this.monitor.storage(); const battery = this.monitor.battery(); if (metric === 'cpu') return cpu ? `${cpu.usagePercent}%` : '—'; if (metric === 'memory') return memory ? `${memory.pressurePercent}%` : '—'; if (metric === 'disks') return storage ? `${storage.usedPercent}%` : '—'; if (metric === 'energy') return battery ? `${battery.percent}%` : '—'; if (metric === 'network') { const network = this.monitor.network(); return network ? `${formatBinaryBytes(network.downloadBytesPerSecond) ?? '0 KB'}/s` : '—'; } if (metric === 'thermals') return cpu?.temperatureC === null || cpu?.temperatureC === undefined ? '—' : `${cpu.temperatureC}°C`; return 'Unavailable'; });
  readonly graphDetail = computed(() => { const metric = this.selectedMetric(); const cpu = this.monitor.cpu(); const memory = this.monitor.memory(); const storage = this.monitor.storage(); const battery = this.monitor.battery(); if (metric === 'cpu') return cpu ? `${cpu.model} · ${cpu.logicalCores} logical processors` : 'Waiting for system data'; if (metric === 'memory') return memory ? `${formatBytes(memory.totalBytes)} total memory` : 'Waiting for system data'; if (metric === 'npu') return 'Apple Neural Engine · power only'; if (metric === 'network') { const network = this.monitor.network(); return network ? `${network.interfaceName} · ${network.address ?? 'No address'}` : 'Waiting for network data'; } if (metric === 'thermals') { const t = this.monitor.thermals(); return t ? `${t.readableSensors} readable sensors · ${t.fans === 0 ? 'fanless' : `${t.fans} fans`}` : 'Waiting for system data'; } if (metric === 'gpu') { const info = this.monitor.gpuInfo(); return info?.model ? `${info.model}${info.cores ? ` · ${info.cores} cores` : ''} · integrated` : 'Waiting for system data'; } if (metric === 'disks') return storage?.volumeName ?? 'Waiting for system data'; if (metric === 'energy') return battery ? `${battery.percent}% · ${battery.isCharging ? 'charging' : battery.externalConnected ? 'on power' : 'on battery'}${battery.cycleCount === null ? '' : ` · ${battery.cycleCount} cycles`}` : 'Waiting for system data';  return 'No live data source yet'; });
  readonly graphPoints = computed(() => {
    const metric = this.selectedMetric();
    const value = metric === 'disks' ? this.monitor.storage()?.usedPercent
      : metric === 'energy' ? this.monitor.battery()?.percent
      : metric === 'thermals' ? this.monitor.cpu()?.temperatureC
      : null;
    return value === null || value === undefined ? '' : this.flatGraphPoints(value);
  });
  flatGraphPoints(value: number): string { return Array.from({ length: 24 }, (_, index) => `${index * 600 / 23},${190 - (value / 100) * 190}`).join(' '); }
}

function formatBytes(bytes: number): string {
  const gigabytes = bytes / (1024 ** 3);
  return `${gigabytes.toFixed(1)} GB`;
}

function formatStorageBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBinaryBytes(bytesPerSecond) ?? '0 KB'}/s`;
}
