import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { faArrowRight, faBoxOpen, faCircleCheck, faCircleExclamation, faFileLines, faMagnifyingGlass, faRotateLeft, faTerminal, faTrashCan, faPowerOff } from '@fortawesome/free-solid-svg-icons';
import { formatBinaryBytes } from '../dashboard/metric-format';
import { RemovalsService } from '../removals.service';
import { ApplicationInventoryService, Filter, IDLE_DAYS, Mode, Sort, toolKey } from './application-inventory.service';

/**
 * What is installed, and what each app really costs once the data it has written into the home
 * folder is counted with it. Finder reports Docker.app at 1.65 GB; its Linux VM disk is another
 * 43 GB, and nothing in macOS puts the two figures together.
 *
 * The page is a view: every piece of state belongs to the inventory service, because switching
 * tabs destroys this component and a scan half-finished would be lost with it.
 */

type Kind = AppSliceKind;

const KIND_LABEL: Record<Kind, string> = {
  binary: 'Binaries', support: 'Supporting files', cache: 'Caches',
  container: 'Containers', preference: 'Preferences', log: 'Logs'
};

/**
 * Removing a whole application is one decision; removing one part of it while the application
 * stays is a different one, and the tree made them look identical. ~/Library/Caches comes back
 * by itself. ~/Library/Application Support is where Chrome keeps its bookmarks and saved
 * passwords, where VS Code keeps the settings you wrote, and where Docker's 44 GB of images
 * live. Same checkbox, same shape, opposite consequence — so each kind now says which it is.
 */
type Risk = 'removes' | 'safe' | 'resets' | 'data';

const KIND_RISK: Record<Kind, { risk: Risk; note: string }> = {
  binary: { risk: 'removes', note: 'Removes the application itself' },
  cache: { risk: 'safe', note: 'Rebuilt automatically' },
  log: { risk: 'safe', note: 'Rebuilt automatically' },
  preference: { risk: 'resets', note: 'Resets settings and sign-ins' },
  support: { risk: 'data', note: 'Your data lives here' },
  container: { risk: 'data', note: 'Your data lives here' }
};

/**
 * A stable colour per app, so the bar and the fallback tile do not change between scans. Taken
 * from the bundle identifier rather than assigned in order, which would reshuffle on every sort.
 */
function accentFor(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 58% 52%)`;
}

@Component({
  selector: 'oc-applications', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FontAwesomeModule],
  template: `
    <section class="apps-page">
      <div class="page-heading">
        <div>
          <p class="eyebrow">APPLICATIONS</p>
          <h1>Applications Manager</h1>
          <p class="muted">An app is its bundle plus everything it has written into your home folder. That total is what this page sorts by, and it is usually not what Finder shows you.</p>
        </div>
        @if (screen() === 'browse' && phase() === 'browse' && (mode() === 'uninstaller' || mode() === 'tools')) {
          <div class="application-controls">
            <label class="app-search"><fa-icon [icon]="faMagnifyingGlass" /><input type="search" [value]="search()" (input)="search.set($any($event.target).value)" [placeholder]="mode() === 'tools' ? 'Search developer tools' : 'Search applications'" [attr.aria-label]="mode() === 'tools' ? 'Search developer tools' : 'Search applications'" /></label>
            @if (mode() === 'uninstaller') {
            <div class="sort-group" role="group" aria-label="Sort applications">
              <button type="button" [class.on]="sort() === 'footprint'" (click)="sort.set('footprint')">Footprint</button>
              <button type="button" [class.on]="sort() === 'idle'" (click)="sort.set('idle')">Least used</button>
              <button type="button" [class.on]="sort() === 'name'" (click)="sort.set('name')">Name</button>
            </div>
            }
          </div>

        }
      </div>

      @if (phase() === 'browse' && toolStage() === 'browse') {
        @if (scanError(); as error) { <p class="scan-banner scan-error">{{ error }}</p> }
        @if (screen() === 'browse') {
        @if (scanning()) {
          <section class="scan-progress-card">
            <span class="scan-progress-icon"><fa-icon [icon]="faMagnifyingGlass" /></span>
            <div>
              <h2>Reading applications</h2>
              <p>Measuring each app together with the data it owns. Nothing is selected or changed while the scan runs.</p>
              <div class="scan-progress"><i [style.width.%]="scanTotal() ? (scanned() / scanTotal()) * 100 : 0"></i></div>
              <small>Scanning app bundles and the data they own…</small>
            </div>
            <button class="ghost-button" type="button" (click)="cancel()">Stop</button>
          </section>
        } @else if (scanned() > 0) {
          <section class="scan-banner quiet">
            <div><strong>Applications scanned</strong><small>{{ scannedLabel() }}</small></div>
            <button class="ghost-button" type="button" (click)="scan()"><fa-icon [icon]="faRotateLeft" />Scan again</button>
          </section>
        }
        }
        @if (!scanning()) {
        <div class="manager-layout" [class.welcome-mode]="screen() === 'idle' && mode() === 'uninstaller'">
          <nav class="mode-rail" aria-label="Applications sections">
            <button type="button" [class.on]="mode() === 'uninstaller'" (click)="mode.set('uninstaller')"><fa-icon [icon]="faTrashCan" />Uninstaller</button>
            <button type="button" [class.on]="mode() === 'tools'" (click)="mode.set('tools')"><fa-icon [icon]="faTerminal" />Developer Tools</button>
            <button type="button" [class.on]="mode() === 'leftovers'" (click)="mode.set('leftovers')"><fa-icon [icon]="faBoxOpen" />Leftovers</button>
            <!-- Finder cannot undo what this app removed, so the undo needs a place of its own. -->
            <button type="button" [class.on]="mode() === 'putback'" (click)="mode.set('putback')"><fa-icon [icon]="faRotateLeft" />Put back@if (removals.applications().length) { <em>{{ removals.applications().length }}</em> }</button>
            <button type="button" [class.on]="mode() === 'startup'" (click)="mode.set('startup')"><fa-icon [icon]="faPowerOff" />Startup Items</button>
          </nav>

          @if (railVisible()) {
          <aside class="filter-rail">
            @if (mode() === 'uninstaller') {
              <h2>Uninstaller</h2>
              <p>Remove an application together with every file it owns.</p>
              <button type="button" class="filter" [class.on]="filter().kind === 'all'" (click)="filter.set({ kind: 'all' })"><span>All Applications</span><em>{{ installed() }}</em></button>
              <button type="button" class="filter" [class.on]="filter().kind === 'unused'" (click)="filter.set({ kind: 'unused' })"><span>Unused</span><em>{{ unusedCount() }}</em></button>
              <button type="button" class="filter" [class.on]="filter().kind === 'selected'" (click)="filter.set({ kind: 'selected' })"><span>Selected</span><em>{{ selectedApps().length }}</em></button>
              <!-- CleanMyMac has a "Suspicious" filter here. There is no signature database behind
                   this app, so the row would be a claim it cannot make. -->
              <p class="filter-head">Stores</p>
              @for (store of stores(); track store.label) {
                <button type="button" class="filter" [class.on]="isFilter('store', store.label)" (click)="filter.set({ kind: 'store', value: store.label })"><span>{{ store.label }}</span><em>{{ store.count }}</em></button>
              }
              <p class="filter-head">Vendors</p>
              @for (vendor of vendors(); track vendor.label) {
                <button type="button" class="filter" [class.on]="isFilter('vendor', vendor.label)" (click)="filter.set({ kind: 'vendor', value: vendor.label })"><span>{{ vendor.label }}</span><em>{{ vendor.count }}</em></button>
              }
            } @else if (mode() === 'leftovers') {
              <h2>Leftovers</h2>
              <p>Installers you no longer need, and files whose application is already gone.</p>
              <button type="button" class="filter tall on"><span>Installers<small>{{ size(installerBytes()) }}</small></span></button>
              <button type="button" class="filter tall"><span>Leftover Files<small>{{ size(leftoverBytes()) }}</small></span></button>
            } @else if (mode() === 'tools') {
              <h2>Developer Tools</h2>
              <p>Command-line packages and language runtimes installed outside Applications.</p>
              @for (group of developerTools()?.groups ?? []; track group.label) {
                <button type="button" class="filter tall" [class.on]="activeToolGroup()?.label === group.label"
                        (click)="toolGroup.set(group.label)"><span>{{ group.label }}<small>{{ group.bytes ? size(group.bytes) : 'not measured' }}</small></span><em>{{ group.items.length }}</em></button>
              }
            } @else if (mode() === 'putback') {
              <h2>Put back</h2>
            }
          </aside>
          }

          <section class="manager-main" [class.wide]="!railVisible()">
            @if (mode() === 'startup') {
              <section class="startup-card"><span class="startup-icon"><fa-icon [icon]="faPowerOff" /></span><p class="eyebrow">MACOS LOGIN ITEMS</p><h2>Manage what starts with your Mac</h2><p>macOS controls which apps and background services open at login. Open Login Items & Extensions in System Settings to review or change them.</p><button class="primary" type="button" (click)="openLoginItems()">Open Login Items in System Settings <fa-icon [icon]="faArrowRight" /></button><small>OpenClean can’t read or change other apps’ login items directly.</small></section>
            } @else {
            @if (screen() === 'idle' && mode() === 'uninstaller') {
            <section class="apps-welcome">
              <section class="apps-hero">
                <span class="apps-hero-icon" aria-hidden="true">
                  <svg viewBox="0 0 180 180" role="presentation">
                    <defs><linearGradient id="appBadge" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#43d9ef"/><stop offset=".52" stop-color="#0879db"/><stop offset="1" stop-color="#183bc3"/></linearGradient><linearGradient id="appGlass" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".55"/><stop offset=".48" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#071a70" stop-opacity=".28"/></linearGradient></defs>
                    <path class="badge-shadow" d="M90 8C109 8 156 31 167 46c8 11 3 81-4 94-7 14-58 33-74 32-16 0-67-23-75-37C7 122 6 59 16 45 26 31 71 8 90 8Z"/>
                    <path class="badge-face" d="M90 4C109 4 156 27 167 42c8 11 3 81-4 94-7 14-58 33-74 32-16 0-67-23-75-37C7 118 6 55 16 41 26 27 71 4 90 4Z"/><path class="badge-glass" d="M90 4C109 4 156 27 167 42c8 11 3 81-4 94-7 14-58 33-74 32-16 0-67-23-75-37C7 118 6 55 16 41 26 27 71 4 90 4Z"/>
                    <g class="app-mark-lines"><path d="M69 96l39-47M61 57l49 56M68 96h42"/></g><g class="app-mark-dots"><circle cx="51" cy="113" r="7"/><circle cx="73" cy="119" r="7"/><circle cx="96" cy="122" r="7"/><circle cx="119" cy="117" r="7"/><circle cx="137" cy="109" r="7"/><circle cx="70" cy="140" r="4"/><circle cx="93" cy="143" r="4"/><circle cx="116" cy="137" r="4"/></g>
                  </svg>
                </span>
                <div class="apps-hero-copy">
                  <p class="apps-hero-kicker">OPEN APPLICATIONS</p><h2>Take control of your apps</h2><p>See what is installed, how much space it uses, and which files belong to it.</p>
                  <div class="apps-hero-actions">
                    <button class="apps-hero-scan" type="button" (click)="scan()"><fa-icon [icon]="faMagnifyingGlass" />Scan applications<fa-icon [icon]="faArrowRight" /></button>
                    @if (removals.applications().length) { <button class="apps-hero-putback" type="button" (click)="mode.set('putback')"><fa-icon [icon]="faRotateLeft" />Put back<em>{{ removals.applications().length }}</em></button> }
                  </div>
                  <ul class="apps-hero-promises"><li><fa-icon [icon]="faCircleCheck" />Nothing moves until you review it</li><li><fa-icon [icon]="faCircleCheck" />Everything goes to the Trash</li><li><fa-icon [icon]="faCircleCheck" />Put back any time</li></ul>
                </div>
                <span class="apps-hero-orb apps-orb-one"></span><span class="apps-hero-orb apps-orb-two"></span>
              </section>
              <div class="apps-section-label"><h3>What a scan looks at</h3><span>One scan covers all three</span></div>
              <div class="apps-category-preview">
                <button type="button" class="apps-preview-card tone-violet" (click)="openSection('uninstaller')"><span class="card-icon"><fa-icon [icon]="faTrashCan" /></span><div><h3>Uninstaller</h3><p>Apps plus the caches, preferences and containers they leave in your Library.</p></div><fa-icon class="card-go" [icon]="faArrowRight" /></button>
                <button type="button" class="apps-preview-card tone-teal" (click)="openSection('tools')"><span class="card-icon"><fa-icon [icon]="faTerminal" /></span><div><h3>Developer Tools</h3><p>Homebrew, npm, pip and other packages, removed through their own manager.</p></div><fa-icon class="card-go" [icon]="faArrowRight" /></button>
                <button type="button" class="apps-preview-card tone-amber" (click)="openSection('leftovers')"><span class="card-icon"><fa-icon [icon]="faBoxOpen" /></span><div><h3>Leftovers</h3><p>Installers and support folders whose app is already gone.</p></div><fa-icon class="card-go" [icon]="faArrowRight" /></button>
              </div>
              <button type="button" class="apps-startup-link" (click)="mode.set('startup')"><span class="card-icon"><fa-icon [icon]="faPowerOff" /></span><span><strong>Startup Items</strong><small>Choose what opens when you log in — no scan needed</small></span><fa-icon class="card-go" [icon]="faArrowRight" /></button>
            </section>
            } @else if (screen() === 'idle' && mode() !== 'putback') {
            <section class="scan-invite">
              <span class="scan-invite-icon"><fa-icon [icon]="faMagnifyingGlass" /></span>
              <div>
                <h2>Measure what is installed</h2>
                <p class="muted">Reads every application bundle and the data each one has written into your home folder, adds the two together, then lists what is installed outside Applications — Homebrew, npm, Python and the runtimes on your path. It takes about twenty seconds and changes nothing on disk.</p>
                <p class="scan-note">Nothing is scanned until you ask. You can leave this page while it runs — the scan carries on and the results will be here when you come back.</p>
              </div>
              <button class="primary" type="button" (click)="scan()">Scan applications <fa-icon [icon]="faArrowRight" /></button>
            </section>
            } @else if (mode() === 'uninstaller') {
              @if (filter().kind === 'unused') {
                <p class="list-note">Not opened in {{ idleDays }} days or more. Age is the only claim made here — an app you use twice a year is not clutter.</p>
              }
              @if (!visible().length) {
                <article class="empty-state app-empty"><span class="empty-icon"><fa-icon [icon]="faMagnifyingGlass" /></span><h3>No applications match</h3><p>Try a different search or filter.</p></article>
              } @else {
              <div class="app-list">
                @for (app of visible(); track app.id) {
                  <article class="app-row" [class.collapsed]="!open().has(app.id)" [style.--accent]="accent(app)">
                    <header (click)="toggleOpen(app.id)">
                      <button class="tick" type="button" [class.on]="appTicked(app)" [class.part]="appPartly(app)"
                              [disabled]="!appSelectable(app)" [attr.aria-label]="'Select everything belonging to ' + app.name" (click)="toggleApp(app); $event.stopPropagation()"></button>
                      @if (app.icon) { <img class="app-icon" [src]="app.icon" alt="" /> } @else { <span class="app-mark">{{ initial(app) }}</span> }
                      <div class="app-copy">
                        <h3>{{ app.name }}</h3>
                        <p>{{ idleLabel(app) }} · {{ app.vendor }} · {{ app.store }}</p>
                      </div>
                      <!-- Bundle against data on one bar. A short dark stem with a long pale tail
                           is an app whose data has outgrown it, which is the whole point. -->
                      <span class="app-bar" [attr.aria-label]="size(total(app))">
                        <i class="bundle" [style.width.%]="share(bundleOf(app))"></i>
                        <i class="data" [style.width.%]="share(total(app) - bundleOf(app))"></i>
                      </span>
                      <span class="app-total"><strong>{{ size(total(app)) }}</strong><small>{{ size(bundleOf(app)) }} app · {{ size(total(app) - bundleOf(app)) }} data</small></span>
                    </header>
                    @if (open().has(app.id)) {
                      <div class="app-tree">
                        @for (group of app.groups; track group.kind) {
                          <div class="tree-group">
                            <div class="tree-head" (click)="toggleGroupOpen(app, group)">
                              <button class="tick" type="button" [class.on]="groupTicked(app, group)" [class.part]="groupPartly(app, group)"
                                      [disabled]="!groupSelectable(group)" [attr.aria-label]="'Select ' + kindLabel(group.kind)" (click)="toggleGroup(app, group); $event.stopPropagation()"></button>
                              <span class="tree-kind" [attr.data-kind]="group.kind">{{ kindLabel(group.kind) }}</span>
                              <span class="tree-note" [attr.data-risk]="risk(group.kind)">{{ note(group.kind) }}</span>
                              <span class="tree-size">{{ size(groupBytes(group)) }}</span>
                            </div>
                            @if (openGroups().has(groupKey(app, group))) {
                              <ul>
                                @for (item of group.items; track item.path) {
                                  <li [class.reported]="item.offered === false" (click)="item.offered === false ? null : toggleItem(app, item)">
                                    @if (item.offered === false) { <span class="tick disabled" aria-hidden="true"></span> }
                                    @else { <button class="tick" type="button" [class.on]="selected().has(key(app, item))" [attr.aria-label]="'Select ' + item.label"></button> }
                                    <div>
                                      <strong>{{ item.label }}</strong>
                                      <code>{{ item.path }}</code>
                                      @if (item.impact) { <em [attr.data-risk]="risk(group.kind)">{{ item.impact }}</em> }
                                    </div>
                                    <span>{{ size(item.bytes) }}</span>
                                  </li>
                                }
                              </ul>
                            }
                          </div>
                        }
                      </div>
                    }
                  </article>
                }
              </div>
              }
            } @else if (mode() === 'leftovers') {
              <h3 class="list-title">Installers</h3>
              <p class="list-note">Disk images and packages whose application is already installed. Classified by what the file contains, not by its extension — the emulator images inside the Android SDK are not installers and are listed under Android Studio instead.</p>
              <div class="plain-list">
                @for (item of installers(); track item.path) {
                  <article class="plain-row" (click)="toggleLoose(item)">
                    <button class="tick" type="button" [class.on]="selected().has(looseKey(item))" [attr.aria-label]="'Select ' + item.label"></button>
                    <span class="app-mark ghost"><fa-icon [icon]="faBoxOpen" /></span>
                    <div><strong>{{ item.label }}</strong><code>{{ item.path }}</code></div>
                    <span class="plain-size">{{ size(item.bytes) }}</span>
                  </article>
                }
              </div>
              <h3 class="list-title">Leftover files</h3>
              <p class="list-note">Support folders with no application left to own them. Apple's own components are excluded: they have no bundle by design, and calling them leftovers would be wrong.</p>
              <div class="plain-list">
                @for (item of leftoverFiles(); track item.path) {
                  <article class="plain-row" (click)="toggleLoose(item)">
                    <button class="tick" type="button" [class.on]="selected().has(looseKey(item))" [attr.aria-label]="'Select ' + item.label"></button>
                    <span class="app-mark ghost">—</span>
                    <div><strong>{{ item.label }}</strong><code>{{ item.path }}</code></div>
                    <span class="plain-size">{{ size(item.bytes) }}</span>
                  </article>
                }
              </div>
            } @else if (mode() === 'tools') {
              @if (toolsError(); as error) { <p class="scan-banner scan-error">{{ error }}</p> }
              @if (toolsScanning() && !developerTools()) {
                <p class="list-note">Reading Homebrew, npm and Python…</p>
              }
              @if (developerTools(); as report) {
                @if (activeToolGroup(); as group) {
                  <section class="scan-banner quiet tool-banner"><div><strong>{{ activeToolItems().length }} {{ activeToolItems().length === 1 ? 'tool' : 'tools' }} · {{ size(group.bytes) }}</strong><small>{{ report.groups.length }} local sources scanned · a package footprint, not space you are promised back</small></div><button class="ghost-button" type="button" [disabled]="toolsScanning()" (click)="scanDeveloperTools()"><fa-icon [icon]="faRotateLeft" />Scan again</button></section>
                  @if (activeToolItems().length) {
                  <div class="app-list tool-list">
                  <article class="app-row tool-app-row">
                    <header>
                      <span class="app-mark"><fa-icon [icon]="faTerminal" /></span>
                      <div class="app-copy"><h3>{{ group.label }}</h3><p>{{ group.detail }}</p></div>
                      <span class="app-total"><strong>{{ size(group.bytes) }}</strong><small>{{ activeToolItems().length }} {{ activeToolItems().length === 1 ? 'package' : 'packages' }}</small></span>
                    </header>
                    <div class="app-tree tool-tree"><ul>
                      @for (item of activeToolItems(); track item.source + item.name) {
                        <li [class.reported]="!!item.protection">
                          @if (item.protection) {
                            <span class="tick disabled" [attr.title]="item.protection"></span>
                          } @else {
                            <button class="tick" type="button" [class.on]="toolTicked(item)"
                                    [attr.aria-label]="'Select ' + item.name" (click)="toggleTool(item)"></button>
                          }
                          <div>
                            <strong>{{ item.name }} <span class="tool-version">{{ item.version || 'version unknown' }}</span></strong>
                            <em [attr.data-risk]="toolRisk(item)">{{ toolNote(item) }}</em>
                          </div>
                          <span>{{ item.bytes === null ? '—' : size(item.bytes) }}</span>
                        </li>
                      }
                    </ul></div>
                  </article>
                  </div>
                  } @else {
                    <article class="empty-state app-empty"><span class="empty-icon"><fa-icon [icon]="faMagnifyingGlass" /></span><h3>No developer tools match</h3><p>Try a different search.</p></article>
                  }
                }
              } @else if (!toolsScanning()) {
                <article class="empty-state">
                  <span class="empty-icon"><fa-icon [icon]="faTerminal" /></span>
                  <h3>Nothing was read from the command line</h3>
                  <p>No Homebrew, npm or pip installation answered. Scanning the page again retries all of them.</p>
                </article>
              }
            } @else if (mode() === 'putback') {
              @if (removals.applications().length) {
                <h3 class="list-title">Recent removals</h3>
                <p class="list-note">Putting one back returns every piece to where it came from. Pieces you have since emptied from the Trash are struck through — nothing can bring those back, and a removal with nothing left is not listed at all.</p>
                <div class="plain-list">
                  @for (removal of removals.applications(); track removal.id) {
                    <article class="undo-card">
                      <header>
                        <div>
                          <strong>{{ removal.label }}</strong>
                          <small>{{ removal.entries.length }} {{ removal.entries.length === 1 ? 'item' : 'items' }} · {{ size(removal.bytes) }} · {{ removals.since(removal.removedAt) }}</small>
                        </div>
                        <button class="primary" type="button" [disabled]="removals.restoring() === removal.id"
                                (click)="removals.restore(removal.id)">{{ removals.restoring() === removal.id ? 'Putting back…' : 'Put back' }}</button>
                      </header>
                      <ul>
                        @for (entry of removal.entries; track entry.originalPath) {
                          <li [class.gone]="entry.available === false">
                            <span>{{ entry.label }}</span>
                            <code>{{ entry.originalPath }}</code>
                            <em>{{ entry.available === false ? 'emptied' : size(entry.bytes) }}</em>
                          </li>
                        }
                      </ul>
                      @if (removals.lastResult(); as outcome) {
                        @if (outcome.id === removal.id && outcome.failures.length) {
                          <p class="undo-failed">{{ outcome.failures.join(' · ') }}</p>
                        }
                      }
                    </article>
                  }
                </div>
              } @else {
                <article class="empty-state">
                  <span class="empty-icon"><fa-icon [icon]="faRotateLeft" /></span>
                  <h3>Nothing to put back</h3>
                  <p>Anything you remove here is listed until you return it or empty the Trash yourself.</p>
                </article>
              }
            }
            }
          </section>
        </div>

        @if (screen() === 'browse' && mode() === 'tools') {
        <footer class="selection-bar" [class.armed]="selectedTools().length > 0">
          @if (selectedTools().length > 0) {
            <span class="selection-count">{{ selectedTools().length }} selected</span>
            <strong>{{ size(selectedToolBytes()) }}</strong>
            <button class="link-button" type="button" (click)="clearToolSelection()">Clear</button>
            <button class="primary" type="button" (click)="reviewTools()">Review selected <fa-icon [icon]="faArrowRight" /></button>
          } @else {
            <span class="selection-count dim">Nothing selected</span>
            <small>Tick a package to remove it through its own package manager. Runtimes, and anything that would need sudo, cannot be ticked.</small>
          }
        </footer>
        } @else if (screen() === 'browse' && mode() !== 'putback') {
        <footer class="selection-bar" [class.armed]="selectedCount() > 0">
          @if (selectedCount() > 0) {
            <span class="selection-count">{{ selectedCount() }} selected</span>
            <strong>{{ size(selectedBytes()) }}</strong>
            <button class="link-button" type="button" (click)="clearSelection()">Clear</button>
            <button class="primary" type="button" (click)="phase.set('review')">Review selected <fa-icon [icon]="faArrowRight" /></button>
          } @else {
            <span class="selection-count dim">Nothing selected</span>
            <small>Tick an application to remove it with everything it owns, or open it and take only the part you do not need.</small>
          }
        </footer>
        }
        }
      }

      @if (toolStage() === 'review') {
        <section class="review-panel">
          <p class="eyebrow">STEP 2 OF 2</p>
          <h2>Uninstall {{ selectedTools().length }} {{ selectedTools().length === 1 ? 'package' : 'packages' }}?</h2>
          <!-- The Trash is not on this path, so neither is Put back. Saying so here is the whole
               reason this screen reads differently from the application one. -->
          <p class="muted">These are removed by their own package manager — <code>brew uninstall</code>, <code>npm uninstall -g</code>, <code>pip uninstall</code> — which is the only way to take the symlinks and receipts with them. Nothing goes to the Trash, so there is no Put back. The command that reinstalls each one is on the next screen.</p>
          @if (blockedTools().length) {
            <div class="review-warning">
              <strong>{{ blockedTools().length === 1 ? 'One of these is a dependency' : blockedTools().length + ' of these are dependencies' }}</strong>
              <p>{{ blockedNames() }} {{ blockedTools().length === 1 ? 'is' : 'are' }} needed by other packages you have installed. Homebrew will refuse rather than break them; pip will not, so removing one there leaves the package that needed it half-installed.</p>
            </div>
          }
          <ul class="review-list">
            @for (item of selectedTools(); track item.manager + item.name) {
              <li><span class="review-dot"></span><div><strong>{{ item.name }} {{ item.version }}</strong><code>{{ uninstallCommand(item) }}</code></div><span>{{ item.bytes === null ? '—' : size(item.bytes) }}</span></li>
            }
          </ul>
          <div class="review-total"><span>Footprint</span><strong>{{ size(selectedToolBytes()) }}</strong></div>
          <div class="review-actions">
            <button class="ghost-button" type="button" (click)="backToTools()">Back</button>
            <button class="primary" type="button" [disabled]="uninstalling()" (click)="uninstallSelectedTools()">{{ uninstalling() ? 'Uninstalling…' : 'Uninstall' }} <fa-icon [icon]="faArrowRight" /></button>
          </div>
        </section>
      }

      @if (toolStage() === 'done') {
        @if (uninstallReport(); as report) {
        <section class="result-panel">
          <span class="result-icon"><fa-icon [icon]="faCircleCheck" /></span>
          <h2>{{ report.removed ? 'Removed ' + size(report.bytes) : 'Nothing was removed' }}</h2>
          <p class="muted">{{ report.removed }} of {{ report.outcomes.length }} {{ report.outcomes.length === 1 ? 'package' : 'packages' }} uninstalled. These did not go to the Trash — paste a line below to put one back.</p>
          <ul class="review-list outcome-list">
            @for (outcome of report.outcomes; track outcome.manager + outcome.name) {
              <li><span class="review-dot" [class.bad]="!outcome.removed"></span>
                <div><strong>{{ outcome.name }}</strong><code>{{ outcome.removed ? outcome.reinstall : outcome.message }}</code></div>
                <span>{{ outcome.removed ? 'removed' : 'kept' }}</span></li>
            }
          </ul>
          <button class="ghost-button" type="button" (click)="backToTools()"><fa-icon [icon]="faRotateLeft" />Back to developer tools</button>
        </section>
        }
      }

      @if (phase() === 'review') {
        <section class="review-panel">
          <p class="eyebrow">STEP 2 OF 2</p>
          <h2>Move {{ size(selectedBytes()) }} to the Trash?</h2>
          <p class="muted">Applications and their files go to the Trash, not to nowhere. Finder will not offer to put them back — it only remembers what it moved itself — so OpenClean keeps a note of where each one came from and can return them for you.</p>
          @if (gutted().length) {
            <div class="review-warning">
              <strong>{{ gutted().length === 1 ? 'One application keeps running without its data' : gutted().length + ' applications keep running without their data' }}</strong>
              <p>{{ guttedNames() }} will still be installed, but the files below are where they keep what you made with them. They will open as if newly installed.</p>
            </div>
          }
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
        <section class="apps-moving" aria-live="polite">
          <div class="moving-stage">
            <span class="moving-glow"></span>
            <span class="moving-bin"><fa-icon [icon]="faTrashCan" /></span>
            @for (line of selectedLines().slice(0, 4); track line.id; let i = $index) {
              <span class="flying-file" [style.--i]="i"><fa-icon [icon]="faFileLines" /></span>
            }
          </div>
          <p class="eyebrow">STEP 2 OF 2</p>
          <h2>Moving applications to the Trash…</h2>
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
          <div class="apps-result-summary">
            <div class="apps-result-title">
              <span class="result-icon" [class.failed]="!freedCount() && failures().length"><fa-icon [icon]="freedCount() || !failures().length ? faCircleCheck : faCircleExclamation" /></span>
              <div><p class="eyebrow">{{ freedCount() || !failures().length ? 'REMOVAL COMPLETE' : 'REMOVAL INCOMPLETE' }}</p><h2>{{ freedCount() || !failures().length ? 'Moved to the Trash' : 'Nothing was moved' }}</h2></div>
            </div>
            @if (freedCount() || !failures().length) {
              <strong class="apps-result-amount">{{ size(freedBytes()) }}</strong>
              <p class="apps-result-count">{{ freedCount() }} {{ freedCount() === 1 ? 'item' : 'items' }} moved · Nothing has been deleted permanently.</p>
            } @else {
              <p class="apps-result-count failed-copy">None of the selected items could be moved. Everything is still where it was.</p>
            }
            @if (restoreResult(); as outcome) {
              <p class="restore-note" [class.bad]="!outcome.restored">{{ outcome.restored ? 'Put back ' + outcome.restored + ' of them where they came from.' : 'Nothing could be put back.' }} @if (outcome.failures.length) { <span>{{ outcome.failures.join(' · ') }}</span> }</p>
            } @else if (removalId()) { <p class="restore-note">Finder cannot restore these items. OpenClean saved their original locations so you can put them back here.</p> }
            @if (failures().length) { <ul class="failure-list">@for (failure of failures(); track failure) { <li>{{ failure }}</li> }</ul> }
          </div>
          <aside class="apps-result-next">
            <p class="eyebrow">WHAT HAPPENS NEXT</p>
            @if (freedCount()) {
              <h3>Review before permanent deletion</h3>
              <p>The selected app files are in the Trash. They remain recoverable until you empty the Trash in Finder.</p>
            } @else {
              <h3>Check the removal details</h3>
              <p>Review the messages on the left, then scan again or return to your application list.</p>
            }
            <div class="apps-result-actions">
              @if (removalId()) { <button class="ghost-button" type="button" [disabled]="restoring()" (click)="putBack()"><fa-icon [icon]="faRotateLeft" />{{ restoring() ? 'Putting back…' : 'Put everything back' }}</button> }
              <button class="primary" type="button" (click)="scanAgain()">Scan again</button>
              <button class="apps-result-back" type="button" (click)="reset()">Back to applications</button>
            </div>
          </aside>
        </section>
      }
    </section>
  `,
  styles: [`
    .apps-page { padding-top: 12px; padding-bottom: 28px; }
    .apps-page button:not(:disabled) { cursor:pointer; }
    .apps-page button:disabled { cursor:default; }
    .apps-moving { max-width:590px; margin:10px auto 0; padding:26px 28px; text-align:center; border:1px solid #ffffffc8; border-radius:20px; background:linear-gradient(145deg,#ffffffc8,#ffffff88); box-shadow:0 20px 44px #44516b1f,inset 0 1px #fff; backdrop-filter:blur(26px); animation:app-move-panel-in .35s cubic-bezier(.2,.8,.2,1) both; }
    .moving-stage { position:relative; width:170px; height:112px; margin:0 auto 8px; }
    .moving-glow { position:absolute; width:118px; height:70px; left:26px; bottom:0; border-radius:50%; background:radial-gradient(ellipse,#bdaaff65,transparent 72%); animation:app-glow-pulse 1.1s ease-in-out infinite alternate; }
    .moving-bin { position:absolute; z-index:1; left:61px; bottom:7px; width:48px; height:48px; display:grid; place-items:center; border:1px solid #ddd3ff; border-radius:15px; color:#7056cf; background:linear-gradient(145deg,#f4efff,#e5dcff); box-shadow:0 8px 20px #6650ad24,inset 0 1px #fff; font-size:20px; animation:app-bin-bounce .55s ease-in-out infinite alternate; }
    .flying-file { position:absolute; z-index:2; top:8px; left:23px; color:#8294bb; font-size:15px; animation:app-file-to-trash .85s cubic-bezier(.35,.04,.65,.45) both; animation-delay:calc(var(--i) * 120ms); }
    .flying-file:nth-of-type(4) { left:64px; top:0; }.flying-file:nth-of-type(5) { left:104px; top:10px; }.flying-file:nth-of-type(6) { left:143px; top:2px; }
    .apps-moving .eyebrow { margin:0 0 6px; color:#9b91ae; font-size:9px; font-weight:700; letter-spacing:.14em; }
    .apps-moving h2 { margin:0; color:#342d47; font-size:20px; letter-spacing:-.03em; }
    .apps-moving > .muted { max-width:52ch; margin:8px auto 16px; color:#8f899f; font-size:11px; line-height:1.5; }
    .moving-list { display:grid; max-width:430px; margin:0 auto; border-top:1px solid #6b5ea018; }
    .moving-row { display:flex; align-items:center; justify-content:space-between; gap:14px; min-width:0; padding:9px 2px; border-bottom:1px solid #6b5ea018; color:#645b78; font-size:10px; text-align:left; animation:app-file-row-out .8s ease both; animation-delay:calc(var(--i) * 120ms); }
    .moving-row span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.moving-row strong { flex:none; color:#4b3e70; font-size:10px; }.moving-list > small { padding-top:8px; color:#a19aad; font-size:10px; }
    .result-panel { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(270px,.85fr); max-width:860px; margin:28px auto 0; overflow:hidden; border:1px solid #ffffffd9; border-radius:22px; background:linear-gradient(145deg,#ffffffde,#ffffff9c); box-shadow:0 22px 54px #44516b20,inset 0 1px #fff; backdrop-filter:blur(24px); animation:app-move-panel-in .42s cubic-bezier(.2,.8,.2,1) both; }
    .apps-result-summary { min-width:0; padding:30px 34px; }
    .apps-result-title { display:flex; align-items:center; gap:13px; }
    .apps-result-title .result-icon { width:42px; height:42px; flex:none; display:grid; place-items:center; border-radius:14px; color:#139c70; background:linear-gradient(145deg,#e3fbf1,#c9f3e4); box-shadow:inset 0 1px #fff; font-size:18px; }
    .apps-result-title .result-icon.failed { color:#c25362; background:linear-gradient(145deg,#fff0f0,#ffe1e4); }
    .apps-result-title .eyebrow,.apps-result-next .eyebrow { margin:0 0 4px; color:#978bae; font-size:9px; font-weight:750; letter-spacing:.14em; }
    .apps-result-title h2 { margin:0; color:#302b3d; font-size:20px; letter-spacing:-.03em; }
    .apps-result-amount { display:block; margin:27px 0 0; color:#513c9b; font-size:clamp(38px,5vw,54px); line-height:1; letter-spacing:-.055em; }
    .apps-result-count { margin:10px 0 0; color:#766d88; font-size:12px; line-height:1.5; }.apps-result-count.failed-copy { margin-top:24px; }
    .apps-result-summary .restore-note { margin:23px 0 0; padding-top:14px; border-top:1px solid #66559018; color:#938ba1; font-size:10px; line-height:1.55; }
    .apps-result-next { display:flex; flex-direction:column; padding:29px 27px; border-left:1px solid #66559016; background:linear-gradient(150deg,#f8f6ffb8,#edf8f8a6); }
    .apps-result-next h3 { margin:8px 0 6px; color:#39334b; font-size:15px; }.apps-result-next > p:not(.eyebrow) { margin:0; color:#7f778f; font-size:11px; line-height:1.55; }
    .apps-result-actions { display:grid; gap:8px; margin-top:auto; padding-top:22px; }.apps-result-actions > button { width:100%; justify-content:center; margin:0; }
    .apps-result-back { padding:7px; border:0; background:transparent; color:#776b96; font:600 10px inherit; cursor:pointer; }
    @media (max-width:700px) { .result-panel { grid-template-columns:1fr; margin-top:14px; }.apps-result-summary { padding:24px; }.apps-result-next { border-top:1px solid #66559016; border-left:0; padding:22px 24px; }.apps-result-actions { grid-template-columns:1fr 1fr; }.apps-result-back { grid-column:1 / -1; } }
    @keyframes app-move-panel-in { from { opacity:0; transform:translateY(9px) scale(.985); } to { opacity:1; transform:translateY(0) scale(1); } }
    @keyframes app-file-to-trash { 0% { opacity:0; transform:translateY(-3px) scale(.7) rotate(-10deg); } 25% { opacity:1; } 82% { opacity:1; } 100% { opacity:0; transform:translate(42px,61px) scale(.15) rotate(22deg); } }
    @keyframes app-file-row-out { 0%,45% { opacity:1; transform:translateX(0); } 100% { opacity:.35; transform:translateX(10px); } }
    @keyframes app-bin-bounce { from { transform:translateY(0) rotate(-2deg); } to { transform:translateY(-4px) rotate(2deg); } }
    @keyframes app-glow-pulse { from { opacity:.45; transform:scale(.9); } to { opacity:1; transform:scale(1.06); } }
    .page-heading p.muted { max-width: 66ch; }
    .manager-layout.welcome-mode { grid-template-columns:minmax(0,1fr); align-items:stretch; }
    .manager-layout.welcome-mode > .mode-rail { display:none; }
    .manager-layout.welcome-mode .manager-main.wide { grid-column:1 / -1; }
    .apps-welcome { display:grid; gap:14px; }
    .apps-hero { position:relative; isolation:isolate; min-height:238px; overflow:hidden; display:grid; grid-template-columns:58px minmax(0,1fr); align-items:start; gap:22px; padding:34px 38px; border:1px solid #ffffff40; border-radius:23px; color:#fff; background:radial-gradient(ellipse at 80% 30%, #7f46b6 0, transparent 42%),linear-gradient(112deg,#301058 0%,#552078 48%,#155f5f 115%); box-shadow:0 22px 48px #36135a30,inset 0 1px #ffffff30; }
    .apps-hero > :not(.apps-hero-orb) { position:relative; z-index:1; }
    .apps-hero-icon { display:grid; place-items:center; width:54px; height:54px; padding:7px; border:1px solid #ffffff4c; border-radius:17px; background:#ffffff20; box-shadow:inset 0 1px #ffffff30; }
    .apps-hero-icon svg { width:100%; height:100%; overflow:visible; }
    .badge-shadow { fill:#061b64; opacity:.78; transform:translateY(5px); }
    .badge-face { fill:url(#appBadge); stroke:#51d8f3; stroke-opacity:.72; stroke-width:2.5; }
    .badge-glass { fill:url(#appGlass); stroke:#ffffff55; stroke-width:1; }
    .app-mark-lines { fill:none; stroke:#e8fbff; stroke-width:11; stroke-linecap:round; stroke-linejoin:round; filter:drop-shadow(0 2px 2px #054b9970); }
    .app-mark-dots { fill:#52e3e7; stroke:#b0ffff88; stroke-width:1.5; }
    .apps-hero-kicker { margin:0 0 9px; color:#d6c2f0; font-size:10px; font-weight:700; letter-spacing:.15em; }
    .apps-hero h2 { margin:0; color:#fff; font-size:clamp(24px,3vw,34px); letter-spacing:-.04em; }
    .apps-hero p:not(.apps-hero-kicker) { max-width:60ch; margin:9px 0 0; color:#eee2fa; font-size:13px; line-height:1.55; }
    .apps-hero small { display:block; margin-top:12px; color:#c8e9de; font-size:11px; }
    .apps-hero-scan { display:inline-flex; align-items:center; gap:10px; white-space:nowrap; padding:13px 17px; border:1px solid #d4fff0; border-radius:12px; background:linear-gradient(110deg,#baffdf,#77e4bd); color:#184b47; box-shadow:0 9px 24px #062f352c,inset 0 1px #fff; font:700 12px inherit; cursor:pointer; }
    .apps-hero-scan:hover { transform:translateY(-1px); filter:brightness(1.04); }
    .apps-hero-orb { position:absolute; z-index:0; pointer-events:none; border:1px solid #ffffff24; border-radius:50%; background:linear-gradient(145deg,#ffffff0f,#9cf4d914); }
    .apps-orb-one { width:260px; height:260px; right:15%; top:-148px; }.apps-orb-two { width:180px; height:180px; right:7%; bottom:-128px; }
    .apps-hero-copy { min-width:0; }
    .apps-hero-actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-top:20px; }
    .apps-hero-putback { display:inline-flex; align-items:center; gap:8px; height:42px; padding:0 15px; border:1px solid #ffffff45; border-radius:12px; background:#ffffff14; color:#fff; font:600 12px inherit; cursor:pointer; transition:background .12s; }
    .apps-hero-putback:hover { background:#ffffff26; }
    .apps-hero-putback em { padding:1px 7px; border-radius:6px; background:#ffd98a; color:#5b3a07; font-size:10px; font-style:normal; font-weight:800; }
    .apps-hero-promises { display:flex; flex-wrap:wrap; gap:6px 18px; margin:18px 0 0; padding:0; list-style:none; }
    .apps-hero-promises li { display:inline-flex; align-items:center; gap:7px; color:#d8f3ea; font-size:11px; }
    .apps-hero-promises fa-icon { color:#8ff0c9; font-size:10px; }
    .apps-section-label { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin:6px 4px -2px; }
    .apps-section-label h3 { margin:0; color:#3d3652; font-size:14px; }
    .apps-section-label span { color:#958da6; font-size:11px; }
    .apps-category-preview { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:13px; }
    .apps-preview-card, .apps-startup-link { --tone:#6850c2; --tint:#eee8ff; position:relative; display:grid; grid-template-columns:42px minmax(0,1fr) auto; align-items:start; gap:14px; padding:20px; border:1px solid #ffffffc8; border-radius:18px; background:linear-gradient(145deg,#ffffffc9,#ffffff73); box-shadow:0 12px 26px #44516b10,inset 0 1px #fff; color:inherit; font:inherit; text-align:left; cursor:pointer; transition:transform .15s, box-shadow .15s, border-color .15s; }
    .apps-preview-card { overflow:hidden; }
    .apps-preview-card::before { content:""; position:absolute; inset:0 0 auto; height:3px; background:linear-gradient(90deg,var(--tone),transparent 85%); opacity:.5; }
    .apps-preview-card:hover, .apps-startup-link:hover { transform:translateY(-2px); border-color:#fff; box-shadow:0 18px 34px #44516b1c,inset 0 1px #fff; }
    .apps-preview-card:focus-visible, .apps-startup-link:focus-visible { outline:2px solid var(--tone); outline-offset:3px; }
    .tone-teal { --tone:#168d70; --tint:#dff7ef; }.tone-amber { --tone:#a86b15; --tint:#fff0d7; }
    .card-icon { display:grid; place-items:center; width:42px; height:42px; border-radius:13px; color:var(--tone); background:var(--tint); font-size:15px; }
    .apps-preview-card h3 { margin:3px 0 6px; color:#332d43; font-size:14px; }
    .apps-preview-card p { margin:0; color:#857d94; font-size:12px; line-height:1.5; }
    .card-go { align-self:center; color:#c3bbd3; font-size:12px; transition:transform .15s, color .15s; }
    .apps-preview-card:hover .card-go, .apps-startup-link:hover .card-go { color:var(--tone); transform:translateX(3px); }
    .apps-startup-link { --tone:#4d7d9f; --tint:#e5f2ff; align-items:center; width:100%; padding:14px 20px; border-radius:15px; background:#ffffff70; }
    .apps-startup-link .card-icon { width:36px; height:36px; border-radius:11px; font-size:13px; }
    .apps-startup-link strong, .apps-startup-link small { display:block; }
    .apps-startup-link strong { color:#39324f; font-size:13px; }
    .apps-startup-link small { margin-top:3px; color:#948da8; font-size:11px; }
    @media (max-width:850px) { .apps-hero { grid-template-columns:48px minmax(0,1fr); padding:24px; }.apps-category-preview { grid-template-columns:1fr; } }
    @media (max-width:560px) { .apps-hero { grid-template-columns:1fr; padding:22px; }.apps-hero-icon { width:44px; height:44px; } }
    .application-controls { display: flex; flex: none; align-items: center; gap: 8px; white-space: nowrap; }
    .application-controls .sort-group { flex: none; flex-wrap: nowrap; white-space: nowrap; }
    .application-controls .sort-group button { flex: none; padding-inline: 10px; white-space: nowrap; }
    .app-search { display: flex; flex: 0 0 166px; align-items: center; gap: 7px; width: 166px; padding: 7px 10px; border: 1px solid #ffffffc2; border-radius: 11px; background: #ffffff86; box-shadow: inset 0 0 0 1px #ffffff70; color: #9b93b0; }
    .app-search:focus-within { border-color: #b9a6f5; background: #ffffffc8; box-shadow: 0 3px 10px #4b3c7d12, inset 0 0 0 1px #cfc1fa; }
    .app-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: #3a3452; font: 600 11px inherit; }
    .app-search input::placeholder { color: #aaa3b7; font-weight: 500; }
    @media (max-width: 980px) { .apps-page > .page-heading { flex-wrap: wrap; }.application-controls { margin-left:auto; } }
    .app-empty { margin-bottom: 18px; }
    @media (max-width:650px) { .apps-splash-icon { width:210px; height:210px; margin-bottom:18px; }.apps-welcome h2 { font-size:32px; }.apps-welcome > p { font-size:14px; }.welcome-shortcuts { gap:7px; margin-top:22px; } }


    /* Three columns, as CleanMyMac has: what you are doing, what you are looking at, and the
       list itself. At 47 apps the filter column is what makes the list usable at all. */




    .app-list, .plain-list { display: grid; gap: 8px; margin-bottom: 18px; }
    .app-row, .plain-row { border: 1px solid #ffffffb8; border-radius: 16px; background: linear-gradient(145deg, #ffffffb8, #ffffff70); box-shadow: 0 12px 26px #44516b12, inset 0 1px #ffffffc8; backdrop-filter: blur(22px); overflow: hidden; }
    .app-row header { display: grid; grid-template-columns: 18px 32px minmax(0, 1fr) 76px auto; align-items: center; gap: 11px; padding: 13px 15px; cursor: pointer; }
    .app-mark { width: 32px; height: 32px; border-radius: 11px; display: grid; place-items: center; font-size: 14px; font-weight: 700; color: var(--accent, #8d6cf5); background: color-mix(in srgb, var(--accent, #8d6cf5) 15%, #fff); }
    .app-mark.ghost { color: #a49db4; background: #efedf4; font-weight: 500; font-size: 12px; }
    .app-copy h3 { margin: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .app-copy p { margin: 4px 0 0; color: #948da8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .app-bar { display: flex; height: 6px; border-radius: 3px; background: #e6e3ef; overflow: hidden; }
    .app-bar i { display: block; height: 100%; }
    .app-bar .bundle { background: var(--accent); }
    .app-bar .data { background: color-mix(in srgb, var(--accent) 32%, #fff); }

    .app-total { display: flex; flex-direction: column; align-items: flex-end; min-width: 108px; }
    .app-total strong { font-size: 15px; letter-spacing: -.3px; color: #2f2a44; }
    .app-total small { margin-top: 3px; color: #a8a1b6; font-size: 10px; white-space: nowrap; }

    /* Two levels, as CleanMyMac has: the kind of file, then the files. A rule down the left
       keeps the nesting readable once several groups are open at once. */
    .app-tree { padding: 0 17px 10px 49px; }
    .tree-group { border-top: 1px solid #6b5ea01a; }
    .tree-head { display: grid; grid-template-columns: 18px auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 9px 0; cursor: pointer; }
    .tree-note { font-size: 10px; color: #a29bb0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-note[data-risk="data"] { color: #b5812b; font-weight: 600; }
    .tree-note[data-risk="resets"] { color: #94799f; }
    .tree-note[data-risk="removes"] { color: #7a72a0; }
    .review-warning { margin: 0 0 16px; padding: 13px 15px; border: 1px solid #f0d9b8; border-radius: 12px; background: #fff6e9; }
    .review-warning strong { display: block; color: #6b4a14; font-size: 12px; }
    .review-warning p { margin: 6px 0 0; color: #8a6c3c; font-size: 11px; line-height: 1.5; }
    .tree-kind { justify-self: start; padding: 4px 9px; border-radius: 6px; font-size: 9px; font-weight: 700; letter-spacing: .04em; }
    .tree-kind[data-kind="binary"] { color: #5b48c5; background: #ece7fb; }
    .tree-kind[data-kind="support"] { color: #a8741f; background: #fbf0dd; }
    .tree-kind[data-kind="cache"] { color: #1f8a6d; background: #dff6ee; }
    .tree-kind[data-kind="container"] { color: #b04e6f; background: #fbe6ed; }
    .tree-kind[data-kind="preference"] { color: #6b7ba8; background: #e9eef8; }
    .tree-size { font-size: 12px; font-weight: 600; color: #453e5f; }
    .app-tree ul { margin: 0 0 6px; padding: 0 0 0 30px; list-style: none; border-left: 1.5px solid #6b5ea01a; }
    .app-tree li { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 7px 0; cursor: pointer; }
    .app-tree li:hover { background: #ffffff5c; }
    /* Reported, not offered: nothing here can act on it, so it takes no pointer and recedes. */
    .app-tree li.reported { cursor: default; }
    .app-tree li.reported:hover { background: none; }
    .app-tree li.reported strong, .app-tree li.reported > span { color: #948da8; }
    .app-tree li strong { display: block; font-size: 12px; font-weight: 600; color: #3a3452; }
    .app-tree li code, .plain-row code { display: block; margin-top: 3px; color: #948da8; font: 500 10px ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .app-tree li > span { font-size: 12px; font-weight: 600; color: #453e5f; }
    /* The consequence sits under the path, where the decision is actually taken — the group
       heading is too far away by the time you are reading a row. */
    .app-tree li em { display: block; margin-top: 3px; font-style: normal; font-size: 10px; color: #a29bb0; }
    .app-tree li em[data-risk="data"] { color: #b5812b; }
    .app-tree li em[data-risk="removes"] { color: #7a72a0; }

    .plain-row { display: grid; grid-template-columns: 18px 34px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 12px 17px; cursor: pointer; }
    .plain-row strong { display: block; font-size: 12px; font-weight: 600; color: #3a3452; }
    .plain-size { font-size: 13px; font-weight: 600; color: #35304a; }

    /* Developer tools deliberately reuse the application list grammar: summary strip, one
       source selected in the rail, then a bundle-like row with the installed items beneath. */
    .tool-banner { margin-bottom: 13px; }
    .tool-app-row header { grid-template-columns: 32px minmax(0, 1fr) auto; cursor: default; }
    .tool-tree { padding-left: 59px; }
    .tool-tree ul { padding-left: 0; border-left: 0; }
    .tool-tree li { padding: 8px 0; cursor: default; }
    .tool-version { font-weight: 500; color: #948da8; font: 500 10px ui-monospace, SFMono-Regular, monospace; }
    .outcome-list code { color: #766f8f; }
    .review-dot.bad { background: #d4813a; }

    .app-icon { width: 32px; height: 32px; border-radius: 7px; }

    .scan-invite { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 20px; padding: 26px 28px; border: 1px solid #ffffffb8; border-radius: 20px; background: linear-gradient(105deg, #ffffff92, #ffffff42); box-shadow: 0 14px 35px #59627c14, inset 0 1px #ffffffb8; backdrop-filter: blur(24px); }
    .scan-progress-card { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 20px; padding: 26px 28px; border: 1px solid #ffffffb8; border-radius: 20px; background: linear-gradient(105deg, #ffffff92, #ffffff42); box-shadow: 0 14px 35px #59627c14, inset 0 1px #ffffffb8; backdrop-filter: blur(24px); }
    .scan-progress-icon { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: #8f72f6; color: #fff; font-size: 19px; animation: applications-pulse 1.4s ease-in-out infinite; }
    .scan-progress-card h2 { margin: 0; font-size: 16px; }
    .scan-progress-card p { margin: 7px 0 0; color: #8f899f; font-size: 11px; line-height: 1.5; max-width: 62ch; }
    .scan-progress-card small { display: block; margin-top: 7px; color: #a49db4; font-size: 10px; }
    @keyframes applications-pulse { 50% { transform: scale(1.06); box-shadow: 0 0 0 7px #8f72f622; } }
    .scan-invite-icon { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: #8f72f6; color: #fff; font-size: 18px; }
    .scan-invite h2 { font-size: 16px; }
    .scan-invite .muted { margin: 7px 0 0; max-width: 62ch; }
    .scan-note { margin: 9px 0 0; color: #a49db4; font-size: 11px; max-width: 62ch; }

    /* Whether a scan is running is the state of the whole page, so it sits above the columns
       rather than inside the list — Leftovers is just as empty until it lands. */
    /* Finder will not offer to undo these, so the offer has to stay visible here. */
    .rail-note { color: #a49db4 !important; font-size: 10px !important; line-height: 1.5; }
    /* With the filter rail away, the invitation takes the width it had before the columns. */
    .manager-main.wide { grid-column: 2 / -1; }
    .startup-card { max-width:660px; margin:24px auto; padding:34px; border:1px solid #e8e0f6; border-radius:20px; background:linear-gradient(145deg,#fff,#f6f1ff); box-shadow:0 14px 38px #51406b12; }
    .startup-icon { display:grid; place-items:center; width:48px; height:48px; border-radius:15px; background:#eee8ff; color:#7656cd; font-size:19px; }
    .startup-card .eyebrow { margin:22px 0 7px; color:#8d7bb8; font-size:10px; font-weight:750; letter-spacing:.14em; }.startup-card h2 { margin:0; color:#302943; font-size:23px; }.startup-card p:not(.eyebrow) { max-width:55ch; color:#756d84; font-size:13px; line-height:1.65; }.startup-card button { display:inline-flex; align-items:center; gap:9px; margin-top:12px; }.startup-card small { display:block; margin-top:18px; color:#948da8; font-size:11px; }
    .mode-rail em { margin-left: auto; padding: 1px 6px; border-radius: 5px; background: #ece7fb; color: #6b4be1; font-style: normal; font-size: 9px; font-weight: 700; }
    .undo-card { border: 1px solid #d9cdfbc0; border-radius: 16px; background: linear-gradient(145deg, #f7f3ffd0, #ffffff7c); box-shadow: 0 12px 26px #44516b12, inset 0 1px #fff; overflow: hidden; }
    .undo-card header { display: flex; align-items: center; gap: 14px; padding: 14px 17px; }
    .undo-card header > div { flex: 1; min-width: 0; }
    .undo-card strong { display: block; font-size: 13px; color: #43346f; }
    .undo-card header small { display: block; margin-top: 3px; color: #7d70a8; font-size: 11px; }
    .undo-card .primary { margin-left: 0; }
    .undo-card ul { margin: 0; padding: 0 17px 13px 17px; list-style: none; }
    .undo-card li { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; align-items: baseline; gap: 10px; padding: 6px 0; border-top: 1px solid #6b5ea01a; }
    .undo-card li span { font-size: 12px; font-weight: 600; color: #3a3452; }
    .undo-card li code { color: #948da8; font: 500 10px ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .undo-card li em { font-style: normal; font-size: 11px; font-weight: 600; color: #453e5f; }
    /* Emptied from the Trash: still named, because knowing what is gone beats a shorter list. */
    .undo-card li.gone span, .undo-card li.gone code { color: #b3adc0; text-decoration: line-through; }
    .undo-card li.gone em { color: #9a5555; text-decoration: none; }
    .undo-failed { margin: 0; padding: 9px 17px 13px; color: #9a5555; font-size: 11px; }

    .scan-banner { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 13px; padding: 13px 18px; border: 1px solid #ffffffb8; border-radius: 14px; background: linear-gradient(105deg, #ffffffb0, #ffffff66); box-shadow: 0 10px 22px #44516b12, inset 0 1px #ffffffc8; }
    .scan-banner strong { display: block; font-size: 13px; color: #2f2a44; }
    .scan-banner small { display: block; margin-top: 3px; color: #8f899f; font-size: 11px; }
    .scan-banner.quiet { background: #ffffff5c; box-shadow: none; border-color: #ffffff8c; }
    .scan-banner > div { min-width: 0; flex: 1; }
    .scan-progress { height: 4px; margin: 9px 0 1px; border-radius: 2px; background: #e6e3ef; overflow: hidden; }
    .scan-progress i { display: block; height: 100%; background: linear-gradient(90deg, #7357ec, #4c87ea); transition: width .3s ease; }
    .scan-error { color: #b23f3f; }
    .restore-note { margin: 0 auto 18px; max-width: 46ch; color: #8f899f; font-size: 11px; line-height: 1.55; }
    .restore-note.bad { color: #9a5555; }
    .restore-note span { display: block; margin-top: 5px; color: #a8a1b6; }
    .put-back { margin: 0 8px 0 0; }
    .put-back:disabled { opacity: .6; }
    .failure-list { margin: 0 0 16px; padding: 0; list-style: none; text-align: left; }
    .failure-list li { padding: 7px 10px; margin-top: 6px; border-radius: 8px; background: #fdeeee; color: #9a5555; font-size: 11px; }

    .empty-state { padding: 34px 30px; text-align: center; border: 1px solid #ffffffb8; border-radius: 18px; background: linear-gradient(145deg, #ffffffb0, #ffffff66); box-shadow: 0 14px 30px #44516b14, inset 0 1px #ffffffc8; }
    .empty-icon { display: inline-grid; place-items: center; width: 44px; height: 44px; margin-bottom: 13px; border-radius: 14px; background: #f6dfbc; color: #a8741f; font-size: 18px; }
    .empty-state h3 { margin: 0; font-size: 15px; }
    .empty-state p { margin: 9px auto 0; max-width: 58ch; color: #8f899f; font-size: 12px; line-height: 1.55; }

    @media (max-width: 1180px) { .app-row header { grid-template-columns: 18px 32px minmax(0, 1fr) auto; } .app-bar { display: none; } }
  `]
})
export class ApplicationsComponent {
  readonly faTrashCan = faTrashCan;
  readonly faBoxOpen = faBoxOpen;
  readonly faArrowRight = faArrowRight;
  readonly faRotateLeft = faRotateLeft;
  readonly faCircleCheck = faCircleCheck;
  readonly faCircleExclamation = faCircleExclamation;
  readonly faMagnifyingGlass = faMagnifyingGlass;
  readonly faFileLines = faFileLines;
  readonly faTerminal = faTerminal;
  readonly faPowerOff = faPowerOff;

  private readonly inv = inject(ApplicationInventoryService);

  readonly idleDays = IDLE_DAYS;

  readonly apps = this.inv.apps;
  readonly leftoverFiles = this.inv.leftoverFiles;
  readonly installers = this.inv.installers;
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

  readonly phase = this.inv.phase;
  readonly mode = this.inv.mode;
  async openLoginItems(): Promise<void> { try { await window.electronAPI?.openLoginItemsSettings(); } catch { /* macOS settings may be unavailable on other platforms. */ } }
  readonly filter = this.inv.filter;
  readonly sort = this.inv.sort;
  readonly search = this.inv.search;
  readonly open = this.inv.open;
  readonly openGroups = this.inv.openGroups;
  readonly selected = this.inv.selected;
  readonly developerTools = this.inv.developerTools;
  readonly toolsScanning = this.inv.toolsScanning;
  readonly toolsError = this.inv.toolsError;
  readonly toolGroup = this.inv.toolGroup;
  readonly toolPhase = this.inv.toolPhase;
  readonly selectedTools = this.inv.selectedTools;
  readonly selectedToolBytes = this.inv.selectedToolBytes;
  readonly uninstalling = this.inv.uninstalling;
  readonly uninstallReport = this.inv.uninstallReport;
  /** Developer Tools runs its own select → review → act, so it needs its own stage. */
  readonly toolStage = computed(() => this.mode() === 'tools' ? this.toolPhase() : 'browse');
  readonly blockedTools = computed(() => this.selectedTools().filter(item => item.requiredBy.length > 0));
  readonly blockedNames = computed(() => {
    const names = this.blockedTools().map(item => item.name);
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ');
  });

  readonly installed = this.inv.installed;
  readonly installerBytes = this.inv.installerBytes;
  readonly leftoverBytes = this.inv.leftoverBytes;
  readonly unusedCount = this.inv.unusedCount;
  readonly stores = this.inv.stores;
  readonly vendors = this.inv.vendors;
  readonly selectedLines = this.inv.selectedLines;
  readonly selectedCount = this.inv.selectedCount;
  readonly selectedBytes = this.inv.selectedBytes;
  readonly selectedApps = this.inv.selectedApps;
  readonly visible = this.inv.visible;

  /**
   * Applications whose data is going but whose bundle is staying. Not blocked — resetting an
   * app is a legitimate thing to want — but never silent.
   */
  readonly gutted = computed(() => this.apps().filter(app => {
    const bundles = app.groups.filter(group => group.kind === 'binary');
    const keepsApp = bundles.length > 0 && !bundles.every(group => this.groupTicked(app, group));
    const losesData = app.groups.some(group => group.kind !== 'binary' && KIND_RISK[group.kind].risk !== 'safe'
      && group.items.some(item => this.selected().has(this.key(app, item))));
    return keepsApp && losesData;
  }));

  readonly guttedNames = computed(() => {
    const names = this.gutted().map(app => app.name);
    return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  });

  /** Three screens: the invitation, the scan and its results, and what a removal did. */
  /**
   * The filter rail earns its column only when it has something to say: counts before a scan
   * are all zero, and a section with nothing scanned has nothing to filter. The main pane takes
   * the space back whenever the rail stands down.
   */
  /** The rail picks the source; the pane shows that one, so a hundred packages do not stack
      into a column six thousand pixels tall beside three. */
  readonly activeToolGroup = computed(() => {
    const groups = this.developerTools()?.groups ?? [];
    const query = this.search().trim().toLocaleLowerCase();
    if (query) {
      const match = groups.find(group => group.items.some(item => `${item.name} ${item.source} ${item.version ?? ''}`.toLocaleLowerCase().includes(query)));
      if (match) return match;
    }
    return groups.find(group => group.label === this.toolGroup()) ?? groups.at(0) ?? null;
  });
  readonly activeToolItems = computed(() => {
    const group = this.activeToolGroup();
    const query = this.search().trim().toLocaleLowerCase();
    return group?.items.filter(item => !query || `${item.name} ${item.source} ${item.version ?? ''}`.toLocaleLowerCase().includes(query)) ?? [];
  });

  readonly railVisible = computed(() =>
    this.mode() !== 'putback' && this.screen() === 'browse');

  readonly screen = computed<'idle' | 'browse'>(() => this.scanning() || this.hasScanned() ? 'browse' : 'idle');

  readonly scannedLabel = computed(() => {
    const at = this.scannedAt();
    if (at === null) return '';
    const minutes = Math.floor((Date.now() - at) / 60_000);
    return minutes < 1 ? 'Scanned just now' : minutes === 1 ? 'Scanned a minute ago' : `Scanned ${minutes} minutes ago`;
  });

  // Another page may have removed something since this one was last open.
  constructor() { void this.removals.refresh(); }

  scan(): void { void this.inv.scan(); }
  /** A section card is a shortcut: land on that section and start the one scan that fills all three. */
  openSection(section: 'uninstaller' | 'tools' | 'leftovers'): void { this.mode.set(section); this.scan(); }
  scanAgain(): void { this.inv.reset(); void this.inv.scan(); }
  scanDeveloperTools(): void { void this.inv.scanDeveloperTools(); }
  toolTicked(item: DeveloperTool): boolean { return this.inv.toolSelection().has(toolKey(item)); }
  toggleTool(item: DeveloperTool): void { this.inv.toggleTool(item); }
  clearToolSelection(): void { this.inv.clearToolSelection(); }
  reviewTools(): void { this.inv.reviewTools(); }
  backToTools(): void { this.inv.backToTools(); }
  uninstallSelectedTools(): void { void this.inv.uninstallSelectedTools(); }

  /** The line the user could have typed themselves. Showing it is what makes the button trustworthy. */
  uninstallCommand(item: DeveloperTool): string {
    switch (item.manager) {
      case 'brew': return `brew uninstall --formula ${item.name}`;
      case 'brew-cask': return `brew uninstall --cask ${item.name}`;
      case 'npm': return `npm uninstall -g ${item.name}`;
      case 'pip': return `python3 -m pip uninstall ${item.name}`;
      default: return '';
    }
  }

  toolNote(item: DeveloperTool): string {
    if (item.protection) return item.protection;
    if (item.requiredBy.length) {
      const names = item.requiredBy.slice(0, 3).join(', ');
      const rest = item.requiredBy.length - 3;
      return `Needed by ${names}${rest > 0 ? ` and ${rest} more` : ''}`;
    }
    return item.note ?? item.source;
  }

  toolRisk(item: DeveloperTool): string {
    if (item.protection) return 'removes';
    return item.requiredBy.length ? 'data' : '';
  }
  cancel(): void { void this.inv.cancel(); }
  trashSelected(): void { void this.inv.trashSelected(); }
  putBack(): void { void this.inv.putBack(); }

  size(bytes: number): string { return formatBinaryBytes(bytes) ?? '—'; }
  kindLabel(kind: Kind): string { return KIND_LABEL[kind]; }
  risk(kind: Kind): Risk { return KIND_RISK[kind].risk; }
  note(kind: Kind): string { return KIND_RISK[kind].note; }
  accent(app: InstalledApp): string { return accentFor(app.id); }
  initial(app: InstalledApp): string { return app.name.charAt(0).toUpperCase(); }
  total(app: InstalledApp): number { return this.inv.total(app); }
  groupBytes(group: AppGroup): number { return this.inv.groupBytes(group); }
  bundleOf(app: InstalledApp): number { return this.inv.bundleOf(app); }
  share(bytes: number): number { return this.inv.share(bytes); }
  groupKey(app: InstalledApp, group: AppGroup): string { return this.inv.groupKey(app, group); }
  key(app: InstalledApp, item: AppSlice): string { return this.inv.key(app, item); }
  looseKey(item: LooseFile): string { return this.inv.looseKey(item); }
  isFilter(kind: 'store' | 'vendor', value: string): boolean { const f = this.filter(); return f.kind === kind && f.value === value; }

  idleLabel(app: InstalledApp): string {
    if (app.daysIdle === null) return 'Never opened on this Mac';
    if (app.daysIdle === 0) return 'Opened today';
    if (app.daysIdle === 1) return 'Opened yesterday';
    return `Not opened in ${app.daysIdle} days`;
  }

  appTicked(app: InstalledApp): boolean { return this.inv.appTicked(app); }
  appPartly(app: InstalledApp): boolean { return this.inv.appPartly(app); }
  appSelectable(app: InstalledApp): boolean { return this.inv.appSelectable(app); }
  groupSelectable(group: AppGroup): boolean { return this.inv.groupSelectable(group); }
  groupTicked(app: InstalledApp, group: AppGroup): boolean { return this.inv.groupTicked(app, group); }
  groupPartly(app: InstalledApp, group: AppGroup): boolean { return this.inv.groupPartly(app, group); }

  toggleOpen(id: string): void { this.inv.toggleOpen(id); }
  toggleGroupOpen(app: InstalledApp, group: AppGroup): void { this.inv.toggleGroupOpen(app, group); }
  toggleItem(app: InstalledApp, item: AppSlice): void { this.inv.toggleItem(app, item); }
  toggleLoose(item: LooseFile): void { this.inv.toggleLoose(item); }
  toggleGroup(app: InstalledApp, group: AppGroup): void { this.inv.toggleGroup(app, group); }
  toggleApp(app: InstalledApp): void { this.inv.toggleApp(app); }
  clearSelection(): void { this.inv.clearSelection(); }
  reset(): void { this.inv.reset(); }
}
