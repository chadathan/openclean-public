import { ChangeDetectionStrategy, Component, HostBinding, Input } from '@angular/core';

export interface ChartSeries {
  key: string;
  points: string;
}

export interface RailFact {
  key: string;
  label: string;
  value: string;
}

export interface CoreChart {
  index: number;
  usagePercent: number;
  points: string;
  color: string;
}

let instanceCount = 0;

/**
 * The plot, the per-core grid and the reading rail beside them.
 *
 * Everything here is presentational: the caller supplies points already projected into the
 * 600x190 box, so this component never touches history or units. Styles are encapsulated —
 * the chart rules used to live in the global sheet, where later rules at equal specificity
 * kept silently overriding earlier ones.
 */
@Component({
  selector: 'oc-metric-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (cores.length) {
      <div class="logical-grid" [attr.data-cores]="cores.length">
        @for (core of cores; track core.index) {
          <article class="logical-cell">
            <header><span>{{ compact ? core.index : 'CPU ' + core.index }}</span><strong>{{ compact ? round(core.usagePercent) : core.usagePercent }}%</strong></header>
            <svg viewBox="0 0 600 190" preserveAspectRatio="none" role="img"
                 [attr.aria-label]="'Logical processor ' + core.index + ' history'">
              <line class="grid" x1="0" y1="63" x2="600" y2="63" />
              <line class="grid" x1="0" y1="127" x2="600" y2="127" />
              <polygon class="area" [style.fill]="core.color" [attr.points]="areaPoints(core.points)" />
              <polyline class="line" [style.stroke]="core.color" [attr.points]="core.points" />
            </svg>
          </article>
        }
      </div>
    } @else {
      <svg class="chart" viewBox="0 0 600 190" preserveAspectRatio="none" role="img" [attr.aria-label]="label + ' history'">
        <defs>
          @for (item of series; track item.key) {
            <linearGradient [attr.id]="gradientId(item.key)" x1="0" y1="0" x2="0" y2="1">
              <stop [attr.class]="'stop-top series-' + item.key" offset="0" />
              <stop [attr.class]="'stop-bottom series-' + item.key" offset="1" />
            </linearGradient>
          }
        </defs>
        <line class="grid" x1="0" y1="63" x2="600" y2="63" />
        <line class="grid" x1="0" y1="127" x2="600" y2="127" />
        @for (item of series; track item.key) {
          <polygon class="area" [attr.fill]="'url(#' + gradientId(item.key) + ')'" [attr.points]="areaPoints(item.points)" />
        }
        @for (item of series; track item.key) {
          <polyline [attr.class]="'line series-' + item.key" [attr.points]="item.points" />
        }
      </svg>
    }
    @if (rail.length) {
      <div class="rail">
        @for (fact of rail; track fact.key) {
          <div [attr.class]="'series-' + fact.key"><strong>{{ fact.value }}</strong><small>{{ fact.label }}</small></div>
        }
      </div>
    }
  `,
  styles: [`
    /* One token per series. The line, the fill under it and its rail row all read the same
       pair, so a colour cannot end up on the wrong reading. */
    :host {
      --usage: #8d76d9; --usage-text: #4d3b8f;
      --available: #b9b9c8; --available-text: #5f6175;
      --user: #ef7c86; --user-text: #d94f67;
      --system: #7789e9; --system-text: #596fe8;
      --app: #5b8def; --app-text: #3568cc;
      --wired: #35b8a0; --wired-text: #1f8f7b;
      --compressed: #e879a8; --compressed-text: #c2497f;
      --renderer: #b06ee0; --renderer-text: #8a45bd;
      --tiler: #3ca6b8; --tiler-text: #2a7f8e;
      --battery: #35b98a; --battery-text: #168d62;
      --download: #4a86e8; --upload: #ef7181;
      --metric: #6c8cff; --metric-text: #4a63c9;

      display: grid;
      grid-template-columns: minmax(0, 1fr) 120px;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 260px;
      margin-top: auto;
      padding-top: 18px;
    }

    .chart, .logical-grid, .rail { height: 260px; margin-top: 12px; }

    .chart {
      display: block;
      width: 100%;
      min-width: 0;
      border: 1px solid #c7cee3;
      border-radius: 12px;
      background:
        repeating-linear-gradient(to bottom, transparent 0, transparent calc(10% - 1px), #aeb8d02b calc(10% - 1px), #aeb8d02b 10%),
        linear-gradient(180deg, #f8f9ffff, #eef1fbcc);
      box-shadow: inset 0 0 0 1px #ffffffb8, 0 5px 14px #66739b12;
    }

    .grid { display: none; }
    .area { stroke: none; }
    .stop-top { stop-opacity: .26; }
    .stop-bottom { stop-opacity: 0; }

    /* preserveAspectRatio="none" scales the stroke with the box, so a wide plot renders
       thinner than a small per-core cell unless the width is pinned. */
    .line {
      fill: none;
      stroke-width: 1.6;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }

    .line.series-usage { stroke: var(--usage); }
    .line.series-available { stroke: var(--available); }
    .line.series-user { stroke: var(--user); }
    .line.series-system { stroke: var(--system); }
    .line.series-app { stroke: var(--app); }
    .line.series-wired { stroke: var(--wired); }
    .line.series-compressed { stroke: var(--compressed); }
    .line.series-renderer { stroke: var(--renderer); }
    .line.series-tiler { stroke: var(--tiler); }
    .line.series-battery { stroke: var(--battery); }
    .line.series-download { stroke: var(--download); }
    .line.series-upload { stroke: var(--upload); }
    .line.series-metric { stroke: var(--metric); }

    stop.series-usage { stop-color: var(--usage); }
    stop.series-available { stop-color: var(--available); }
    stop.series-user { stop-color: var(--user); }
    stop.series-system { stop-color: var(--system); }
    stop.series-app { stop-color: var(--app); }
    stop.series-wired { stop-color: var(--wired); }
    stop.series-compressed { stop-color: var(--compressed); }
    stop.series-renderer { stop-color: var(--renderer); }
    stop.series-tiler { stop-color: var(--tiler); }
    stop.series-battery { stop-color: var(--battery); }
    stop.series-download { stop-color: var(--download); }
    stop.series-upload { stop-color: var(--upload); }
    stop.series-metric { stop-color: var(--metric); }

    /* Rail. Rows divide the plot's height evenly, whatever the metric publishes, and their
       accent bars butt together into one unbroken line. */
    .rail {
      justify-self: end;
      box-sizing: border-box;
      width: 108px;
      display: grid;
      grid-template-columns: 1fr;
      grid-auto-rows: 1fr;
      align-content: stretch;
      gap: 0;
    }

    .rail > div { padding-left: 10px; border-left: 3px solid var(--available); }
    .rail strong { display: block; font-size: 17px; font-weight: 700; line-height: 1.1; letter-spacing: -.01em; white-space: nowrap; }
    .rail small { display: block; margin-top: 4px; color: #8f899f; font-size: 11px; font-weight: 500; line-height: 1.2; }

    .rail > .series-usage { border-left-color: var(--usage); }
    .rail > .series-available { border-left-color: var(--available); }
    .rail > .series-user { border-left-color: var(--user); }
    .rail > .series-system { border-left-color: var(--system); }
    .rail > .series-app { border-left-color: var(--app); }
    .rail > .series-wired { border-left-color: var(--wired); }
    .rail > .series-compressed { border-left-color: var(--compressed); }
    .rail > .series-renderer { border-left-color: var(--renderer); }
    .rail > .series-tiler { border-left-color: var(--tiler); }
    .rail > .series-battery { border-left-color: var(--battery); }
    .rail > .series-download { border-left-color: var(--download); }
    .rail > .series-upload { border-left-color: var(--upload); }

    .rail > .series-usage strong { color: var(--usage-text); }
    .rail > .series-available strong { color: var(--available-text); }
    .rail > .series-user strong { color: var(--user-text); }
    .rail > .series-system strong { color: var(--system-text); }
    .rail > .series-app strong { color: var(--app-text); }
    .rail > .series-wired strong { color: var(--wired-text); }
    .rail > .series-compressed strong { color: var(--compressed-text); }
    .rail > .series-renderer strong { color: var(--renderer-text); }
    .rail > .series-tiler strong { color: var(--tiler-text); }
    .rail > .series-battery strong { color: var(--battery-text); }
    .rail > .series-download strong { color: var(--download); }
    .rail > .series-upload strong { color: var(--upload); }

    /* Per-core grid: four across like Task Manager, squaring up for small core counts and
       dropping to two in a narrow window so the "CPU n  nn.n%" header still fits. */
    .logical-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr); gap: 8px; min-width: 0; }
    .logical-grid[data-cores="1"] { grid-template-columns: minmax(0, 1fr); }
    .logical-grid[data-cores="2"],
    .logical-grid[data-cores="3"],
    .logical-grid[data-cores="4"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }

    .logical-cell {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border: 1px solid #c7cee3;
      border-radius: 10px;
      background: linear-gradient(180deg, #f8f9ffff, #eef1fbcc);
      box-shadow: inset 0 0 0 1px #ffffffb8;
    }

    .logical-cell header { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; padding: 6px 8px 1px; }
    .logical-cell header span { color: #8f899f; font-size: 11px; font-weight: 500; line-height: 1.2; white-space: nowrap; }
    .logical-cell header strong { color: #302b3d; font-size: 12px; font-weight: 650; line-height: 1.2; white-space: nowrap; }
    .logical-cell svg { display: block; flex: 1; width: 100%; min-height: 0; }
    .logical-cell .area { fill-opacity: .14; }

    @media (max-width: 1150px) {
      .logical-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    /* A narrow viewport means the dashboard window was resized. It does not mean the compact
       panel, whose window is a fixed 420px and always wants the rail beside the plot — so the
       compact host opts out. Unscoped, the rail took the three-across layout while :host(.compact)
       still pinned it to 96px, and the three readings piled up on top of the cards below it. */
    @media (max-width: 780px) {
      :host(:not(.compact)) { grid-template-columns: 1fr; gap: 16px; }
      :host(:not(.compact)) .chart, :host(:not(.compact)) .rail { height: auto; }
      :host(:not(.compact)) .chart { height: 240px; }
      :host(:not(.compact)) .logical-grid { height: 320px; }
      :host(:not(.compact)) .rail { width: 100%; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: auto; gap: 12px; }
    }

    :host(.compact) { min-height: 240px; grid-template-columns: minmax(0, 1fr) 100px; gap: 8px; padding-top: 10px; }
    :host(.compact) .chart, :host(.compact) .logical-grid, :host(.compact) .rail { height: 220px; margin-top: 8px; }
    :host(.compact) .rail { width: 96px; }
    :host(.compact) .logical-grid { gap: 5px; }
    :host(.compact) .logical-cell { border-radius: 8px; }
    :host(.compact) .logical-cell header { padding: 4px 6px 0; }
    :host(.compact) .logical-cell header span { font-size: 9px; }
    :host(.compact) .logical-cell header strong { font-size: 10px; }
    :host(.compact) .rail strong { font-size: 16px; }
  `]
})
export class MetricChartComponent {
  @Input({ required: true }) series: ChartSeries[] = [];
  @Input({ required: true }) rail: RailFact[] = [];
  @Input() cores: CoreChart[] = [];
  @Input() label = 'Selected metric';
  @Input() compact = false;
  round(value: number): number { return Math.round(value); }
  @HostBinding('class.compact') get compactClass(): boolean { return this.compact; }

  // Gradient ids are document-global, so they carry the instance number.
  private readonly uid = ++instanceCount;

  gradientId(key: string): string {
    return `metric-chart-${this.uid}-${key}`;
  }

  areaPoints(points: string): string {
    return points ? `0,190 ${points} 600,190` : '';
  }
}
