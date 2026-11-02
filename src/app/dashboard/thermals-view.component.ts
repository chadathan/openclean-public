import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MetricChartComponent } from './metric-chart.component';
import { MetricFact, MetricSpecComponent } from './metric-spec.component';
import { presentFacts, toCeilingChartPoints } from './metric-format';
import { SystemMonitorService } from './system-monitor.service';

/**
 * A ceiling for the plot. Apple Silicon throttles well below this, so a trace never fills
 * the box and the shape of the day stays comparable from one minute to the next — which a
 * window-relative scale would not be.
 */
const CHART_CEILING_C = 100;

/** How macOS names its four thermal pressure levels, in the order it escalates through. */
const PRESSURE_LABELS: Record<string, string> = {
  nominal: 'Nominal',
  fair: 'Fair',
  serious: 'Serious',
  critical: 'Critical'
};

/** Everything the Thermals metric shows: its plot, its rail and its detail panel. */
@Component({
  selector: 'oc-thermals-view',
  standalone: true,
  imports: [MetricChartComponent, MetricSpecComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oc-metric-chart label="Thermals" [series]="series()" [rail]="rail()" />
    <oc-metric-spec [live]="liveFacts()" [spec]="specFacts()" />
  `
})
export class ThermalsViewComponent {
  private readonly monitor = inject(SystemMonitorService);

  /** Plotted against a fixed ceiling, so these are degrees rather than a shape. */
  readonly series = computed(() => {
    const history = this.monitor.history();
    const scale = (values: number[]) => toCeilingChartPoints(values, CHART_CEILING_C);
    return [
      { key: 'user', points: scale(history.map(sample => sample.cpuC)) },
      { key: 'app', points: scale(history.map(sample => sample.socC)) },
      { key: 'wired', points: scale(history.map(sample => sample.batteryC)) }
    ];
  });

  readonly rail = computed(() => {
    const thermals = this.monitor.thermals();
    const degrees = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value}°C`;
    return [
      { key: 'usage', label: 'Pressure', value: this.pressure() },
      { key: 'user', label: 'CPU', value: degrees(thermals?.cpuC) },
      { key: 'app', label: 'SoC', value: degrees(thermals?.socC) },
      { key: 'wired', label: 'Battery', value: degrees(thermals?.batteryC) }
    ];
  });

  readonly pressure = computed(() => {
    const state = this.monitor.thermals()?.thermalState;
    return state ? PRESSURE_LABELS[state] ?? state : '—';
  });

  /**
   * The GPU and Neural Engine rows read blank while those blocks are idle: macOS gates
   * their sensors rather than reporting a low number, so there is genuinely nothing to show.
   */
  readonly liveFacts = computed<MetricFact[]>(() => {
    const thermals = this.monitor.thermals();
    if (!thermals) return [];
    const degrees = (value: number | null) => value === null ? '—' : `${value}°C`;
    return presentFacts([
      { label: 'Pressure', value: this.pressure(), hint: 'ProcessInfo.thermalState — the level macOS is at now, not whether it has ever throttled' },
      { label: 'CPU', value: degrees(thermals.cpuC) },
      { label: 'SoC', value: degrees(thermals.socC), hint: 'The die itself, from the memory-traffic ring and the power manager' },
      { label: 'GPU', value: degrees(thermals.gpuC), hint: 'Blank while idle: macOS gates the sensor rather than reporting a low number' },
      { label: 'Neural Engine', value: degrees(thermals.aneC), hint: 'Blank while idle, for the same reason as the GPU' },
      { label: 'Battery', value: degrees(thermals.batteryC) }
    ]);
  });

  readonly specFacts = computed<MetricFact[]>(() => {
    const thermals = this.monitor.thermals();
    if (!thermals) return [];
    return presentFacts([
      // A fanless Mac reports no fan anywhere in the SMC tree. Saying so beats an empty row.
      { label: 'Cooling', value: thermals.fans === null ? null : thermals.fans === 0 ? 'Fanless' : `${thermals.fans} fan${thermals.fans === 1 ? '' : 's'}` },
      { label: 'Readable sensors', value: thermals.readableSensors || null, hint: 'Sensors returning a live figure; a gated block reports none' },
      { label: 'Hot spot', value: thermals.hottestC === null ? null : `${thermals.hottestC}°C`, hint: 'The warmest reading anywhere on the board, whichever block it belongs to' },
      { label: 'Hot sensor', value: thermals.hottestName },
      { label: 'Package power', value: thermals.packageWatts === null ? null : `${thermals.packageWatts.toFixed(2)} W`, hint: 'CPU plus GPU plus Neural Engine, from the energy counters' },
      { label: 'Chart ceiling', value: `${CHART_CEILING_C}°C` }
    ]);
  });
}
