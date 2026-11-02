/** Formatting shared by the per-metric views. */

/** Matches Task Manager's d:hh:mm:ss reading. */
export function formatUptime(totalSeconds: number): string {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  const days = Math.floor(totalSeconds / 86_400);
  return `${days}:${pad(Math.floor(totalSeconds / 3_600) % 24)}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}`;
}

/**
 * Memory and cache readings span three orders of magnitude, so the unit follows the value:
 * a fixed gigabyte formatter renders a 13 MB purgeable pool as "0.0 GB".
 */
export function formatBinaryBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`;
  return `${Math.round(bytes / 1_024)} KB`;
}

/** Projects a series of percentages into the 600x190 box the charts draw in. */
export function toChartPoints(values: number[]): string {
  if (!values.length) return '';
  return values
    .map((value, index) => `${values.length === 1 ? 300 : index * 600 / (values.length - 1)},${190 - (Math.max(0, Math.min(100, value)) / 100) * 190}`)
    .join(' ');
}

/** Drops facts the platform could not answer rather than rendering a blank or a NaN. */
export function presentFacts(
  facts: Array<{ label: string; value: string | number | null | undefined; hint?: string }>
): Array<{ label: string; value: string; hint?: string }> {
  return facts
    .filter(fact => fact.value !== null && fact.value !== undefined && fact.value !== '')
    .map(fact => ({ label: fact.label, value: `${fact.value}`, hint: fact.hint }));
}

/**
 * Projects a series that is not a percentage — watts, for instance — into the same box, by
 * scaling against the tallest value in the window. There is no published ceiling to scale a
 * Neural Engine wattage against, and a fixed guess would be wrong on every other chip, so
 * the window sets its own top. `floor` keeps an idle trace flat instead of amplifying noise
 * into a full-height scribble.
 */
export function toScaledChartPoints(values: number[], floor: number): string {
  const peak = Math.max(floor, ...values);
  return toChartPoints(values.map(value => (value / peak) * 100));
}

/** Scales against a peak the caller supplies, so several traces can share one top. */
export function toSharedScaleChartPoints(values: number[], peak: number): string {
  return toChartPoints(values.map(value => (value / Math.max(peak, Number.EPSILON)) * 100));
}

/** Projects against a fixed ceiling, so the trace means degrees rather than a shape. */
export function toCeilingChartPoints(values: number[], ceiling: number): string {
  return toChartPoints(values.map(value => (value / ceiling) * 100));
}
