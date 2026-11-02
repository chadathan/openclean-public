import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MetricChartComponent } from './metric-chart.component';
import { MetricFact, MetricSpecComponent } from './metric-spec.component';
import { formatBinaryBytes, presentFacts, toChartPoints } from './metric-format';
import { SystemMonitorService } from './system-monitor.service';

/** Everything the GPU metric shows: its plot, its rail and its detail panel. */
@Component({
  selector: 'oc-gpu-view',
  standalone: true,
  imports: [MetricChartComponent, MetricSpecComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oc-metric-chart label="GPU" [series]="series()" [rail]="rail()" />
    <oc-metric-spec [live]="liveFacts()" [spec]="specFacts()" />
  `
})
export class GpuViewComponent {
  private readonly monitor = inject(SystemMonitorService);

  /** The two halves of the GPU's work: geometry setup and fragment shading. */
  readonly series = computed(() => {
    const history = this.monitor.history();
    return [
      { key: 'renderer', points: toChartPoints(history.map(sample => sample.gpuRenderer)) },
      { key: 'tiler', points: toChartPoints(history.map(sample => sample.gpuTiler)) }
    ];
  });

  readonly rail = computed(() => {
    const gpu = this.monitor.gpu();
    const percent = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value}%`;
    return [
      { key: 'usage', label: 'Usage', value: percent(gpu?.usagePercent) },
      { key: 'renderer', label: 'Renderer', value: percent(gpu?.rendererPercent) },
      { key: 'tiler', label: 'Tiler', value: percent(gpu?.tilerPercent) },
      { key: 'available', label: 'Memory', value: formatBinaryBytes(gpu?.inUseBytes) ?? '—' }
    ];
  });

  readonly liveFacts = computed<MetricFact[]>(() => {
    const gpu = this.monitor.gpu();
    if (!gpu) return [];
    return presentFacts([
      { label: 'Usage', value: gpu.usagePercent === null ? null : `${gpu.usagePercent}%` },
      { label: 'Temperature', value: gpu.temperatureC === null ? '—' : `${gpu.temperatureC}°C`, hint: 'Reads blank while the GPU is idle: macOS gates the sensor rather than reporting a low number' },
      { label: 'Power', value: gpu.watts === null ? null : `${gpu.watts.toFixed(2)} W`, hint: 'From IOReport energy counters, averaged over the sampling window' },
      { label: 'Memory used', value: formatBinaryBytes(gpu.inUseBytes), hint: "The GPU's share of unified memory currently in use" },
      { label: 'Allocated', value: formatBinaryBytes(gpu.allocatedBytes), hint: 'Reserved for the GPU, not necessarily in use' }
    ]);
  });

  /**
   * Clock speed appears nowhere in IORegistry, and Apple Silicon has no dedicated VRAM, so
   * neither is listed. Displays come along with the GPU in system_profiler's report.
   */
  readonly specFacts = computed<MetricFact[]>(() => {
    const info = this.monitor.gpuInfo();
    const gpu = this.monitor.gpu();
    if (!info) return [];
    const main = info.displays.find(display => display.main) ?? info.displays[0];
    return presentFacts([
      { label: 'Model', value: info.model },
      { label: 'Cores', value: info.cores },
      { label: 'Vendor', value: info.vendor },
      { label: 'Engine', value: info.bus === 'Built-in' ? 'Integrated' : info.bus },
      { label: 'Metal', value: info.metal },
      { label: 'Memory', value: 'Unified', hint: 'The GPU draws on system memory rather than dedicated VRAM' },
      { label: 'Parameter buffer', value: formatBinaryBytes(gpu?.parameterBufferBytes) },
      { label: 'Resets', value: gpu?.recoveryCount ?? null, hint: 'Times the driver has had to recover the GPU since boot' },
      { label: 'Display', value: main?.type ?? main?.name ?? null },
      { label: 'Resolution', value: main?.resolution }
    ]);
  });
}
