import { ChangeDetectionStrategy, Component, OnDestroy, computed, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { faArrowsRotate, faCircleNodes, faMagnifyingGlass, faMicrochip, faMemory, faNetworkWired, faHardDrive } from '@fortawesome/free-solid-svg-icons';
import { formatBinaryBytes } from '../dashboard/metric-format';

type ProcessSort = 'name' | 'cpu' | 'memory' | 'disk' | 'network';
const PROCESS_SORT_STORAGE_KEY = 'openclean.processManager.sort';

function readStoredSort(): ProcessSort {
  try {
    const value = localStorage.getItem(PROCESS_SORT_STORAGE_KEY);
    return value === 'name' || value === 'cpu' || value === 'memory' || value === 'disk' || value === 'network' ? value : 'cpu';
  } catch {
    return 'cpu';
  }
}

@Component({
  selector: 'oc-process-manager',
  standalone: true,
  imports: [FontAwesomeModule, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="process-page">
      <header class="process-heading">
        <div><p class="eyebrow">ACTIVITY</p><h1>Process Manager</h1><p class="process-subtitle">See what is using your Mac right now, with live CPU, memory, disk and network activity.</p></div>
        <div class="process-actions"><button type="button" (click)="refresh()" [disabled]="loading() || !electronAvailable"><fa-icon [icon]="faArrowsRotate" /> Refresh</button></div>
      </header>

      <div class="process-toolbar"><label><fa-icon [icon]="faMagnifyingGlass" /><input type="search" placeholder="Search processes" [value]="query()" (input)="onSearch($any($event.target).value)" /></label><div class="scope-tabs" role="tablist" aria-label="Which processes">@for (tab of scopeTabs; track tab.id) {<button type="button" role="tab" [attr.aria-selected]="scope() === tab.id" [class.active]="scope() === tab.id" (click)="setScope(tab.id)">{{ tab.label }}<em>{{ scopeCount(tab.id) }}</em></button>}</div>@if (electronAvailable) { <span>{{ filteredRows().length }} processes</span> } @else { <span>Desktop app required</span> }<small>Sorted by {{ sortLabel() }}</small></div>

      <section class="process-table" aria-label="Running processes">
        <div class="process-table-head process-grid"><button class="name-sort" type="button" (click)="setSort('name')">Name{{ sortMark('name') }}</button><span>Status</span><button type="button" (click)="setSort('cpu')">CPU <fa-icon [icon]="faMicrochip" />{{ sortMark('cpu') }}</button><button type="button" (click)="setSort('memory')">Memory <fa-icon [icon]="faMemory" />{{ sortMark('memory') }}</button><button type="button" (click)="setSort('disk')">Disk <fa-icon [icon]="faHardDrive" />{{ sortMark('disk') }}</button><button type="button" (click)="setSort('network')">Network <fa-icon [icon]="faNetworkWired" />{{ sortMark('network') }}</button><span></span></div>
        @if (!electronAvailable) { <div class="process-state">Open this page in the OpenClean desktop app to view live processes.</div> }
        @else if (error()) { <div class="process-state error-state">Couldn't read process activity. Try refreshing.</div> }
        @else if (loading() && rows().length === 0) { <div class="process-state">Reading running processes…</div> }
        @else if (filteredRows().length === 0 && !loading()) { <div class="process-state">No matching processes.</div> }
        @if (appRows().length) {
          @if (scope() === 'all') { <div class="process-group-title">Apps <span>({{ appCount() }})</span></div> }
          @for (process of appRows(); track process.pid) { <ng-container *ngTemplateOutlet="row; context: {$implicit: process}" /> }
        }
        @if (backgroundRows().length) {
          @if (scope() === 'all') { <div class="process-group-title">Background processes <span>({{ backgroundCount() }})</span></div> }
          @for (process of backgroundRows(); track process.pid) { <ng-container *ngTemplateOutlet="row; context: {$implicit: process}" /> }
        }
        @if (remainingRows() > 0) { <button class="show-more" type="button" (click)="showMore()">Show {{ nextBatchSize() }} more processes</button> }
        <ng-template #row let-process>
          <div class="process-row process-grid">
            <div class="process-name">@if (process.kind === 'app' && process.children.length > 1) { <button class="process-expand" type="button" [class.expanded]="expanded().has(process.pid)" [attr.aria-expanded]="expanded().has(process.pid)" [attr.aria-label]="(expanded().has(process.pid) ? 'Collapse ' : 'Expand ') + process.name" (click)="toggleExpanded(process.pid)">›</button> } @else { <span class="process-expand-spacer"></span> }@if (process.icon) { <img [src]="process.icon" alt="" /> } @else { <span class="process-glyph"><fa-icon [icon]="process.kind === 'app' ? faCircleNodes : faMicrochip" /></span> }<span class="process-label"><strong>{{ process.name }}</strong><small>PID {{ process.pid }}@if (process.pids.length > 1) { · {{ process.pids.length }} processes }</small></span></div>
            <span class="process-status"><i [class.running]="process.status === 'Running'"></i>{{ process.status }}</span>
            <span class="process-usage" [class.usage-medium]="process.cpuPercent >= 5" [class.usage-high]="process.cpuPercent >= 25">{{ process.cpuPercent.toFixed(1) }}%</span>
            <span class="process-usage memory-cell">{{ formatBytes(process.memoryBytes) }}</span>
            <span class="process-usage">{{ formatRate(process.diskBytesPerSecond) }}</span>
            <span class="process-usage">{{ formatRate(process.networkBytesPerSecond) }}</span>
            @if (process.kind === 'app') { <button class="end-process" type="button" title="Quit app" (click)="quit(process.pid)" [disabled]="quitting().has(process.pid)">{{ quitting().has(process.pid) ? '…' : 'Quit' }}</button> } @else { <span></span> }
          </div>
          @if (expanded().has(process.pid)) { @for (child of process.children; track child.pid) {
            <div class="process-child process-grid"><div class="child-name"><span></span><strong>{{ child.name }}</strong><small>PID {{ child.pid }}</small></div><span class="process-status"><i [class.running]="child.status === 'Running'"></i>{{ child.status }}</span><span class="process-usage">{{ child.cpuPercent.toFixed(1) }}%</span><span class="process-usage memory-cell">{{ formatBytes(child.memoryBytes) }}</span><span class="process-usage">{{ formatRate(child.diskBytesPerSecond) }}</span><span class="process-usage">{{ formatRate(child.networkBytesPerSecond) }}</span><span></span></div>
          } }
        </ng-template>
      </section>
      <footer class="process-footer"><span class="footer-refresh">Updated {{ updatedAt() }}</span></footer>
    </section>
  `,
  styles: [`
    :host { display:block; min-height:0; height:100%; color:#302a43; }
    .process-page { height:100%; display:flex; flex-direction:column; min-height:0; }
    .process-heading { display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-bottom:22px; }
    .eyebrow { margin:0 0 8px; color:#978cb0; font-size:10px; font-weight:800; letter-spacing:.12em; }
    h1 { margin:0; font-size:27px; letter-spacing:-.04em; }
    .process-subtitle { margin:7px 0 0; color:#807991; font-size:14px; }
    .process-actions { display:flex; align-items:center; gap:13px; padding-bottom:2px; }
    .process-status i { width:7px; height:7px; border-radius:50%; background:#31ae83; box-shadow:0 0 0 3px #31ae831c; }
    .process-actions button { display:flex; align-items:center; gap:8px; padding:10px 14px; border:1px solid #fff; border-radius:11px; background:#ffffff9c; color:#5e4bd1; font:inherit; font-size:13px; font-weight:600; box-shadow:0 6px 18px #42357410; cursor:pointer; }
    .process-actions button:disabled { opacity:.6; cursor:default; }
    .process-toolbar { display:flex; align-items:center; gap:14px; min-height:54px; margin-bottom:13px; padding:8px 13px; border:1px solid #ffffffd6; border-radius:15px; background:linear-gradient(110deg,#fff,#f8f9ff); box-shadow:0 10px 22px #44516b12,inset 0 1px #ffffff; }
    .process-toolbar label { display:flex; align-items:center; gap:9px; flex:1; max-width:390px; padding:9px 11px; border:1px solid #e1dcf0; border-radius:10px; color:#9289a8; background:#ffffffa8; }
    .process-toolbar input { width:100%; min-width:0; border:0; outline:0; background:transparent; color:#352f49; font:inherit; font-size:13px; }
    .scope-tabs { display:flex; gap:2px; padding:3px; border:1px solid #e6e1f2; border-radius:11px; background:#f4f2fa; }
    .scope-tabs button { display:inline-flex; align-items:center; gap:7px; height:32px; padding:0 12px; border:0; border-radius:8px; background:transparent; color:#7a7190; font:inherit; font-size:12px; font-weight:650; cursor:pointer; transition:background .12s, color .12s, box-shadow .12s; }
    .scope-tabs button:hover:not(.active) { background:#ffffff8c; color:#4f4568; }
    .scope-tabs button.active { background:#fff; color:#4b33a3; box-shadow:0 2px 6px #4b3c7d1a; }
    .scope-tabs em { padding:1px 6px; border-radius:5px; background:#e9e5f3; color:#8d84a2; font-size:10px; font-style:normal; font-weight:700; font-variant-numeric:tabular-nums; }
    .scope-tabs button.active em { background:#ece7fb; color:#6b4be1; }
    .process-toolbar > span { margin-left:auto; color:#5d5576; font-size:12px; font-weight:700; }
    .process-toolbar small { color:#958da6; font-size:12px; }
    .process-table { flex:1; min-height:0; overflow:auto; border:1px solid #ffffffed; border-radius:19px; background:linear-gradient(145deg,#fff,#f8f9ff); box-shadow:0 20px 48px #50416e16,inset 0 1px #fff; }
    .process-grid { display:grid; grid-template-columns:minmax(245px, 1fr) 112px 88px 108px 112px 112px 46px; align-items:center; gap:4px; }
    .process-table-head { position:sticky; top:0; z-index:2; min-height:43px; padding:0 14px; border-bottom:1px solid #e8e3f1; background:#f5f2fbf2; color:#807893; font-size:11px; font-weight:700; }
    .process-table-head button { display:flex; justify-content:flex-end; align-items:center; gap:6px; padding:0; border:0; background:none; color:inherit; font:inherit; cursor:pointer; }
    .process-table-head .name-sort { justify-content:flex-start; }
    .process-table-head button fa-icon { opacity:.65; }
    .process-group-title { padding:14px 16px 8px; color:#383249; font-size:13px; font-weight:750; }
    .process-group-title span { color:#9991a8; font-weight:500; }
    .process-row { min-height:53px; padding:0 14px; border-top:1px solid #ece8f3a8; color:#514b63; font-size:12px; transition:background .12s ease; }
    .process-row:hover { background:#ffffffc7; }
    .process-name { display:flex; align-items:center; gap:9px; min-width:0; }
    .process-expand,.process-expand-spacer { width:12px; height:20px; flex:none; display:grid; place-items:center; }
    .process-expand { padding:0; border:0; border-radius:4px; background:transparent; color:#8f87a3; font-size:19px; line-height:1; cursor:pointer; transition:transform .15s ease, background .15s ease; }
    .process-expand:hover { background:#ebe6f5; }
    .process-expand.expanded { transform:rotate(90deg); }
    .process-name img,.process-glyph { width:25px; height:25px; flex:none; display:grid; place-items:center; border-radius:7px; object-fit:contain; }
    .process-glyph { color:#6b57cd; background:#eee9fc; font-size:12px; }
    .process-label { display:flex; flex-direction:column; min-width:0; gap:3px; }
    .process-label strong { overflow:hidden; color:#39334e; font-size:12px; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
    .process-label small { color:#9991a8; font-size:10px; }
    .process-child { min-height:42px; padding:0 14px; border-top:1px solid #ece8f3a8; background:#f7f5fb91; color:#807990; font-size:11px; }
    .child-name { display:grid; grid-template-columns:12px minmax(0,1fr) auto; align-items:center; gap:9px; min-width:0; padding-left:25px; }
    .child-name > span { width:7px; height:1px; background:#bcb4ce; }
    .child-name strong { overflow:hidden; color:#6e6780; font-size:11px; font-weight:550; text-overflow:ellipsis; white-space:nowrap; }
    .child-name small { color:#aaa3b5; font-size:10px; }
    .process-status { display:flex; align-items:center; gap:7px; color:#847d93; font-size:11px; }
    .process-status i { width:6px; height:6px; background:#b7b2c1; box-shadow:none; }
    .process-status i.running { background:#39b786; box-shadow:0 0 0 3px #39b7861d; }
    .process-usage { display:block; padding:9px 8px; border-radius:7px; background:#f5f3faad; color:#48415c; font-variant-numeric:tabular-nums; text-align:right; white-space:nowrap; }
    .process-usage.usage-medium { background:#f4eecf; color:#866714; }
    .process-usage.usage-high { background:#f8dce2; color:#bb3155; }
    .memory-cell { background:#efebfa; }
    .end-process { justify-self:end; padding:5px 7px; border:0; border-radius:7px; background:transparent; color:#6655c5; font-size:11px; cursor:pointer; }
    .end-process:hover:not(:disabled) { background:#efeaff; }
    .end-process:disabled { color:#9991a8; cursor:default; }
    .process-state { padding:35px 16px; color:#89819a; font-size:13px; text-align:center; }
    .error-state { color:#a34f39; }
    .show-more { display:block; margin:14px auto; padding:9px 14px; border:1px solid #e1dcf0; border-radius:10px; background:#fff; color:#5e4bd1; font:inherit; font-size:12px; font-weight:650; cursor:pointer; }
    .show-more:hover { background:#f5f2ff; }
    .process-footer { display:flex; align-items:center; padding:13px 3px 0; color:#8b839b; font-size:11px; }
    .footer-refresh { margin-left:auto; }
    @media (max-width:820px) { .process-toolbar { flex-wrap:wrap; }.process-toolbar label { max-width:none; flex-basis:100%; } }
    @media (max-width:1050px) { .process-grid { grid-template-columns:minmax(190px,1fr) 88px 74px 90px 90px 90px 42px; }.process-row,.process-table-head { padding-inline:9px; } }
  `]
})
export class ProcessManagerComponent implements OnDestroy {
  readonly faArrowsRotate = faArrowsRotate;
  readonly faCircleNodes = faCircleNodes;
  readonly faMagnifyingGlass = faMagnifyingGlass;
  readonly faMicrochip = faMicrochip;
  readonly faMemory = faMemory;
  readonly faHardDrive = faHardDrive;
  readonly faNetworkWired = faNetworkWired;
  readonly rows = signal<ActivityProcess[]>([]);
  readonly query = signal('');
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly sort = signal<ProcessSort>(readStoredSort());
  readonly visibleLimit = signal(100);
  readonly quitting = signal(new Set<number>());
  readonly expanded = signal(new Set<number>());
  readonly updatedAt = signal('—');
  readonly electronAvailable = typeof window !== 'undefined' && Boolean(window.electronAPI);
  private readonly interval = setInterval(() => void this.refresh(), 2_000);
  private requestInFlight = false;
  private session = 0;
  readonly scope = signal<'app' | 'background' | 'all'>('app');
  readonly scopeTabs = [{ id: 'app', label: 'Apps' }, { id: 'background', label: 'Background' }, { id: 'all', label: 'All' }] as const;
  /** Search applies before the scope, so each tab's count says how many matches are waiting there. */
  private readonly searchedRows = computed(() => {
    const needle = this.query().trim().toLocaleLowerCase();
    return this.rows().filter(row => !needle || row.name.toLocaleLowerCase().includes(needle) || String(row.pid).includes(needle));
  });
  readonly filteredRows = computed(() => {
    const scope = this.scope();
    const rows = this.searchedRows().filter(row => scope === 'all' || row.kind === scope);
    const sort = this.sort();
    return rows.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : this.sortValue(b, sort) - this.sortValue(a, sort));
  });
  readonly visibleRows = computed(() => this.filteredRows().slice(0, this.visibleLimit()));
  readonly appRows = computed(() => this.visibleRows().filter(row => row.kind === 'app'));
  readonly backgroundRows = computed(() => this.visibleRows().filter(row => row.kind === 'background'));
  readonly appCount = computed(() => this.searchedRows().filter(row => row.kind === 'app').length);
  readonly backgroundCount = computed(() => this.searchedRows().filter(row => row.kind === 'background').length);
  readonly remainingRows = computed(() => Math.max(0, this.filteredRows().length - this.visibleLimit()));
  readonly nextBatchSize = computed(() => Math.min(100, this.remainingRows()));
  readonly sortLabel = () => ({ name: 'Name', cpu: 'CPU', memory: 'Memory', disk: 'Disk', network: 'Network' })[this.sort()];

  constructor() { void this.refresh(); }
  ngOnDestroy(): void {
    clearInterval(this.interval);
    this.session++;
    void window.electronAPI?.stopProcessActivity();
  }

  async refresh(): Promise<void> {
    const api = window.electronAPI;
    if (!api || this.requestInFlight) return;
    const session = this.session;
    this.requestInFlight = true;
    this.loading.set(true);
    this.error.set(false);
    try {
      const rows = await api.getProcessActivity();
      if (session !== this.session) return;
      this.rows.set(rows);
      this.updatedAt.set(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (error) {
      if (session === this.session) { this.error.set(true); console.error('Unable to read process activity', error); }
    } finally {
      this.requestInFlight = false;
      if (session === this.session) this.loading.set(false);
    }
  }

  setSort(sort: ProcessSort): void {
    const next = this.sort() === sort && sort === 'name' ? 'cpu' : sort;
    this.sort.set(next);
    this.visibleLimit.set(100);
    try { localStorage.setItem(PROCESS_SORT_STORAGE_KEY, next); } catch { /* Sorting remains usable when storage is unavailable. */ }
  }
  onSearch(value: string): void { this.query.set(value); this.visibleLimit.set(100); }
  setScope(scope: 'app' | 'background' | 'all'): void { this.scope.set(scope); this.visibleLimit.set(100); }
  scopeCount(scope: 'app' | 'background' | 'all'): number { return scope === 'app' ? this.appCount() : scope === 'background' ? this.backgroundCount() : this.appCount() + this.backgroundCount(); }
  showMore(): void { this.visibleLimit.update(limit => limit + 100); }
  toggleExpanded(pid: number): void { this.expanded.update(items => { const next = new Set(items); next.has(pid) ? next.delete(pid) : next.add(pid); return next; }); }
  sortMark(sort: ProcessSort): string { return this.sort() === sort ? ' ↓' : ''; }
  formatBytes(bytes: number): string { return formatBinaryBytes(bytes) ?? '0 B'; }
  formatRate(bytes: number | null): string { if (bytes === null) return '—'; if (bytes < 1024) return `${Math.round(bytes)} B/s`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB/s`; return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`; }

  quit(pid: number): void {
    if (this.quitting().has(pid)) return;
    const request = window.electronAPI?.quitProcess(pid);
    if (!request) return;
    this.quitting.update(items => new Set(items).add(pid));
    void request.then(result => {
      if (result.quit) setTimeout(() => void this.refresh(), 700);
    }).finally(() => this.quitting.update(items => { const next = new Set(items); next.delete(pid); return next; }));
  }

  private sortValue(row: ActivityProcess, sort: ProcessSort): number {
    if (sort === 'cpu') return row.cpuPercent;
    if (sort === 'memory') return row.memoryBytes;
    if (sort === 'disk') return row.diskBytesPerSecond ?? 0;
    return row.networkBytesPerSecond ?? 0;
  }
}
