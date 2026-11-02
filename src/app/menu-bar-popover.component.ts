import { AfterViewInit, ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { faBatteryHalf, faChartLine, faHardDrive, faMemory, faMicrochip, faTemperatureHalf } from '@fortawesome/free-solid-svg-icons';
import { CoreChart, MetricChartComponent } from './dashboard/metric-chart.component';
import { CORE_COLORS } from './dashboard/cpu-view.component';
import { formatBinaryBytes, toChartPoints, toSharedScaleChartPoints } from './dashboard/metric-format';
import { SystemMonitorService } from './dashboard/system-monitor.service';

/** Without a floor an idle machine draws its own noise at full height. */
const CHART_FLOOR_WATTS = 5;

type DetailMetric = 'cpu' | 'memory' | 'disks' | 'battery';
const DETAIL_METRICS: DetailMetric[] = ['cpu', 'memory', 'disks', 'battery'];

const LOGICAL_CPU_KEY = 'openclean.menubar.logicalCpu';
function readLogicalCpu(): boolean {
  try { return localStorage.getItem(LOGICAL_CPU_KEY) === 'on'; } catch { return false; }
}

function readDetailMetric(): DetailMetric | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('detail') as DetailMetric;
  return DETAIL_METRICS.includes(value) ? value : null;
}

@Component({
  selector: 'oc-menu-bar-popover',
  standalone: true,
  imports: [FontAwesomeModule, MetricChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="menu-popover" aria-label="OpenClean menu bar monitor" (click)="dismissDetail($event)">
      @if (detailMetric()) {
        <div class="metric-detail" #detailPanel>
        <div class="metric-detail-header"><div class="metric-detail-title"><h2>{{ detailTitle() }}</h2><span>{{ detailSubtitle() }}</span></div>@if (detailMetric() === 'cpu') {<div class="cpu-view-toggle" role="group" aria-label="CPU chart"><button type="button" [class.on]="!logicalCpu()" [attr.aria-pressed]="!logicalCpu()" (click)="setLogicalCpu(false)">Overall</button><button type="button" [class.on]="logicalCpu()" [attr.aria-pressed]="logicalCpu()" (click)="setLogicalCpu(true)">Logical</button></div>}</div>
        @if (detailMetric() === 'disks') {
          <div class="disk-gauge">
            <svg viewBox="0 0 120 120" role="img" [attr.aria-label]="startupDisk()?.name + ' capacity'">
              @for (slice of capacityRing(); track slice.key) {
                <circle class="ring" [class]="'ring series-' + slice.key" r="46" cx="60" cy="60"
                        pathLength="100" [attr.stroke-dasharray]="slice.dash" [attr.stroke-dashoffset]="slice.offset" />
              }
            </svg>
            <div class="disk-gauge-centre"><strong>{{ freeLabel() }}</strong><small>of {{ totalLabel() }}<br>available</small></div>
            <ul class="disk-legend">
              @for (slice of capacityRing(); track slice.key) {
                <li [class]="'series-' + slice.key"><span>{{ slice.label }}</span><b>{{ slice.value }}</b></li>
              }
            </ul>
          </div>
        } @else {
          <oc-metric-chart [label]="detailLabel()" [series]="detailSeries()" [rail]="detailRail()" [cores]="detailCores()" [compact]="true" />
        }
        @if (showConsumers()) {
          <section class="top-consumers">
            <h3>Top Consumers</h3>
            <div class="consumer-head"><span></span><span>Process name</span><span>{{ consumerColumn() }}</span><span></span></div>
            @for (process of consumers(); track process.pid) {
              <div class="consumer-row">
                @if (process.icon) { <img [src]="process.icon" alt="" /> } @else { <span class="consumer-icon-blank"></span> }
                <span>{{ process.name }}</span>
                <strong [class.hot]="isHeaviest(process)">{{ consumerValue(process) }}</strong>
                <button type="button" (click)="quit(process)" [disabled]="quitting().has(process.pid)">{{ quitting().has(process.pid) ? '…' : 'Quit' }}</button>
              </div>
            } @empty {
              <div class="consumer-empty">{{ emptyMessage() }}</div>
            }
            @if (backgroundValue(); as background) {
              <div class="consumer-background"><span></span><span>Background and system</span><strong>{{ background }}</strong><span></span></div>
            }
          </section>
        }
        @if (detailFacts(); as facts) {
          <section class="detail-facts">
            <h3>{{ factsTitle() }}</h3>
            @for (fact of facts; track fact.label) {
              <div class="fact-row"><span>{{ fact.label }}</span><strong>{{ fact.value }}</strong></div>
            }
          </section>
        }
        @if (otherDisks().length) {
          <section class="other-disks">
            <h3>Other disks</h3>
            @for (disk of otherDisks(); track disk.id) {
              <article class="disk-row">
                <header><span>{{ disk.name }}</span><small>{{ disk.isDiskImage ? 'disk image' : (disk.connection ?? '') }}</small></header>
                <div class="disk-bar"><i [style.width.%]="disk.usedPercent" [class.warm]="disk.usedPercent >= 85" [class.hot]="disk.usedPercent >= 95"></i></div>
                <footer>{{ disk.mounted ? diskFooter(disk) : 'Not mounted' }}</footer>
              </article>
            }
          </section>
        }
        </div>
      } @else {
      <header class="menu-popover-header">
        <div class="menu-brand"><span class="menu-brand-mark"><img src="assets/brand/openclean-mark.png" alt="" /></span><div><strong>OpenClean</strong><small>Mac monitor</small></div></div>
      </header>
      <div class="menu-metrics">
        <article class="menu-metric cpu" (click)="openDetail('cpu')" tabindex="0" role="button"><div class="metric-icon"><fa-icon [icon]="faMicrochip" /></div><div><span>CPU</span><strong>{{ percent(cpu()?.usagePercent) }}</strong><small class="temperature-readout" [class.temperature-warning]="temperatureTone(cpu()?.temperatureC) === 'warning'" [class.temperature-danger]="temperatureTone(cpu()?.temperatureC) === 'danger'">{{ temperature(cpu()?.temperatureC) }}</small></div></article>
        <article class="menu-metric memory" (click)="openDetail('memory')" tabindex="0" role="button"><div class="metric-icon"><fa-icon [icon]="faMemory" /></div><div><span>Memory</span><strong>{{ percent(memory()?.pressurePercent) }}</strong><small>{{ memoryDetail() }}</small></div></article>
        <article class="menu-metric disks" [class.warning]="(storage()?.usedPercent ?? 0) > 65 && (storage()?.usedPercent ?? 0) <= 80" [class.danger]="(storage()?.usedPercent ?? 0) > 80" (click)="openDetail('disks')" tabindex="0" role="button"><div class="metric-icon"><fa-icon [icon]="faHardDrive" /></div><div class="menu-metric-copy"><div class="metric-copy-head"><span>Disks</span>@if ((storage()?.usedPercent ?? 0) > 65) { <b class="disk-status" [class.high]="(storage()?.usedPercent ?? 0) > 80">{{ (storage()?.usedPercent ?? 0) > 80 ? 'High' : 'Elevated' }}</b> }</div><strong>{{ percent(storage()?.usedPercent) }}</strong><small>{{ storageDetail() }}</small><div class="mini-meter disk-meter" role="meter" aria-label="Disk space used" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="meterValue(storage()?.usedPercent)"><i [style.width.%]="meterValue(storage()?.usedPercent)" [class.warm]="(storage()?.usedPercent ?? 0) > 65 && (storage()?.usedPercent ?? 0) <= 80" [class.hot]="(storage()?.usedPercent ?? 0) > 80"></i></div></div></article>
        <article class="menu-metric battery" [class.charging]="battery()?.isCharging" [class.warning]="(battery()?.percent ?? 100) >= 20 && (battery()?.percent ?? 100) < 35" [class.low]="(battery()?.percent ?? 100) < 20" (click)="openDetail('battery')" tabindex="0" role="button"><div class="metric-icon"><fa-icon [icon]="faBatteryHalf" /></div><div class="menu-metric-copy"><span>Battery</span><strong>{{ percent(battery()?.percent) }}</strong><small>{{ battery()?.state ?? 'Reading…' }} · {{ battery()?.timeRemaining ?? 'Time unavailable' }}</small><div class="mini-meter battery-meter" role="meter" aria-label="Battery charge" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="meterValue(battery()?.percent)"><i [style.width.%]="meterValue(battery()?.percent)"></i></div></div></article>
      </div>
      <div class="menu-thermal"><fa-icon [icon]="faTemperatureHalf" /><span>Thermals</span><strong class="temperature-readout" [class.temperature-warning]="temperatureTone(thermals()?.cpuC) === 'warning'" [class.temperature-danger]="temperatureTone(thermals()?.cpuC) === 'danger'">{{ temperature(thermals()?.cpuC) }}</strong><small>{{ thermals()?.thermalState ?? 'State unavailable' }}</small></div>
      <footer class="menu-popover-footer"><button type="button" class="menu-dashboard-button" (click)="openDashboard()"><fa-icon [icon]="faChartLine" /> Open Dashboard</button></footer>
      }
    </section>
  `,
  styles: [`
    :host { display:block; width:100%; height:100vh; min-height:100vh; user-select:none; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; color:#29243d; }
    .menu-popover { box-sizing:border-box; width:100%; height:100%; min-height:100vh; padding:28px 20px 20px; display:flex; flex-direction:column; background:transparent; overflow:hidden; }
    /* A popover has no window chrome, so a scrollbar down its edge reads as a rendering fault
       rather than a control. Each panel sizes its window to its own content and should never
       scroll; scrolling still works by trackpad if one ever does. */
    /* flex:none rather than flex:1 — the panel reports its own height to size the window, and a block stretched to fill the window can only ever measure the height it already has. */
    .metric-detail { display:flex; flex-direction:column; flex:none; min-height:0; }.metric-detail-header { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }.cpu-view-toggle { display:flex; flex:none; gap:2px; padding:2px; border:1px solid rgba(116,102,176,.16); border-radius:9px; background:rgba(255,255,255,.5); }.cpu-view-toggle button { height:24px; padding:0 9px; border:0; border-radius:7px; background:transparent; color:#7c7494; font:inherit; font-size:11px; font-weight:650; cursor:pointer; transition:background .12s, color .12s; }.cpu-view-toggle button:hover:not(.on) { color:#4f4568; background:rgba(255,255,255,.6); }.cpu-view-toggle button.on { background:#fff; color:#4b33a3; box-shadow:0 1px 4px rgba(75,60,125,.14); }.metric-detail-title h2 { margin:0; color:#29243d; font-size:20px; letter-spacing:-.03em; }.metric-detail-title span { display:block; margin-top:3px; color:#827b98; font-size:10px; }.metric-detail oc-metric-chart { flex:none; height:240px; min-height:240px; margin:4px 0 8px; }.top-consumers { min-height:0; margin-top:4px; }.top-consumers h3 { margin:0 0 10px; color:#302a47; font-size:16px; }.consumer-head, .consumer-row { display:grid; grid-template-columns:20px minmax(0,1fr) 54px 34px; align-items:center; column-gap:9px; }.consumer-head { padding-bottom:6px; color:#8d86a0; font-size:10px; }.consumer-head span:nth-child(3) { text-align:right; }.consumer-row { min-height:30px; color:#3a3452; font-size:12px; }.consumer-row > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.consumer-row img, .consumer-icon-blank { width:18px; height:18px; border-radius:4px; }.consumer-icon-blank { background:rgba(116,102,176,.14); box-shadow:inset 0 0 0 1px rgba(116,102,176,.14); }.consumer-row strong { color:#453e5f; font-size:12px; font-weight:600; text-align:right; }/* Amber on the busiest row alone, and only once it is taking a serious share — a whole column of amber would say nothing. */.consumer-row strong.hot { color:#c9761c; }.consumer-row button { padding:0; border:0; background:none; color:#5b48c5; font:inherit; font-size:11px; font-weight:700; text-align:right; cursor:pointer; }.consumer-row button:hover:not(:disabled) { text-decoration:underline; }.consumer-row button:disabled { color:#a29cb8; cursor:default; }.consumer-empty { color:#8d86a0; font-size:12px; }/* macOS publishes no per-app energy figure, so the battery panel lists what it does know instead of a consumers table built on a proxy. *//* The capacity ring. Percentages of a container, drawn against pathLength=100 so the arc maths
   stays readable; rotated so it starts at the top rather than at three o'clock. */
    .disk-gauge { --app:#5b8def; --wired:#35b8a0; --compressed:#e879a8; --renderer:#b06ee0; --tiler:#3ca6b8; --metric:#9aa0bb; --swap:#e99a45; --available:#dfe2ee;
      position:relative; display:grid; grid-template-columns:150px minmax(0,1fr); align-items:center; gap:12px; margin:8px 0 14px; }
    .disk-gauge svg { width:150px; height:150px; transform:rotate(-90deg); }
    .disk-gauge .ring { fill:none; stroke-width:13; }
    .disk-gauge .ring.series-app { stroke:var(--app); }.disk-gauge .ring.series-wired { stroke:var(--wired); }.disk-gauge .ring.series-compressed { stroke:var(--compressed); }.disk-gauge .ring.series-renderer { stroke:var(--renderer); }.disk-gauge .ring.series-tiler { stroke:var(--tiler); }.disk-gauge .ring.series-metric { stroke:var(--metric); }.disk-gauge .ring.series-swap { stroke:var(--swap); }.disk-gauge .ring.series-available { stroke:var(--available); }
    .disk-gauge-centre { position:absolute; left:0; top:0; width:150px; height:150px; display:grid; place-content:center; text-align:center; }
    .disk-gauge-centre strong { display:block; color:#3a3452; font-size:22px; font-weight:700; letter-spacing:-.02em; }
    .disk-gauge-centre small { display:block; margin-top:3px; color:#8d86a0; font-size:9px; line-height:1.3; }
    .disk-legend { margin:0; padding:0; list-style:none; display:grid; gap:5px; }
    .disk-legend li { display:grid; grid-template-columns:8px minmax(0,1fr) auto; align-items:center; column-gap:7px; color:#6f6888; font-size:11px; }
    .disk-legend li::before { content:''; width:8px; height:8px; border-radius:50%; background:var(--available); }
    .disk-legend li.series-app::before { background:var(--app); }.disk-legend li.series-wired::before { background:var(--wired); }.disk-legend li.series-compressed::before { background:var(--compressed); }.disk-legend li.series-renderer::before { background:var(--renderer); }.disk-legend li.series-tiler::before { background:var(--tiler); }.disk-legend li.series-metric::before { background:var(--metric); }.disk-legend li.series-swap::before { background:var(--swap); }
    .disk-legend span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .disk-legend b { color:#3a3452; font-weight:600; }
    .other-disks { margin-top:14px; }
    .other-disks h3 { margin:0 0 9px; color:#302a47; font-size:16px; }
    .disk-row + .disk-row { margin-top:11px; }
    .disk-row header { display:flex; align-items:baseline; justify-content:space-between; gap:8px; color:#3a3452; font-size:12px; }
    .disk-row header span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .disk-row header small { flex:none; color:#8d86a0; font-size:9px; }
    .disk-bar { height:6px; margin:6px 0 5px; border-radius:3px; background:rgba(116,102,176,.14); overflow:hidden; }
    .disk-bar i { display:block; height:100%; border-radius:3px; background:#6b8cf0; }
    /* Amber once free space is getting short, red once it is a problem. */
    .disk-bar i.warm { background:#d99a2b; }
    .disk-bar i.hot { background:#d65a5a; }
    .disk-row footer { color:#8d86a0; font-size:10px; }
    .detail-facts { margin-top:14px; }.detail-facts h3 { margin:0 0 6px; color:#302a47; font-size:16px; }.detail-facts + .top-consumers { margin-top:16px; }.detail-facts h3 { margin:0 0 6px; color:#302a47; font-size:16px; }.fact-row { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:29px; color:#6f6888; font-size:12px; }.fact-row + .fact-row { border-top:1px solid rgba(116,102,176,.1); }.fact-row strong { color:#3a3452; font-size:12px; font-weight:600; text-align:right; }/* The CPU the app rows do not account for: daemons, helpers and the kernel. Not quittable, so no link — but not hidden either. */.consumer-background { display:grid; grid-template-columns:20px minmax(0,1fr) 54px 34px; align-items:center; column-gap:9px; min-height:30px; margin-top:4px; padding-top:7px; border-top:1px solid rgba(116,102,176,.16); color:#8d86a0; font-size:11px; }.consumer-background strong { color:#8d86a0; font-size:11px; font-weight:600; text-align:right; }
    .menu-popover-header, .menu-health, .menu-popover-footer { display:flex; align-items:center; justify-content:space-between; }
    .menu-brand { display:flex; align-items:center; gap:10px; }.menu-brand-mark { width:36px; height:36px; display:block; flex:none; border-radius:11px; }.menu-brand-mark img { display:block; width:100%; height:100%; border-radius:inherit; }.menu-brand strong { display:block; font-size:15px; }.menu-brand small { display:block; color:#85809e; font-size:10px; margin-top:2px; }
    .menu-close { border:0; width:30px; height:30px; border-radius:10px; background:rgba(112,92,190,.1); color:#6a5ba9; cursor:pointer; transition:background .18s ease, transform .18s ease; }.menu-close:hover { background:rgba(112,92,190,.18); transform:scale(1.04); }.menu-health { margin:16px 0 13px; padding:13px 14px; border:1px solid rgba(113,94,185,.16); border-radius:16px; background:linear-gradient(135deg, rgba(255,255,255,.72), rgba(255,255,255,.46)); box-shadow:inset 0 1px 0 rgba(255,255,255,.8); }.health-dot { width:9px; height:9px; border-radius:50%; background:#2bb88a; box-shadow:0 0 0 4px rgba(43,184,138,.12), 0 0 10px rgba(43,184,138,.32); margin-right:10px; }.menu-health > div { flex:1; }.menu-health strong { display:block; font-size:13px; }.menu-health small, .health-time { color:#827d99; font-size:10px; }.health-time { color:#2d9f7b; font-weight:700; }
    .menu-metrics { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:13px; }.menu-metric { min-height:86px; display:flex; align-items:flex-start; gap:9px; padding:12px 10px; border-radius:16px; border:1px solid rgba(105,88,170,.16); background:rgba(255,255,255,.5); box-shadow:inset 0 1px 0 rgba(255,255,255,.75), 0 4px 12px rgba(86,73,150,.08); }.metric-icon { width:29px; height:29px; flex:none; display:grid; place-items:center; border-radius:10px; color:#6451d7; background:#eee9ff; font-size:12px; }.menu-metric-copy { flex:1; min-width:0; }.menu-metric span, .menu-metric strong, .menu-metric small { display:block; }.menu-metric span { color:#766f8f; font-size:11px; font-weight:600; }.menu-metric strong { margin-top:4px; font-size:21px; letter-spacing:-.5px; }.menu-metric small { margin-top:4px; color:#8d87a2; font-size:9px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:112px; }.mini-meter { height:4px; margin-top:8px; overflow:hidden; border-radius:999px; background:rgba(105,88,170,.12); }.mini-meter i { display:block; width:0; height:100%; border-radius:inherit; transition:width .65s cubic-bezier(.2,.75,.25,1), background-color .3s ease; }.disk-meter i { background:linear-gradient(90deg,#8b6bf0,#638af0); }.disk-meter i.warm { background:linear-gradient(90deg,#eead48,#e68b40); }.disk-meter i.hot { background:linear-gradient(90deg,#e87968,#d94e64); }.battery-meter i { background:linear-gradient(90deg,#31b984,#54d4a2); }.menu-metric.battery.charging .metric-icon { animation:battery-pulse 1.8s ease-in-out infinite; }.menu-metric.battery.charging .battery-meter i { background:linear-gradient(90deg,#22ad77,#9be8c6,#22ad77); background-size:200% 100%; animation:charge-shimmer 2.1s linear infinite; }@keyframes battery-pulse { 50% { box-shadow:0 0 0 5px rgba(32,167,117,.1); } }@keyframes charge-shimmer { to { background-position:200% 0; } }@media(prefers-reduced-motion:reduce) { .mini-meter i,.menu-metric.battery.charging .metric-icon { transition:none; animation:none; } }/* Only the cards that open a panel take a pointer; the rest would be promising something. */.menu-metric[role="button"] { cursor:pointer; transition:transform .16s ease, box-shadow .16s ease; }.menu-metric[role="button"]:hover { transform:translateY(-1px); box-shadow:inset 0 1px 0 rgba(255,255,255,.75), 0 7px 16px rgba(86,73,150,.14); }.menu-metric.cpu .metric-icon { color:#df812d; background:#fff0dd; }.menu-metric.memory .metric-icon { color:#6b4be1; background:#eee5ff; }.menu-metric.disks .metric-icon { color:#7550d8; background:#eee5ff; }.menu-metric.battery .metric-icon { color:#20a775; background:#ddf8ec; }.temperature-readout { transition:color .2s ease, text-shadow .2s ease; }.temperature-readout.temperature-warning { color:#d97b22 !important; text-shadow:0 0 10px rgba(217,123,34,.16); }.temperature-readout.temperature-danger { color:#df4f66 !important; text-shadow:0 0 10px rgba(223,79,102,.2); }.menu-thermal { display:flex; align-items:center; gap:9px; margin-top:13px; padding:12px 13px; border-radius:16px; border:1px solid rgba(105,88,170,.16); background:rgba(255,255,255,.5); box-shadow:inset 0 1px 0 rgba(255,255,255,.75), 0 4px 12px rgba(86,73,150,.08); color:#746e8e; font-size:11px; }.menu-thermal fa-icon { color:#e45e83; }.menu-thermal strong { margin-left:auto; color:#4e4772; font-size:15px; }.menu-thermal small { color:#928ca5; font-size:9px; }.menu-popover-footer { margin-top:auto; padding-top:17px; justify-content:center; }.menu-dashboard-button { border:0; border-radius:12px; padding:10px 14px; color:#fff; background:linear-gradient(135deg,#7357ec,#4c87ea); font-size:11px; font-weight:700; cursor:pointer; box-shadow:0 8px 16px rgba(86,73,205,.24), inset 0 1px 0 rgba(255,255,255,.28); transition:transform .18s ease, box-shadow .18s ease; }.menu-dashboard-button:hover { transform:translateY(-1px); box-shadow:0 10px 20px rgba(86,73,205,.3), inset 0 1px 0 rgba(255,255,255,.3); }.menu-dashboard-button fa-icon { margin-right:6px; }.menu-popover-footer > span { color:#aaa4b8; font-size:9px; }
    .metric-copy-head { display:flex; align-items:center; justify-content:space-between; gap:6px; }
    .metric-copy-head .disk-status { flex:none; padding:3px 7px; border-radius:999px; color:#9a6500; background:#ffe4a8; font-size:9px; font-weight:700; }
    .menu-metric.disks.warning { border-color:#f2bd4d99; background:linear-gradient(145deg,#fffaf0e8,#fff4d780); box-shadow:inset 0 1px #ffffffed,0 5px 16px #e7a92e24; }
    .menu-metric.disks.danger { border-color:#ff718899; background:linear-gradient(145deg,#fff5f7e8,#ffe9ef8c); box-shadow:inset 0 1px #ffffffed,0 5px 16px #ed547026; }
    .menu-metric.disks.danger .disk-status { color:#a9274d; background:#ffc5d4; }
    .menu-metric.disks.warning .metric-icon { color:#9a6500; background:linear-gradient(145deg,#fff1d1,#ffd988); }
    .menu-metric.disks.danger .metric-icon { color:#c52f59; background:linear-gradient(145deg,#ffe0e8,#ff9eb7); }
    .menu-metric.disks.warning .menu-metric-copy > strong { color:#9a6500; }
    .menu-metric.disks.danger .menu-metric-copy > strong { color:#c52f59; }
    .menu-metric.battery.warning { border-color:#f2bd4d99; background:linear-gradient(145deg,#fffaf0e8,#fff4d780); }
    .menu-metric.battery.warning .metric-icon { color:#a86b15; background:linear-gradient(145deg,#fff1d1,#ffd988); }
    .menu-metric.battery.warning .menu-metric-copy > strong { color:#a86b15; }
    .menu-metric.battery.low { border-color:#ff718899; background:linear-gradient(145deg,#fff5f7e8,#ffe9ef8c); animation:low-battery-border 1.8s ease-in-out infinite; }
    .menu-metric.battery.low .metric-icon { color:#c52f59; background:linear-gradient(145deg,#ffe0e8,#ff9eb7); animation:low-battery-pulse 1.25s ease-in-out infinite; }
    .menu-metric.battery.low .menu-metric-copy > strong { color:#c52f59; }
    .menu-metric.battery.low .battery-meter i { background:linear-gradient(90deg,#e87968,#d94e64); animation:low-battery-pulse 1.25s ease-in-out infinite; }
    @keyframes low-battery-pulse { 50% { box-shadow:0 0 0 5px rgba(217,78,100,.13); filter:brightness(1.08); } }
    @keyframes low-battery-border { 50% { box-shadow:inset 0 1px #ffffffed,0 0 0 2px rgba(217,78,100,.12),0 5px 16px #ed547026; } }
    @media(prefers-reduced-motion:reduce) { .menu-metric.battery.low,.menu-metric.battery.low .metric-icon,.menu-metric.battery.low .battery-meter i { animation:none; } }
  `]
})
export class MenuBarPopoverComponent implements AfterViewInit, OnInit, OnDestroy {
  readonly monitor = inject(SystemMonitorService);
  readonly faChartLine = faChartLine; readonly faMicrochip = faMicrochip; readonly faMemory = faMemory; readonly faBatteryHalf = faBatteryHalf; readonly faHardDrive = faHardDrive; readonly faTemperatureHalf = faTemperatureHalf;
  readonly cpu = this.monitor.cpu; readonly memory = this.monitor.memory; readonly storage = this.monitor.storage; readonly battery = this.monitor.battery; readonly network = this.monitor.network; readonly thermals = this.monitor.thermals;
  /**
   * Which metric this window is showing, or null in the menu bar popover itself. Set from the
   * query string on first load and then by the main process, which switches an open panel
   * over rather than reloading it — a reload would blank the window and throw away the 60
   * seconds of history the chart has collected.
   */
  readonly detailMetric = signal<DetailMetric | null>(readDetailMetric());
  readonly detailMode = this.detailMetric() !== null;

  /** Per-processor charts in the CPU panel, remembered separately from the dashboard's own toggle. */
  readonly logicalCpu = signal(readLogicalCpu());
  readonly detailCores = computed<CoreChart[]>(() => {
    if (this.detailMetric() !== 'cpu' || !this.logicalCpu()) return [];
    const history = this.monitor.history();
    return this.cpu()?.logical.map(core => ({
      index: core.index,
      usagePercent: core.usagePercent,
      points: toChartPoints(history.map(sample => sample.logicalCores[core.index - 1] ?? 0)),
      color: CORE_COLORS[(core.index - 1) % CORE_COLORS.length]
    })) ?? [];
  });

  setLogicalCpu(on: boolean): void {
    this.logicalCpu.set(on);
    try { localStorage.setItem(LOGICAL_CPU_KEY, on ? 'on' : 'off'); } catch { /* A preference is not worth an error. */ }
  }

  readonly detailLabel = computed(() => ({ memory: 'Memory', disks: 'Disks', cpu: 'CPU', battery: 'Energy' })[this.detailMetric() ?? 'cpu']);

  readonly detailTitle = computed(() => {
    if (this.detailMetric() === 'memory') return formatBinaryBytes(this.memory()?.totalBytes) ?? 'Memory';
    if (this.detailMetric() === 'disks') return this.startupDisk()?.name ?? 'Disks';
    // The pack's rated capacity, which is what the battery is, rather than how full it is now.
    if (this.detailMetric() === 'battery') {
      const design = this.battery()?.designMah;
      return design ? `${design.toLocaleString()} mAh` : 'Battery';
    }
    return this.cpu()?.model ?? 'CPU';
  });

  readonly detailSubtitle = computed(() => {
    if (this.detailMetric() === 'memory') return this.monitor.memoryInfo()?.type ?? 'Installed memory';
    if (this.detailMetric() === 'disks') {
      const disk = this.startupDisk();
      if (!disk) return 'Reading…';
      const kind = disk.isDiskImage ? 'Disk image' : disk.internal ? 'Internal' : 'External';
      return [disk.model, `${kind}${disk.internal && !disk.isDiskImage ? ' SSD' : ''}`].filter(Boolean).join(' · ');
    }
    if (this.detailMetric() === 'battery') {
      const battery = this.battery();
      if (!battery) return 'Reading…';
      return [battery.cycleCount === null ? null : `${battery.cycleCount} cycles`, battery.health].filter(Boolean).join(' · ') || 'Battery';
    }
    return `${this.cpu()?.logicalCores ?? '—'} logical processors`;
  });

  /** One rail row per line on the plot, so no reading is left without a colour to match it. */
  readonly detailSeries = computed(() => {
    const history = this.monitor.history();
    if (this.detailMetric() === 'memory') {
      return [
        { key: 'usage', points: toChartPoints(history.map(sample => sample.memoryPressure)) },
        { key: 'app', points: toChartPoints(history.map(sample => sample.memoryApp)) },
        { key: 'wired', points: toChartPoints(history.map(sample => sample.memoryWired)) },
        { key: 'compressed', points: toChartPoints(history.map(sample => sample.memoryCompressed)) }
      ];
    }
    if (this.detailMetric() === 'battery') {
      // Both traces share one scale so the pack draw can be read against what the chips
      // account for; a floor keeps an idle machine from drawing a flat line at full height.
      const peak = Math.max(CHART_FLOOR_WATTS, ...history.map(sample => Math.max(sample.batteryWatts, sample.packageWatts)));
      return [
        { key: 'user', points: toSharedScaleChartPoints(history.map(sample => sample.batteryWatts), peak) },
        { key: 'app', points: toSharedScaleChartPoints(history.map(sample => sample.packageWatts), peak) }
      ];
    }
    return [
      { key: 'usage', points: toChartPoints(history.map(sample => sample.cpuUsage)) },
      { key: 'user', points: toChartPoints(history.map(sample => sample.cpuUser)) },
      { key: 'system', points: toChartPoints(history.map(sample => sample.cpuSystem)) }
    ];
  });

  readonly detailRail = computed(() => {
    if (this.detailMetric() === 'memory') {
      const memory = this.memory();
      const bytes = (value: number | undefined) => value === undefined ? '—' : formatBinaryBytes(value) ?? '—';
      return [
        { key: 'usage', label: 'Usage', value: this.percent(memory?.pressurePercent) },
        { key: 'app', label: 'App', value: bytes(memory?.appBytes) },
        { key: 'wired', label: 'Wired', value: bytes(memory?.wiredBytes) },
        { key: 'compressed', label: 'Compressed', value: bytes(memory?.compressedBytes) }
      ];
    }
    if (this.detailMetric() === 'battery') {
      const battery = this.battery();
      const watts = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value.toFixed(2)} W`;
      return [
        { key: 'usage', label: 'Charge', value: this.percent(battery?.percent) },
        // One number means charge going in or coming out, so the label says which.
        { key: 'user', label: battery?.isCharging ? 'Charging' : battery?.externalConnected ? 'From pack' : 'Draw', value: watts(battery?.watts) },
        { key: 'app', label: 'Chips', value: watts(this.thermals()?.packageWatts) },
        { key: 'wired', label: 'Temp', value: battery?.temperatureC == null ? '—' : `${battery.temperatureC}°C` }
      ];
    }
    const cpu = this.cpu();
    return [
      { key: 'usage', label: 'Usage', value: this.percent(cpu?.usagePercent) },
      { key: 'available', label: 'Available', value: this.percent(cpu?.availablePercent) },
      { key: 'user', label: 'User', value: this.percent(cpu?.userPercent) },
      { key: 'system', label: 'System', value: this.percent(cpu?.systemPercent) }
    ];
  });

  /** Startup disk first, which is what readDisks sorts for. */
  readonly startupDisk = computed<Disk | null>(() => {
    const disks = this.storage()?.disks ?? [];
    return disks.find(disk => disk.isStartupDisk) ?? disks[0] ?? null;
  });

  readonly otherDisks = computed<Disk[]>(() => {
    if (this.detailMetric() !== 'disks') return [];
    const startup = this.startupDisk();
    return (this.storage()?.disks ?? []).filter(disk => disk !== startup);
  });
  /**
   * What the drive itself reports, for the Disks panel. Rows the hardware does not answer for
   * are dropped rather than printed as a dash — and SSD wear is not among them at all: the
   * NVMe SMART interface exists on Apple Silicon but refuses every command.
   */
  readonly factsTitle = computed(() => this.detailMetric() === 'battery' ? 'Battery' : 'Disk');

  readonly detailFacts = computed<Array<{ label: string; value: string }> | null>(() => {
    if (this.detailMetric() === 'battery') return this.batteryFacts();
    if (this.detailMetric() !== 'disks') return null;
    const disk = this.startupDisk();
    const storage = this.storage();
    if (!disk) return null;
    return [
      { label: 'Connection', value: [disk.connection, disk.internal === null ? null : disk.internal ? 'Internal' : 'External'].filter(Boolean).join(' · ') },
      { label: 'SMART', value: storage?.hardware?.smartStatus ?? null },
      { label: 'Temperature', value: disk.temperatureC === null ? null : `${disk.temperatureC}°C` },
      { label: 'Snapshots', value: storage?.snapshots === null || storage?.snapshots === undefined ? null : String(storage.snapshots) }
    ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));
  });

  private readonly batteryFacts = computed<Array<{ label: string; value: string }> | null>(() => {
    const battery = this.battery();
    if (!battery) return null;
    const capacity = battery.maxChargeMah !== null && battery.designMah
      ? `${battery.maxChargeMah.toLocaleString()} of ${battery.designMah.toLocaleString()} mAh · ${Math.round((battery.maxChargeMah / battery.designMah) * 100)}%`
      : null;
    return [
      { label: 'Condition', value: battery.health },
      { label: 'Cycles', value: battery.cycleCount === null ? null : String(battery.cycleCount) },
      { label: 'Capacity', value: capacity },
      { label: 'Voltage', value: battery.volts === null ? null : `${battery.volts.toFixed(2)} V` },
      // Not connected is an answer, so it prints; an unknown wattage is not, so it drops.
      { label: 'Power adapter', value: battery.externalConnected ? (battery.adapterWatts === null ? null : `${battery.adapterWatts} W`) : 'Not connected' }
    ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));
  });

  readonly freeLabel = computed(() => formatBinaryBytes(this.startupDisk()?.freeBytes) ?? '—');
  readonly totalLabel = computed(() => formatBinaryBytes(this.startupDisk()?.totalBytes) ?? '—');
  diskFooter(disk: Disk): string { return `${this.bytes(disk.usedBytes)} used · ${this.bytes(disk.freeBytes)} free of ${this.bytes(disk.totalBytes)}`; }

  /**
   * The ring is the startup container: its volumes, then whatever is left free. Every volume in
   * a container draws on one pool, so this is the only place a percentage means anything — a
   * per-volume "% full" would show one disk as several, each filled to a different level.
   *
   * Arcs are laid out against `pathLength="100"`, so the numbers here are plain percentages
   * rather than fractions of a circumference nobody can check by eye.
   */
  readonly capacityRing = computed(() => {
    const disk = this.startupDisk();
    if (!disk || disk.totalBytes <= 0) return [];

    const palette = ['app', 'wired', 'compressed', 'renderer', 'tiler'];
    const categories = disk.categories.length
      ? disk.categories.slice(0, palette.length)
      : disk.volumes.slice(0, palette.length).map(volume => ({ key: volume.role ?? volume.name, label: volume.role ?? volume.name, usedBytes: volume.usedBytes }));
    const swapCandidate = this.monitor.memory()?.swapUsedBytes ?? 0;
    const parts = categories.flatMap((category, index) => {
      if (category.key !== 'other') return [{ key: palette[index], label: category.label, bytes: category.usedBytes }];
      // The residual Other bucket includes swap files. Split the reported Swap Used out of
      // that remainder so the ring shows it distinctly without counting it twice.
      const swapBytes = Math.min(Math.max(0, swapCandidate), category.usedBytes);
      return [
        { key: palette[index], label: category.label, bytes: category.usedBytes - swapBytes },
        ...(swapBytes > 0 ? [{ key: 'swap', label: 'macOS Swap', bytes: swapBytes }] : [])
      ];
    }).filter(part => part.bytes > 0);
    parts.push({ key: 'available', label: 'Free', bytes: disk.freeBytes });

    let start = 0;
    return parts.map(part => {
      const percent = (part.bytes / disk.totalBytes) * 100;
      const slice = {
        key: part.key,
        label: part.label,
        value: formatBinaryBytes(part.bytes) ?? '—',
        dash: `${percent.toFixed(3)} ${(100 - percent).toFixed(3)}`,
        offset: (-start).toFixed(3)
      };
      start += percent;
      return slice;
    });
  });

  /**
   * The Disks panel has no consumers list: macOS gives no per-app disk figure the ring could
   * be split by, so that panel shows its volumes instead.
   */
  /** Only the two metrics macOS attributes per process. */
  readonly showConsumers = computed(() => this.detailMetric() === 'cpu' || this.detailMetric() === 'memory');

  readonly consumerMetric = computed<'cpu' | 'memory'>(() => this.detailMetric() === 'memory' ? 'memory' : 'cpu');

  readonly consumers = computed<TopProcess[]>(() => {
    if (this.detailMetric() === 'disks') return [];
    return this.consumerMetric() === 'memory' ? this.monitor.memoryConsumers() : this.monitor.cpuConsumers();
  });

  readonly consumerColumn = computed(() => this.consumerMetric() === 'memory' ? 'Memory' : 'Usage, %');

  readonly emptyMessage = computed(() => this.consumerMetric() === 'memory'
    ? 'No application is holding memory right now'
    : 'No application is using the CPU right now');

  /** What the app rows do not account for: daemons, helpers and the kernel. */
  readonly backgroundValue = computed(() => {
    if (this.detailMetric() === 'disks') return null;
    if (this.consumerMetric() === 'memory') return formatBinaryBytes(this.monitor.memoryBackground());
    const percent = this.monitor.cpuBackground();
    return percent == null || percent === 0 ? null : percent.toFixed(1);
  });

  /**
   * Rows arrive ranked, so the first is the heaviest. It is only marked once it is taking a
   * share worth pointing at — a highlight on whatever happens to lead a quiet machine says
   * nothing.
   */
  private readonly heaviestConsumer = computed(() => {
    const leader = this.consumers()[0];
    if (!leader) return null;
    const floor = this.consumerMetric() === 'memory' ? (this.memory()?.totalBytes ?? 0) * 0.1 : 20;
    const weight = this.consumerMetric() === 'memory' ? leader.memoryBytes : leader.cpuPercent;
    return weight >= floor ? leader : null;
  });

  isHeaviest(process: TopProcess): boolean { return this.heaviestConsumer()?.pid === process.pid; }

  consumerValue(process: TopProcess): string {
    if (this.consumerMetric() === 'memory') return formatBinaryBytes(process.memoryBytes) ?? '—';
    return process.cpuPercent.toFixed(1);
  }

  /** Pids with a quit in flight, so a row cannot be clicked twice while the dialog is open. */
  readonly quitting = signal(new Set<number>());

  quit(process: TopProcess): void {
    if (this.quitting().has(process.pid)) return;
    this.quitting.update(pids => new Set(pids).add(process.pid));
    const release = () => this.quitting.update(pids => { const next = new Set(pids); next.delete(process.pid); return next; });
    void window.electronAPI?.quitProcess(process.pid).then(release, release);
  }

  private readonly detailPanel = viewChild<ElementRef<HTMLElement>>('detailPanel');
  private panelObserver?: ResizeObserver;

  /**
   * The window is sized from the panel, not the other way round. Watching the element rather
   * than reporting once covers every way the content changes height: switching metric, the
   * first readings landing, a disk appearing, a row of facts the hardware does not report.
   */
  ngAfterViewInit(): void {
    if (!this.detailMode || typeof ResizeObserver === 'undefined') return;
    let reported = 0;
    const measure = (element: HTMLElement) => {
      // The panel's own height plus the padding the popover puts around it.
      const style = getComputedStyle(element.parentElement ?? element);
      const padding = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
      const height = Math.ceil(element.getBoundingClientRect().height + padding);
      if (height < 1 || height === reported) return;
      reported = height;
      void window.electronAPI?.fitDetail(height);
    };
    this.panelObserver = new ResizeObserver(entries => {
      const element = entries[0]?.target as HTMLElement | undefined;
      if (element) measure(element);
    });
    const panel = this.detailPanel()?.nativeElement;
    if (panel) { this.panelObserver.observe(panel); measure(panel); }
  }

  private removeVisibilityListener?: () => void;
  private removeMetricListener?: () => void;
  ngOnInit(): void {
    const api = window.electronAPI;
    this.removeVisibilityListener = api?.onMenuBarVisibilityChanged(visible => visible ? this.monitor.startPolling() : this.monitor.stopPolling());
    if (this.detailMode) {
      this.removeMetricListener = api?.onDetailMetricChanged(metric => {
        const next: DetailMetric = DETAIL_METRICS.includes(metric as DetailMetric) ? metric as DetailMetric : 'cpu';
        this.detailMetric.set(next);
        // The query string seeds the metric on load, so keep it in step — otherwise a reload
        // would drop the panel back to whichever metric it was first opened for.
        window.history.replaceState(null, '', `?menubar=1&detail=${next}`);
      });
      this.monitor.startPolling();
      return;
    }
    void api?.isMenuBarVisible().then(({ visible }) => visible ? this.monitor.startPolling() : this.monitor.stopPolling());
  }
  ngOnDestroy(): void { this.panelObserver?.disconnect(); this.removeVisibilityListener?.(); this.removeMetricListener?.(); this.monitor.stopPolling(); }
  /**
   * A click on the popover's own background puts the detail panel away, the way clicking off a
   * menu dismisses it. Only the bare background counts — the target has to be the popover
   * itself, so a click that lands on any card or row is that element's business, and a metric
   * card goes on swapping the panel over rather than closing it.
   */
  dismissDetail(event: MouseEvent): void {
    if (this.detailMetric() || event.target !== event.currentTarget) return;
    void window.electronAPI?.closeDetail();
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: KeyboardEvent): void { event.preventDefault(); this.close(); }

  openDetail(metric: DetailMetric): void { void window.electronAPI?.openDetail(metric); }
  closeDetail(): void { this.detailMetric.set(null); void window.electronAPI?.closeDetail(); }
  temperature(value: number | null | undefined): string { return value == null ? 'Temperature unavailable' : `${value}°C`; }
  temperatureTone(value: number | null | undefined): 'normal' | 'warning' | 'danger' { return value == null ? 'normal' : value >= 70 ? 'danger' : value >= 60 ? 'warning' : 'normal'; }
  percent(value: number | null | undefined): string { return value == null ? '0%' : `${value}%`; }
  meterValue(value: number | null | undefined): number { return value == null ? 0 : Math.max(0, Math.min(100, value)); }
  memoryDetail(): string { const memory = this.memory(); return memory ? `${this.bytes(memory.availableBytes)} available` : 'Reading…'; }
  storageDetail(): string { const storage = this.storage(); return storage ? `${this.bytes(storage.availableBytes)} available` : 'Reading…'; }
  networkRate(): string { const network = this.network(); if (!network) return '—'; return `${this.rate(network.downloadBytesPerSecond)} ↓`; }
  openDashboard(): void { void window.electronAPI?.showMainWindow(); }
  close(): void { void window.electronAPI?.hideMenuBar(); }
  bytes(value: number): string { if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`; return `${Math.round(value / 1_000_000)} MB`; }
  private rate(value: number): string { if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB/s`; if (value >= 1_000) return `${Math.round(value / 1_000)} KB/s`; return `${Math.round(value)} B/s`; }
}
