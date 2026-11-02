import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MetricChartComponent } from './metric-chart.component';
import { MetricFact, MetricSpecComponent } from './metric-spec.component';
import { presentFacts, toSharedScaleChartPoints } from './metric-format';
import { SystemMonitorService } from './system-monitor.service';

/**
 * Scale floor for the plot. A machine sitting on mains power draws nothing from the pack,
 * and without a floor that flat line would be stretched into a full-height scribble.
 */
const CHART_FLOOR_WATTS = 5;

/** Everything the Energy metric shows: its plot, its rail and its detail panel. */
@Component({
  selector: 'oc-energy-view',
  standalone: true,
  imports: [MetricChartComponent, MetricSpecComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oc-metric-chart label="Energy" [series]="series()" [rail]="rail()" />
    <oc-metric-spec [live]="liveFacts()" [spec]="specFacts()" />
  `
})
export class EnergyViewComponent {
  private readonly monitor = inject(SystemMonitorService);

  /**
   * Watts rather than charge percentage: the percentage barely moves over a minute, while
   * the draw is what actually explains where the charge is going. Both traces share one
   * scale so the pack draw can be read against what the chips are accounting for.
   */
  readonly series = computed(() => {
    const history = this.monitor.history();
    const peak = Math.max(CHART_FLOOR_WATTS, ...history.map(sample => Math.max(sample.batteryWatts, sample.packageWatts)));
    return [
      { key: 'user', points: toSharedScaleChartPoints(history.map(sample => sample.batteryWatts), peak) },
      { key: 'app', points: toSharedScaleChartPoints(history.map(sample => sample.packageWatts), peak) }
    ];
  });

  readonly rail = computed(() => {
    const battery = this.monitor.battery();
    const thermals = this.monitor.thermals();
    const watts = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value.toFixed(2)} W`;
    return [
      { key: 'usage', label: 'Charge', value: battery ? `${battery.percent}%` : '—' },
      { key: 'user', label: this.drawLabel(), value: watts(battery?.watts) },
      { key: 'app', label: 'Chips', value: watts(thermals?.packageWatts) },
      { key: 'wired', label: 'Temp', value: battery?.temperatureC == null ? '—' : `${battery.temperatureC}°C` }
    ];
  });

  /** The same number means charge going in or coming out, so the label says which. */
  readonly drawLabel = computed(() => {
    const battery = this.monitor.battery();
    if (battery?.isCharging) return 'Charging';
    return battery?.externalConnected ? 'From pack' : 'Draw';
  });

  readonly status = computed(() => {
    const battery = this.monitor.battery();
    if (!battery) return '—';
    if (battery.isCharging) return 'Charging';
    if (battery.externalConnected) return battery.percent >= 100 ? 'Charged' : 'On power';
    return 'On battery';
  });

  readonly liveFacts = computed<MetricFact[]>(() => {
    const battery = this.monitor.battery();
    const thermals = this.monitor.thermals();
    if (!battery) return [];
    return presentFacts([
      { label: 'Charge', value: `${battery.percent}%` },
      { label: 'Status', value: this.status() },
      { label: this.drawLabel(), value: battery.watts === null ? '—' : `${battery.watts.toFixed(2)} W`, hint: 'Pack voltage times instantaneous current. Zero on mains power, when the pack is neither charging nor supplying.' },
      { label: 'Chips', value: thermals?.packageWatts == null ? '—' : `${thermals.packageWatts.toFixed(2)} W`, hint: 'CPU plus GPU plus Neural Engine, from the energy counters — a part of the total, not the whole machine' },
      { label: 'Time remaining', value: battery.timeRemaining === '0:00' ? null : battery.timeRemaining },
      { label: 'Temperature', value: battery.temperatureC === null ? null : `${battery.temperatureC}°C` }
    ]);
  });

  readonly specFacts = computed<MetricFact[]>(() => {
    const battery = this.monitor.battery();
    if (!battery) return [];
    // Health from the raw figures rather than the word macOS prints: "Good" covers
    // everything down to 80% of design, which is a wide range to hide behind one word.
    const healthPercent = battery.nominalMah && battery.designMah
      ? Math.round((battery.nominalMah / battery.designMah) * 100)
      : null;
    return presentFacts([
      { label: 'Condition', value: battery.health },
      { label: 'Capacity', value: healthPercent === null ? null : `${healthPercent}% of design`, hint: 'Nominal charge capacity against the capacity this pack shipped with' },
      { label: 'Charge cycles', value: battery.cycleCount },
      { label: 'Charge', value: battery.chargeMah === null || battery.maxChargeMah === null ? null : `${battery.chargeMah} of ${battery.maxChargeMah} mAh` },
      { label: 'Design capacity', value: battery.designMah === null ? null : `${battery.designMah} mAh` },
      { label: 'Voltage', value: battery.volts === null ? null : `${battery.volts.toFixed(2)} V` },
      { label: 'Current', value: battery.milliamps === null ? null : `${battery.milliamps} mA` },
      { label: 'Adapter', value: battery.adapterWatts === null ? (battery.externalConnected ? 'Connected' : 'Not connected')
        : `${battery.adapterWatts} W${battery.adapterVolts === null ? '' : ` · ${battery.adapterVolts} V`}` }
    ]);
  });
}
