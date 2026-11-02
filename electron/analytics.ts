// Anonymous usage counts, sent to Google Analytics 4 through the Measurement Protocol.
//
// The point is to know how many Macs run OpenClean and how many use it day to day, without an
// account. Each install gets a random identifier stored on this Mac; nothing ties it to a person.
// Events carry only the screen that was opened, the app version and the macOS version. File
// names, paths, scan results, installed apps and process data are never sent.
//
// The GA web tag is not used: it depends on cookies, which do not persist for a page loaded from
// a file, so every launch would count as a new user. The main process sends events itself.
import { app, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Settings = { enabled: boolean; clientId: string | null };

/** The only screens that may be reported, so nothing else can be passed through as a name. */
export const SCREENS = ['overview', 'processes', 'cleanup', 'applications', 'files', 'privacy', 'settings', 'menu-bar'] as const;
type Screen = typeof SCREENS[number];

const SCREEN_REPEAT_MS = 60_000;

let settings: Settings = { enabled: true, clientId: null };
let measurementId = '';
let apiSecret = '';
const sessionId = String(Math.floor(Date.now() / 1000));
const lastScreen = new Map<Screen, number>();

function settingsPath(): string { return join(app.getPath('userData'), 'analytics.json'); }

function loadConfig(): void {
  try {
    const config = JSON.parse(readFileSync(join(__dirname, 'app-config.json'), 'utf8')) as { gaMeasurementId?: unknown; gaApiSecret?: unknown };
    measurementId = typeof config.gaMeasurementId === 'string' ? config.gaMeasurementId : '';
    apiSecret = typeof config.gaApiSecret === 'string' ? config.gaApiSecret : '';
  } catch { /* No bundled configuration: analytics stays off. */ }
}

/** Configured, packaged (or explicitly testing), and not turned off by the user. */
function active(): boolean {
  const allowed = app.isPackaged || process.env['OPENCLEAN_ANALYTICS_DEV'] === '1';
  return Boolean(measurementId && apiSecret && settings.enabled && allowed);
}

async function save(): Promise<void> {
  try { await writeFile(settingsPath(), JSON.stringify(settings), 'utf8'); }
  catch (error) { console.error('Unable to save the analytics preference', error); }
}

async function send(name: string, params: Record<string, string | number> = {}): Promise<void> {
  if (!active()) return;
  if (!settings.clientId) { settings.clientId = randomUUID(); await save(); }
  const debug = process.env['OPENCLEAN_ANALYTICS_DEV'] === '1' && !app.isPackaged;
  const url = `https://www.google-analytics.com/${debug ? 'debug/' : ''}mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        client_id: settings.clientId,
        events: [{
          name,
          params: {
            // GA4 counts a user as active only for events with a session and engagement time.
            session_id: sessionId,
            engagement_time_msec: 1,
            app_version: app.getVersion(),
            os_version: process.getSystemVersion(),
            ...params
          }
        }]
      })
    });
    if (debug) console.log('GA4 validation', name, await response.text());
  } catch { /* Offline or blocked: usage counts are best effort and never retried. */ }
}

export function trackScreen(screen: string): void {
  if (!(SCREENS as readonly string[]).includes(screen)) return;
  const now = Date.now();
  const previous = lastScreen.get(screen as Screen) ?? 0;
  if (now - previous < SCREEN_REPEAT_MS) return;
  lastScreen.set(screen as Screen, now);
  void send('page_view', { page_title: screen, page_location: `app://openclean/${screen}` });
}

export async function registerAnalytics(): Promise<void> {
  loadConfig();
  try {
    const saved = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<Settings>;
    settings = { enabled: saved.enabled !== false, clientId: typeof saved.clientId === 'string' ? saved.clientId : null };
  } catch { /* First launch. */ }

  ipcMain.handle('analytics:get', () => ({ enabled: settings.enabled, available: Boolean(measurementId && apiSecret) }));
  ipcMain.handle('analytics:set', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return { enabled: settings.enabled, available: Boolean(measurementId && apiSecret) };
    // Turning it off also forgets the identifier, so turning it back on starts a new, unlinked one.
    settings = { enabled, clientId: enabled ? settings.clientId : null };
    await save();
    return { enabled: settings.enabled, available: Boolean(measurementId && apiSecret) };
  });
  ipcMain.on('analytics:screen', (_event, screen: unknown) => { if (typeof screen === 'string') trackScreen(screen); });

  void send('app_open');
}
