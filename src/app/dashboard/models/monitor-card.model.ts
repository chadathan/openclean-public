import { IconDefinition } from '@fortawesome/fontawesome-svg-core';

export type MonitorTone = 'purple' | 'blue' | 'green' | 'orange' | 'pink' | 'teal';
export type MonitorStatus = 'warning' | 'danger';

export interface MonitorCard {
  icon: IconDefinition;
  title: string;
  value: string;
  detail: string;
  temperature?: { value: string; status?: MonitorStatus };
  charging?: boolean;
  tone: MonitorTone;
  action?: string;
  breakdown?: Array<{ label: string; value: string; hint?: string }>;
  status?: MonitorStatus;
}
