import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSystemSummary: () => ipcRenderer.invoke('system:summary'),
  getCpuMetrics: () => ipcRenderer.invoke('system:cpu'),
  getNetworkMetrics: () => ipcRenderer.invoke('system:network'),
  getCpuInfo: () => ipcRenderer.invoke('system:cpu-info'),
  getMemoryMetrics: () => ipcRenderer.invoke('system:memory'),
  getMemoryInfo: () => ipcRenderer.invoke('system:memory-info'),
  getGpuMetrics: () => ipcRenderer.invoke('system:gpu'),
  getGpuInfo: () => ipcRenderer.invoke('system:gpu-info'),
  getNpuMetrics: () => ipcRenderer.invoke('system:npu'),
  getThermalMetrics: () => ipcRenderer.invoke('system:thermals'),
  runNpuSelfTest: () => ipcRenderer.invoke('system:npu-selftest'),
  getStorageMetrics: () => ipcRenderer.invoke('system:storage'),
  getBatteryMetrics: () => ipcRenderer.invoke('system:battery'),
  openPrivacySettings: () => ipcRenderer.invoke('system:open-privacy-settings'),
  openLoginItemsSettings: () => ipcRenderer.invoke('system:open-login-items-settings'),
  checkFullDiskAccess: () => ipcRenderer.invoke('system:check-full-disk-access'),
  chooseFolder: () => ipcRenderer.invoke('system:choose-folder')
  ,showMainWindow: () => ipcRenderer.invoke('window:show-main')
  ,hideMenuBar: () => ipcRenderer.invoke('window:hide-menu-bar')
  ,isMenuBarVisible: () => ipcRenderer.invoke('window:is-menu-bar-visible')
  ,getConsumers: () => ipcRenderer.invoke('system:consumers')
  ,getProcessActivity: () => ipcRenderer.invoke('system:process-activity')
  ,stopProcessActivity: () => ipcRenderer.invoke('system:stop-process-activity')
  ,subscribeMetrics: () => ipcRenderer.invoke('metrics:subscribe')
  ,unsubscribeMetrics: () => ipcRenderer.invoke('metrics:unsubscribe')
  ,getMetricsSnapshot: () => ipcRenderer.invoke('metrics:snapshot')
  ,getBackgroundMonitoring: () => ipcRenderer.invoke('metrics:get-background-monitoring')
  ,setBackgroundMonitoring: (enabled: boolean) => ipcRenderer.invoke('metrics:set-background-monitoring', enabled)
  ,getLowStorageAlert: () => ipcRenderer.invoke('metrics:get-low-storage-alert')
  ,setLowStorageAlert: (request: { enabled: boolean; thresholdBytes: number }) => ipcRenderer.invoke('metrics:set-low-storage-alert', request)
  ,onMetricsSample: (callback: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on('metrics:sample', listener);
    return () => ipcRenderer.removeListener('metrics:sample', listener);
  }
  ,onMetricsSlow: (callback: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on('metrics:slow', listener);
    return () => ipcRenderer.removeListener('metrics:slow', listener);
  }
  ,scanCleanup: () => ipcRenderer.invoke('cleanup:scan')
  ,cancelCleanupScan: () => ipcRenderer.invoke('cleanup:cancel-scan')
  ,emptyTrash: (paths: string[], all?: boolean) => ipcRenderer.invoke('cleanup:empty-trash', paths, all)
  ,onCleanupScan: (callback: (event: string, payload: unknown) => void) => {
    const channels = ['cleanup:scan-begin', 'cleanup:scan-category', 'cleanup:scan-done', 'cleanup:scan-failed'];
    const listeners = channels.map(channel => {
      const listener = (_event: unknown, payload: unknown) => callback(channel, payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => listeners.forEach(off => off());
  }
  ,scanApplications: () => ipcRenderer.invoke('apps:scan')
  ,scanDeveloperTools: () => ipcRenderer.invoke('developer-tools:scan')
  ,scanFiles: (path?: string, scanId?: string) => ipcRenderer.invoke('files:scan', path, scanId)
  ,queryFileInventory: (request: { page: number; pageSize: number; query: string; kind: string; minimum: number }) => ipcRenderer.invoke('files:page', request)
  ,queryFolderMap: (path: string) => ipcRenderer.invoke('files:folders', path)
  ,removeFromFileInventory: (paths: string[]) => ipcRenderer.invoke('files:remove-from-inventory', paths)
  ,findFileDuplicates: (root: string) => ipcRenderer.invoke('files:duplicates', root)
  ,listFileVolumes: () => ipcRenderer.invoke('files:volumes')
  ,cancelFileScan: () => ipcRenderer.invoke('files:cancel')
  ,revealFile: (path: string) => ipcRenderer.invoke('files:reveal', path)
  ,onFileScan: (callback: (event: string, payload: unknown) => void) => {
    const channels = ['files:batch', 'files:progress', 'files:done', 'files:failed', 'files:duplicates-progress'];
    const listeners = channels.map(channel => { const listener = (_event: unknown, payload: unknown) => callback(channel, payload); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); });
    return () => listeners.forEach(off => off());
  }
  ,uninstallDeveloperTools: (requests: { manager: string; name: string }[]) => ipcRenderer.invoke('developer-tools:uninstall', requests)
  ,cancelApplicationScan: () => ipcRenderer.invoke('apps:cancel-scan')
  ,trashPaths: (paths: string[], label?: string, source?: string) => ipcRenderer.invoke('apps:trash', paths, label, source)
  ,listRemovals: () => ipcRenderer.invoke('removals:list')
  ,restoreRemoval: (id: string) => ipcRenderer.invoke('removals:restore', id)
  ,revealPath: (path: string) => ipcRenderer.invoke('apps:reveal', path)
  ,onApplicationScan: (callback: (event: string, payload: unknown) => void) => {
    const channels = ['apps:scan-begin', 'apps:scan-app', 'apps:scan-done', 'apps:scan-failed'];
    const listeners = channels.map(channel => {
      const listener = (_event: unknown, payload: unknown) => callback(channel, payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => listeners.forEach(off => off());
  }
  ,quitProcess: (pid: number) => ipcRenderer.invoke('system:quit-process', pid)
  ,openDetail: (metric: string) => ipcRenderer.invoke('window:open-detail', metric)
  ,closeDetail: () => ipcRenderer.invoke('window:close-detail')
  ,fitDetail: (height: number) => ipcRenderer.invoke('window:fit-detail', height)
  ,onDetailMetricChanged: (callback: (metric: string) => void) => {
    const listener = (_event: unknown, metric: string) => callback(metric);
    ipcRenderer.on('detail:metric', listener);
    return () => ipcRenderer.removeListener('detail:metric', listener);
  }
  ,onMenuBarVisibilityChanged: (callback: (visible: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
    ipcRenderer.on('menu-bar:visibility', listener);
    return () => ipcRenderer.removeListener('menu-bar:visibility', listener);
  }
});
