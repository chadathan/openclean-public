import { Injectable, computed, signal } from '@angular/core';

export type FileEntry = { name: string; path: string; bytes: number; extension: string; modifiedAt: number; removable: boolean };
export type FileVolume = { name: string; path: string };
export type DuplicateGroup = { bytes: number; files: Array<FileEntry & { selected: boolean }> };
export type FolderMapEntry = { name: string; path: string; bytes: number; isDirectory: boolean; removable: boolean };

@Injectable({ providedIn: 'root' })
export class FileInventoryService {
  readonly files = signal<FileEntry[]>([]);
  readonly matchingCount = signal(0);
  readonly totalFiles = signal(0);
  readonly totalBytes = signal(0);
  readonly largestName = signal('');
  readonly largestBytes = signal(0);
  readonly volumes = signal<FileVolume[]>([]);
  readonly ordered = computed(() => this.files());
  readonly target = signal('__home__');
  readonly root = signal('');
  readonly scanning = signal(false);
  readonly stopping = signal(false);
  readonly scanned = signal(false);
  readonly partial = signal(false);
  readonly skipped = signal(0);
  readonly directories = signal(0);
  readonly error = signal('');
  readonly lastRemovalId = signal<string | null>(null);
  readonly duplicateGroups = signal<DuplicateGroup[]>([]);
  readonly duplicateScanning = signal(false);
  readonly duplicatesSearched = signal(false);
  readonly duplicateProgress = signal({ completed: 0, total: 0 });
  readonly folderMapEntries = signal<FolderMapEntry[]>([]);
  readonly folderMapLoading = signal(false);
  readonly folderMapError = signal('');
  readonly folderMapTruncated = signal(false);
  private scanId = '';
  private pageRequestId = 0;
  private lastRefresh = 0;
  private pageFilters = { page: 0, pageSize: 100, query: '', kind: 'all', minimum: 0 };

  constructor() {
    void this.loadVolumes();
    window.electronAPI?.onFileScan((event, payload) => {
      if (event === 'files:duplicates-progress') { this.duplicateProgress.set(payload); return; }
      if (payload.scanId !== this.scanId) return;
      if (event === 'files:progress' || event === 'files:done') {
        this.root.set(payload.root);
        this.skipped.set(payload.skipped);
        this.directories.set(payload.directories);
        this.totalFiles.set(payload.files); this.totalBytes.set(payload.bytes);
        if (Date.now() - this.lastRefresh > 1200 || event === 'files:done') void this.refreshPage();
      }
      if (event === 'files:done') {
        this.scanning.set(false);
        this.stopping.set(false);
        this.scanned.set(true);
        this.partial.set(payload.cancelled);
      }
      if (event === 'files:failed') {
        this.error.set(payload.reason);
        this.scanning.set(false);
        this.stopping.set(false);
        this.partial.set(true);
      }
    });
  }

  async loadVolumes(): Promise<void> {
    try { this.volumes.set(await window.electronAPI?.listFileVolumes() ?? []); }
    catch { this.volumes.set([]); }
  }

  async scan(): Promise<void> {
    if (this.scanning()) return;
    if (!window.electronAPI) { this.error.set('Open this page in the desktop app to scan files.'); return; }
    this.files.set([]); this.matchingCount.set(0); this.totalFiles.set(0); this.totalBytes.set(0); this.largestName.set(''); this.largestBytes.set(0); this.duplicateGroups.set([]); this.duplicatesSearched.set(false); this.folderMapEntries.set([]); this.folderMapError.set(''); this.error.set(''); this.root.set(''); this.skipped.set(0); this.directories.set(0);
    this.scanned.set(false); this.partial.set(false); this.scanning.set(true); this.stopping.set(false);
    this.scanId = crypto.randomUUID();
    try {
      const result = await window.electronAPI.scanFiles(this.target() || undefined, this.scanId);
      if (result.root) this.root.set(result.root);
      if (!result.started) { this.error.set(result.error ?? 'Could not start the scan.'); this.scanning.set(false); }
    } catch { this.error.set('Could not reach the file scanner.'); this.scanning.set(false); }
  }

  async refreshPage(filters?: Partial<typeof this.pageFilters>): Promise<void> {
    if (!window.electronAPI) return;
    this.pageFilters = { ...this.pageFilters, ...filters };
    const requestId = ++this.pageRequestId; this.lastRefresh = Date.now();
    try {
      const result = await window.electronAPI.queryFileInventory(this.pageFilters);
      if (requestId !== this.pageRequestId) return;
      this.files.set(result.entries); this.matchingCount.set(result.count);
      this.totalFiles.set(result.totalFiles); this.totalBytes.set(result.totalBytes);
      this.largestName.set(result.largestName ?? ''); this.largestBytes.set(result.largestBytes ?? 0);
    } catch { this.error.set('Could not load file results.'); }
  }

  async stop(): Promise<void> {
    if (!this.scanning() || this.stopping()) return;
    this.stopping.set(true);
    try { await window.electronAPI?.cancelFileScan(); }
    catch { this.stopping.set(false); this.error.set('Could not stop the scan.'); }
  }

  async findDuplicates(): Promise<void> {
    if (!this.scanned() || this.partial() || this.duplicateScanning() || !this.root()) return;
    this.duplicateScanning.set(true); this.duplicateGroups.set([]); this.duplicateProgress.set({ completed: 0, total: 0 }); this.error.set('');
    try {
      const result = await window.electronAPI?.findFileDuplicates(this.root());
      if (!result || result.error) { this.error.set(result?.error || 'Could not compare files.'); return; }
      this.duplicateGroups.set(result.groups.map(group => ({ ...group, files: group.files.map(file => ({ ...file, bytes: group.bytes, extension: file.name.split('.').pop()?.toLowerCase() ?? '', modifiedAt: 0, selected: false })) })));
      this.duplicatesSearched.set(true);
    } catch { this.error.set('Could not compare files.'); }
    finally { this.duplicateScanning.set(false); }
  }

  async loadFolderMap(path: string): Promise<void> {
    if (!window.electronAPI || !this.scanned() || this.partial()) return;
    this.folderMapLoading.set(true);
    this.folderMapError.set('');
    try {
      const result = await window.electronAPI.queryFolderMap(path);
      this.folderMapEntries.set(result.entries);
      this.folderMapTruncated.set(result.truncated);
      this.folderMapError.set(result.error);
    } catch {
      this.folderMapError.set('Could not load this folder.');
    } finally {
      this.folderMapLoading.set(false);
    }
  }
}
