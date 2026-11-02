import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MetricChartComponent } from './metric-chart.component';
import { MetricFact, MetricSpecComponent } from './metric-spec.component';
import { formatBinaryBytes, presentFacts, toSharedScaleChartPoints } from './metric-format';
import { SystemMonitorService } from './system-monitor.service';

@Component({
  selector: 'oc-storage-view',
  standalone: true,
  imports: [MetricChartComponent, MetricSpecComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <oc-metric-chart label="Disks" [series]="series()" [rail]="rail()" />
    <div class="storage-io">
      <div><small>Read</small><strong>{{ rate(io().readBytesPerSecond) }}</strong></div>
      <div><small>Write</small><strong>{{ rate(io().writeBytesPerSecond) }}</strong></div>
      <div><small>Read since boot</small><strong>{{ format(io().readBytes) }}</strong></div>
      <div><small>Written since boot</small><strong>{{ format(io().writtenBytes) }}</strong></div>
    </div>
    <section class="storage-volumes" aria-label="Storage volumes">
      @for (volume of volumes(); track volume.mountPoint) {
        <article class="storage-volume">
          <div class="storage-volume-head"><strong>{{ volume.name }}</strong><span>{{ volume.usedPercent }}%</span></div>
          <div class="storage-meter"><i [style.width.%]="volume.usedPercent"></i></div>
          <div class="storage-volume-meta"><span>{{ format(volume.usedBytes) }} used</span><span>{{ format(volume.availableBytes) }} free</span><span>{{ format(volume.totalBytes) }} total</span></div>
          <div class="storage-volume-meta"><span>File system {{ volume.fileSystem ?? '—' }}</span><span>Health {{ volume.health ?? '—' }}</span></div>
          <div class="storage-volume-meta"><span>Trash {{ format(volume.trashBytes) }}</span></div>
          <small>{{ volume.mountPoint }}</small>
        </article>
      }
    </section>
    <oc-metric-spec [live]="[]" [spec]="driveFacts()" />
  `,
  styles: [`
    :host { display: block; min-height: 260px; margin-top: 18px; }
    .storage-io { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px 24px; margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid #dde2f0; }
    .storage-io small { display: block; color: #8f899f; font-size: 13px; font-weight: 500; }
    .storage-io strong { display: block; margin-top: 4px; color: #302b3d; font-size: 21px; font-weight: 700; line-height: 1.1; letter-spacing: -.01em; white-space: nowrap; }
    .storage-volumes { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .storage-volume { min-width: 0; padding: 14px; border: 1px solid #c7cee3; border-radius: 12px; background: linear-gradient(145deg, #fbfcff, #eef1fb); box-shadow: inset 0 0 0 1px #ffffffb8; }
    .storage-volume-head, .storage-volume-meta { display: flex; justify-content: space-between; gap: 10px; min-width: 0; }
    .storage-volume-head strong { min-width: 0; overflow: hidden; color: #302b3d; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
    .storage-volume-head span { color: #6b54c7; font-size: 15px; font-weight: 700; }
    .storage-meter { height: 8px; margin: 14px 0 10px; overflow: hidden; border-radius: 999px; background: #dfe4f2; }
    .storage-meter i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7e68e8, #5b94e9); }
    .storage-volume-meta { flex-wrap: wrap; justify-content: flex-start; gap: 5px 18px; color: #6e6780; font-size: 11px; line-height: 1.4; }
    .storage-volume-meta span { min-width: 0; overflow-wrap: anywhere; }
    .storage-volume small { display: block; min-width: 0; margin-top: 9px; color: #9891a5; font-size: 10px; line-height: 1.35; overflow-wrap: anywhere; }
  `]
})
export class StorageViewComponent {
  private readonly monitor = inject(SystemMonitorService);

  /** Read and write share one scale so the two can be read against each other. */
  readonly series = computed(() => {
    const history = this.monitor.history();
    const peak = Math.max(1024 * 1024, ...history.flatMap(sample => [sample.diskRead, sample.diskWrite]));
    return [
      { key: 'app', points: toSharedScaleChartPoints(history.map(sample => sample.diskRead), peak) },
      { key: 'compressed', points: toSharedScaleChartPoints(history.map(sample => sample.diskWrite), peak) }
    ];
  });

  readonly rail = computed(() => {
    const storage = this.monitor.storage();
    return [
      { key: 'usage', label: 'Used', value: storage ? `${storage.usedPercent}%` : '—' },
      { key: 'app', label: 'Read', value: this.rate(storage?.readBytesPerSecond ?? null) },
      { key: 'compressed', label: 'Write', value: this.rate(storage?.writeBytesPerSecond ?? null) },
      { key: 'available', label: 'Free', value: this.format(storage?.availableBytes ?? null) }
    ];
  });

  readonly driveFacts = computed<MetricFact[]>(() => {
    const storage = this.monitor.storage();
    if (!storage) return [];
    const hardware = storage.hardware;
    const usable = storage.totalBytes;
    return presentFacts([
      { label: 'Drive', value: hardware?.model },
      { label: 'Bus', value: hardware?.protocol, hint: 'Apple Silicon reaches its storage over Apple Fabric rather than NVMe over PCIe' },
      { label: 'Type', value: hardware?.solidState === null || hardware?.solidState === undefined ? null : `${hardware.solidState ? 'SSD' : 'Hard disk'}${hardware.location ? ` · ${hardware.location}` : ''}` },
      { label: 'SMART', value: hardware?.smartStatus },
      // The gap between the two is over-provisioning and filesystem metadata, and it is the
      // answer to why a 512 GB drive shows up as rather less than that.
      { label: 'Physical size', value: hardware?.physicalBytes == null ? null : `${(hardware.physicalBytes / 1e9).toFixed(1)} GB` },
      { label: 'Usable', value: formatBinaryBytes(usable) },
      { label: 'Read', value: storage.readOpsPerSecond === null ? null : `${Math.round(storage.readOpsPerSecond)} ops/s` },
      { label: 'Write', value: storage.writeOpsPerSecond === null ? null : `${Math.round(storage.writeOpsPerSecond)} ops/s` },
      { label: 'Read latency', value: storage.readLatencyMs === null ? null : `${storage.readLatencyMs.toFixed(2)} ms`, hint: 'Average service time over the sampling window' },
      { label: 'Write latency', value: storage.writeLatencyMs === null ? null : `${storage.writeLatencyMs.toFixed(2)} ms` },
      { label: 'Snapshots', value: storage.snapshots, hint: 'Local APFS snapshots on the startup volume' }
    ]);
  });
  readonly volumes = computed(() => this.monitor.storage()?.volumes ?? []);
  readonly io = computed(() => {
    const storage = this.monitor.storage();
    return {
      readBytesPerSecond: storage?.readBytesPerSecond ?? null,
      writeBytesPerSecond: storage?.writeBytesPerSecond ?? null,
      readBytes: storage?.readBytes ?? null,
      writtenBytes: storage?.writtenBytes ?? null
    };
  });
  format(bytes: number | null): string { return bytes === null ? '—' : formatBinaryBytes(bytes) ?? '—'; }
  rate(bytes: number | null): string { return bytes === null ? '—' : `${this.format(bytes)}/s`; }
}
