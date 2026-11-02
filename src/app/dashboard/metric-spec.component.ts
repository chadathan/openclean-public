import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

export interface MetricFact {
  label: string;
  value: string;
  hint?: string;
}

/**
 * The detail panel under the plot: live readings on the left, fixed hardware facts on the
 * right. Rows the platform cannot answer are dropped by the caller, so nothing here has to
 * render a placeholder.
 */
@Component({
  selector: 'oc-metric-spec',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="live">
      @for (fact of live; track fact.label) {
        <div [title]="fact.hint ?? ''"><small>{{ fact.label }}</small><strong>{{ fact.value }}</strong></div>
      }
    </div>
    <dl class="spec">
      @for (fact of spec; track fact.label) {
        <div [title]="fact.hint ?? ''"><dt>{{ fact.label }}</dt><dd>{{ fact.value }}</dd></div>
      }
    </dl>
  `,
  styles: [`
    :host {
      display: grid;
      grid-template-columns: minmax(0, 250px) minmax(0, 1fr);
      gap: 14px 44px;
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid #dde2f0;
    }

    /* 250px wide so the longest live reading — a d:hh:mm:ss up time — still fits its cell. */
    .live { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 14px 18px; align-content: start; }
    .live small { display: block; color: #8f899f; font-size: 13px; font-weight: 500; line-height: 1.2; }
    /* A reading must not break across lines: "12.1 GB" split after "12.1" reads as two facts. */
    .live strong { display: block; margin-top: 4px; color: #302b3d; font-size: 21px; font-weight: 700; line-height: 1.1; letter-spacing: -.01em; white-space: nowrap; }

    /* min() lets a column fall below its ideal width. A bare minmax(186px, …) is a hard
       floor, and once the track went under it the grid pushed every value past the card's
       right edge, where overflow: hidden cut them off. */
    .spec { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(186px, 100%), 1fr)); gap: 5px 32px; align-content: start; margin: 0; }
    .spec > div { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; min-width: 0; }
    .spec dt { flex: 0 0 auto; white-space: nowrap; color: #8f899f; font-size: 13px; font-weight: 500; line-height: 1.2; }
    .spec dd { min-width: 0; margin: 0; text-align: right; overflow-wrap: anywhere; color: #302b3d; font-size: 13px; font-weight: 650; line-height: 1.2; }

    /* Side by side only while the card is wide enough for both halves. */
    @media (max-width: 1150px) {
      :host { grid-template-columns: minmax(0, 1fr); gap: 16px; }
    }
  `]
})
export class MetricSpecComponent {
  @Input({ required: true }) live: MetricFact[] = [];
  @Input({ required: true }) spec: MetricFact[] = [];
}
