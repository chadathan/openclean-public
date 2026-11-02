import { ChangeDetectionStrategy, Component, EventEmitter, OnDestroy, Output, computed, inject, signal } from '@angular/core';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faArrowRight, faBan, faCircleCheck, faDatabase, faDownload, faEnvelope, faFileLines,
  faFolderOpen, faHammer, faLock, faMagnifyingGlass, faRotateLeft, faTrashCan, faBroom
} from '@fortawesome/free-solid-svg-icons';
import { formatBinaryBytes } from '../dashboard/metric-format';
import { RemovalsService } from '../removals.service';
import { CleanupInventoryService, CleanupSection } from './cleanup-inventory.service';

/**
 * What is on the disk that nobody needs. Sections summarize first; the user drills into one to
 * same rule throughout: a category that cannot be read says so rather than rendering a zero.
 * Reporting an unreadable Trash as empty is not a gap, it is a claim.
 *
 * Every figure comes from the main process. The page is a view: all state belongs to the
 * inventory service, because switching tabs destroys this component.
 */

const ICONS: Record<string, IconDefinition> = {
  xcode: faHammer, appcache: faFolderOpen, downloads: faDownload, syslog: faFileLines,
  userlog: faFileLines, syscache: faDatabase, universal: faBan, versions: faFileLines,
  mail: faEnvelope, trash: faTrashCan
};

const SECTION_ICONS: Record<string, IconDefinition> = { system: faDatabase, xcode: faHammer, mail: faEnvelope, trash: faTrashCan };
const ACCENTS: Record<string, string> = {
  xcode: '#2f7fd1', appcache: '#8d6cf5', downloads: '#20a775', syslog: '#6b7ba8',
  userlog: '#4c87ea', syscache: '#6b7ba8', universal: '#c04a4a', versions: '#6b7ba8',
  mail: '#c98a2e', trash: '#c98a2e'
};

@Component({
  selector: 'oc-cleanup', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FontAwesomeModule],
  template: `
    <section class="cleanup-page">
      <div class="page-heading">
        <div>
          <p class="eyebrow">CLEANUP</p>
          <h1>Cleanup Manager</h1>
          <p class="muted">See what Cleanup can safely remove, review the files, and send them to the Trash where you can put them back.</p>
        </div>
        <div class="cleanup-heading-actions">
          @if (screen() === 'browse' && phase() === 'browse' && !putBackView() && detailView() && scanned() > 0) {
          <div class="sort-group" role="group" aria-label="What to select">
            <button type="button" (click)="selectAll()">Select all</button>
            <button type="button" [class.on]="preset() === 'smart'" (click)="selectSmartly()">Select smartly</button>
            <button type="button" [class.on]="preset() === 'none'" (click)="clearSelection()">Select none</button>
          </div>
          }
          @if (screen() === 'browse' && phase() === 'browse') {
            @if (putBackView()) { <button class="ghost-button" type="button" (click)="putBackView.set(false)">Back to Cleanup</button> }
            @else {
              @if (scanned() > 0 && !detailView()) { <button class="ghost-button" type="button" (click)="scan()"><fa-icon [icon]="faRotateLeft" />Scan again</button> }
              <button class="ghost-button" type="button" (click)="putBackView.set(true)"><fa-icon [icon]="faRotateLeft" />Put back @if (removals.cleanup().length) { <em>{{ removals.cleanup().length }}</em> }</button>
            }
          }
        </div>
      </div>

      @if (putBackView()) {
          <section class="putback-panel">
            <h2 class="list-title">Recent removals</h2>
            <p class="list-note">Putting one back returns every piece to where it came from. Pieces emptied from the Trash cannot be restored.</p>
            @if (removals.cleanup().length) {
              <div class="undo-list">
                @for (removal of removals.cleanup(); track removal.id) {
                  <article class="undo-card">
                    <header>
                      <div><strong>{{ removal.label }}</strong><small>{{ removal.entries.length }} {{ removal.entries.length === 1 ? 'item' : 'items' }} · {{ size(removal.bytes) }} · {{ removals.since(removal.removedAt) }}</small></div>
                      <button class="primary" type="button" [disabled]="removals.restoring() === removal.id" (click)="removals.restore(removal.id)">{{ removals.restoring() === removal.id ? 'Putting back…' : 'Put back' }}</button>
                    </header>
                    <ul>
                      @for (entry of removal.entries; track entry.originalPath) {
                        <li [class.gone]="entry.available === false"><span>{{ entry.label }}</span><code>{{ entry.originalPath }}</code><em>{{ entry.available === false ? 'emptied' : size(entry.bytes) }}</em></li>
                      }
                    </ul>
                    @if (removals.lastResult(); as outcome) { @if (outcome.id === removal.id && outcome.failures.length) { <p class="undo-failed">{{ outcome.failures.join(' · ') }}</p> } }
                  </article>
                }
              </div>
            } @else {
              <article class="empty-state"><span class="empty-icon"><fa-icon [icon]="faRotateLeft" /></span><h3>Nothing to put back</h3><p>Anything you remove here is listed until you return it or empty the Trash yourself.</p></article>
            }
          </section>
      }

      @if (screen() === 'idle' && !putBackView()) {
        @if (scanError(); as error) { <p class="scan-banner scan-error" role="alert">{{ error }}</p> }
        <section class="cleanup-dashboard">
          <section class="cleanup-hero">
            <span class="hero-icon"><fa-icon [icon]="faBroom" /></span>
            <div><p class="hero-kicker">OPEN CLEANUP</p><h2>Make room with confidence</h2><p>Review system junk, downloaded mail attachments, and old Trash items. Nothing moves until you choose it.</p><small>Every selected item goes to the Trash and can be put back.</small></div>
            <button class="hero-scan" type="button" (click)="scan()"><fa-icon [icon]="faMagnifyingGlass" />Scan for clutter<fa-icon [icon]="faArrowRight" /></button>
            <span class="hero-orb orb-one"></span><span class="hero-orb orb-two"></span>
          </section>
          <aside class="putback-shortcut"><span class="putback-shortcut-icon"><fa-icon [icon]="faRotateLeft" /></span><div><strong>Put files back</strong><small>{{ removals.cleanup().length ? removals.cleanup().length + ' removals can be restored' : 'Recently removed files stay recoverable here' }}</small></div><button type="button" class="ghost-button" (click)="putBackView.set(true)">View</button></aside>
        </section>
      }

      @if (screen() === 'browse' && phase() === 'browse' && !putBackView()) {
        @if (scanError(); as error) { <p class="scan-banner scan-error">{{ error }}</p> }
        @if (scanning()) {
          <section class="scan-progress-card">
            <span class="scan-progress-icon"><fa-icon [icon]="faMagnifyingGlass" /></span>
            <div>
              <h2>Finding clutter</h2>
              <p>Reading each location and measuring what it contains. Nothing is selected or moved while the scan runs.</p>
              <div class="scan-progress"><i [style.width.%]="scanTotal() ? (scanned() / scanTotal()) * 100 : 0"></i></div>
              <small>{{ scanned() }} of {{ scanTotal() || '…' }} locations checked</small>
            </div>
            <button class="ghost-button" type="button" (click)="cancel()">Stop</button>
          </section>
        } @else if (scanned() > 0 && !detailView()) {
          <section class="scan-summary">
            <header><div><p class="eyebrow">CLEANUP SUMMARY</p><h2>There are {{ size(foundBytes()) }} of clutter on your Mac</h2><p>{{ scannedLabel() }} · {{ size(safeBytesTotal()) }} can be selected as safe to remove</p></div><button class="primary" type="button" (click)="detailView.set(true)">Review all junk</button></header>
            @if (disk(); as drive) {
              <section class="disk-capacity scan-disk-capacity" aria-label="Disk space and cleanup estimate">
                <div class="disk-capacity-heading"><span class="disk-capacity-icon"><fa-icon [icon]="faDatabase" /></span><div><p class="eyebrow">{{ drive.name }}</p><h2>{{ size(drive.totalBytes) }} total disk space</h2></div></div>
                <div class="disk-capacity-meter" role="img" [attr.aria-label]="'Disk used ' + drive.usedPercent + ' percent' + (swapUsedBytes() !== null ? ', including macOS Swap shown in orange' : '')">
                  <i [style.width.%]="drive.usedPercent">
                    <b class="disk-swap-portion" [class.visible]="swapUsedBytes() !== null && swapUsedBytes()! > 0" [style.width.%]="swapPercentOfUsed(drive)"></b>
                  </i>
                </div>
                @if (swapUsedBytes() !== null && swapUsedBytes()! > 0) {
                  <div class="disk-capacity-legend"><span><i class="legend-used"></i>Used space</span><span><i class="legend-swap"></i>macOS Swap (included in used)</span></div>
                }
                <div class="disk-capacity-stats"><span><b>{{ size(drive.freeBytes) }}</b> free now</span><span><b>{{ size(safeBytesTotal()) }}</b> safe to remove</span><span><b>Up to {{ size(projectedFreeBytes()) }}</b> free after permanent deletion*</span></div>
                <small class="disk-capacity-note">*Estimate assumes all safe items are deleted from this disk. Moving items to Trash does not free space until Trash is emptied.</small>
                @if (swapUsedBytes() !== null) {
                  <div class="swap-note" role="note">
                    <strong>macOS Swap: {{ size(swapUsedBytes()!) }} currently in use</strong>
                    <span>macOS uses disk space to help manage memory. Cleanup cannot remove active Swap, so available space may not increase by the full estimate.</span>
                  </div>
                }
              </section>
            }
            @if (recommendations().length) {
              <section class="recommendations" aria-label="Cleanup recommendations">
                <p class="eyebrow">SUGGESTED NEXT STEPS</p>
                @for (recommendation of recommendations(); track recommendation.title) {
                  <article class="recommendation-row"><div><strong>{{ recommendation.title }}</strong><small>{{ recommendation.detail }}</small></div>@if (recommendation.section) { <button type="button" (click)="selectSection(recommendation.section!)">{{ recommendation.action }}</button> }</article>
                }
              </section>
            }
            <div class="summary-cards">
              @for (section of sections(); track section.key) {
                <button type="button" class="summary-card" [attr.data-section]="section.key" (click)="selectSection(section)">
                  <span class="summary-icon"><fa-icon [icon]="sectionIcon(section.key)" /></span>
                  <span class="summary-copy"><strong>{{ section.label }}</strong><small>{{ sectionDescription(section.key) }}</small><em>{{ sectionItemCount(section) }} items · {{ sectionReviewHint(section) }}</em></span>
                  <span class="summary-size">{{ size(sectionBytes(section)) }}</span><fa-icon class="summary-arrow" [icon]="faArrowRight" />
                </button>
              }
            </div>
          </section>
        } @else if (scanned() > 0) {
        <section class="cleanup-details">
          <div class="detail-topline"><button type="button" class="text-back" (click)="detailView.set(false)"><fa-icon [icon]="faArrowRight" /> Overview</button><span>Choose a category, review the files, then select what to remove.</span></div>
          <nav class="section-tabs" aria-label="Cleanup categories">
            @for (section of sections(); track section.key) {
              <button type="button" [class.on]="sectionKey() === section.key" (click)="selectSection(section)"><fa-icon [icon]="sectionIcon(section.key)" />{{ section.label }}<small>{{ size(sectionBytes(section)) }}</small></button>
            }
          </nav>
          <div class="manager-layout cleanup-detail-layout">
          <aside class="filter-rail">
            <h2>{{ section()?.label }}</h2>
            <p>{{ section()?.blurb }}</p>
            @for (category of section()?.categories ?? []; track category.key) {
              <button type="button" class="filter tall" [class.on]="categoryKey() === category.key" (click)="categoryKey.set(category.key)">
                <span>{{ category.label }}<small>{{ categoryCaption(category) }}</small></span>
                <!-- The badge is what "Select smartly" would tick, not the whole category. A
                     figure you can act on, beside a figure you cannot. -->
                @if (safeBytes(category) > 0) { <em class="badge">{{ size(safeBytes(category)) }}</em> }
              </button>
            }
          </aside>

          <section class="manager-main">
            @if (category(); as active) {
              <div class="category-heading">
                <div><h3 class="list-title">{{ active.label }}</h3><p class="list-note">{{ active.blurb }}</p></div>
                @if (active.key === 'trash' && active.items.length) {
                  <button class="empty-trash-button" type="button" [disabled]="emptyingTrash()" (click)="emptyTrash(categoryPaths(active), true)">{{ emptyingTrash() ? 'Emptying…' : 'Empty Trash' }}</button>
                }
              </div>
              @if (trashActionMessage()) { <p class="trash-action-message" role="status">{{ trashActionMessage() }}</p> }

              @if (active.state === 'found') {
                <div class="junk-list">
                  @for (item of active.items; track item.id) {
                    <article class="junk-row" [class.suggested]="item.safe" [class.reported]="item.offered === false"
                             [style.--accent]="accent(active.key)" (click)="item.offered === false ? null : toggleItem(item)">
                      @if (item.offered === false) { <span class="tick disabled" aria-hidden="true"></span> }
                      @else { <button class="tick" type="button" [class.on]="selected().has(item.id)" [attr.aria-label]="'Select ' + item.label"></button> }
                      @if (item.icon) { <img class="junk-app-icon" [src]="item.icon" alt="" /> }
                      @else { <span class="junk-icon"><fa-icon [icon]="icon(active.key)" /></span> }
                      <div class="junk-copy">
                        <strong>{{ item.label }}@if (item.safe) { <span class="safe-flag">{{ item.flag ?? 'comes back on its own' }}</span> }</strong>
                        <code>{{ item.path }}</code>
                        @if (item.note) { <em>{{ item.note }}</em> }
                      </div>
                      <span class="junk-size"><strong>{{ size(item.bytes) }}</strong></span>
                    </article>
                  }
                </div>
              } @else {
                <article class="blocked" [class.refused]="active.state === 'refused'">
                  <span class="blocked-icon"><fa-icon [icon]="active.state === 'refused' ? faBan : active.state === 'locked' ? faLock : faCircleCheck" /></span>
                  <div>
                    <h4>{{ active.status }}</h4>
                    <p>{{ active.reason }}</p>
                    @if (active.items.length) {
                      <p class="blocked-size">Measured at {{ size(categoryBytes(active)) }}, but not offered for removal here.</p>
                    }
                    @if (active.facts?.length) {
                      <dl class="blocked-facts">
                        @for (fact of active.facts; track fact.label) {
                          <div><dt>{{ fact.label }}</dt><dd>{{ fact.value }}</dd>@if (fact.detail) { <small>{{ fact.detail }}</small> }</div>
                        }
                      </dl>
                    }
                  </div>
                  @if (active.state === 'locked') { <button class="ghost-button" type="button" (click)="openPrivacySettings()">Open Settings</button> }
                </article>
              }
            }
          </section>
          </div>
        </section>

        <footer class="selection-bar" [class.armed]="selectionCount() > 0">
          @if (selectionCount() > 0) {
            <span class="selection-count">{{ selectionCount() }} selected</span>
            <strong>{{ size(selectionBytes()) }}</strong>
            <button class="link-button" type="button" (click)="clearSelection()">Clear</button>
            @if (sectionKey() === 'trash') {
              <button class="empty-trash-button" type="button" [disabled]="emptyingTrash()" (click)="emptyTrash(selectedPaths())">{{ emptyingTrash() ? 'Deleting…' : 'Delete selected permanently' }}</button>
            } @else {
              <button class="primary" type="button" (click)="phase.set('review')">Review selected <fa-icon [icon]="faArrowRight" /></button>
            }
          } @else {
            <span class="selection-count dim">Nothing selected</span>
            <small>{{ sectionKey() === 'trash' ? 'Select Trash items to delete permanently, or use Empty Trash to remove everything listed.' : 'Tick what you want removed, or use Select smartly to take only what comes back on its own.' }}</small>
          }
        </footer>
        }
      }

      @if (phase() === 'review') {
        <section class="review-panel">
          <p class="eyebrow">STEP 2 OF 2</p>
          <h2>Move {{ size(selectedBytes()) }} to the Trash?</h2>
          <p class="muted">These go to the Trash, not to nowhere. Finder will not offer to put them back — it only remembers what it moved itself — so OpenClean keeps a note of where each one came from and can return them for you.</p>
          <ul class="review-list">
            @for (line of selectedLines(); track line.id) {
              <li><span class="review-dot"></span><div><strong>{{ line.label }}</strong><code>{{ line.path }}</code></div><span>{{ size(line.bytes) }}</span></li>
            }
          </ul>
          <div class="review-total"><span>Total</span><strong>{{ size(selectedBytes()) }}</strong></div>
          <div class="review-actions">
            <button class="ghost-button" type="button" (click)="phase.set('browse')">Back</button>
            <button class="primary" type="button" (click)="trashSelected()">Move to Trash <fa-icon [icon]="faArrowRight" /></button>
          </div>
        </section>
      }

      @if (phase() === 'removing') {
        <section class="cleanup-moving" aria-live="polite">
          <div class="moving-stage">
            <span class="moving-glow"></span>
            <span class="moving-bin"><fa-icon [icon]="faTrashCan" /></span>
            @for (line of selectedLines().slice(0, 4); track line.id; let i = $index) {
              <span class="flying-file" [style.--i]="i"><fa-icon [icon]="faFileLines" /></span>
            }
          </div>
          <p class="eyebrow">STEP 2 OF 2</p>
          <h2>Moving items to the Trash…</h2>
          <p class="muted">Moving {{ selectedCount() }} {{ selectedCount() === 1 ? 'item' : 'items' }}. OpenClean is keeping a record so you can put them back.</p>
          <div class="moving-list">
            @for (line of selectedLines().slice(0, 4); track line.id; let i = $index) {
              <div class="moving-row" [style.--i]="i"><span>{{ line.label }}</span><strong>{{ size(line.bytes) }}</strong></div>
            }
            @if (selectedCount() > 4) { <small>and {{ selectedCount() - 4 }} more…</small> }
          </div>
        </section>
      }

      @if (phase() === 'done') {
        <section class="result-panel">
          <div class="result-summary">
            <div class="result-title"><span class="result-icon"><fa-icon [icon]="faCircleCheck" /></span><div><p class="eyebrow">CLEANUP COMPLETE</p><h2>Moved to the Trash</h2></div></div>
            <strong class="result-amount">{{ size(freedBytes()) }}</strong>
            <p class="result-count">{{ freedCount() }} {{ freedCount() === 1 ? 'item' : 'items' }} moved · You can put them back from OpenClean.</p>
            @if (restoreResult(); as outcome) {
              <p class="restore-note" [class.bad]="!outcome.restored">
                {{ outcome.restored ? 'Put back ' + outcome.restored + ' of them where they came from.' : 'Nothing could be put back.' }}
                @if (outcome.failures.length) { <span>{{ outcome.failures.join(' · ') }}</span> }
              </p>
            } @else if (removalId()) {
              <p class="restore-note">Finder cannot restore these items. OpenClean saved their original locations so you can put them back here.</p>
            }
            @if (failures().length) { <ul class="failure-list">@for (failure of failures(); track failure) { <li>{{ failure }}</li> }</ul> }
          </div>
          <aside class="result-next">
            <p class="eyebrow">WHAT HAPPENS NEXT</p>
            <h3>To free disk space</h3>
            <p>These items are in the Trash. Empty the Trash to permanently delete them and make their space available.</p>
            @if (swapUsedBytes() !== null) {
              <div class="result-swap"><span>macOS Swap</span><strong>{{ size(swapUsedBytes()!) }} in use</strong><small>Swap is managed by macOS and cannot be removed by Cleanup.</small></div>
            }
            <div class="result-actions">
              @if (removalId()) { <button class="ghost-button" type="button" [disabled]="restoring()" (click)="putBack()"><fa-icon [icon]="faRotateLeft" />{{ restoring() ? 'Putting back…' : 'Put everything back' }}</button> }
              <button class="primary" type="button" (click)="scanAgain()">Scan again</button>
              <button class="result-back" type="button" (click)="reset()">Back to results</button>
            </div>
          </aside>
        </section>
      }
    </section>
  `,
  styles: [`
    .cleanup-page { padding-top: 12px; padding-bottom: 28px; }
    .cleanup-page button:not(:disabled) { cursor:pointer; }
    .cleanup-page button:disabled { cursor:default; }
    .page-heading p.muted { max-width: 64ch; }
    .cleanup-heading-actions { display:flex; align-items:center; gap:9px; flex-shrink:0; }
    .cleanup-heading-actions .sort-group { flex:none; flex-wrap:nowrap; white-space:nowrap; }
    .cleanup-heading-actions .sort-group button { white-space:nowrap; }
    .cleanup-heading-actions .sort-group button:first-child { color:#5b48c5; font-weight:700; }
    .category-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }
    .category-heading > div { min-width:0; }
    .empty-trash-button { flex:none; padding:9px 12px; border:1px solid #efb6bd; border-radius:10px; background:linear-gradient(135deg,#fff5f5,#ffe8eb); color:#b44054; font:600 11px inherit; cursor:pointer; }
    .empty-trash-button:hover:not(:disabled) { background:#ffe0e4; }
    .empty-trash-button:disabled { opacity:.6; cursor:default; }
    .trash-action-message { margin:8px 0; color:#6f6888; font-size:11px; }
    .cleanup-dashboard { display:grid; gap:14px; }
    .disk-capacity { padding:17px 20px; border:1px solid #ffffffc8; border-radius:17px; background:linear-gradient(145deg,#ffffffbd,#ffffff75); box-shadow:0 12px 26px #44516b12,inset 0 1px #fff; }
    .disk-capacity-heading { display:flex; align-items:center; gap:11px; }
    .disk-capacity-heading > div { flex:1; min-width:0; }
    .disk-capacity-heading .eyebrow { margin:0 0 3px; color:#9589ad; font-size:9px; font-weight:700; letter-spacing:.13em; }
    .disk-capacity-heading h2 { margin:0; color:#332d43; font-size:14px; }
    .disk-capacity-heading > strong { color:#514575; font-size:12px; }
    .disk-capacity-icon { display:grid; place-items:center; width:35px; height:35px; border-radius:11px; background:#eee8ff; color:#6850c2; }
    .disk-capacity-meter { height:8px; margin:13px 0 9px; overflow:hidden; border-radius:999px; background:#e4e6f1; }
    .disk-capacity-meter > i { position:relative; display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#8a6cf4,#5b94e9); }
    .disk-swap-portion { display:none; position:absolute; top:0; right:0; height:100%; border-radius:0 999px 999px 0; background:linear-gradient(90deg,#f2b94b,#ef8966); }
    .disk-swap-portion.visible { display:block; }
    .disk-capacity-legend { display:flex; flex-wrap:wrap; gap:5px 16px; margin-top:7px; color:#827a96; font-size:9px; }
    .disk-capacity-legend span { display:inline-flex; align-items:center; gap:5px; }
    .disk-capacity-legend i { display:inline-block; width:9px; height:9px; border-radius:3px; }
    .legend-used { background:#7668e8; }.legend-swap { background:#ef9c57; }
    .disk-capacity-stats { display:flex; flex-wrap:wrap; justify-content:space-between; gap:7px 18px; color:#827a96; font-size:10px; }
    .disk-capacity-stats b { color:#41385b; font-size:11px; }
    .scan-disk-capacity { margin:0 0 14px; background:#ffffff9c; }
    .disk-capacity-note { display:block; margin-top:9px; color:#9891a5; font-size:10px; line-height:1.4; }
    .swap-note { display:grid; gap:3px; margin-top:11px; padding:10px 12px; border:1px solid #e6dcff; border-radius:10px; background:linear-gradient(100deg,#f5f0ff,#f6f8ff); color:#786e91; font-size:10px; line-height:1.45; }
    .swap-note strong { color:#57438e; font-size:11px; }
    .recommendations { padding:14px 17px; border:1px solid #e5ddf6; border-radius:14px; background:linear-gradient(120deg,#f9f6ff,#ffffffa8); }
    .recommendations > .eyebrow { margin:0 0 8px; color:#9387ad; font-size:9px; font-weight:750; letter-spacing:.13em; }
    .recommendation-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 0; border-top:1px solid #6b5ea018; }
    .recommendation-row:first-of-type { border-top:0; }
    .recommendation-row > div { min-width:0; }
    .recommendation-row strong,.recommendation-row small { display:block; }
    .recommendation-row strong { color:#463b61; font-size:11px; }
    .recommendation-row small { margin-top:3px; color:#817891; font-size:10px; line-height:1.4; }
    .recommendation-row button { flex:none; padding:7px 10px; border:1px solid #d9cff4; border-radius:8px; background:#fff; color:#624eb2; font:600 10px inherit; cursor:pointer; }
    .cleanup-hero { position:relative; isolation:isolate; min-height:238px; overflow:hidden; display:grid; grid-template-columns:58px minmax(0,1fr) auto; align-items:center; gap:20px; padding:34px 38px; border:1px solid #ffffff40; border-radius:23px; color:#fff; background:radial-gradient(ellipse at 80% 30%, #7f46b6 0, transparent 42%), linear-gradient(112deg,#301058 0%,#552078 48%,#155f5f 115%); box-shadow:0 22px 48px #36135a30,inset 0 1px #ffffff30; }
    .cleanup-hero > :not(.hero-orb) { position:relative; z-index:1; }
    .hero-icon { display:grid; place-items:center; width:54px; height:54px; border:1px solid #ffffff4c; border-radius:17px; color:#fff; background:#ffffff20; font-size:23px; box-shadow:inset 0 1px #ffffff30; }
    .hero-kicker { margin:0 0 9px; color:#d6c2f0; font-size:10px; font-weight:700; letter-spacing:.15em; }
    .cleanup-hero h2 { margin:0; color:#fff; font-size:clamp(24px,3vw,34px); letter-spacing:-.04em; }
    .cleanup-hero p:not(.hero-kicker) { max-width:60ch; margin:9px 0 0; color:#eee2fa; font-size:13px; line-height:1.55; }
    .cleanup-hero small { display:block; margin-top:12px; color:#c8e9de; font-size:11px; }
    .hero-scan { display:inline-flex; align-items:center; gap:10px; white-space:nowrap; padding:13px 17px; border:1px solid #d4fff0; border-radius:12px; background:linear-gradient(110deg,#baffdf,#77e4bd); color:#184b47; box-shadow:0 9px 24px #062f352c,inset 0 1px #ffffff; font:700 12px inherit; cursor:pointer; }
    .hero-scan:hover { transform:translateY(-1px); filter:brightness(1.04); }
    .hero-orb { position:absolute; z-index:0; pointer-events:none; border-radius:50%; border:1px solid #ffffff24; background:linear-gradient(145deg,#ffffff0f,#9cf4d914); }
    .orb-one { width:260px; height:260px; right:15%; top:-148px; }
    .orb-two { width:180px; height:180px; right:7%; bottom:-128px; }
    .summary-icon { display:grid; place-items:center; width:38px; height:38px; border-radius:12px; color:#6850c2; background:#eee8ff; }
    .summary-card[data-section="mail"] .summary-icon { color:#a86b15; background:#fff0d7; }
    .summary-card[data-section="trash"] .summary-icon { color:#b26238; background:#ffeadf; }
    .putback-shortcut { display:flex; align-items:center; gap:13px; padding:14px 18px; border:1px solid #ffffffba; border-radius:15px; background:#ffffff78; }
    .putback-shortcut-icon { display:grid; place-items:center; width:34px; height:34px; border-radius:11px; background:#fff0d7; color:#a86b15; }
    .putback-shortcut > div { flex:1; min-width:0; }
    .putback-shortcut strong,.putback-shortcut small { display:block; }
    .putback-shortcut strong { color:#39324f; font-size:12px; }
    .putback-shortcut small { margin-top:3px; color:#948da8; font-size:10px; }
    .putback-shortcut .ghost-button { margin-left:0; }
    .scan-summary,.putback-panel { padding:22px; border:1px solid #ffffffc8; border-radius:20px; background:linear-gradient(145deg,#ffffffbd,#ffffff6b); box-shadow:0 14px 30px #44516b14,inset 0 1px #fff; }
    .scan-summary > header { display:flex; align-items:center; justify-content:space-between; gap:18px; margin-bottom:15px; }
    .scan-summary > header h2 { margin:0; font-size:23px; letter-spacing:-.035em; }
    .scan-summary > header p:not(.eyebrow) { margin:6px 0 0; color:#8f899f; font-size:11px; }
    .scan-summary > header .eyebrow { margin-bottom:5px; }
    .scan-summary > header .primary { margin-left:0; white-space:nowrap; }
    .summary-cards { display:grid; gap:8px; }
    .summary-card { width:100%; display:grid; grid-template-columns:40px minmax(0,1fr) auto 18px; align-items:center; gap:13px; padding:13px 15px; border:1px solid #ffffffd6; border-radius:14px; background:#ffffff86; text-align:left; cursor:pointer; transition:background .15s,transform .15s; }
    .summary-card:hover { transform:translateY(-1px); background:#fff; }
    .summary-copy { min-width:0; display:grid; gap:3px; }
    .summary-copy strong { color:#39324f; font-size:13px; }
    .summary-copy small { overflow:hidden; color:#8f899f; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    .summary-copy em { color:#776b96; font-size:10px; font-style:normal; }
    .summary-size { color:#43346f; font-size:13px; font-weight:700; white-space:nowrap; }
    .summary-arrow { color:#8d7bae; font-size:11px; }
    .cleanup-details { display:grid; gap:12px; }
    .detail-topline { display:flex; align-items:center; gap:13px; color:#8f899f; font-size:11px; }
    .text-back { display:inline-flex; align-items:center; gap:7px; padding:8px 10px; border:1px solid #ffffffbe; border-radius:9px; background:#ffffff83; color:#6451b0; font:600 11px inherit; cursor:pointer; }
    .text-back fa-icon { transform:rotate(180deg); }
    .section-tabs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:9px; }
    .section-tabs button { min-width:0; display:grid; grid-template-columns:20px minmax(0,1fr) auto; align-items:center; gap:8px; padding:11px 13px; border:1px solid #ffffffc8; border-radius:12px; background:#ffffff78; color:#6e6683; font:600 11px inherit; text-align:left; cursor:pointer; }
    .section-tabs button.on { border-color:#cbbdf4; background:#f4f0ff; color:#604ac1; }
    .section-tabs small { color:#9a92aa; font-size:10px; font-weight:600; }
    .cleanup-detail-layout { grid-template-columns:minmax(190px,230px) minmax(0,1fr); gap:13px; }
    .cleanup-moving { max-width:590px; margin:10px auto 0; padding:26px 28px; text-align:center; border:1px solid #ffffffc8; border-radius:20px; background:linear-gradient(145deg,#ffffffc8,#ffffff88); box-shadow:0 20px 44px #44516b1f,inset 0 1px #fff; backdrop-filter:blur(26px); animation:move-panel-in .35s cubic-bezier(.2,.8,.2,1) both; }
    .moving-stage { position:relative; width:170px; height:112px; margin:0 auto 8px; }
    .moving-glow { position:absolute; width:118px; height:70px; left:26px; bottom:0; border-radius:50%; background:radial-gradient(ellipse,#bdaaff65,transparent 72%); animation:glow-pulse 1.1s ease-in-out infinite alternate; }
    .moving-bin { position:absolute; z-index:1; left:61px; bottom:7px; width:48px; height:48px; display:grid; place-items:center; border:1px solid #ddd3ff; border-radius:15px; color:#7056cf; background:linear-gradient(145deg,#f4efff,#e5dcff); box-shadow:0 8px 20px #6650ad24,inset 0 1px #fff; font-size:20px; animation:bin-bounce .55s ease-in-out infinite alternate; }
    .flying-file { position:absolute; z-index:2; top:8px; left:23px; color:#8294bb; font-size:15px; animation:file-to-trash .85s cubic-bezier(.35,.04,.65,.45) both; animation-delay:calc(var(--i) * 120ms); }
    .flying-file:nth-of-type(4) { left:64px; top:0; }.flying-file:nth-of-type(5) { left:104px; top:10px; }.flying-file:nth-of-type(6) { left:143px; top:2px; }
    .cleanup-moving .eyebrow { margin:0 0 6px; color:#9b91ae; font-size:9px; font-weight:700; letter-spacing:.14em; }
    .cleanup-moving h2 { margin:0; color:#342d47; font-size:20px; letter-spacing:-.03em; }
    .cleanup-moving > .muted { max-width:52ch; margin:8px auto 16px; color:#8f899f; font-size:11px; line-height:1.5; }
    .moving-list { display:grid; max-width:430px; margin:0 auto; border-top:1px solid #6b5ea018; }
    .moving-row { display:flex; align-items:center; justify-content:space-between; gap:14px; min-width:0; padding:9px 2px; border-bottom:1px solid #6b5ea018; color:#645b78; font-size:10px; text-align:left; animation:file-row-out .8s ease both; animation-delay:calc(var(--i) * 120ms); }
    .moving-row span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.moving-row strong { flex:none; color:#4b3e70; font-size:10px; }
    .moving-list > small { padding-top:8px; color:#a19aad; font-size:10px; }
    .result-panel { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(270px,.85fr); max-width:860px; margin:28px auto 0; overflow:hidden; border:1px solid #ffffffd9; border-radius:22px; background:linear-gradient(145deg,#ffffffde,#ffffff9c); box-shadow:0 22px 54px #44516b20,inset 0 1px #fff; backdrop-filter:blur(24px); animation:move-panel-in .42s cubic-bezier(.2,.8,.2,1) both; }
    .result-summary { min-width:0; padding:30px 34px; }
    .result-title { display:flex; align-items:center; gap:13px; }
    .result-icon { width:42px; height:42px; flex:none; display:grid; place-items:center; border-radius:14px; color:#139c70; background:linear-gradient(145deg,#e3fbf1,#c9f3e4); box-shadow:inset 0 1px #fff; font-size:18px; }
    .result-title .eyebrow,.result-next .eyebrow { margin:0 0 4px; color:#978bae; font-size:9px; font-weight:750; letter-spacing:.14em; }
    .result-title h2 { margin:0; color:#302b3d; font-size:20px; letter-spacing:-.03em; }
    .result-amount { display:block; margin:27px 0 0; color:#513c9b; font-size:clamp(38px,5vw,54px); line-height:1; letter-spacing:-.055em; }
    .result-count { margin:10px 0 0; color:#766d88; font-size:12px; line-height:1.5; }
    .result-summary .restore-note { margin:23px 0 0; padding-top:14px; border-top:1px solid #66559018; color:#938ba1; font-size:10px; line-height:1.55; }
    .result-next { display:flex; flex-direction:column; padding:29px 27px; border-left:1px solid #66559016; background:linear-gradient(150deg,#f8f6ffb8,#edf8f8a6); }
    .result-next h3 { margin:8px 0 6px; color:#39334b; font-size:15px; }
    .result-next > p:not(.eyebrow) { margin:0; color:#7f778f; font-size:11px; line-height:1.55; }
    .result-swap { display:grid; grid-template-columns:1fr auto; gap:5px 10px; margin-top:18px; padding:12px 13px; border:1px solid #eadfc8; border-radius:12px; background:#fff9edb8; }
    .result-swap span { color:#8c7653; font-size:10px; font-weight:650; }.result-swap strong { color:#805b22; font-size:10px; }.result-swap small { grid-column:1 / -1; color:#98876c; font-size:9px; line-height:1.45; }
    .result-actions { display:grid; gap:8px; margin-top:auto; padding-top:22px; }.result-actions > button { width:100%; justify-content:center; margin:0; }
    .result-back { padding:7px; border:0; background:transparent; color:#776b96; font:600 10px inherit; cursor:pointer; }
    @media (max-width:700px) { .result-panel { grid-template-columns:1fr; margin-top:14px; }.result-summary { padding:24px; }.result-next { border-top:1px solid #66559016; border-left:0; padding:22px 24px; }.result-actions { grid-template-columns:1fr 1fr; }.result-back { grid-column:1 / -1; } }
    @keyframes move-panel-in { from { opacity:0; transform:translateY(9px) scale(.985); } to { opacity:1; transform:translateY(0) scale(1); } }
    @keyframes file-to-trash { 0% { opacity:0; transform:translateY(-3px) scale(.7) rotate(-10deg); } 25% { opacity:1; } 82% { opacity:1; } 100% { opacity:0; transform:translate(42px,61px) scale(.15) rotate(22deg); } }
    @keyframes file-row-out { 0%,45% { opacity:1; transform:translateX(0); } 100% { opacity:.35; transform:translateX(10px); } }
    @keyframes bin-bounce { from { transform:translateY(0) rotate(-2deg); } to { transform:translateY(-4px) rotate(2deg); } }
    @keyframes glow-pulse { from { opacity:.45; transform:scale(.9); } to { opacity:1; transform:scale(1.06); } }
    .putback-panel .list-title { margin-top:0; }
    @media (max-width:850px) { .cleanup-hero { grid-template-columns:48px minmax(0,1fr); padding:24px; }.hero-scan { grid-column:2; justify-self:start; }.cleanup-detail-layout { grid-template-columns:1fr; }.cleanup-detail-layout .filter-rail { position:static; }.section-tabs button { grid-template-columns:20px minmax(0,1fr); }.section-tabs small { grid-column:2; } }
    @media (max-width:560px) { .cleanup-heading-actions { align-items:flex-end; flex-direction:column; }.cleanup-hero { grid-template-columns:1fr; padding:22px; }.hero-icon { width:44px; height:44px; }.hero-scan { grid-column:1; }.scan-summary,.putback-panel { padding:15px; }.scan-summary > header { align-items:flex-start; flex-direction:column; }.section-tabs { grid-template-columns:1fr; }.section-tabs button { grid-template-columns:20px minmax(0,1fr) auto; }.section-tabs small { grid-column:auto; }.detail-topline { align-items:flex-start; flex-direction:column; } }
    /* The shared grid only defines its columns globally; Applications owns the wide-pane rule
       in its encapsulated stylesheet. Cleanup needs the same rule locally or its invitation
       is trapped in the 176px filter column. */
    .manager-main.wide { grid-column: 2 / -1; }
    .putback-panel h2 { margin: 2px 0 0; font-size: 16px; }
    .undo-list { display: grid; gap: 8px; margin-bottom: 18px; }
    .undo-card { border: 1px solid #d9cdfbc0; border-radius: 16px; background: linear-gradient(145deg, #f7f3ffd0, #ffffff7c); box-shadow: 0 12px 26px #44516b12, inset 0 1px #fff; overflow: hidden; }
    .undo-card header { display: flex; align-items: center; gap: 14px; padding: 14px 17px; }
    .undo-card header > div { flex: 1; min-width: 0; }
    .undo-card strong { display: block; font-size: 13px; color: #43346f; }
    .undo-card header small { display: block; margin-top: 3px; color: #7d70a8; font-size: 11px; }
    .undo-card .primary { margin-left: 0; }
    .undo-card ul { margin: 0; padding: 0 17px 13px; list-style: none; }
    .undo-card li { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; align-items: baseline; gap: 10px; padding: 6px 0; border-top: 1px solid #6b5ea01a; }
    .undo-card li span { font-size: 12px; font-weight: 600; color: #3a3452; }
    .undo-card li code { color: #948da8; font: 500 10px ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .undo-card li em { font-style: normal; font-size: 11px; font-weight: 600; color: #453e5f; }
    .undo-card li.gone span, .undo-card li.gone code { color: #b3adc0; text-decoration: line-through; }
    .undo-card li.gone em { color: #9a5555; }
    .undo-failed { margin: 0; padding: 0 17px 12px; color: #9a5555; font-size: 11px; }
    .putback-panel .empty-state { padding: 34px 30px; text-align: center; border: 1px solid #ffffffb8; border-radius: 18px; background: linear-gradient(145deg, #ffffffb0, #ffffff66); box-shadow: 0 14px 30px #44516b14, inset 0 1px #ffffffc8; }
    .putback-panel .empty-state h3 { margin: 0; font-size: 15px; }
    .putback-panel .empty-state p { margin: 9px auto 0; max-width: 58ch; color: #8f899f; font-size: 12px; line-height: 1.55; }
    .scan-progress-card { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 20px; padding: 26px 28px; border: 1px solid #ffffffb8; border-radius: 20px; background: linear-gradient(105deg, #ffffff92, #ffffff42); box-shadow: 0 14px 35px #59627c14, inset 0 1px #ffffffb8; backdrop-filter: blur(24px); }
    .scan-progress-icon { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: #8f72f6; color: #fff; font-size: 19px; animation: cleanup-pulse 1.4s ease-in-out infinite; }
    .scan-progress-card h2 { margin: 0; font-size: 16px; }
    .scan-progress-card p { margin: 7px 0 0; color: #8f899f; font-size: 11px; line-height: 1.5; max-width: 62ch; }
    .scan-progress-card small { display: block; margin-top: 7px; color: #a49db4; font-size: 10px; }
    @keyframes cleanup-pulse { 50% { transform: scale(1.06); box-shadow: 0 0 0 7px #8f72f622; } }
    .scan-invite { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 20px; padding: 26px 28px; border: 1px solid #ffffffb8; border-radius: 20px; background: linear-gradient(105deg, #ffffff92, #ffffff42); box-shadow: 0 14px 35px #59627c14, inset 0 1px #ffffffb8; backdrop-filter: blur(24px); }
    .scan-invite-icon { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: #8f72f6; color: #fff; font-size: 19px; }
    .scan-invite h2 { font-size: 16px; }
    .scan-invite .muted { margin: 6px 0 12px; }
    .scan-areas { display: flex; flex-wrap: wrap; gap: 6px; }
    .scan-chip { padding: 5px 10px; border-radius: 7px; background: #ffffffb0; box-shadow: inset 0 0 0 1px #8d6cf526; color: #6a6184; font: 600 10px ui-monospace, SFMono-Regular, monospace; }
    .scan-never { margin: 12px 0 0; color: #a49db4; font-size: 10px; }
    .scan-never code { font: 600 10px ui-monospace, SFMono-Regular, monospace; color: #8f88a3; }

    .junk-app-icon { width: 32px; height: 32px; border-radius: 7px; }
    /* Reported, not offered: it recedes and takes no pointer, because nothing here can act on it. */
    .junk-row.reported { cursor: default; background: linear-gradient(145deg, #ffffff86, #ffffff4a); box-shadow: 0 8px 20px #44516b0e, inset 0 1px #ffffffa0; }
    .junk-row.reported .junk-copy strong, .junk-row.reported .junk-size strong { color: #8b839f; }
    /* Finder will not offer to undo these, so the offer has to stay visible here. */
    .undo-strip { display: grid; gap: 8px; margin-bottom: 13px; }
    .undo-row { display: flex; align-items: center; gap: 14px; padding: 14px 17px; border: 1px solid #d9cdfbc0; border-radius: 16px; background: linear-gradient(105deg, #f3edffd8, #ffffff88); box-shadow: 0 10px 22px #44516b0d, inset 0 1px #fff; }
    .undo-row > div { flex: 1; min-width: 0; }
    .undo-row strong { display: block; font-size: 12px; color: #43346f; }
    .undo-row small { display: block; margin-top: 3px; color: #7d70a8; font-size: 11px; }
    .undo-failed { flex: none; color: #9a5555 !important; max-width: 30ch; }

    .scan-banner { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 13px; padding: 13px 18px; border: 1px solid #ffffffb8; border-radius: 14px; background: linear-gradient(105deg, #ffffffb0, #ffffff66); box-shadow: 0 10px 22px #44516b12, inset 0 1px #ffffffc8; }
    .scan-banner strong { display: block; font-size: 13px; color: #2f2a44; }
    .scan-banner small { display: block; margin-top: 3px; color: #8f899f; font-size: 11px; }
    .scan-banner.quiet { background: #ffffff5c; box-shadow: none; border-color: #ffffff8c; }
    .scan-banner > div { min-width: 0; flex: 1; }
    .scan-error { color: #b23f3f; }
    .scan-progress { height: 4px; margin: 9px 0 1px; border-radius: 2px; background: #e6e3ef; overflow: hidden; }
    .scan-progress i { display: block; height: 100%; background: linear-gradient(90deg, #7357ec, #4c87ea); transition: width .3s ease; }
    .restore-note { margin: 0 auto 18px; max-width: 46ch; color: #8f899f; font-size: 11px; line-height: 1.55; }
    .restore-note.bad { color: #9a5555; }
    .restore-note span { display: block; margin-top: 5px; color: #a8a1b6; }
    .put-back { margin: 0 8px 0 0; }
    .put-back:disabled { opacity: .6; }
    .failure-list { margin: 0 0 16px; padding: 0; list-style: none; text-align: left; }
    .failure-list li { padding: 7px 10px; margin-top: 6px; border-radius: 8px; background: #fdeeee; color: #9a5555; font-size: 11px; }

    .badge { flex: none; padding: 3px 7px; border-radius: 6px; background: #ece7fb; color: #6b4be1 !important; font-size: 9px; font-weight: 700; white-space: nowrap; }

    .junk-list { display: grid; gap: 8px; margin-bottom: 18px; }
    .junk-row { display: grid; grid-template-columns: 18px 32px minmax(0, 1fr) auto; align-items: center; gap: 13px; padding: 12px 16px; border: 1px solid #ffffffb8; border-radius: 16px; background: linear-gradient(145deg, #ffffffb8, #ffffff70); box-shadow: 0 12px 26px #44516b12, inset 0 1px #ffffffc8; backdrop-filter: blur(22px); cursor: pointer; }
    /* A row that comes back on its own is the safe answer, so it is marked once, quietly. */
    .junk-row.suggested { border-color: #d9cdfbc0; background: linear-gradient(145deg, #f6f2ffd0, #ffffff7c); }
    .junk-icon { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; font-size: 12px; color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, #fff); }
    .junk-copy strong { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: #3a3452; }
    .safe-flag { padding: 2px 7px; border-radius: 5px; background: #ece7fb; color: #6b4be1; font-size: 9px; font-weight: 700; }
    .junk-copy code { display: block; margin-top: 3px; color: #948da8; font: 500 10px ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .junk-copy em { display: block; margin-top: 3px; color: #a9a2b8; font-size: 10px; font-style: normal; }
    .junk-size { display: flex; flex-direction: column; align-items: flex-end; }
    .junk-size strong { font-size: 14px; color: #35304a; }
    .junk-size small { margin-top: 3px; color: #a8a1b6; font-size: 10px; white-space: nowrap; }

    /* Locked, empty and refused share a shape: a reason, and where it leaves you. A category
       that cannot be read must never render as a zero — that would be a claim, not a gap. */
    .blocked { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 22px 24px; border: 1px solid #f0d9b8; border-radius: 18px; background: linear-gradient(105deg, #fff6e9e0, #fffdfa90); box-shadow: 0 14px 30px #a8741f14, inset 0 1px #fff; }
    .blocked-icon { width: 40px; height: 40px; border-radius: 13px; display: grid; place-items: center; background: #f6dfbc; color: #a8741f; font-size: 16px; }
    .blocked h4 { margin: 0; font-size: 14px; color: #6b4a14; }
    .blocked p { margin: 7px 0 0; color: #8a6c3c; font-size: 12px; line-height: 1.55; max-width: 64ch; }
    .blocked-size { color: #a8885c !important; font-size: 11px !important; }
    /* Figures beside a reason, for a category that has plenty to report and nothing to tick. */
    .blocked-facts { margin: 13px 0 0; padding: 12px 0 0; border-top: 1px solid #e3cfae; }
    .blocked-facts > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 14px; padding: 5px 0; }
    .blocked-facts dt { color: #6b4a14; font-size: 12px; font-weight: 600; }
    .blocked-facts dd { margin: 0; color: #6b4a14; font-size: 12px; font-weight: 700; text-align: right; }
    .blocked-facts small { grid-column: 1 / -1; color: #a8885c; font-size: 10px; }
    .blocked.refused { border-color: #f0c4c4; background: linear-gradient(105deg, #fdeeeee0, #fffbfb90); }
    .blocked.refused .blocked-icon { background: #f8d8d8; color: #b23f3f; }
    .blocked.refused h4 { color: #8a2f2f; }
    .blocked.refused p { color: #9a5555; }
  `]
})
export class CleanupComponent implements OnDestroy {
  @Output() readonly openPrivacy = new EventEmitter<void>();
  readonly faFolderOpen = faFolderOpen;
  readonly faArrowRight = faArrowRight;
  readonly faRotateLeft = faRotateLeft;
  readonly faCircleCheck = faCircleCheck;
  readonly faLock = faLock;
  readonly faBan = faBan;
  readonly faMagnifyingGlass = faMagnifyingGlass;
  readonly faFileLines = faFileLines;
  readonly faDatabase = faDatabase;
  readonly faEnvelope = faEnvelope;
  readonly faTrashCan = faTrashCan;
  readonly faBroom = faBroom;
  readonly putBackView = signal(false);
  readonly detailView = signal(false);
  private readonly inv = inject(CleanupInventoryService);
  readonly emptyingTrash = this.inv.emptyingTrash;
  readonly swapUsedBytes = signal<number | null>(null);
  readonly trashActionMessage = signal('');
  private swapRefreshTimer: ReturnType<typeof setInterval>;

  readonly sections = this.inv.sections;
  readonly section = this.inv.section;
  readonly category = this.inv.category;
  readonly sectionKey = this.inv.sectionKey;
  readonly categoryKey = this.inv.categoryKey;
  readonly selected = this.inv.selected;
  readonly preset = this.inv.preset;
  readonly phase = this.inv.phase;

  readonly scanning = this.inv.scanning;
  readonly scanned = this.inv.scanned;
  readonly scanTotal = this.inv.scanTotal;
  readonly scanError = this.inv.scanError;
  readonly hasScanned = this.inv.hasScanned;
  readonly scannedAt = this.inv.scannedAt;
  readonly freedBytes = this.inv.freedBytes;
  readonly freedCount = this.inv.freedCount;
  readonly failures = this.inv.failures;
  readonly removals = inject(RemovalsService);
  readonly removalId = this.inv.removalId;
  readonly restoreResult = this.inv.restoreResult;
  readonly restoring = this.inv.restoring;

  readonly selectedLines = this.inv.selectedLines;
  readonly selectedCount = this.inv.selectedCount;
  readonly selectedBytes = this.inv.selectedBytes;
  readonly foundBytes = this.inv.foundBytes;
  readonly safeBytesTotal = this.inv.safeBytesTotal;
  readonly disk = signal<Disk | null>(null);
  readonly recommendations = computed(() => {
    const sections = this.sections();
    const result: Array<{ title: string; detail: string; section?: CleanupSection; action?: string }> = [];
    const drive = this.disk();
    const trash = sections.find(section => section.key === 'trash');
    if (trash && this.sectionBytes(trash) > 0) {
      result.push({ title: `Empty Trash after reviewing ${this.size(this.sectionBytes(trash))}`, detail: 'These files have already been moved to the Trash; permanently deleting them may free disk space.', section: trash, action: 'Review Trash' });
    }
    if (drive && drive.freeBytes < 20 * 1024 ** 3) {
      const largest = sections.filter(section => section.key !== 'trash' && this.sectionSafeBytes(section) > 0).sort((a, b) => this.sectionSafeBytes(b) - this.sectionSafeBytes(a))[0];
      result.push({ title: 'Free disk space is getting low', detail: `Only ${this.size(drive.freeBytes)} is available. Review the largest safe-to-remove category; the estimate may differ from space actually freed.`, section: largest, action: 'Review files' });
    }
    const swap = this.swapUsedBytes();
    if (swap !== null && swap >= 5 * 1024 ** 3) {
      result.push({ title: `macOS Swap is using ${this.size(swap)}`, detail: 'Swap is managed by macOS and is not cleanup clutter. Closing memory-heavy apps may let macOS reduce it; OpenClean cannot remove active Swap.' });
    }
    if (!result.length) {
      const largest = sections.filter(section => section.key !== 'trash').sort((a, b) => this.sectionSafeBytes(b) - this.sectionSafeBytes(a))[0];
      if (largest && this.sectionSafeBytes(largest) > 0) result.push({ title: `Review ${largest.label}`, detail: `${this.size(this.sectionSafeBytes(largest))} is marked safe to remove. Check the listed items before selecting them.`, section: largest, action: 'Review files' });
    }
    return result.slice(0, 3);
  });
  readonly projectedFreeBytes = computed(() => {
    const drive = this.disk();
    return drive ? Math.min(drive.totalBytes, drive.freeBytes + this.safeBytesTotal()) : 0;
  });

  readonly screen = computed<'idle' | 'browse'>(() => this.scanning() || this.hasScanned() ? 'browse' : 'idle');

  readonly areas = ['~/Library/Caches', '~/Library/Logs', '~/Library/Developer', '~/Downloads', '~/.Trash', '/Library/Caches'];

  readonly scannedLabel = computed(() => {
    const at = this.scannedAt();
    if (at === null) return '';
    const minutes = Math.floor((Date.now() - at) / 60_000);
    return minutes < 1 ? 'Scanned just now' : minutes === 1 ? 'Scanned a minute ago' : `Scanned ${minutes} minutes ago`;
  });

  // Another page may have removed something since this one was last open.
  constructor() {
    void this.removals.refresh();
    void this.loadDisk();
    void this.refreshSwap();
    this.swapRefreshTimer = setInterval(() => void this.refreshSwap(), 8_000);
  }

  ngOnDestroy(): void { clearInterval(this.swapRefreshTimer); }

  private async refreshSwap(): Promise<void> {
    try {
      const memory = await window.electronAPI?.getMemoryMetrics();
      if (memory) this.swapUsedBytes.set(memory.swapUsedBytes);
    } catch (error) { console.error('Unable to read current Swap usage', error); }
  }

  private async loadDisk(): Promise<void> {
    try {
      const metrics = await window.electronAPI?.getStorageMetrics();
      this.disk.set(metrics?.disks.find(drive => drive.isStartupDisk) ?? metrics?.disks[0] ?? null);
    } catch (error) { console.error('Unable to read disk capacity', error); }
  }

  scan(): void { this.detailView.set(false); void this.inv.scan(); }
  openPrivacySettings(): void { this.openPrivacy.emit(); }
  cancel(): void { void this.inv.cancel(); }
  trashSelected(): void { this.detailView.set(false); void this.inv.trashSelected(); }
  putBack(): void { void this.inv.putBack(); }
  selectAll(): void { this.trashActionMessage.set(''); this.inv.selectAllInCategory(); }
  categoryPaths(category: JunkCategory): string[] { return category.items.filter(item => item.offered !== false).map(item => item.id); }
  selectedPaths(): string[] {
    const category = this.category();
    if (!category) return [];
    const selected = this.selected();
    return category.items.filter(item => selected.has(item.id) && item.offered !== false).map(item => item.id);
  }
  selectionCount(): number {
    if (this.sectionKey() !== 'trash') return this.selectedCount();
    const selected = this.selected();
    return this.category()?.items.filter(item => selected.has(item.id) && item.offered !== false).length ?? 0;
  }
  selectionBytes(): number {
    if (this.sectionKey() !== 'trash') return this.selectedBytes();
    const selected = this.selected();
    return this.category()?.items.reduce((sum, item) => sum + (selected.has(item.id) && item.offered !== false ? item.bytes : 0), 0) ?? 0;
  }
  async emptyTrash(paths: string[], all = false): Promise<void> {
    this.trashActionMessage.set('');
    try {
      const result = await this.inv.emptyTrash(paths, all);
      if (!result || result.cancelled) return;
      void this.loadDisk();
      const spaceResult = result.freeBytesBefore != null && result.freeBytesAfter != null
        ? `Free space: ${this.size(result.freeBytesAfter)} (was ${this.size(result.freeBytesBefore)}; change ${result.freeBytesAfter >= result.freeBytesBefore ? '+' : '−'}${this.size(Math.abs(result.freeBytesAfter - result.freeBytesBefore))}).`
        : 'Could not measure the change in free space.';
      this.trashActionMessage.set(result.failures.length
        ? `${result.deleted} deleted permanently. ${spaceResult} ${result.failures.join(' · ')}`
        : `${result.deleted} ${result.deleted === 1 ? 'item' : 'items'} deleted permanently. ${spaceResult}`);
    } catch (error) {
      this.trashActionMessage.set(error instanceof Error ? error.message : 'Could not empty the Trash.');
    }
  }

  size(bytes: number): string { return formatBinaryBytes(bytes) ?? '—'; }
  swapPercentOfUsed(drive: Disk): number {
    const swapBytes = this.swapUsedBytes();
    if (swapBytes === null || drive.usedBytes <= 0) return 0;
    return Math.min(swapBytes, drive.usedBytes) / drive.usedBytes * 100;
  }
  icon(key: string): IconDefinition { return ICONS[key] ?? faFolderOpen; }
  sectionIcon(key: string): IconDefinition { return SECTION_ICONS[key] ?? faDatabase; }
  sectionDescription(key: string): string { return this.sections().find(section => section.key === key)?.blurb ?? ''; }
  sectionBytes(section: CleanupSection): number { return section.categories.reduce((sum, category) => sum + this.categoryBytes(category), 0); }
  sectionItemCount(section: CleanupSection): number { return section.categories.reduce((sum, category) => sum + category.items.length, 0); }
  sectionSafeBytes(section: CleanupSection): number { return section.categories.reduce((sum, category) => sum + this.safeBytes(category), 0); }
  sectionReviewHint(section: CleanupSection): string {
    const safe = this.sectionSafeBytes(section);
    if (safe > 0) return `${this.size(safe)} safe to remove`;
    return section.categories.some(category => category.state === 'locked') ? 'Needs Full Disk Access' : 'Review before removing';
  }
  accent(key: string): string { return ACCENTS[key] ?? '#8d6cf5'; }
  categoryBytes(category: JunkCategory): number { return this.inv.categoryBytes(category); }
  safeBytes(category: JunkCategory): number { return this.inv.safeBytes(category); }

  categoryCaption(category: JunkCategory): string {
    if (category.items.length) return this.size(this.categoryBytes(category));
    return category.status ?? '';
  }

  selectSection(section: CleanupSection): void { this.trashActionMessage.set(''); this.inv.selectSection(section.key); this.detailView.set(true); }
  selectCategory(section: CleanupSection, category: JunkCategory): void {
    this.inv.sectionKey.set(section.key);
    this.inv.categoryKey.set(category.key);
    this.detailView.set(true);
  }
  toggleItem(item: JunkItem): void { this.inv.toggleItem(item); }
  selectSmartly(): void { this.inv.selectSmartly(); }
  clearSelection(): void { this.inv.clearSelection(); }
  reset(): void { this.detailView.set(false); this.inv.reset(); }
  scanAgain(): void { this.detailView.set(false); this.putBackView.set(false); this.inv.reset(); void this.inv.scan(); }
}
