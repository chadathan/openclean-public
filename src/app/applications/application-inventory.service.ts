import { Injectable, computed, inject, signal } from '@angular/core';
import { RemovalsService } from '../removals.service';

/**
 * The scan outlives the page.
 *
 * Switching tabs destroys the Applications component — the shell renders one tab at a time —
 * so anything held in the component is thrown away and a scan in progress would appear to have
 * been abandoned. All of it lives here instead, in a service the injector keeps for the life of
 * the window: the scan keeps running while you are somewhere else, and coming back shows the
 * progress it reached, or the results, or the selection you had already ticked.
 *
 * Nothing starts on its own. Reading 49 apps costs twenty seconds of disk, and a page that
 * spends it the moment you glance at it is spending it on your behalf without asking.
 */
@Injectable({ providedIn: 'root' })
export class ApplicationInventoryService {
  readonly apps = signal<InstalledApp[]>([]);
  readonly leftoverFiles = signal<LooseFile[]>([]);
  readonly installers = signal<LooseFile[]>([]);
  readonly developerTools = signal<DeveloperToolsReport | null>(null);
  readonly toolsScanning = signal(false);
  readonly toolsError = signal<string | null>(null);
  /** Which package source the rail is showing; null means the first one. */
  readonly toolGroup = signal<string | null>(null);
  /** Keyed manager|name, the same key the main process refuses anything it does not recognise. */
  readonly toolSelection = signal<Set<string>>(new Set());
  readonly toolPhase = signal<'browse' | 'review' | 'done'>('browse');
  readonly uninstalling = signal(false);
  readonly uninstallReport = signal<UninstallReport | null>(null);
  readonly selectedTools = computed(() => {
    const picked = this.toolSelection();
    return (this.developerTools()?.groups ?? [])
      .flatMap(group => group.items)
      .filter(item => item.manager && picked.has(toolKey(item)));
  });
  readonly selectedToolBytes = computed(() => this.selectedTools().reduce((total, item) => total + (item.bytes ?? 0), 0));

  readonly scanning = signal(false);
  readonly scanned = signal(0);
  readonly scanTotal = signal(0);
  readonly scanError = signal<string | null>(null);
  /** False until a scan has finished at least once, which is what tells the page to stop offering the invitation. */
  readonly hasScanned = signal(false);
  readonly scannedAt = signal<number | null>(null);

  /** What the last removal actually freed, as the main process reported it. */
  readonly freedBytes = signal(0);
  readonly freedCount = signal(0);
  readonly failures = signal<string[]>([]);
  /**
   * Finder cannot put these back: its Put Back reads an origin only Finder records, and
   * shell.trashItem writes none. So the receipt for the last removal is kept here, and putting
   * it back is this app's job.
   */
  readonly removalId = signal<string | null>(null);
  readonly restoreResult = signal<{ restored: number; failures: string[] } | null>(null);
  readonly restoring = signal(false);

  readonly phase = signal<'browse' | 'review' | 'removing' | 'done'>('browse');
  readonly mode = signal<Mode>('uninstaller');
  readonly filter = signal<Filter>({ kind: 'all' });
  readonly sort = signal<Sort>('footprint');
  readonly search = signal('');
  readonly open = signal<ReadonlySet<string>>(new Set());
  readonly openGroups = signal<ReadonlySet<string>>(new Set());
  readonly selected = signal<ReadonlySet<string>>(new Set());

  readonly installed = computed(() => this.apps().length);
  readonly installerBytes = computed(() => this.installers().reduce((sum, item) => sum + item.bytes, 0));
  readonly leftoverBytes = computed(() => this.leftoverFiles().reduce((sum, item) => sum + item.bytes, 0));
  readonly unusedCount = computed(() => this.apps().filter(app => app.daysIdle !== null && app.daysIdle >= IDLE_DAYS).length);

  readonly stores = computed(() => ['App Store', 'Other'].map(label => ({ label, count: this.apps().filter(app => app.store === label).length })));

  /** Vendors with a single app are noise in a filter list, so the rail keeps the ones worth filtering by. */
  readonly vendors = computed(() => {
    const counts = new Map<string, number>();
    for (const app of this.apps()) counts.set(app.vendor, (counts.get(app.vendor) ?? 0) + 1);
    return [...counts].map(([label, count]) => ({ label, count })).filter(entry => entry.count > 1).sort((a, b) => b.count - a.count);
  });

  private readonly largest = computed(() => Math.max(1, ...this.apps().map(app => this.total(app))));

  private readonly lines = computed(() => [
    ...this.apps().flatMap(app => app.groups.flatMap(group => group.items.filter(item => item.offered !== false).map(item =>
      ({ id: this.key(app, item), label: `${app.name} · ${item.label}`, path: item.path, bytes: item.bytes })))),
    ...[...this.installers(), ...this.leftoverFiles()].map(item => ({ id: this.looseKey(item), label: item.label, path: item.path, bytes: item.bytes }))
  ]);

  readonly selectedLines = computed(() => this.lines().filter(line => this.selected().has(line.id)));
  readonly selectedCount = computed(() => this.selectedLines().length);
  readonly selectedBytes = computed(() => this.selectedLines().reduce((sum, line) => sum + line.bytes, 0));
  readonly selectedApps = computed(() => this.apps().filter(app => this.appPartly(app) || this.appTicked(app)));

  readonly visible = computed(() => {
    const active = this.filter();
    const query = this.search().trim().toLocaleLowerCase();
    const matches = (app: InstalledApp) =>
      (query.length === 0 || `${app.name} ${app.vendor} ${app.id}`.toLocaleLowerCase().includes(query)) &&
      (active.kind === 'all' ? true
      : active.kind === 'unused' ? app.daysIdle !== null && app.daysIdle >= IDLE_DAYS
      : active.kind === 'selected' ? this.appTicked(app) || this.appPartly(app)
      : active.kind === 'store' ? app.store === active.value
      : app.vendor === active.value);
    const order = this.sort();
    // An app Spotlight has no record of sorts last under "least used" rather than first: a
    // missing date is not evidence of disuse.
    const idle = (app: InstalledApp) => app.daysIdle ?? -1;
    return this.apps().filter(matches).sort((a, b) =>
      order === 'name' ? a.name.localeCompare(b.name)
      : order === 'idle' ? idle(b) - idle(a)
      : this.total(b) - this.total(a));
  });

  private readonly removals = inject(RemovalsService);

  constructor() {
    // Subscribed once, for the life of the window, so results still arrive while the page is
    // closed. Never torn down: the only reader is this service, and it outlives every view.
    window.electronAPI?.onApplicationScan((channel, payload) => this.onScan(channel, payload));
  }

  async scan(): Promise<void> {
    if (!window.electronAPI || this.scanning()) return;
    this.apps.set([]);
    this.leftoverFiles.set([]);
    this.installers.set([]);
    this.scanned.set(0);
    this.scanTotal.set(0);
    this.scanError.set(null);
    this.clearSelection();
    this.clearToolSelection();
    this.toolPhase.set('browse');
    this.uninstallReport.set(null);
    this.open.set(new Set());
    this.openGroups.set(new Set());
    this.phase.set('browse');
    this.scanning.set(true);
    // The command-line inventory costs about a second against the application pass's twenty,
    // and both answer the same question, so one button asks for both.
    void this.scanDeveloperTools();
    const result = await window.electronAPI.scanApplications();
    if (!result.started) { this.scanning.set(false); this.scanError.set(result.reason ?? 'Could not start'); }
  }

  async cancel(): Promise<void> {
    await window.electronAPI?.cancelApplicationScan();
    this.scanning.set(false);
  }

  async scanDeveloperTools(): Promise<void> {
    if (!window.electronAPI || this.toolsScanning()) return;
    this.toolsScanning.set(true);
    this.toolsError.set(null);
    try { this.developerTools.set(await window.electronAPI.scanDeveloperTools()); }
    catch { this.toolsError.set('Could not read the developer tools installed on this Mac.'); }
    finally { this.toolsScanning.set(false); }
  }

  toggleTool(item: DeveloperTool): void {
    if (!item.manager || item.protection) return;
    const next = new Set(this.toolSelection());
    next.has(toolKey(item)) ? next.delete(toolKey(item)) : next.add(toolKey(item));
    this.toolSelection.set(next);
  }

  clearToolSelection(): void { this.toolSelection.set(new Set()); }

  reviewTools(): void { if (this.selectedTools().length) this.toolPhase.set('review'); }
  backToTools(): void { this.toolPhase.set('browse'); }

  /**
   * These do not go to the Trash, so there is no receipt and no Put Back. What comes back instead
   * is the command that reinstalls each one, which is the only honest undo a package manager offers.
   */
  async uninstallSelectedTools(): Promise<void> {
    const picked = this.selectedTools();
    if (!window.electronAPI || !picked.length || this.uninstalling()) return;
    this.uninstalling.set(true);
    try {
      const report = await window.electronAPI.uninstallDeveloperTools(
        picked.map(item => ({ manager: item.manager!, name: item.name })));
      this.uninstallReport.set(report);
      this.toolPhase.set('done');
      this.clearToolSelection();
      // The list on screen still shows what was just removed; only a fresh read can say otherwise.
      await this.scanDeveloperTools();
    } catch {
      this.toolsError.set('The uninstall could not be started.');
    } finally {
      this.uninstalling.set(false);
    }
  }

  private onScan(channel: string, payload: any): void {
    if (channel === 'apps:scan-begin') { this.scanTotal.set(payload.total); return; }
    if (channel === 'apps:scan-app') {
      this.apps.set([...this.apps(), payload.app as InstalledApp]);
      this.scanned.set(payload.done);
      return;
    }
    if (channel === 'apps:scan-done') {
      this.leftoverFiles.set(payload.leftovers ?? []);
      this.installers.set(payload.installers ?? []);
      this.scanning.set(false);
      this.hasScanned.set(true);
      this.scannedAt.set(Date.now());
      return;
    }
    if (channel === 'apps:scan-failed') { this.scanning.set(false); this.scanError.set(payload.reason ?? 'Scan failed'); }
  }

  async trashSelected(): Promise<void> {
    const selected = this.selectedLines();
    if (!selected.length || this.phase() === 'removing') return;
    const paths = selected.map(line => line.path);
    this.phase.set('removing');
    const animation = new Promise<void>(resolve => setTimeout(resolve, 1100));
    let result: Awaited<ReturnType<NonNullable<typeof window.electronAPI>['trashPaths']>> | undefined;
    try {
      [result] = await Promise.all([
        window.electronAPI?.trashPaths(paths, this.selectedApps().map(app => app.name).join(', ') || 'Applications', 'applications'),
        animation
      ]);
    } catch (error) {
      await animation;
      result = { trashed: 0, bytes: 0, failures: [error instanceof Error ? error.message : 'Could not move selected items to the Trash'], removalId: null, trashedPaths: [] };
    }
    this.freedBytes.set(result?.bytes ?? 0);
    this.freedCount.set(result?.trashed ?? 0);
    this.failures.set(result?.failures ?? ['Could not reach the system file service.']);
    this.removalId.set(result?.removalId ?? null);
    // The strip on the browse screen reads from disk, so it has to be told there is more.
    void this.removals.refresh();
    this.restoreResult.set(null);
    this.clearSelection();
    this.phase.set('done');
  }

  total(app: InstalledApp): number { return app.groups.reduce((sum, group) => sum + this.groupBytes(group), 0); }
  groupBytes(group: AppGroup): number { return group.items.reduce((sum, item) => sum + item.bytes, 0); }
  bundleOf(app: InstalledApp): number { return app.groups.filter(group => group.kind === 'binary').reduce((sum, group) => sum + this.groupBytes(group), 0); }
  share(bytes: number): number { return (bytes / this.largest()) * 100; }
  key(app: InstalledApp, item: AppSlice): string { return `${app.id}:${item.path}`; }
  looseKey(item: LooseFile): string { return `loose:${item.path}`; }
  groupKey(app: InstalledApp, group: AppGroup): string { return `${app.id}:${group.kind}`; }

  appTicked(app: InstalledApp): boolean {
    const items = app.groups.flatMap(group => group.items.filter(item => item.offered !== false));
    return items.length > 0 && items.every(item => this.selected().has(this.key(app, item)));
  }
  appPartly(app: InstalledApp): boolean { return !this.appTicked(app) && app.groups.some(group => this.groupTicked(app, group) || this.groupPartly(app, group)); }
  groupSelectable(group: AppGroup): boolean { return group.items.some(item => item.offered !== false); }
  appSelectable(app: InstalledApp): boolean { return app.groups.some(group => this.groupSelectable(group)); }
  groupTicked(app: InstalledApp, group: AppGroup): boolean {
    const items = group.items.filter(item => item.offered !== false);
    return items.length > 0 && items.every(item => this.selected().has(this.key(app, item)));
  }
  groupPartly(app: InstalledApp, group: AppGroup): boolean {
    return !this.groupTicked(app, group) && group.items.some(item => item.offered !== false && this.selected().has(this.key(app, item)));
  }

  private toggleIn(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  }

  toggleOpen(id: string): void {
    const next = this.toggleIn(this.open(), id);
    this.open.set(next);
    if (next.has(id)) {
      const app = this.apps().find(candidate => candidate.id === id);
      if (app) this.openGroups.set(new Set([...this.openGroups(), ...app.groups.map(group => this.groupKey(app, group))]));
    }
  }

  toggleGroupOpen(app: InstalledApp, group: AppGroup): void { this.openGroups.set(this.toggleIn(this.openGroups(), this.groupKey(app, group))); }
  toggleItem(app: InstalledApp, item: AppSlice): void { this.selected.set(this.toggleIn(this.selected(), this.key(app, item))); }
  toggleLoose(item: LooseFile): void { this.selected.set(this.toggleIn(this.selected(), this.looseKey(item))); }

  toggleGroup(app: InstalledApp, group: AppGroup): void {
    const next = new Set(this.selected());
    const on = this.groupTicked(app, group);
    for (const item of group.items) {
      if (item.offered === false) continue;
      on ? next.delete(this.key(app, item)) : next.add(this.key(app, item));
    }
    this.selected.set(next);
  }

  toggleApp(app: InstalledApp): void {
    const next = new Set(this.selected());
    const on = this.appTicked(app);
    for (const group of app.groups) for (const item of group.items) {
      if (item.offered === false) continue;
      on ? next.delete(this.key(app, item)) : next.add(this.key(app, item));
    }
    this.selected.set(next);
  }

  async putBack(): Promise<void> {
    const id = this.removalId();
    if (!id || this.restoring()) return;
    this.restoring.set(true);
    const result = await window.electronAPI?.restoreRemoval(id);
    this.restoreResult.set(result ?? { restored: 0, failures: ['Could not reach the main process'] });
    this.restoring.set(false);
    if (result?.restored) this.removalId.set(null);
  }

  clearSelection(): void { this.selected.set(new Set()); }
  reset(): void { this.clearSelection(); this.phase.set('browse'); }
}

/** Not opened in this long counts as unused. Age is the only claim; an app used twice a year is not clutter. */
export const IDLE_DAYS = 30;

export const toolKey = (item: DeveloperTool): string => `${item.manager}|${item.name}`;

export type Mode = 'uninstaller' | 'leftovers' | 'tools' | 'putback' | 'startup';
export type Sort = 'footprint' | 'idle' | 'name';
/**
 * Each kind is its own member so narrowing on `kind` reaches `value`; grouping the three
 * valueless kinds into one member leaves the union undiscriminated.
 */
export type Filter =
  | { kind: 'all' } | { kind: 'unused' } | { kind: 'selected' }
  | { kind: 'store'; value: string } | { kind: 'vendor'; value: string };
