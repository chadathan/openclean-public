import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CoreChart, MetricChartComponent } from './metric-chart.component';
import { MetricFact, MetricSpecComponent } from './metric-spec.component';
import { formatBinaryBytes, formatUptime, presentFacts, toChartPoints } from './metric-format';
import { SystemMonitorService } from './system-monitor.service';

/** One colour per logical processor, reused by its chart and its header. */
export const CORE_COLORS = ['#7657e8', '#4d8de8', '#ef7181', '#2ebc99', '#e39b45', '#9a63d8', '#3ca6b8', '#d85caa'];

/** Everything the CPU metric shows: its plot, its rail and its detail panel. */
@Component({
  selector: 'oc-cpu-view',
  standalone: true,
  imports: [MetricChartComponent, MetricSpecComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oc-metric-chart label="CPU" [series]="series()" [rail]="rail()" [cores]="cores()" />
    <oc-metric-spec [live]="liveFacts()" [spec]="specFacts()" />
  `
})
export class CpuViewComponent {
  /**
   * Swaps the single plot for one small chart per logical processor. A signal input, not a
   * plain one: `cores` is a computed, and a computed never re-runs for a plain property.
   */
  readonly showLogicalCores = input(false);

  private readonly monitor = inject(SystemMonitorService);

  readonly series = computed(() => {
    const history = this.monitor.history();
    return [
      { key: 'usage', points: toChartPoints(history.map(sample => sample.cpuUsage)) },
      { key: 'user', points: toChartPoints(history.map(sample => sample.cpuUser)) },
      { key: 'system', points: toChartPoints(history.map(sample => sample.cpuSystem)) }
    ];
  });

  readonly rail = computed(() => {
    const cpu = this.monitor.cpu();
    return [
      { key: 'usage', label: 'Usage', value: cpu ? `${cpu.usagePercent}%` : '—' },
      { key: 'available', label: 'Available', value: cpu ? `${cpu.availablePercent}%` : '—' },
      { key: 'user', label: 'User', value: cpu ? `${cpu.userPercent}%` : '—' },
      { key: 'system', label: 'System', value: cpu ? `${cpu.systemPercent}%` : '—' }
    ];
  });

  readonly cores = computed<CoreChart[]>(() => {
    if (!this.showLogicalCores()) return [];
    const history = this.monitor.history();
    return this.monitor.cpu()?.logical.map(core => ({
      index: core.index,
      usagePercent: core.usagePercent,
      // `index` is one-based, matching the labels.
      points: toChartPoints(history.map(sample => sample.logicalCores[core.index - 1] ?? 0)),
      color: CORE_COLORS[(core.index - 1) % CORE_COLORS.length]
    })) ?? [];
  });

  readonly liveFacts = computed<MetricFact[]>(() => {
    const cpu = this.monitor.cpu();
    return presentFacts([
      { label: 'Processes', value: cpu ? cpu.processes : '—' },
      { label: 'Threads', value: cpu ? cpu.threads : '—' },
      { label: 'Up time', value: cpu ? formatUptime(cpu.uptimeSeconds) : '—' }
    ]);
  });

  /**
   * Windows reports current speed, base speed and handle counts; macOS implements none of
   * them, and Apple Silicon has no L3. Missing rows are dropped rather than blanked, so
   * this list is shorter on some Macs than on others.
   */
  readonly specFacts = computed<MetricFact[]>(() => {
    const info = this.monitor.cpuInfo();
    if (!info) return [];
    return presentFacts([
      { label: 'Sockets', value: info.sockets },
      { label: 'Cores', value: info.physicalCores },
      { label: 'Logical processors', value: info.logicalCores },
      { label: 'Performance cores', value: info.performanceCores, hint: 'High-power core cluster' },
      { label: 'Efficiency cores', value: info.efficiencyCores, hint: 'Low-power core cluster' },
      { label: 'Virtualization', value: info.virtualization === null ? null : info.virtualization ? 'Enabled' : 'Disabled', hint: 'Hypervisor.framework support (kern.hv_support)' },
      { label: 'L1 cache', value: formatBinaryBytes(info.l1CacheBytes), hint: 'Instruction plus data cache, per core' },
      { label: 'L2 cache', value: formatBinaryBytes(info.l2CacheBytes), hint: 'Shared across a core cluster' },
      { label: 'L3 cache', value: formatBinaryBytes(info.l3CacheBytes) }
    ]);
  });
}
