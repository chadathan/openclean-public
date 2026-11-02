import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { MonitorCard } from './models/monitor-card.model';

@Component({
  selector: 'oc-monitor-card', standalone: true, imports: [FontAwesomeModule], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<article class="card" [class]="card.tone" [class.card-warning]="card.status === 'warning'" [class.card-danger]="card.status === 'danger'" [class.card-charging]="card.charging"><div class="card-top"><span class="card-icon"><fa-icon [icon]="card.icon" /></span>@if (card.charging) {<span class="charging-badge">Charging</span>} @else if (card.status) {<span class="status-badge">{{ card.status === 'danger' ? 'High' : 'Elevated' }}</span>}</div><p class="card-title">{{ card.title }}</p><div class="card-value">{{ card.value }}</div><p class="card-detail">@if (card.temperature) {<span class="temperature-text" [class.temperature-warning]="card.temperature.status === 'warning'" [class.temperature-danger]="card.temperature.status === 'danger'">{{ card.temperature.value }}</span>@if (card.detail) {<span> · </span>}} {{ card.detail }}</p>@if (card.breakdown) {<div class="metric-breakdown">@for (item of card.breakdown; track item.label) {<span [title]="item.hint ?? ''"><strong>{{ item.value }}</strong><small>{{ item.label }}</small></span>}</div>}@if (card.action) {<button class="card-action" type="button" (click)="actionClicked.emit(card)">{{ card.action }} <span>→</span></button>}</article>`
})
export class MonitorCardComponent {
  @Input({ required: true }) card!: MonitorCard;
  @Output() actionClicked = new EventEmitter<MonitorCard>();
}
