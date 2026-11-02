import { Injectable, computed, signal } from '@angular/core';

/**
 * Every removal this app has made and not yet put back.
 *
 * Finder cannot undo them — its Put Back reads an origin only Finder records — so the offer to
 * put something back has to live somewhere the user will find it later, not only on the screen
 * shown once immediately after the removal. The receipts are on disk in the main process, so
 * they outlive the window as well as the page.
 */
@Injectable({ providedIn: 'root' })
export class RemovalsService {
  readonly list = signal<Removal[]>([]);
  readonly applications = computed(() => this.list().filter(removal => removal.source === 'applications'));
  readonly cleanup = computed(() => this.list().filter(removal => removal.source === 'cleanup'));
  readonly files = computed(() => this.list().filter(removal => removal.source === 'files'));
  readonly restoring = signal<string | null>(null);
  readonly lastResult = signal<{ id: string; restored: number; failures: string[] } | null>(null);

  constructor() { void this.refresh(); }

  async refresh(): Promise<void> {
    const list = await window.electronAPI?.listRemovals();
    this.list.set(list ?? []);
  }

  async restore(id: string): Promise<void> {
    if (this.restoring()) return;
    this.restoring.set(id);
    const result = await window.electronAPI?.restoreRemoval(id);
    this.lastResult.set({ id, restored: result?.restored ?? 0, failures: result?.failures ?? ['Could not reach the main process'] });
    this.restoring.set(null);
    await this.refresh();
  }

  /** "2 minutes ago", for a list where the newest matters most. */
  since(at: number): string {
    const minutes = Math.floor((Date.now() - at) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes === 1) return 'a minute ago';
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  }
}
