/** Sampling is needed while a view is subscribed, or while the user opted into background collection. */
export function shouldRunMetrics(backgroundEnabled: boolean, subscriberCount: number): boolean {
  return backgroundEnabled || subscriberCount > 0;
}
