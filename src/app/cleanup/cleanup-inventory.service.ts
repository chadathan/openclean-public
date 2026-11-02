import { Injectable, computed, inject, signal } from '@angular/core';
import { RemovalsService } from '../removals.service';

export type CleanupSection = { key: string; label: string; blurb: string; categories: JunkCategory[] };

const SECTION_LABELS: Record<string, { label: string; blurb: string }> = {
  system: { label: 'System Junk', blurb: 'Files that are rebuilt, re-downloaded or simply left behind.' },
  xcode: { label: 'Xcode Junk', blurb: 'Build data and simulator files Xcode leaves behind.' },
  mail: { label: 'Mail Attachments', blurb: 'Attachments Mail has already downloaded and kept.' },
  trash: { label: 'Trash Bins', blurb: 'What is waiting in the Trash on every mounted volume.' }
};

const SECTION_ORDER = ['system', 'xcode', 'mail', 'trash'];

/**
 * The scan outlives the page, for the same reason the application one does: switching tabs
 * destroys the component, and a scan half-finished would be lost with it. Nothing starts on its
 * own — reading the disk costs twenty seconds, and a page that spends it the moment you glance
 * at it is spending it on your behalf without asking.
 */
@Injectable({ providedIn: 'root' })
export class CleanupInventoryService {
  private readonly categories = signal<Array<JunkCategory & { section: string }>>([]);

  readonly scanning = signal(false);
  readonly scanned = signal(0);
  readonly scanTotal = signal(0);
  readonly scanError = signal<string | null>(null);
  readonly hasScanned = signal(false);
  readonly scannedAt = signal<number | null>(null);

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
  readonly sectionKey = signal('system');
  readonly categoryKey = signal('');
  readonly selected = signal<ReadonlySet<string>>(new Set());
  readonly preset = signal<'smart' | 'none' | 'custom'>('none');
  readonly emptyingTrash = signal(false);

  readonly sections = computed<CleanupSection[]>(() => {
    const all = this.categories();
    return SECTION_ORDER
      .filter(key => all.some(category => category.section === key))
      .map(key => ({ key, ...SECTION_LABELS[key], categories: all.filter(category => category.section === key) }));
  });

  readonly section = computed<CleanupSection | null>(() =>
    this.sections().find(entry => entry.key === this.sectionKey()) ?? this.sections().at(0) ?? null);

  readonly category = computed<JunkCategory | null>(() => {
    const section = this.section();
    if (!section) return null;
    return section.categories.find(entry => entry.key === this.categoryKey()) ?? section.categories.at(0) ?? null;
  });

  private readonly lines = computed(() => this.categories().flatMap(category =>
    category.items.map(item => ({ id: item.id, label: `${category.label} · ${item.label}`, path: item.path, bytes: item.bytes }))));

  readonly selectedLines = computed(() => this.lines().filter(line => this.selected().has(line.id)));
  readonly selectedCount = computed(() => this.selectedLines().length);
  readonly selectedBytes = computed(() => this.selectedLines().reduce((sum, line) => sum + line.bytes, 0));

  /** What the whole scan found, and how much of it comes back on its own. */
  readonly foundBytes = computed(() => this.categories().reduce((sum, category) => sum + this.categoryBytes(category), 0));
  readonly safeBytesTotal = computed(() => this.categories().reduce((sum, category) => sum + this.safeBytes(category), 0));

  private readonly removals = inject(RemovalsService);

  constructor() {
    // Subscribed once, for the life of the window, so results still arrive while the page is closed.
    window.electronAPI?.onCleanupScan((channel, payload) => this.onScan(channel, payload));
  }

  async scan(): Promise<void> {
    if (!window.electronAPI || this.scanning()) return;
    this.categories.set([]);
    this.scanned.set(0);
    this.scanTotal.set(0);
    this.scanError.set(null);
    this.clearSelection();
    this.phase.set('browse');
    this.scanning.set(true);
    const result = await window.electronAPI.scanCleanup();
    if (!result.started) { this.scanning.set(false); this.scanError.set(result.reason ?? 'Could not start'); }
  }

  async cancel(): Promise<void> {
    await window.electronAPI?.cancelCleanupScan();
    this.scanning.set(false);
  }

  private onScan(channel: string, payload: any): void {
    if (channel === 'cleanup:scan-begin') { this.scanTotal.set(payload.total); return; }
    if (channel === 'cleanup:scan-category') {
      this.categories.set([...this.categories(), { section: payload.section, ...payload.category }]);
      this.scanned.set(payload.done);
      // The first category to arrive is what the page opens on, rather than an empty pane.
      if (!this.categoryKey()) this.categoryKey.set(payload.category.key);
      return;
    }
    if (channel === 'cleanup:scan-done') {
      this.scanning.set(false);
      this.hasScanned.set(true);
      this.scannedAt.set(Date.now());
      return;
    }
    if (channel === 'cleanup:scan-failed') { this.scanning.set(false); this.scanError.set(payload.reason ?? 'Scan failed'); }
  }

  async trashSelected(): Promise<void> {
    const selected = this.selectedLines();
    if (!selected.length || this.phase() === 'removing') return;
    const paths = selected.map(line => line.path);
    this.phase.set('removing');
    const animation = new Promise<void>(resolve => setTimeout(resolve, 1100));
    let result: Awaited<ReturnType<NonNullable<typeof window.electronAPI>['trashPaths']>> | undefined;
    try {
      // Keep the moving state visible long enough for the item-to-Trash animation to read.
      [result] = await Promise.all([
        window.electronAPI?.trashPaths(paths, this.category()?.label ?? 'Cleanup', 'cleanup'),
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
    const moved = new Set(result?.trashedPaths ?? []);
    if (moved.size) this.categories.update(categories => categories.map(category => ({ ...category, items: category.items.filter(item => !moved.has(item.id)) })));
    this.clearSelection();
    // The strip on the browse screen reads from disk, so it has to be told there is more.
    void this.removals.refresh();
    this.restoreResult.set(null);
    this.phase.set('done');
  }

  categoryBytes(category: JunkCategory): number { return category.items.reduce((sum, item) => sum + item.bytes, 0); }
  safeBytes(category: JunkCategory): number { return category.items.filter(item => item.safe).reduce((sum, item) => sum + item.bytes, 0); }

  selectSection(key: string): void {
    this.sectionKey.set(key);
    const section = this.sections().find(entry => entry.key === key);
    this.categoryKey.set(section?.categories[0]?.key ?? '');
  }

  toggleItem(item: JunkItem): void {
    const next = new Set(this.selected());
    next.has(item.id) ? next.delete(item.id) : next.add(item.id);
    this.selected.set(next);
    this.preset.set('custom');
  }

  /** Only what the machine puts back by itself. Nothing of the user's, nothing expensive to refetch. */
  selectSmartly(): void {
    this.selected.set(new Set(this.categories().flatMap(category => category.items.filter(item => item.safe).map(item => item.id))));
    this.preset.set('smart');
  }

  selectAllInCategory(): void {
    const category = this.category();
    if (!category) return;
    const next = new Set<string>();
    for (const item of category.items) if (item.offered !== false) next.add(item.id);
    this.selected.set(next);
    this.preset.set('custom');
  }

  async emptyTrash(paths: string[], all = false): Promise<{ deleted: number; failures: string[]; deletedPaths: string[]; cancelled?: boolean; freeBytesBefore?: number | null; freeBytesAfter?: number | null } | null> {
    const api = window.electronAPI;
    if (!api || !paths.length || this.emptyingTrash()) return null;
    this.emptyingTrash.set(true);
    try {
      const result = await api.emptyTrash(paths, all);
      const deleted = new Set(result.deletedPaths);
      if (deleted.size) {
        this.categories.update(categories => categories.map(category => {
          if (category.key !== 'trash') return category;
          const items = category.items.filter(item => !deleted.has(item.id));
          return { ...category, items, state: items.length ? 'found' : 'empty', status: items.length ? undefined : 'Trash is empty' };
        }));
        this.selected.update(selected => new Set([...selected].filter(id => !deleted.has(id))));
        void this.removals.refresh();
      }
      return result;
    } finally {
      this.emptyingTrash.set(false);
    }
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

  clearSelection(): void { this.selected.set(new Set()); this.preset.set('none'); }
  reset(): void { this.clearSelection(); this.phase.set('browse'); }
}
