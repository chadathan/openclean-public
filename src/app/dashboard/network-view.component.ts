import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MetricChartComponent } from './metric-chart.component';
import { MetricFact, MetricSpecComponent } from './metric-spec.component';
import { formatBinaryBytes, presentFacts } from './metric-format';
import { SystemMonitorService } from './system-monitor.service';

@Component({
  selector: 'oc-network-view',
  standalone: true,
  imports: [MetricChartComponent, MetricSpecComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<oc-metric-chart label="Network" [series]="series()" [rail]="rail()" /><oc-metric-spec [live]="liveFacts()" [spec]="specFacts()" />`
})
export class NetworkViewComponent {
  private readonly monitor = inject(SystemMonitorService);
  private speed(value: number): string { return `${formatBinaryBytes(value) ?? '0 KB'}/s`; }

  readonly series = computed(() => {
    const history = this.monitor.history();
    const peak = Math.max(1024, ...history.flatMap(sample => [sample.networkDownload, sample.networkUpload]));
    return [
      { key: 'download', points: history.length ? history.map((sample, index) => `${history.length === 1 ? 300 : index * 600 / (history.length - 1)},${190 - Math.min(100, sample.networkDownload / peak * 100) / 100 * 190}`).join(' ') : '' },
      { key: 'upload', points: history.length ? history.map((sample, index) => `${history.length === 1 ? 300 : index * 600 / (history.length - 1)},${190 - Math.min(100, sample.networkUpload / peak * 100) / 100 * 190}`).join(' ') : '' }
    ];
  });

  readonly rail = computed(() => {
    const network = this.monitor.network();
    return [
      { key: 'download', label: 'Download', value: network ? this.speed(network.downloadBytesPerSecond) : '—' },
      { key: 'upload', label: 'Upload', value: network ? this.speed(network.uploadBytesPerSecond) : '—' },
      { key: 'available', label: 'Received', value: network ? formatBinaryBytes(network.receivedBytes) ?? '—' : '—' },
      { key: 'wired', label: 'Sent', value: network ? formatBinaryBytes(network.sentBytes) ?? '—' : '—' }
    ];
  });

  readonly liveFacts = computed<MetricFact[]>(() => {
    const network = this.monitor.network();
    if (!network) return [];
    return presentFacts([
      { label: 'Download', value: this.speed(network.downloadBytesPerSecond) },
      { label: 'Upload', value: this.speed(network.uploadBytesPerSecond) },
      { label: 'Total received', value: formatBinaryBytes(network.receivedBytes) },
      { label: 'Total sent', value: formatBinaryBytes(network.sentBytes) }
    ]);
  });

  readonly specFacts = computed<MetricFact[]>(() => {
    const network = this.monitor.network();
    if (!network) return [];
    return presentFacts([
      { label: 'Interface', value: network.interfaceName },
      { label: 'Connection', value: network.connectionType },
      { label: 'Network', value: network.ssid ?? (network.connectionType === 'Wi-Fi' ? 'Name withheld' : null), hint: 'macOS reveals the Wi-Fi network name only to apps holding Location Services' },
      { label: 'Signal', value: network.signalStrength },
      { label: 'Link speed', value: network.linkSpeed ? `${network.linkSpeed} Mbps` : null },
      { label: 'Channel', value: network.channel },
      { label: 'Band', value: network.phyMode },
      { label: 'Security', value: network.security },
      { label: 'Address', value: network.address },
      { label: 'IPv6', value: network.ipv6Address },
      { label: 'Packets in', value: network.packetsIn },
      { label: 'Packets out', value: network.packetsOut },
      { label: 'Latency', value: null, hint: 'Requires an active endpoint test' }
    ]);
  });
}
