import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'oc-recommendation', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="recommendation"><div class="recommendation-icon">✦</div><div><p class="eyebrow">TODAY'S RECOMMENDATION</p><h3>{{ title }}</h3><p class="muted">{{ description }}</p></div><button class="primary" type="button" (click)="reviewClicked.emit()">{{ actionLabel }} <span>→</span></button></section>`
})
export class RecommendationComponent {
  @Input() title = 'Free up some storage space';
  @Input() description = 'You have 42 GB of old files and cache that can be safely reviewed.';
  @Input() actionLabel = 'Review files';
  @Output() reviewClicked = new EventEmitter<void>();
}
