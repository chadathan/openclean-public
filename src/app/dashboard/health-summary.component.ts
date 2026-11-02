import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'oc-health-summary', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="health"><div class="health-icon">✓</div><div><p class="eyebrow">MAC HEALTH</p><h2>{{ status }}</h2><p class="muted">Last checked just now · {{ deviceName }}</p></div><div class="score"><strong>{{ score }}</strong><span>/ 100</span></div></section>`
})
export class HealthSummaryComponent {
  @Input() status = 'Everything is running smoothly';
  @Input() deviceName = 'MacBook Pro';
  @Input() score = 92;
}
