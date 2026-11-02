import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { faArrowDownWideShort, faArrowRight, faClockRotateLeft, faClone, faCopy, faFile, faTrashCan, faTriangleExclamation, faFolderOpen, faMagnifyingGlass, faRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { formatBinaryBytes } from '../dashboard/metric-format';
import { SystemMonitorService } from '../dashboard/system-monitor.service';
import { RemovalsService } from '../removals.service';
import { FileEntry, FileInventoryService } from './file-inventory.service';

@Component({
  selector: 'oc-file-manager', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FontAwesomeModule, DatePipe, DecimalPipe],
  template: `
    <section class="files-page">
      <div class="page-heading">
        <div><p class="eyebrow">FILES</p><h1>File Manager</h1><p class="muted">Find your largest files across every subfolder, then decide what to do with them.</p></div>
        <div class="heading-actions">
          @if (putBackView()) { <button class="ghost-button" type="button" (click)="putBackView.set(false)">Back to File Manager</button> }
          @else {
            <button class="ghost-button" type="button" (click)="putBackView.set(true)"><fa-icon [icon]="faClockRotateLeft" />Put back @if (removals.files().length) { <em class="count">{{ removals.files().length }}</em> }</button>
            @if (inventory.scanning()) {
              <button class="ghost-button stop" type="button" [disabled]="inventory.stopping()" (click)="inventory.stop()">{{ inventory.stopping() ? 'Stopping…' : 'Stop scan' }}</button>
            } @else if (inventory.scanned()) {
              <button class="primary" type="button" [disabled]="busy()" (click)="startScan()"><fa-icon [icon]="faRotateLeft" />Scan again</button>
            }
          }
        </div>
      </div>
      @if (putBackView()) {
        <section class="putback-panel">
          <h2>Recent removals</h2>
          <p class="list-note">Putting one back returns every piece to where it came from. Pieces emptied from the Trash cannot be restored.</p>
          @if (removals.files().length) {
            <div class="undo-list">
              @for (removal of removals.files(); track removal.id) {
                <article class="undo-card">
                  <header>
                    <div><strong>{{ removal.label }}</strong><small>{{ removal.entries.length }} {{ removal.entries.length === 1 ? 'item' : 'items' }} · {{ format(removal.bytes) }} · {{ removals.since(removal.removedAt) }}</small></div>
                    <button class="primary" type="button" [disabled]="removals.restoring() === removal.id" (click)="putBack(removal.id)">{{ removals.restoring() === removal.id ? 'Putting back…' : 'Put back' }}</button>
                  </header>
                  <ul>
                    @for (entry of removal.entries; track entry.originalPath) {
                      <li [class.gone]="entry.available === false"><span>{{ entry.label }}</span><code>{{ entry.originalPath }}</code><em>{{ entry.available === false ? 'emptied' : format(entry.bytes) }}</em></li>
                    }
                  </ul>
                  @if (removals.lastResult(); as outcome) { @if (outcome.id === removal.id && outcome.failures.length) { <p class="undo-failed">{{ outcome.failures.join(' · ') }}</p> } }
                </article>
              }
            </div>
          } @else {
            <article class="empty-state"><span class="empty-icon"><fa-icon [icon]="faClockRotateLeft" /></span><h3>Nothing to put back</h3><p>Anything you move to the Trash from OpenClean is listed here until you return it or empty the Trash yourself.</p></article>
          }
        </section>
      } @else {
      <div class="file-toolbar">
        <label>Look in <select [value]="inventory.target()" [disabled]="inventory.scanning() || busy()" (focus)="inventory.loadVolumes()" (change)="changeTarget($any($event.target).value)"><option value="__home__">Home folder</option><option value="">{{ startupVolumeName() }}</option>@for (volume of inventory.volumes(); track volume.path) { <option [value]="volume.path">{{ volume.name }}</option> }@if (customTarget()) { <option [value]="customTarget()">{{ customTarget() }}</option> }</select></label>
        <span>{{ inventory.target() === '' ? 'Whole startup volume, including your Home folder' : 'Includes all subfolders' }}</span>
        <button type="button" class="ghost-button" [disabled]="inventory.scanning() || busy()" (click)="chooseFolder()"><fa-icon [icon]="faFolderOpen" />Choose folder</button>
      </div>
      @if (inventory.error()) { <p class="message error" role="alert">{{ inventory.error() }}</p> }
      @if (message()) { <p class="message" role="status">{{ message() }}</p> }
      @if (inventory.scanning() || inventory.scanned() || inventory.files().length) {
        <section class="file-results">
          <div class="results-heading"><div><p class="eyebrow">FILE INVENTORY</p><h2>{{ view() === 'largest' ? 'Largest files' : 'Exact duplicate files' }}</h2><p class="scan-status" [class.is-scanning]="inventory.scanning()"><span class="status-dot"></span>{{ inventory.scanning() ? 'Scanning folders · results update as files are found' : inventory.partial() ? 'Scan stopped · showing files found so far' : 'Sorted by file size, largest first' }}</p><code [title]="inventory.root()">{{ inventory.root() }}</code></div><span class="result-count">{{ inventory.totalFiles() | number }}<small>files found</small></span></div>
          <div class="file-stats">
            <article class="file-stat spotlight"><span class="stat-label">Largest file</span><strong [title]="topFileName()">{{ topFileName() }}</strong><small>{{ topFileSize() }}</small></article>
            <article class="file-stat"><span class="stat-label">Total file sizes</span><strong>{{ format(totalBytes()) }}</strong><small>Across files found in this scan</small></article>
            <article class="file-stat"><span class="stat-label">Folders checked</span><strong>{{ inventory.directories() | number }}</strong><small>{{ inventory.skipped() ? (inventory.skipped() | number) + ' unreadable entries' : 'Subfolders included' }}</small></article>
          </div>
          @if (inventory.skipped()) { <p class="access-note">{{ inventory.skipped() | number }} files or folders could not be read. Their contents are not included.</p> }
          <div class="view-tabs" role="tablist" aria-label="Results view">
            <button type="button" role="tab" [attr.aria-selected]="view() === 'largest'" [class.active]="view() === 'largest'" (click)="view.set('largest')"><fa-icon [icon]="faArrowDownWideShort" />Largest files<span class="tab-badge">{{ inventory.matchingCount() | number }}</span></button>
            <button type="button" role="tab" [attr.aria-selected]="view() === 'folders'" [class.active]="view() === 'folders'" [disabled]="!inventory.scanned() || inventory.partial()" (click)="openFolderMap()"><fa-icon [icon]="faFolderOpen" />Storage map</button>
            <button type="button" role="tab" [attr.aria-selected]="view() === 'duplicates'" [class.active]="view() === 'duplicates'" (click)="view.set('duplicates')"><fa-icon [icon]="faClone" />Duplicates
              @if (inventory.duplicateScanning()) { <span class="tab-badge busy">{{ inventory.duplicateProgress().completed }} / {{ inventory.duplicateProgress().total }}</span> }
              @else if (inventory.duplicateGroups().length) { <span class="tab-badge found">{{ format(reclaimableBytes()) }} reclaimable</span> }
              @else if (inventory.duplicatesSearched()) { <span class="tab-badge">None</span> }
              @else if (inventory.scanned() && !inventory.partial()) { <span class="tab-badge new">Ready to check</span> }
            </button>
          </div>
          @if (view() === 'largest') {
          <div class="file-filters">
            <label class="search"><fa-icon [icon]="faMagnifyingGlass" /><input type="search" placeholder="Search name or path" aria-label="Search name or path" [value]="search()" (input)="search.set($any($event.target).value); page.set(0); loadPage()" /></label>
            <label>Type <select [value]="kind()" (change)="kind.set($any($event.target).value); page.set(0); loadPage()"><option value="all">All types</option><option value="video">Video</option><option value="audio">Audio</option><option value="image">Images</option><option value="archive">Archives & disk images</option><option value="document">Documents</option><option value="other">Other</option></select></label>
            <label>Minimum size <select [value]="minimum()" (change)="minimum.set(+$any($event.target).value); page.set(0); loadPage()"><option value="0">Any size</option><option value="10485760">10 MB</option><option value="104857600">100 MB</option><option value="1073741824">1 GB</option><option value="10737418240">10 GB</option></select></label>
            <button class="ghost-button" type="button" [disabled]="!filtered().length || inventory.scanning()" (click)="exportCsv()">Export page CSV</button>
          </div>
          <div class="table-scroll">
            <table><thead><tr><th class="rank">#</th><th>File / location</th><th class="size-column" aria-sort="descending">Size ↓</th><th>Type</th><th>Modified</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
              @for (file of visible(); track file.path; let index = $index) {
                <tr class="file-row" [class.selected]="selected()?.path === file.path" (click)="select(file)">
                  <td class="rank">{{ currentPage() * pageSize + index + 1 }}</td>
                  <td class="file-cell"><button type="button" class="file-name" [class]="'file-name type-' + fileKind(file.extension)" [attr.aria-expanded]="selected()?.path === file.path" [title]="file.name"><fa-icon [icon]="faFile" /><strong>{{ file.name }}</strong></button><code [title]="file.path">{{ file.path }}</code></td>
                  <td class="file-size"><strong>{{ format(file.bytes) }}</strong><i><b [style.width.%]="largest() ? file.bytes / largest() * 100 : 0"></b></i></td>
                  <td class="file-type"><span class="type-pill" [class]="'type-pill type-' + fileKind(file.extension)">{{ file.extension ? file.extension.toUpperCase() : 'FILE' }}</span></td><td class="file-date">{{ file.modifiedAt | date:'dd MMM yyyy' }}</td>
                  <td><button class="row-action" type="button" (click)="$event.stopPropagation(); reveal(file)" [attr.aria-label]="'Show ' + file.name + ' in Finder'">Show in Finder</button></td>
                </tr>
                @if (selected()?.path === file.path) {
                  <tr class="detail-row"><td colspan="6">
                    <section class="file-detail" id="file-detail" aria-label="Selected file" [class.confirming]="confirmTrash()">
                      <div class="detail-info">
                        <nav class="crumbs" [title]="file.path">@for (part of crumbs(file.path); track $index; let last = $last) {<span>{{ part }}</span>@if (!last) {<i>/</i>}}</nav>
                        <p class="facts">
                          <span class="fact"><i class="meter"><b [style.width.%]="shareValue(file.bytes)"></b></i><strong>{{ share(file.bytes) }}</strong> of this scan</span>
                          <span class="fact"><strong>{{ age(file.modifiedAt) }}</strong> · {{ file.modifiedAt | date:'d MMM yyyy, HH:mm' }}</span>
                          @if (isAppData(file.path)) { <span class="fact caution"><fa-icon [icon]="faTriangleExclamation" />App data — quit the app that owns it first</span> }
                        </p>
                      </div>
                      @if (confirmTrash()) {
                        <div class="detail-actions"><span class="confirm-text">Move to the Trash? You can put it back.</span><button class="btn" type="button" [disabled]="busy()" (click)="confirmTrash.set(false)">Cancel</button><button class="btn btn-danger-solid" type="button" [disabled]="busy() || inventory.scanning()" [title]="inventory.scanning() ? 'Wait for the scan to finish' : ''" (click)="trash(file)"><fa-icon [icon]="faTrashCan" />{{ busy() ? 'Moving…' : 'Move to Trash' }}</button></div>
                      } @else {
                        <div class="detail-actions"><button class="btn" type="button" (click)="reveal(file)"><fa-icon [icon]="faFolderOpen" />Show in Finder</button><button class="btn" type="button" (click)="copyPath(file)"><fa-icon [icon]="faCopy" />Copy path</button>@if (file.removable) { <button class="btn btn-danger" type="button" [disabled]="inventory.scanning() || busy()" [title]="inventory.scanning() ? 'Wait for the scan to finish' : ''" (click)="confirmTrash.set(true)"><fa-icon [icon]="faTrashCan" />Move to Trash…</button> }</div>
                      }
                    </section>
                  </td></tr>
                }
              } @empty { <tr><td colspan="6" class="no-results">{{ inventory.scanning() ? 'Looking for files…' : 'No files match these filters.' }}</td></tr> }
            </tbody></table>
          </div>
          <footer class="results-footer"><span>{{ inventory.matchingCount() | number }} matching files · File sizes, not estimated space recovered</span><div><button type="button" [disabled]="currentPage() === 0" (click)="changePage(currentPage() - 1)">Previous</button><span>{{ currentPage() + 1 }} / {{ pageCount() }}</span><button type="button" [disabled]="currentPage() + 1 >= pageCount()" (click)="changePage(currentPage() + 1)">Next</button></div></footer>
          } @else if (view() === 'duplicates') {
          <section class="duplicates-panel">
            <div class="duplicates-heading"><div><p>Only byte-for-byte matches are grouped. Files under 1 MB are skipped.</p></div><button class="ghost-button" type="button" [disabled]="!inventory.scanned() || inventory.partial() || inventory.duplicateScanning() || busy()" (click)="inventory.findDuplicates()">{{ inventory.duplicateScanning() ? 'Comparing… ' + inventory.duplicateProgress().completed + ' / ' + inventory.duplicateProgress().total : 'Find duplicates' }}</button></div>
            @if (inventory.duplicateGroups().length) {
              <p class="duplicate-summary">{{ inventory.duplicateGroups().length }} groups · {{ format(duplicateBytes()) }} selected to move to Trash</p>
              @for (group of inventory.duplicateGroups(); track group.files[0].path) {
                <article class="duplicate-group"><header><strong>{{ format(group.bytes) }} each</strong><span>{{ group.files.length }} identical files</span></header>
                  @for (file of group.files; track file.path; let index = $index) {
                    <label class="duplicate-file"><input type="checkbox" [checked]="file.selected" [disabled]="!file.removable || (!file.selected && selectedIn(group) >= group.files.length - 1) || busy()" (change)="toggleDuplicate(group, index, $any($event.target).checked)" /><span><strong>{{ file.name }}</strong><code>{{ file.path }}</code></span><em>{{ index === 0 && !file.selected ? 'Keep one copy' : (file.removable ? 'Move to Trash' : 'Protected') }}</em></label>
                  }
                </article>
              }
              @if (duplicateSelected().length) { <div class="duplicate-actions">@if (confirmDuplicates()) { <span>Move {{ duplicateSelected().length }} selected copies to the Trash?</span><button class="ghost-button" (click)="confirmDuplicates.set(false)">Cancel</button><button class="trash-button" [disabled]="busy()" (click)="trashDuplicates()">Move to Trash</button> } @else { <button class="trash-button" [disabled]="busy()" (click)="confirmDuplicates.set(true)">Review removal…</button> }</div> }
            } @else if (inventory.partial() && !inventory.scanning()) { <p class="no-results">The scan was stopped early. Scan again to completion before checking for duplicates.</p> }
            @else if (!inventory.duplicateScanning() && inventory.scanned() && inventory.duplicatesSearched()) { <p class="no-results">No exact duplicates found in this location.</p> }
            @else if (!inventory.duplicateScanning() && inventory.scanned()) { <p class="no-results">Choose Find duplicates to compare files with matching sizes.</p> }
            @else if (!inventory.scanned()) { <p class="no-results">{{ inventory.scanning() ? 'Duplicates can be checked once the scan finishes.' : 'Complete a file scan before searching for duplicates.' }}</p> }
          </section>
          } @else {
          <section class="folder-map-panel">
            <header class="folder-map-heading"><div><p class="eyebrow">STORAGE MAP</p><h3>{{ folderMapPath() === inventory.root() ? 'Scan root' : folderMapName() }}</h3><code [title]="folderMapPath()">{{ folderMapPath() }}</code></div><div><button type="button" class="ghost-button" [disabled]="folderMapPath() === inventory.root() || inventory.folderMapLoading()" (click)="folderMapUp()">Up one folder</button><button type="button" class="ghost-button" [disabled]="folderMapPath() === inventory.root() || inventory.folderMapLoading()" (click)="openFolderMap()">Scan root</button></div></header>
            <p class="folder-map-note">Folder bars show allocated file sizes found in this scan. Choose a folder to explore it. Protected or unreadable data is not included.</p>
            @if (inventory.folderMapLoading()) { <p class="no-results">Measuring this folder…</p> }
            @else if (inventory.folderMapError()) { <p class="message error" role="alert">{{ inventory.folderMapError() }}</p> }
            @else if (!inventory.folderMapEntries().length) { <p class="no-results">No files or folders were found here.</p> }
            @else {
              @if (inventory.folderMapTruncated()) { <p class="access-note">Showing the 100 largest entries in this folder.</p> }
              <div class="folder-map-list">
                @for (entry of inventory.folderMapEntries(); track entry.path) {
                  <article class="folder-map-row">
                    @if (entry.isDirectory) { <button type="button" class="folder-map-name" (click)="folderMapEnter(entry.path)"><fa-icon [icon]="faFolderOpen" />{{ entry.name }}</button> }
                    @else { <button type="button" class="folder-map-name file" (click)="revealMapFile(entry.path)"><fa-icon [icon]="faFile" />{{ entry.name }}<small>Show in Finder</small></button> }
                    <i class="folder-map-meter"><b [style.width.%]="folderMapShare(entry.bytes)"></b></i><strong>{{ format(entry.bytes) }}</strong>
                  </article>
                }
              </div>
            }
          </section>
          }
        </section>
      } @else {
        <section class="file-empty"><span class="empty-icon"><fa-icon [icon]="faFolderOpen" /></span><div><p class="eyebrow">OPEN FILE MANAGER</p><h2>Find the files taking up space</h2><p>Scan a location to see individual files ranked by size. Open a file in Finder, copy its path, or move it to the Trash after reviewing it.</p><button class="hero-scan" type="button" (click)="startScan()"><fa-icon [icon]="faMagnifyingGlass" />Find large files<fa-icon [icon]="faArrowRight" /></button></div><span class="empty-orb orb-a"></span><span class="empty-orb orb-b"></span></section>
      }
      }
    </section>
  `,
  styles: [`
    .files-page { padding: 12px 0 32px; }
    .page-heading { margin-bottom: 24px; }
    .page-heading .primary { display: inline-flex; align-items: center; gap: 8px; margin-left: 0; white-space: nowrap; }
    .heading-actions { display:flex; align-items:center; gap:9px; flex-shrink:0; }
    .heading-actions .ghost-button.stop { border-color:#f1d4df; background:#fff8fa; color:#a94c6a; }
    .heading-actions .count { padding:1px 6px; border-radius:5px; background:#ece7fb; color:#6b4be1; font-style:normal; font-size:9px; font-weight:700; }
    .putback-panel { padding:22px; border:1px solid #ffffffc8; border-radius:20px; background:linear-gradient(145deg,#ffffffbd,#ffffff6b); box-shadow:0 14px 30px #44516b14,inset 0 1px #fff; }
    .putback-panel h2 { margin:2px 0 0; font-size:16px; }
    .list-note { margin:6px 0 16px; color:#8f899f; font-size:11px; }
    .undo-list { display:grid; gap:8px; }
    .undo-card { border:1px solid #d9cdfbc0; border-radius:16px; background:linear-gradient(145deg,#f7f3ffd0,#ffffff7c); box-shadow:0 12px 26px #44516b12,inset 0 1px #fff; overflow:hidden; }
    .undo-card header { display:flex; align-items:center; gap:14px; padding:14px 17px; }
    .undo-card header > div { flex:1; min-width:0; }
    .undo-card strong { display:block; font-size:13px; color:#43346f; }
    .undo-card header small { display:block; margin-top:3px; color:#7d70a8; font-size:11px; }
    .undo-card .primary { margin-left:0; }
    .undo-card ul { margin:0; padding:0 17px 13px; list-style:none; }
    .undo-card li { display:grid; grid-template-columns:minmax(0,auto) minmax(0,1fr) auto; align-items:baseline; gap:10px; padding:6px 0; border-top:1px solid #6b5ea01a; }
    .undo-card li span { font-size:12px; font-weight:600; color:#3a3452; }
    .undo-card li code { color:#948da8; font:500 10px ui-monospace,SFMono-Regular,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .undo-card li em { font-style:normal; font-size:11px; font-weight:600; color:#453e5f; }
    .undo-card li.gone span,.undo-card li.gone code { color:#b3adc0; text-decoration:line-through; }
    .undo-card li.gone em { color:#9a5555; }
    .undo-failed { margin:0; padding:0 17px 12px; color:#9a5555; font-size:11px; }
    .putback-panel .empty-state { padding:34px 30px; text-align:center; border:1px solid #ffffffb8; border-radius:18px; background:linear-gradient(145deg,#ffffffb0,#ffffff66); }
    .putback-panel .empty-state .empty-icon { display:inline-grid; place-items:center; width:42px; height:42px; margin-bottom:10px; border-radius:13px; background:#f0eaff; color:#7958d6; }
    .putback-panel .empty-state h3 { margin:0; font-size:15px; }
    .putback-panel .empty-state p { margin:9px auto 0; max-width:58ch; color:#8f899f; font-size:12px; line-height:1.55; }
    .file-toolbar, .file-results, .file-empty { border: 1px solid #ffffffd6; background: linear-gradient(145deg, #ffffffd4, #ffffffa8); box-shadow: 0 14px 34px #44516b12, inset 0 1px #ffffff; border-radius: 18px; }
    .file-toolbar { display: flex; align-items: center; gap: 16px; padding: 11px 15px; margin-bottom: 16px; background:linear-gradient(110deg,#ffffffd8,#ffffff9b); backdrop-filter:blur(20px); }
    label { display: flex; align-items: center; gap: 8px; color: #736a88; font-size: 11px; font-weight: 600; }
    select, input { min-width: 0; border: 1px solid #dcd5ee; border-radius: 8px; background: #ffffffad; color: #39324f; padding: 8px 10px; font: inherit; }
    .file-toolbar select { max-width: min(380px, 45vw); }
    .file-toolbar > span { font-size: 11px; color: #948da8; }
    .file-toolbar .ghost-button { margin-left: auto; }
    .file-results { overflow: hidden; border-radius:21px; border-color:#ffffffed; box-shadow:0 20px 48px #50416e16,inset 0 1px #fff; }
    .results-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 22px 24px 18px; background:linear-gradient(110deg,#ffffff91,#f9f7ff42); }
    .results-heading .eyebrow { margin:0 0 6px; color:#9387ad; font-size:9px; font-weight:750; letter-spacing:.15em; }
    .results-heading h2 { margin:0; color:#302943; font-size:22px; letter-spacing:-.04em; }
    .results-heading > div { min-width: 0; }
    .results-heading p.scan-status { display:flex; align-items:center; gap:7px; margin:7px 0 5px; color:#777087; font-size:11px; }
    .status-dot { width:7px; height:7px; flex:none; border-radius:50%; background:#a39ab4; }
    .scan-status.is-scanning .status-dot { background:#34b98a; box-shadow:0 0 0 3px #34b98a20; animation:scan-pulse 1.8s ease-in-out infinite; }
    @keyframes scan-pulse { 50% { box-shadow:0 0 0 6px #34b98a08; opacity:.65; } }
    .results-heading code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9188a6; font-size: 10px; }
    .result-count { min-width:94px; padding:10px 13px; border:1px solid #e6defa; border-radius:14px; background:linear-gradient(145deg,#f6f2ff,#fff); color:#4b3d76; font-size:22px; font-weight:750; letter-spacing:-.04em; white-space:nowrap; text-align:right; font-variant-numeric:tabular-nums; }
    .result-count small { display: block; margin-top: 2px; color: #8f879f; font-size: 10px; font-weight: 550; letter-spacing:0; }
    .file-stats { display:grid; grid-template-columns:1.35fr 1fr 1fr; gap:11px; padding:0 22px 18px; }
    .file-stat { min-width:0; display:grid; gap:6px; padding:14px 16px; border:1px solid #ebe7f3; border-top:3px solid #72cbb1; border-radius:14px; background:linear-gradient(145deg,#effcf8,#ffffff); box-shadow:0 3px 10px #44345d08; }
    .file-stat:nth-child(3) { border-top-color:#efa958; background:linear-gradient(145deg,#fff8eb,#fff); }
    .file-stat .stat-label { color:#857d96; font-size:10px; font-weight:600; }
    .file-stat strong { overflow:hidden; color:#39314f; font-size:18px; font-weight:750; letter-spacing:-.025em; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; }
    .file-stat small { overflow:hidden; color:#898298; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    .file-stat.spotlight { border-color:#dfd3ff; border-top-color:#9168f4; background:linear-gradient(115deg,#f1eaff,#fff 88%); }
    .file-stat.spotlight .stat-label { color:#755ab2; }
    .file-stat.spotlight strong { color:#6949bd; font-size:14px; }
    .file-stat:nth-child(2) strong { color:#258b79; }
    .file-stat:nth-child(3) strong { color:#bc7930; }
    .file-filters { display: flex; flex-wrap: wrap; gap: 11px; align-items: center; padding: 12px 18px; background:linear-gradient(100deg,#faf9fe,#ffffff96); border-block: 1px solid #6b5ea018; }
    .search { flex: 1; min-width: 190px; }
    .search input { width: 100%; }
    .table-scroll { max-height: 580px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th { position: sticky; top: 0; z-index: 1; background: #f4f1fa; color: #817893; padding: 12px; font-size: 10px; font-weight: 700; text-align: left; letter-spacing:.015em; }
    th:nth-child(2) { width: auto; } th:nth-child(3) { width: 140px; } th:nth-child(4) { width: 80px; } th:nth-child(5) { width: 115px; } th:nth-child(6) { width: 128px; }
    td { padding: 13px 12px; border-bottom: 1px solid #6b5ea012; font-size: 11px; }
    .rank { width: 46px; text-align: center; color: #a39bb4; font-size: 10px; }
    tr.selected, tbody tr.file-row:hover { background: #f8f5ff; }
    tr.file-row { cursor: pointer; }
    .file-name { display: flex; gap: 9px; align-items: center; width: 100%; padding: 0; border: 0; background: none; text-align: left; color: #3a3452; cursor: pointer; font: inherit; }
    .file-name fa-icon { color: #8f75d8; }
    .file-name.type-video fa-icon { color:#cf609d; }.file-name.type-audio fa-icon { color:#d58a36; }.file-name.type-image fa-icon { color:#319b73; }.file-name.type-archive fa-icon { color:#c67b35; }.file-name.type-document fa-icon { color:#4389bd; }
    .file-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .file-cell code { display: block; margin: 5px 0 0 20px; color: #827b92; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-size strong { font-size: 12px; color: #534278; font-variant-numeric: tabular-nums; }
    .file-size i { display: block; height: 5px; background: #eae5f2; border-radius: 4px; margin-top: 7px; overflow: hidden; }
    .file-size b { display: block; height: 100%; background: linear-gradient(90deg,#a178f5,#687cf2 55%,#43bda4); border-radius: inherit; }
    .file-type, .file-date { color: #8c839e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .type-pill { display:inline-block; max-width:100%; overflow:hidden; padding:4px 7px; border-radius:6px; color:#7159b5; background:#eee8ff; font-size:9px; font-weight:750; letter-spacing:.035em; text-overflow:ellipsis; vertical-align:middle; }
    .type-pill.type-video { color:#a53d79; background:#fce7f3; }.type-pill.type-audio { color:#995e18; background:#fff1d9; }.type-pill.type-image { color:#18734f; background:#ddf7eb; }.type-pill.type-archive { color:#a35b22; background:#ffeadb; }.type-pill.type-document { color:#286993; background:#e1f2ff; }.type-pill.type-other { color:#675d7d; background:#eeeaf4; }
    .row-action { padding: 5px 0; border: 0; background: none; color: #7056c3; font: inherit; font-size: 11px; cursor: pointer; }
    .row-action:hover { text-decoration: underline; }
    .results-footer { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 20px; font-size: 10px; color: #9188a6; }
    .results-footer > div { display: flex; align-items: center; gap: 10px; }
    .results-footer button { padding: 6px 9px; border: 1px solid #dcd5ee; border-radius: 7px; background: #fff8; color: #7056c3; font: inherit; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    .file-empty { position:relative; isolation:isolate; overflow:hidden; min-height:220px; display:grid; grid-template-columns:58px minmax(0,1fr); align-items:center; gap:20px; padding:34px 38px; border-color:#ffffff62; border-radius:22px; color:white; background:radial-gradient(ellipse at 78% 34%,#804cbd 0,transparent 43%),linear-gradient(112deg,#301058 0%,#552078 48%,#155f5f 115%); box-shadow:0 22px 48px #36135a25,inset 0 1px #ffffff35; }
    .file-empty > :not(.empty-orb) { position:relative; z-index:1; }
    .file-empty .empty-icon { display:grid; place-items:center; width:54px; height:54px; border:1px solid #ffffff4c; border-radius:17px; color:white; background:#ffffff20; font-size:22px; box-shadow:inset 0 1px #ffffff30; }
    .file-empty .eyebrow { margin:0 0 8px; color:#d6c2f0; font-size:10px; font-weight:700; letter-spacing:.15em; }
    .file-empty h2 { margin:0; color:#fff; font-size:clamp(22px,2.5vw,30px); letter-spacing:-.04em; }
    .file-empty p:not(.eyebrow) { max-width:64ch; margin:8px 0 16px; color:#eee2fa; font-size:12px; line-height:1.6; }
    .file-empty .hero-scan { display:inline-flex; align-items:center; gap:10px; padding:11px 15px; border:1px solid #d4fff0; border-radius:11px; background:linear-gradient(110deg,#baffdf,#77e4bd); color:#184b47; box-shadow:0 9px 24px #062f352c,inset 0 1px #ffffff; font:700 12px inherit; cursor:pointer; }
    .empty-orb { position:absolute; z-index:0; pointer-events:none; border:1px solid #ffffff24; border-radius:50%; background:linear-gradient(145deg,#ffffff0f,#9cf4d914); }
    .orb-a { width:230px; height:230px; right:17%; top:-140px; }.orb-b { width:180px; height:180px; right:6%; bottom:-135px; }
    tr.file-row.selected td { border-bottom-color: transparent; }
    tr.file-row.selected td:first-child, .detail-row td { box-shadow: inset 3px 0 #9168f4; }
    .detail-row td { padding: 0 16px 14px 66px; background: #f8f5ff; }
    .file-detail { display: flex; align-items: center; gap: 18px; padding: 11px 14px; border-radius: 11px; background: #ffffff9e; animation: detail-open .16s ease-out; transition: background .15s; }
    .file-detail.confirming { background: #fff1f4; }
    @keyframes detail-open { from { opacity: 0; transform: translateY(-3px); } }
    .detail-info { min-width: 0; flex: 1; display: grid; gap: 7px; }
    .crumbs { display: flex; align-items: center; gap: 5px; overflow: hidden; color: #9a91ab; font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
    .crumbs span { flex: none; }
    .crumbs span:last-of-type { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #4a3f6b; font-weight: 700; }
    .crumbs i { color: #cfc7de; font-style: normal; }
    .facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; }
    .fact { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 20px; background: #f1edf9; color: #7d7391; font-size: 10px; white-space: nowrap; }
    .fact strong { color: #4a3f6b; font-weight: 700; }
    .fact .meter { display: block; width: 38px; height: 4px; overflow: hidden; border-radius: 4px; background: #ddd5ec; }
    .fact .meter b { display: block; height: 100%; min-width: 2px; border-radius: inherit; background: linear-gradient(90deg,#a178f5,#687cf2 55%,#43bda4); }
    .fact.caution { background: #fff3df; color: #9a6c25; }
    .fact.caution fa-icon { color: #d39a3f; font-size: 9px; }
    .detail-actions { display: flex; flex: none; align-items: center; gap: 6px; }
    .confirm-text { margin-right: 4px; color: #8f4b5e; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border: 1px solid #e0d8f1; border-radius: 8px; background: #fff; color: #5f48b5; font: inherit; font-size: 11px; font-weight: 600; white-space: nowrap; box-shadow: 0 1px 2px #44345d0d; transition: background .12s, border-color .12s, color .12s, box-shadow .12s, transform .12s; }
    .btn fa-icon { font-size: 10px; opacity: .85; }
    .btn:hover:not(:disabled) { border-color: #b9a6f2; background: #f3eeff; color: #4b33a3; box-shadow: 0 3px 8px #6b4fc922; transform: translateY(-1px); }
    .btn:active:not(:disabled) { transform: none; box-shadow: 0 1px 2px #44345d0d; }
    .btn:focus-visible { outline: 2px solid #9168f4; outline-offset: 2px; }
    .btn-danger { border-color: #f0cfd8; color: #b04c67; }
    .btn-danger:hover:not(:disabled) { border-color: #e39aae; background: #fff0f3; color: #9c3653; box-shadow: 0 3px 8px #c8566f22; }
    .btn-danger-solid { border-color: #c4506a; background: #d0607a; color: #fff; }
    .btn-danger-solid:hover:not(:disabled) { border-color: #a93d56; background: #bb4863; color: #fff; box-shadow: 0 3px 10px #c8566f40; }
    @media (max-width: 1000px) { .file-detail { flex-direction: column; align-items: stretch; } .detail-actions { flex-wrap: wrap; } }
    .trash-button { padding: 9px 12px; border: 1px solid #e4b9c6; background: #fff6f8; color: #a74862; border-radius: 9px; font-size: 11px; cursor: pointer; }
    .message, .access-note { padding: 12px 16px; background: #fff7; border-radius: 9px; color: #78628d; font-size: 12px; }
    .message.error { color: #ac4b61; }
    .access-note { margin: 0 24px 10px; background: #fff1d970; color: #987445; font-size: 11px; }
    .no-results { padding: 48px; text-align: center; color: #948da8; }
    .view-tabs { display:flex; gap:6px; padding:0 22px 14px; }
    .view-tabs button { display:inline-flex; align-items:center; gap:8px; padding:9px 14px; border:1px solid #e3ddf0; border-radius:11px; background:#ffffff8a; color:#6f6584; font:inherit; font-size:12px; font-weight:650; }
    .view-tabs button:hover { background:#fff; }
    .view-tabs button.active { border-color:#cbbcf5; background:linear-gradient(145deg,#f1eaff,#fff); color:#5a3fb0; box-shadow:0 4px 12px #6b4fc914; }
    .view-tabs fa-icon { font-size:11px; opacity:.8; }
    .tab-badge { padding:2px 7px; border-radius:20px; background:#eeeaf4; color:#7d7391; font-size:10px; font-weight:650; font-variant-numeric:tabular-nums; }
    .tab-badge.found { background:#ffeadb; color:#a35b22; }
    .tab-badge.new { background:#ddf7eb; color:#18734f; }
    .tab-badge.busy { background:#e1f2ff; color:#286993; }
    .duplicates-panel { padding: 18px 22px 22px; border-top:1px solid #6b5ea018; }
    .folder-map-panel { padding:18px 22px 22px; border-top:1px solid #6b5ea018; }
    .folder-map-heading { display:flex; align-items:center; justify-content:space-between; gap:14px; }
    .folder-map-heading h3 { margin:0; color:#302943; font-size:16px; }
    .folder-map-heading code { display:block; max-width:60vw; margin-top:4px; overflow:hidden; color:#948da8; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    .folder-map-heading > div:last-child { display:flex; gap:8px; }
    .folder-map-note { margin:9px 0 14px; color:#898298; font-size:11px; }
    .folder-map-list { display:grid; gap:7px; }
    .folder-map-row { display:grid; grid-template-columns:minmax(130px, 1fr) minmax(100px, 2fr) 90px; align-items:center; gap:14px; padding:9px 12px; border:1px solid #e8e2f2; border-radius:10px; background:#ffffffa8; }
    .folder-map-name { display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden; border:0; background:none; color:#514575; font:600 11px inherit; text-align:left; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
    .folder-map-name small { color:#948da8; font-size:9px; font-weight:400; }
    .folder-map-meter { display:block; height:8px; overflow:hidden; border-radius:99px; background:#e4e6f1; }
    .folder-map-meter b { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#8a6cf4,#5b94e9); }
    .folder-map-row > strong { color:#41385b; font-size:11px; text-align:right; }
    @media (max-width:700px) { .folder-map-row { grid-template-columns:minmax(0,1fr) 70px; gap:8px; }.folder-map-meter { grid-column:1; grid-row:2; }.folder-map-row > strong { grid-column:2; grid-row:1 / span 2; }.folder-map-heading { align-items:flex-start; flex-direction:column; } }
    .duplicates-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    .duplicates-heading h2 { margin:0; color:#302943; font-size:18px; }.duplicates-heading p:not(.eyebrow) { margin:5px 0 0; color:#898298; font-size:11px; }
    .duplicates-heading .eyebrow { margin:0 0 5px; color:#9387ad; font-size:9px; font-weight:750; letter-spacing:.15em; }
    .duplicate-group { margin-top:12px; border:1px solid #e8e2f2; border-radius:12px; overflow:hidden; background:#ffffff8c; }
    .duplicate-group header,.duplicate-file { display:flex; align-items:center; gap:12px; padding:10px 13px; }.duplicate-group header { background:#f7f4fc; color:#665b7f; font-size:11px; }.duplicate-group header span { color:#958ca5; }
    .duplicate-file { border-top:1px solid #6b5ea012; cursor:pointer; }.duplicate-file input { accent-color:#7958d6; }.duplicate-file span { min-width:0; flex:1; }.duplicate-file strong,.duplicate-file code { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.duplicate-file strong { color:#433a59; font-size:11px; }.duplicate-file code { margin-top:3px; color:#948da8; font-size:10px; }.duplicate-file em { color:#898298; font-size:10px; font-style:normal; white-space:nowrap; }
    .duplicate-summary { color:#756889; font-size:11px; }.duplicate-actions { display:flex; align-items:center; justify-content:flex-end; gap:10px; padding-top:14px; color:#756889; font-size:11px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .files-page button { cursor:pointer; }
    .files-page button:disabled { cursor:default; }
    @media (max-width: 1000px) { th:nth-child(4), td:nth-child(4), th:nth-child(5), td:nth-child(5) { display: none; } }
    @media (max-width: 700px) { .file-toolbar { flex-wrap: wrap; }.file-toolbar .ghost-button { margin-left: 0; }.file-toolbar > span { display: none; }.file-filters, .results-heading { padding: 14px; }.file-stats { grid-template-columns:1fr; padding:0 14px 14px; }.file-empty { grid-template-columns:1fr; padding:23px; gap:13px; }.file-empty .empty-icon { width:44px; height:44px; }th:nth-child(3) { width: 90px; } th:nth-child(6), td:nth-child(6) { display: none; }.rank { width: 30px; } td { padding: 10px 7px; } }
  `]
})
export class FileManagerComponent {
  readonly inventory = inject(FileInventoryService);
  private readonly monitor = inject(SystemMonitorService);
  readonly removals = inject(RemovalsService);
  readonly faFile = faFile; readonly faFolderOpen = faFolderOpen; readonly faMagnifyingGlass = faMagnifyingGlass; readonly faRotateLeft = faRotateLeft; readonly faArrowRight = faArrowRight; readonly faArrowDownWideShort = faArrowDownWideShort; readonly faClone = faClone; readonly faClockRotateLeft = faClockRotateLeft; readonly faCopy = faCopy; readonly faTrashCan = faTrashCan; readonly faTriangleExclamation = faTriangleExclamation;
  readonly search = signal(''); readonly kind = signal('all'); readonly minimum = signal(0); readonly page = signal(0);
  readonly selected = signal<FileEntry | null>(null); readonly confirmTrash = signal(false); readonly busy = signal(false); readonly message = signal(''); readonly putBackView = signal(false);
  readonly confirmDuplicates = signal(false);
  readonly view = signal<'largest' | 'duplicates' | 'folders'>('largest');
  readonly folderMapPath = signal('');
  /** What keeping one copy of every group would free — the number worth showing before anyone opens the tab. */
  readonly reclaimableBytes = computed(() => this.inventory.duplicateGroups().reduce((sum, group) => sum + group.bytes * (group.files.length - 1), 0));
  readonly duplicateSelected = computed(() => this.inventory.duplicateGroups().flatMap(group => group.files.filter(file => file.selected)));
  readonly duplicateBytes = computed(() => this.duplicateSelected().reduce((sum, file) => sum + file.bytes, 0));
  readonly customTarget = computed(() => {
    const target = this.inventory.target();
    return target && target !== '__home__' && !this.inventory.volumes().some(volume => volume.path === target) ? target : '';
  });
  readonly startupVolumeName = computed(() => {
    const name = this.monitor.storage()?.disks.find(disk => disk.isStartupDisk)?.volumes.find(volume => volume.role === 'Data')?.name ?? 'Macintosh HD - Data';
    return name.replace(/(?:\s*-\s*Data)+$/i, ' - Data');
  });
  readonly pageSize = 100;
  readonly filtered = computed(() => this.inventory.files());
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.inventory.matchingCount() / this.pageSize)));
  readonly currentPage = computed(() => Math.min(this.page(), this.pageCount() - 1));
  readonly visible = computed(() => this.inventory.files());
  readonly largest = computed(() => this.visible()[0]?.bytes ?? 0);
  readonly topFileName = computed(() => this.inventory.largestName() || (this.inventory.scanning() ? 'Still scanning…' : 'No files found'));
  readonly topFileSize = computed(() => this.inventory.largestBytes() ? this.format(this.inventory.largestBytes()) : 'The list updates as files are found');
  readonly totalBytes = computed(() => this.inventory.totalBytes());
  constructor() { void this.loadPage(); }
  openFolderMap(): void {
    const root = this.inventory.root();
    if (!root || !this.inventory.scanned() || this.inventory.partial()) return;
    this.view.set('folders');
    this.folderMapPath.set(root);
    void this.inventory.loadFolderMap(root);
  }
  folderMapEnter(path: string): void { this.folderMapPath.set(path); void this.inventory.loadFolderMap(path); }
  folderMapUp(): void {
    const path = this.folderMapPath();
    if (!path || path === this.inventory.root()) return;
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    const root = this.inventory.root();
    this.folderMapPath.set(parent === root || parent.startsWith(root + '/') ? parent : root);
    void this.inventory.loadFolderMap(this.folderMapPath());
  }
  folderMapName(): string { return this.folderMapPath().split('/').filter(Boolean).at(-1) ?? this.folderMapPath(); }
  folderMapShare(bytes: number): number {
    const max = Math.max(1, ...this.inventory.folderMapEntries().map(entry => entry.bytes));
    return Math.max(2, bytes / max * 100);
  }
  async revealMapFile(path: string): Promise<void> {
    try { const result = await window.electronAPI?.revealFile(path); if (!result?.revealed) this.message.set('Could not show this file in Finder.'); }
    catch { this.message.set('Could not show this file in Finder.'); }
  }
  loadPage(): void {
    const request = { page: this.page(), pageSize: this.pageSize, query: this.search(), kind: this.kind(), minimum: this.minimum() };
    setTimeout(() => void this.inventory.refreshPage(request), 120);
  }
  changePage(page: number): void { this.page.set(page); void this.inventory.refreshPage({ page, pageSize: this.pageSize, query: this.search(), kind: this.kind(), minimum: this.minimum() }); }
  format(bytes: number): string { return bytes < 1024 ? bytes + ' B' : formatBinaryBytes(bytes) ?? '—'; }
  fileKind(extension: string): string {
    if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'].includes(extension)) return 'video';
    if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'aiff', 'ogg'].includes(extension)) return 'audio';
    if (['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp', 'tiff', 'raw', 'svg', 'psd'].includes(extension)) return 'image';
    if (['zip', 'dmg', 'iso', 'tar', 'gz', '7z', 'rar', 'pkg'].includes(extension)) return 'archive';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'pages', 'numbers', 'key'].includes(extension)) return 'document';
    return 'other';
  }
  /** The path as folders the eye can walk, with the middle folded away once it gets long. */
  crumbs(path: string): string[] {
    const shown = path.replace(/^\/Users\/[^/]+(?=\/)/, '~');
    const parts = shown.split('/').filter(Boolean);
    return parts.length > 5 ? [parts[0], '…', ...parts.slice(-3)] : parts;
  }
  shareValue(bytes: number): number { const total = this.totalBytes(); return total ? Math.min(100, bytes / total * 100) : 0; }
  share(bytes: number): string { const value = this.shareValue(bytes); return value >= 10 ? value.toFixed(0) + '%' : value >= 0.1 ? value.toFixed(1) + '%' : '< 0.1%'; }
  age(modifiedAt: number): string {
    const days = Math.floor((Date.now() - modifiedAt) / 86_400_000);
    if (days < 1) return 'Today';
    if (days < 2) return 'Yesterday';
    if (days < 60) return days + ' days ago';
    if (days < 730) return Math.floor(days / 30) + ' months ago';
    return Math.floor(days / 365) + ' years ago';
  }
  isAppData(path: string): boolean { return /\/Library\//.test(path); }
  select(file: FileEntry): void { if (this.busy() || window.getSelection()?.toString()) return; if (this.selected()?.path === file.path) { this.selected.set(null); this.confirmTrash.set(false); return; } this.selected.set(file); this.confirmTrash.set(false); setTimeout(() => document.getElementById('file-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })); }
  async startScan(): Promise<void> { if (this.busy()) return; this.selected.set(null); this.confirmTrash.set(false); this.page.set(0); await this.inventory.scan(); }
  async changeTarget(target: string): Promise<void> { this.inventory.target.set(target); await this.startScan(); }
  async chooseFolder(): Promise<void> { const result = await window.electronAPI?.chooseFolder(); if (result?.granted && result.path) { this.inventory.target.set(result.path); await this.startScan(); } }
  async reveal(file: FileEntry): Promise<void> { try { const result = await window.electronAPI?.revealFile(file.path); if (!result?.revealed) this.message.set('Could not show this file in Finder.'); } catch { this.message.set('Could not show this file in Finder.'); } }
  async copyPath(file: FileEntry): Promise<void> { try { await navigator.clipboard.writeText(file.path); this.message.set('Path copied.'); } catch { this.message.set('Could not copy the path.'); } }
  exportCsv(): void {
    const cell = (value: string | number) => '"' + String(value).replace(/^[=+@\-\t\r]/, match => "'" + match).replace(/"/g, '""') + '"';
    const rows = [['Rank', 'Name', 'Path', 'Bytes', 'Extension', 'Modified'], ...this.filtered().map((file, index) => [this.currentPage() * this.pageSize + index + 1, file.name, file.path, file.bytes, file.extension, new Date(file.modifiedAt).toISOString()])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'openclean-largest-files.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async trash(file: FileEntry): Promise<void> {
    if (this.busy() || this.inventory.scanning() || !this.confirmTrash() || !file.removable) return;
    this.busy.set(true); this.message.set('');
    try {
      const result = await window.electronAPI?.trashPaths([file.path], file.name, 'files');
      if (result?.trashed) { await window.electronAPI?.removeFromFileInventory(result.trashedPaths); this.selected.set(null); await this.inventory.refreshPage({ page: this.currentPage(), pageSize: this.pageSize, query: this.search(), kind: this.kind(), minimum: this.minimum() }); await this.removals.refresh(); }
      this.message.set(result?.failures.join(' · ') || (result?.trashed ? `Moved ${file.name} to the Trash. Use Put back to return it.` : 'Could not move this file to the Trash.'));
    } catch { this.message.set('Could not move this file to the Trash.'); }
    finally { this.busy.set(false); this.confirmTrash.set(false); }
  }
  async putBack(id: string): Promise<void> {
    await this.removals.restore(id);
    const result = this.removals.lastResult();
    // The list on the main page was built before the file came back; saying so beats a silent gap.
    if (result?.id === id && result.restored && this.inventory.scanned()) this.message.set('Put back. Scan again to see restored files in the list.');
  }
  selectedIn(group: { files: Array<FileEntry & { selected: boolean }> }): number { return group.files.filter(file => file.selected).length; }
  toggleDuplicate(group: { files: Array<FileEntry & { selected: boolean }> }, index: number, selected: boolean): void {
    this.inventory.duplicateGroups.update(groups => groups.map(item => item === group ? { ...item, files: item.files.map((file, i) => i === index ? { ...file, selected } : file) } : item));
  }
  async trashDuplicates(): Promise<void> {
    const files = this.duplicateSelected();
    if (!this.confirmDuplicates() || !files.length || this.busy()) return;
    this.busy.set(true); this.message.set('');
    try {
      const result = await window.electronAPI?.trashPaths(files.map(file => file.path), 'Duplicate files', 'files');
      if (result?.trashed) {
        const trashed = new Set(result.trashedPaths);
        await window.electronAPI?.removeFromFileInventory([...trashed]);
        this.inventory.duplicateGroups.update(groups => groups.map(group => ({ ...group, files: group.files.filter(file => !trashed.has(file.path)).map(file => ({ ...file, selected: false })) })).filter(group => group.files.length > 1));
        await this.inventory.refreshPage({ page: this.currentPage(), pageSize: this.pageSize, query: this.search(), kind: this.kind(), minimum: this.minimum() });
        await this.removals.refresh();
      }
      this.message.set(result?.failures.join(' · ') || (result?.trashed ? `${result.trashed} duplicate file(s) moved to the Trash.` : 'Could not move files to the Trash.'));
    } catch { this.message.set('Could not move files to the Trash.'); }
    finally { this.busy.set(false); this.confirmDuplicates.set(false); }
  }
}
