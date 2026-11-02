interface LogicalCpuMetric {
  index: number;
  usagePercent: number;
  userPercent: number;
  systemPercent: number;
}
interface CpuMetrics {
  usagePercent: number;
  availablePercent: number;
  userPercent: number;
  systemPercent: number;
  threads: number;
  processes: number;
  logicalCores: number;
  model: string;
  temperatureC: number | null;
  uptimeSeconds: number;
  sampledAt: number;
  logical: LogicalCpuMetric[];
}

interface CpuInfo {
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
}

interface MetricsSample {
  cpu: CpuMetrics; memory: MemoryMetrics; gpu: GpuMetrics; npu: NpuMetrics;
  thermals: ThermalMetrics; battery: BatteryMetrics; network: NetworkMetrics;
  /** Throughput only; how full the disks are arrives on the slow round. */
  diskIo: Partial<StorageMetrics>;
  /** Null when the round failed; the panels keep their last values. */
  sample: MetricSampleRow | null;
  unavailable: boolean;
}

interface SlowMetrics {
  storage: StorageMetrics | null;
  consumers: Consumers;
}

interface MetricsSnapshot extends Partial<MetricsSample> {
  storage: StorageMetrics | null;
  history: MetricSampleRow[];
  consumers: Consumers;
  unavailable: boolean;
}

interface MetricSampleRow {
  cpuUsage: number; cpuAvailable: number; cpuUser: number; cpuSystem: number;
  memoryPressure: number; memoryApp: number; memoryWired: number; memoryCompressed: number;
  gpuUsage: number; gpuRenderer: number; gpuTiler: number;
  npuWatts: number;
  cpuC: number; socC: number; batteryC: number;
  batteryPercent: number; batteryWatts: number; packageWatts: number;
  logicalCores: number[];
  networkDownload: number; networkUpload: number;
  diskRead: number; diskWrite: number;
}

interface Consumers {
  cpu: TopProcess[];
  cpuBackground: number | null;
  memory: TopProcess[];
  memoryBackground: number | null;
}

interface TopProcess {
  pid: number;
  /** Every process the row stands for, so a quit can reach an app's helpers too. */
  pids: number[];
  name: string;
  icon: string | null;
  cpuPercent: number;
  memoryBytes: number;
}

interface ActivityProcess extends TopProcess {
  kind: 'app' | 'background';
  status: string;
  diskBytesPerSecond: number | null;
  networkBytesPerSecond: number | null;
  children: ActivityProcessChild[];
}

interface ActivityProcessChild {
  pid: number;
  name: string;
  status: string;
  cpuPercent: number;
  memoryBytes: number;
  diskBytesPerSecond: number | null;
  networkBytesPerSecond: number | null;
}

interface MemoryMetrics {
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  appBytes: number;
  activeBytes: number;
  wiredBytes: number;
  compressedBytes: number;
  cachedBytes: number;
  purgeableBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  pressurePercent: number;
  sampledAt: number;
}

interface MemoryInfo {
  totalBytes: number;
  pageSizeBytes: number | null;
  type: string | null;
  manufacturer: string | null;
  speed: string | null;
  formFactor: string | null;
  slotsUsed: number | null;
  slotsTotal: number | null;
  upgradeable: boolean;
}

interface GpuMetrics {
  usagePercent: number | null;
  rendererPercent: number | null;
  tilerPercent: number | null;
  inUseBytes: number | null;
  allocatedBytes: number | null;
  parameterBufferBytes: number | null;
  recoveryCount: number | null;
  temperatureC: number | null;
  watts: number | null;
  sampledAt: number;
}

interface GpuDisplay {
  name: string;
  resolution: string | null;
  type: string | null;
  main: boolean;
}

interface GpuInfo {
  model: string | null;
  cores: number | null;
  vendor: string | null;
  bus: string | null;
  metal: string | null;
  displays: GpuDisplay[];
}

interface NpuMetrics {
  watts: number | null;
  temperatureC: number | null;
  active: boolean;
  available: boolean;
  sampledAt: number;
}

interface ThermalMetrics {
  cpuC: number | null;
  gpuC: number | null;
  aneC: number | null;
  socC: number | null;
  batteryC: number | null;
  hottestName: string | null;
  hottestC: number | null;
  readableSensors: number;
  thermalState: string | null;
  fans: number | null;
  cpuWatts: number | null;
  gpuWatts: number | null;
  aneWatts: number | null;
  packageWatts: number | null;
  sampledAt: number;
}

interface StorageVolume {
  name: string;
  mountPoint: string;
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
  fileSystem: string | null;
  health: string | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  trashBytes: number | null;
}

interface DiskVolume {
  name: string;
  role: string | null;
  usedBytes: number;
}

interface DiskCategory {
  key: string;
  label: string;
  usedBytes: number;
}

interface Disk {
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
  temperatureC: number | null;
  volumes: DiskVolume[];
  categories: DiskCategory[];
  mounted: boolean;
}

interface StorageMetrics {
  /** One entry per APFS container or standalone filesystem, startup disk first. */
  disks: Disk[];
  volumeName: string;
  /** Whole-machine disk throughput: the counters live on the hardware, not on a volume. */
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  readBytes: number | null;
  writtenBytes: number | null;
  readOpsPerSecond: number | null;
  writeOpsPerSecond: number | null;
  /** Average time one operation took over the sampling window, not since boot. */
  readLatencyMs: number | null;
  writeLatencyMs: number | null;
  hardware: {
    model: string | null;
    protocol: string | null;
    location: string | null;
    solidState: boolean | null;
    smartStatus: string | null;
    /** What the maker counts. Always larger than the usable container. */
    physicalBytes: number | null;
  };
  snapshots: number | null;
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  trashBytes: number | null;
  usedPercent: number;
  volumes: StorageVolume[];
  sampledAt: number;
}

interface BatteryMetrics {
  percent: number;
  state: string;
  timeRemaining: string | null;
  cycleCount: number | null;
  health: string | null;
  temperatureC: number | null;
  chargeMah: number | null;
  maxChargeMah: number | null;
  designMah: number | null;
  nominalMah: number | null;
  volts: number | null;
  milliamps: number | null;
  /** Pack voltage times instantaneous current: the real draw, or the charge rate. */
  watts: number | null;
  externalConnected: boolean;
  isCharging: boolean;
  adapterWatts: number | null;
  adapterVolts: number | null;
  sampledAt: number;
}

interface NetworkMetrics {
  interfaceName: string;
  connectionType: string;
  address: string | null;
  ipv6Address: string | null;
  /** Null when macOS withholds the name: it reveals it only to apps holding Location Services. */
  ssid: string | null;
  signalStrength: string | null;
  linkSpeed: string | null;
  channel: string | null;
  phyMode: string | null;
  security: string | null;
  receivedBytes: number;
  sentBytes: number;
  downloadBytesPerSecond: number;
  uploadBytesPerSecond: number;
  packetsIn: number;
  packetsOut: number;
  sampledAt: number;
}


type AppSliceKind = 'binary' | 'support' | 'cache' | 'container' | 'preference' | 'log';

interface AppSlice {
  label: string;
  path: string;
  bytes: number;
  /** What is actually lost, in the user's terms. Absent where the contents are not known. */
  impact?: string;
  /** False for a row that is reported but cannot be removed from here. */
  offered?: boolean;
}

interface AppGroup {
  kind: AppSliceKind;
  items: AppSlice[];
}

interface InstalledApp {
  id: string;
  name: string;
  path: string;
  icon: string | null;
  version: string | null;
  vendor: string;
  store: 'App Store' | 'Other';
  /** Days since Spotlight last saw it opened; null when Spotlight has no record. */
  daysIdle: number | null;
  groups: AppGroup[];
}

interface LooseFile {
  id: string;
  label: string;
  path: string;
  bytes: number;
}

type ToolManager = 'brew' | 'brew-cask' | 'npm' | 'pip';

interface DeveloperTool {
  name: string;
  version: string | null;
  source: string;
  /** What the package itself occupies. Null where it cannot be measured — a linked package, a runtime. */
  bytes: number | null;
  path: string | null;
  /** Null means nothing here can remove it. */
  manager: ToolManager | null;
  /** Installed packages that name this one as a dependency. */
  requiredBy: string[];
  /** Why it cannot be removed. */
  protection: string | null;
  note: string | null;
}
interface DeveloperToolGroup { label: string; detail: string; bytes: number; items: DeveloperTool[]; }
interface DeveloperToolsReport { groups: DeveloperToolGroup[]; scannedAt: number; }

interface UninstallOutcome { name: string; manager: ToolManager; removed: boolean; message: string; reinstall: string | null; }
interface UninstallReport { outcomes: UninstallOutcome[]; removed: number; bytes: number; }

type JunkState = 'found' | 'empty' | 'locked' | 'refused';

interface JunkItem {
  id: string;
  label: string;
  path: string;
  bytes: number;
  icon?: string | null;
  note?: string;
  /** True only where the machine puts it back by itself. */
  safe?: boolean;
  flag?: string;
  /** False for a row that is reported but cannot be removed from here. */
  offered?: boolean;
}

interface JunkFact {
  label: string;
  value: string;
  detail?: string;
}

interface JunkCategory {
  key: string;
  label: string;
  blurb: string;
  state: JunkState;
  status?: string;
  reason?: string;
  facts?: JunkFact[];
  items: JunkItem[];
}

interface RemovalEntry {
  originalPath: string;
  trashPath: string | null;
  label: string;
  bytes: number;
  /** Still in the Trash; false once it has been emptied. */
  available?: boolean;
  /** This entry has already been restored, while other entries in its receipt may remain. */
  restoredAt?: number;
}

type RemovalSource = 'applications' | 'cleanup' | 'files';

interface Removal {
  id: string;
  /** Which page made it; each page's Put back shows only its own. */
  source: RemovalSource;
  label: string;
  removedAt: number;
  bytes: number;
  entries: RemovalEntry[];
  restoredAt: number | null;
}

interface Window {
  electronAPI?: {
    getSystemSummary(): Promise<{ platform: string; model: string; available: boolean }>;
    getCpuMetrics(): Promise<CpuMetrics>;
    getCpuInfo(): Promise<CpuInfo>;
    getMemoryMetrics(): Promise<MemoryMetrics>;
    getMemoryInfo(): Promise<MemoryInfo>;
    getGpuMetrics(): Promise<GpuMetrics>;
    getGpuInfo(): Promise<GpuInfo>;
    getNpuMetrics(): Promise<NpuMetrics>;
    getThermalMetrics(): Promise<ThermalMetrics>;
    runNpuSelfTest(): Promise<{ started: boolean; endsAt: number }>;
    getStorageMetrics(): Promise<StorageMetrics>;
    getBatteryMetrics(): Promise<BatteryMetrics>;
    getNetworkMetrics(): Promise<NetworkMetrics>;
    openPrivacySettings(): Promise<{ opened: boolean }>;
    openLoginItemsSettings(): Promise<{ opened: boolean }>;
    checkFullDiskAccess(): Promise<{ granted: boolean }>;
    chooseFolder(): Promise<{ granted: boolean; path: string | null }>;
    showMainWindow(): Promise<{ opened: boolean }>;
    hideMenuBar(): Promise<{ hidden: boolean }>;
    isMenuBarVisible(): Promise<{ visible: boolean }>;
    getConsumers(): Promise<Consumers>;
    getProcessActivity(): Promise<ActivityProcess[]>;
    stopProcessActivity(): Promise<{ stopped: boolean }>;
    subscribeMetrics(): Promise<{ subscribed: boolean }>;
    unsubscribeMetrics(): Promise<{ subscribed: boolean }>;
    getMetricsSnapshot(): Promise<MetricsSnapshot>;
    getBackgroundMonitoring(): Promise<{ enabled: boolean }>;
    setBackgroundMonitoring(enabled: boolean): Promise<{ enabled: boolean }>;
    getAnalytics(): Promise<{ enabled: boolean; available: boolean }>;
    setAnalytics(enabled: boolean): Promise<{ enabled: boolean; available: boolean }>;
    trackScreen(screen: string): void;
    getLowStorageAlert(): Promise<{ enabled: boolean; thresholdBytes: number; supported: boolean }>;
    setLowStorageAlert(request: { enabled: boolean; thresholdBytes: number }): Promise<{ enabled: boolean; thresholdBytes: number; supported: boolean }>;
    onMetricsSample(callback: (payload: MetricsSample) => void): () => void;
    onMetricsSlow(callback: (payload: SlowMetrics) => void): () => void;
    scanCleanup(): Promise<{ started: boolean; reason?: string }>;
    cancelCleanupScan(): Promise<{ cancelled: boolean }>;
    emptyTrash(paths: string[], all?: boolean): Promise<{ deleted: number; failures: string[]; deletedPaths: string[]; cancelled?: boolean; freeBytesBefore?: number | null; freeBytesAfter?: number | null }>;
    onCleanupScan(callback: (event: string, payload: any) => void): () => void;
    scanApplications(): Promise<{ started: boolean; reason?: string }>;
    scanDeveloperTools(): Promise<DeveloperToolsReport>;
    scanFiles(path?: string, scanId?: string): Promise<{ started: boolean; root?: string; error?: string }>;
    queryFileInventory(request: { page: number; pageSize: number; query: string; kind: string; minimum: number }): Promise<{ entries: Array<{ name: string; path: string; bytes: number; extension: string; modifiedAt: number; removable: boolean }>; count: number; page: number; pageSize: number; totalFiles: number; totalBytes: number; largestName: string | null; largestBytes: number | null }>;
    queryFolderMap(path: string): Promise<{ entries: Array<{ name: string; path: string; bytes: number; isDirectory: boolean; removable: boolean }>; root: string; truncated: boolean; error: string }>;
    removeFromFileInventory(paths: string[]): Promise<{ removed: number }>;
    findFileDuplicates(root: string): Promise<{ groups: Array<{ bytes: number; files: Array<{ path: string; name: string; removable: boolean }> }>; error: string }>;
    listFileVolumes(): Promise<Array<{ name: string; path: string }>>;
    cancelFileScan(): Promise<{ cancelled: boolean }>;
    revealFile(path: string): Promise<{ revealed: boolean }>;
    onFileScan(callback: (event: string, payload: any) => void): () => void;
    /** Removal goes through each package manager, so there is no Put Back — the report carries the command that reinstalls each one. */
    uninstallDeveloperTools(requests: { manager: ToolManager; name: string }[]): Promise<UninstallReport>;
    cancelApplicationScan(): Promise<{ cancelled: boolean }>;
    /** `label` names the group on its receipt, so the whole removal can be put back later. */
    trashPaths(paths: string[], label?: string, source?: RemovalSource): Promise<{ trashed: number; bytes: number; failures: string[]; removalId: string | null; trashedPaths: string[] }>;
    listRemovals(): Promise<Removal[]>;
    restoreRemoval(id: string): Promise<{ restored: number; failures: string[] }>;
    revealPath(path: string): Promise<{ revealed: boolean }>;
    /** One subscription for the whole scan; the channel name says which stage arrived. */
    onApplicationScan(callback: (event: string, payload: any) => void): () => void;
    quitProcess(pid: number): Promise<{ quit: boolean; reason?: string }>;
    openDetail(metric: string): Promise<{ opened: boolean }>;
    closeDetail(): Promise<{ closed: boolean }>;
    fitDetail(height: number): Promise<{ fitted: boolean }>;
    onDetailMetricChanged(callback: (metric: string) => void): () => void;
    onMenuBarVisibilityChanged(callback: (visible: boolean) => void): () => void;
  };
}
