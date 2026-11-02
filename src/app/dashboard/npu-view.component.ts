import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MetricChartComponent } from './metric-chart.component';
import { MetricFact, MetricSpecComponent } from './metric-spec.component';
import { presentFacts, toScaledChartPoints } from './metric-format';
import { SystemMonitorService } from './system-monitor.service';

/** Below this the energy counter is reporting leakage rather than work. */
const ACTIVE_WATTS = 0.05;
/** Scale floor for the plot, so an idle trace stays flat instead of amplifying noise. */
const CHART_FLOOR_WATTS = 1;

/**
 * Everything the Neural Engine metric shows.
 *
 * macOS publishes no utilisation figure for the ANE — not through IOKit, not through
 * IOReport, and not through powermetrics either — so the plot is drawn from power rather
 * than from a percentage, and the status line is inferred from it. Which framework or
 * process is driving the ANE is not exposed anywhere, so no workload row is offered.
 */
@Component({
  selector: 'oc-npu-view',
  standalone: true,
  imports: [MetricChartComponent, MetricSpecComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="test-run">
      <button type="button" (click)="runTest()" [disabled]="testRunning()">
        {{ testRunning() ? 'Running a Vision workload…' : 'Wake the Neural Engine' }}
      </button>
      <small>{{ notice() }}</small>
    </div>
    <oc-metric-chart label="Neural Engine" [series]="series()" [rail]="rail()" />
    <oc-metric-spec [live]="liveFacts()" [spec]="specFacts()" />
  `,
  styles: [`
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .test-run { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
    .test-run button {
      padding: 7px 14px;
      border: 1px solid #c7cee3;
      border-radius: 10px;
      background: linear-gradient(145deg, #ffffffdf, #f5f3ffbf);
      box-shadow: inset 0 1px #ffffff, 0 4px 12px #44516b14;
      color: #4d3b8f;
      font: 650 12px inherit;
      cursor: pointer;
    }
    .test-run button:hover:not(:disabled) { transform: translateY(-1px); }
    .test-run button:disabled { color: #8f899f; cursor: default; }
    .test-run small { color: #8f899f; font-size: 11px; }
  `]
})
export class NpuViewComponent {
  private readonly monitor = inject(SystemMonitorService);

  readonly series = computed(() => [
    { key: 'renderer', points: toScaledChartPoints(this.monitor.history().map(sample => sample.npuWatts), CHART_FLOOR_WATTS) }
  ]);

  readonly rail = computed(() => {
    const npu = this.monitor.npu();
    const history = this.monitor.history();
    const peak = history.length ? Math.max(...history.map(sample => sample.npuWatts)) : 0;
    return [
      { key: 'usage', label: 'Status', value: this.status() },
      { key: 'renderer', label: 'Power', value: npu?.watts === null || npu?.watts === undefined ? '—' : `${npu.watts.toFixed(2)} W` },
      { key: 'available', label: 'Peak 60s', value: history.length ? `${peak.toFixed(2)} W` : '—' },
      { key: 'compressed', label: 'Temp', value: npu?.temperatureC === null || npu?.temperatureC === undefined ? '—' : `${npu.temperatureC}°C` }
    ];
  });

  readonly status = computed(() => {
    const npu = this.monitor.npu();
    if (!npu || !npu.available) return 'Unavailable';
    return npu.watts !== null && npu.watts >= ACTIVE_WATTS ? 'Active' : 'Idle';
  });

  readonly liveFacts = computed<MetricFact[]>(() => {
    const npu = this.monitor.npu();
    if (!npu) return [];
    return presentFacts([
      { label: 'Status', value: this.status(), hint: 'Inferred from the energy counter: macOS reports no utilisation figure for the Neural Engine' },
      { label: 'Power', value: npu.watts === null ? '—' : `${npu.watts.toFixed(2)} W` },
      { label: 'Temperature', value: npu.temperatureC === null ? '—' : `${npu.temperatureC}°C`, hint: 'Reads blank while the Neural Engine is idle: macOS gates the sensor rather than reporting a low number' }
    ]);
  });

  readonly testRunning = signal(false);
  readonly notice = signal('The Neural Engine reads 0 W until something asks it to work.');

  /**
   * Runs a short Vision workload in the main process so the panel has something to show.
   * It does not wait for the load to finish — the reading moves on the next poll, like any
   * other change — it only keeps the button disabled for as long as the load runs.
   */
  async runTest(): Promise<void> {
    if (!window.electronAPI) {
      this.notice.set('Available when running in Electron.');
      return;
    }
    const result = await window.electronAPI.runNpuSelfTest();
    if (!result.started) {
      this.notice.set('A workload is already running.');
      return;
    }
    this.testRunning.set(true);
    this.notice.set('Watch Status and Power move, then settle back to Idle.');
    setTimeout(() => {
      this.testRunning.set(false);
      this.notice.set('The Neural Engine reads 0 W until something asks it to work.');
    }, Math.max(0, result.endsAt - Date.now()));
  }

  readonly specFacts = computed<MetricFact[]>(() => {
    const cpu = this.monitor.cpu();
    return presentFacts([
      { label: 'Engine', value: 'Apple Neural Engine' },
      { label: 'Chip', value: cpu?.model ?? null },
      { label: 'Utilization', value: 'Not reported', hint: 'No macOS interface exposes a Neural Engine utilisation percentage' },
      { label: 'Core count', value: 'Not reported', hint: 'The published core count is a spec-sheet figure; nothing on the system reports it' },
      { label: 'Workload', value: 'Not reported', hint: 'macOS does not attribute Neural Engine work to a framework or a process' }
    ]);
  });
}
