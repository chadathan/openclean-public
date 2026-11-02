import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MetricChartComponent } from './metric-chart.component';
import { MetricFact, MetricSpecComponent } from './metric-spec.component';
import { formatBinaryBytes, presentFacts, toChartPoints } from './metric-format';
import { SystemMonitorService } from './system-monitor.service';

/** Everything the Memory metric shows: its plot, its rail and its detail panel. */
@Component({
  selector: 'oc-memory-view',
  standalone: true,
  imports: [MetricChartComponent, MetricSpecComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oc-metric-chart label="Memory" [series]="series()" [rail]="rail()" />
    <oc-metric-spec [live]="liveFacts()" [spec]="specFacts()" />
  `
})
export class MemoryViewComponent {
  private readonly monitor = inject(SystemMonitorService);

  /** Pressure matches the headline value; the remaining lines show component shares of installed memory. */
  readonly series = computed(() => {
    const history = this.monitor.history();
    return [
      { key: 'usage', points: toChartPoints(history.map(sample => sample.memoryPressure)) },
      { key: 'app', points: toChartPoints(history.map(sample => sample.memoryApp)) },
      { key: 'wired', points: toChartPoints(history.map(sample => sample.memoryWired)) },
      { key: 'compressed', points: toChartPoints(history.map(sample => sample.memoryCompressed)) }
    ];
  });

  readonly rail = computed(() => {
    const memory = this.monitor.memory();
    const bytes = (value: number) => memory ? formatBinaryBytes(value) ?? '—' : '—';
    return [
      { key: 'usage', label: 'Usage', value: memory ? `${memory.pressurePercent}%` : '—' },
      { key: 'available', label: 'Available', value: bytes(memory?.availableBytes ?? 0) },
      { key: 'app', label: 'App', value: bytes(memory?.appBytes ?? 0) },
      { key: 'wired', label: 'Wired', value: bytes(memory?.wiredBytes ?? 0) },
      { key: 'compressed', label: 'Compressed', value: bytes(memory?.compressedBytes ?? 0) }
    ];
  });

  readonly liveFacts = computed<MetricFact[]>(() => {
    const memory = this.monitor.memory();
    if (!memory) return [];
    return presentFacts([
      { label: 'In use', value: formatBinaryBytes(memory.usedBytes), hint: 'App memory plus wired and compressed pages' },
      { label: 'App', value: formatBinaryBytes(memory.appBytes), hint: 'Memory held by applications' },
      { label: 'Wired', value: formatBinaryBytes(memory.wiredBytes), hint: 'Memory the kernel cannot page out' },
      { label: 'Compressed', value: formatBinaryBytes(memory.compressedBytes), hint: 'Memory squeezed rather than swapped out' },
      { label: 'Available', value: formatBinaryBytes(memory.availableBytes) },
      { label: 'Cached files', value: formatBinaryBytes(memory.cachedBytes), hint: 'File contents held in memory and reclaimable on demand' },
      { label: 'Swap used', value: formatBinaryBytes(memory.swapUsedBytes), hint: 'macOS grows its swap file on demand' }
    ]);
  });

  /**
   * Windows lists paged pool, non-paged pool and hardware reserved; macOS has no equivalent
   * of any of them. A soldered package also reports no clock, slot list or form factor —
   * Intel Macs do report those, and the rows appear there.
   */
  readonly specFacts = computed<MetricFact[]>(() => {
    const info = this.monitor.memoryInfo();
    const memory = this.monitor.memory();
    if (!info) return [];
    return presentFacts([
      { label: 'Installed', value: formatBinaryBytes(info.totalBytes) },
      { label: 'Type', value: info.type },
      { label: 'Manufacturer', value: info.manufacturer },
      { label: 'Speed', value: info.speed },
      { label: 'Form factor', value: info.formFactor },
      { label: 'Slots used', value: info.slotsUsed == null || info.slotsTotal == null ? null : `${info.slotsUsed} of ${info.slotsTotal}` },
      { label: 'Page size', value: formatBinaryBytes(info.pageSizeBytes), hint: 'Apple Silicon uses 16 KB pages where Intel used 4 KB' },
      { label: 'Swap size', value: memory && memory.swapTotalBytes > 0 ? formatBinaryBytes(memory.swapTotalBytes) : null, hint: 'Current size of the swap file, which macOS resizes as needed' },
      { label: 'Purgeable', value: memory ? formatBinaryBytes(memory.purgeableBytes) : null, hint: 'Cached data the system may discard at any time' }
    ]);
  });
}
