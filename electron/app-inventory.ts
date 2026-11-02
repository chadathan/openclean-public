// What is installed, and what each app has left around the home folder.
//
// Kept off the metrics loop entirely. Walking an app bundle costs hundreds of milliseconds and
// the whole pass takes tens of seconds; the loop samples every second and must never wait on
// this. The renderer asks for a scan, and results are pushed back one app at a time so the list
// fills in rather than appearing after a minute of nothing.
//
// The number this exists to produce is an app's real footprint: its bundle plus the data it has
// written elsewhere. Finder reports Docker.app at 1.65 GB; its Linux VM disk under
// ~/Library/Containers is another 43 GB, and nothing in macOS puts those two figures together.
import { app, ipcMain, shell, webContents } from 'electron';
import { readdir } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { HOME, execFileAsync, exists, expand, icons, removable, sizesOf, tilde, trashPaths } from './fs-scan';
import { dockerUsage, simulatorDevices, simulatorRuntimes } from './dev-tools';

export type SliceKind = 'binary' | 'support' | 'cache' | 'container' | 'preference' | 'log';

export type AppSlice = {
  label: string;
  path: string;
  bytes: number;
  impact?: string;
  /** False for a row that is reported but cannot be removed from here; it gets no checkbox. */
  offered?: boolean;
};

export type AppGroup = { kind: SliceKind; items: AppSlice[] };

export type InstalledApp = {
  id: string;
  name: string;
  path: string;
  icon: string | null;
  version: string | null;
  vendor: string;
  store: 'App Store' | 'Other';
  /** Days since Spotlight last saw it opened; null when Spotlight has no record. */
  daysIdle: number | null;
  groups: AppGroup[];
};

export type LooseFile = { id: string; label: string; path: string; bytes: number };

type Candidate = { kind: SliceKind; label: string; path: string; impact?: string };

/**
 * What is actually lost, in the user's terms, for the folders whose contents are known. "Your
 * data lives here" is true of every support folder and tells nobody anything; "Bookmarks, saved
 * passwords and history" is a decision someone can make. Where the contents are not known, the
 * generic line below says so honestly rather than guessing at specifics.
 */
const GENERIC_IMPACT: Partial<Record<SliceKind, string>> = {
  container: 'Everything this app has saved, including documents',
  support: 'Settings and anything this app has saved'
};

const SEARCH_ROOTS = ['/Applications', '/Applications/Utilities', join(HOME, 'Applications')];

/**
 * Folders whose name says nothing about which app owns them. Everything else is matched by
 * bundle identifier or by the app's own name, which covers the great majority; these are the
 * ones worth naming by hand because they are large and would otherwise be attributed to
 * nobody. The labels say what is shared, because "Google" is not only Chrome's.
 */
const EXTRA_PATHS: Record<string, Candidate[]> = {
  'com.apple.dt.Xcode': [
    { kind: 'support', label: 'iOS simulators', path: 'Library/Developer/CoreSimulator', impact: 'Installed simulator devices and the apps on them' },
    { kind: 'cache', label: 'Derived data', path: 'Library/Developer/Xcode/DerivedData', impact: 'Rebuilt on the next build; the first one will be slow' },
    { kind: 'support', label: 'Archives and dSYMs', path: 'Library/Developer/Xcode/Archives', impact: 'The only copy of the symbols for builds you have shipped' },
    { kind: 'support', label: 'Device support', path: 'Library/Developer/Xcode/iOS DeviceSupport', impact: 'Re-created the next time each device is attached' }
  ],
  'com.google.android.studio': [
    { kind: 'support', label: 'SDK, emulators and AVDs', path: 'Library/Android', impact: 'The Android SDK, emulator images and every virtual device you set up' }
  ],
  'com.google.Chrome': [
    { kind: 'support', label: 'Profiles and history · shared by Google apps', path: 'Library/Application Support/Google', impact: 'Bookmarks, saved passwords, history, cookies and extensions' },
    { kind: 'cache', label: 'Caches · shared by Google apps', path: 'Library/Caches/Google', impact: 'Pages are fetched again; nothing you saved is in here' }
  ],
  'com.jetbrains.toolbox': [
    { kind: 'support', label: 'IDE data and indexes · shared by JetBrains IDEs', path: 'Library/Application Support/JetBrains', impact: 'IDE settings, plugins, licences and project indexes' },
    { kind: 'cache', label: 'Caches · shared by JetBrains IDEs', path: 'Library/Caches/JetBrains', impact: 'Re-indexed when each project is next opened' }
  ],
  'com.microsoft.VSCode': [
    { kind: 'support', label: 'Extensions and workspace state', path: 'Library/Application Support/Code', impact: 'Installed extensions, keybindings, settings and workspace history' },
    { kind: 'cache', label: 'Downloaded updates', path: 'Library/Caches/com.microsoft.VSCode.ShipIt', impact: 'Installers already applied; nothing needs them' }
  ],
  'com.docker.docker': [
    { kind: 'support', label: 'Settings', path: 'Library/Application Support/Docker Desktop', impact: 'Preferences only; images live in the container below' }
  ]
};

/** Keyed by the path relative to home, for folders no single app owns by name. */
const PATH_IMPACT: Record<string, string> = {
  'Library/Containers/com.docker.docker': 'Every Docker image, container and named volume',
  'Library/Application Support/Claude': 'Conversations, projects and your sign-in',
  'Library/Application Support/Code': 'Installed extensions, keybindings, settings and workspace history'
};

let scanToken = 0;
/** The scan in progress, if any. A cancelled one keeps running until its next checkpoint. */
let running: Promise<void> = Promise.resolve();

function send(id: number, channel: string, payload: unknown): void {
  const contents = webContents.fromId(id);
  if (contents && !contents.isDestroyed()) contents.send(channel, payload);
}

async function plistValue(bundle: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(bundle, 'Contents/Info.plist')], { timeout: 2_000 });
    const value = stdout.trim();
    return value.length ? value : null;
  } catch {
    return null;
  }
}

/**
 * One mdls run for every bundle. With a single -name it prints no filename headers at all:
 * just one value line per path, in the order given, and "(null)" for a file Spotlight has no
 * record of. So the answers are matched back by position, and the count is checked before
 * trusting it — a mismatch would silently attribute one app's date to another.
 */
async function lastUsed(paths: string[]): Promise<Map<string, number>> {
  const days = new Map<string, number>();
  if (!paths.length) return days;
  try {
    const { stdout } = await execFileAsync('/usr/bin/mdls', ['-name', 'kMDItemLastUsedDate', ...paths], { timeout: 20_000, maxBuffer: 4 << 20 });
    const lines = stdout.split('\n').filter(line => line.includes('kMDItemLastUsedDate'));
    if (lines.length !== paths.length) return days;
    paths.forEach((path, index) => {
      const value = lines[index].match(/=\s*(\d{4}-\d{2}-\d{2} [\d:]+)/);
      if (!value) return;
      const elapsed = Date.now() - new Date(`${value[1]}Z`).getTime();
      if (Number.isFinite(elapsed)) days.set(path, Math.max(0, Math.floor(elapsed / 86_400_000)));
    });
  } catch { /* Spotlight is not always able to answer; the column simply stays empty. */ }
  return days;
}

async function listBundles(): Promise<string[]> {
  const bundles: string[] = [];
  for (const root of SEARCH_ROOTS) {
    try {
      for (const entry of await readdir(root)) {
        if (entry.endsWith('.app')) bundles.push(join(root, entry));
      }
    } catch { /* The folder does not exist on this machine. */ }
  }
  return bundles;
}

const VENDOR_NAMES: Record<string, string> = {
  openai: 'OpenAI', jetbrains: 'JetBrains', utmapp: 'UTM', obsproject: 'OBS Project',
  vmware: 'VMware', metaquotes: 'MetaQuotes', rustdesk: 'RustDesk', teamviewer: 'TeamViewer',
  sublimetext: 'Sublime HQ', googlecode: 'Google', if: 'Unknown'
};

function vendorOf(bundleId: string): string {
  // com.microsoft.VSCode -> Microsoft. The only signal a bundle carries about who wrote it that
  // does not need a network call; capitalising alone would give "Openai", hence the table.
  const part = (bundleId.split('.')[1] ?? '').toLowerCase();
  if (!part) return 'Unknown';
  return VENDOR_NAMES[part] ?? part.charAt(0).toUpperCase() + part.slice(1);
}

/**
 * A folder name taken from an app's Info.plist is written by whoever made the app. It becomes a
 * path under ~/Library, so it must be one plain path component: a name like
 * "../../Documents/Projects" would otherwise list a folder of the user's own as the app's data.
 */
export function safeComponent(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\0') && !/^\.+$/.test(value);
}

/** Bundle identifiers are reverse-DNS: letters, digits, hyphens and periods only. */
function safeBundleId(value: string): boolean {
  return /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(value);
}

export function candidatesFor(bundle: string, bundleId: string, aliases: string[]): Candidate[] {
  const library = join(HOME, 'Library');
  const named = (kind: SliceKind, label: string, ...paths: string[]) => paths.map(path => ({ kind, label, path }));
  const names = [...new Set(aliases.filter(safeComponent))];
  const byName = (folder: string) => names.map(alias => join(library, folder, alias));
  const binary: Candidate = { kind: 'binary', label: basename(bundle), path: bundle };
  if (!safeBundleId(bundleId)) {
    // No usable identifier: only folders named after the app itself can be attributed to it.
    return [
      binary,
      ...named('support', 'Application data', ...byName('Application Support')),
      ...named('cache', 'Caches', ...byName('Caches')),
      ...named('log', 'Logs', ...byName('Logs'))
    ];
  }
  return [
    binary,
    ...(EXTRA_PATHS[bundleId] ?? []).map(extra => ({ ...extra, path: join(HOME, extra.path) })),
    ...named('container', 'Sandboxed data', join(library, 'Containers', bundleId)),
    ...named('support', 'Application data', join(library, 'Application Support', bundleId), ...byName('Application Support')),
    ...named('cache', 'Caches', join(library, 'Caches', bundleId), ...byName('Caches')),
    ...named('cache', 'Web storage', join(library, 'HTTPStorages', bundleId), join(library, 'WebKit', bundleId)),
    ...named('log', 'Logs', join(library, 'Logs', bundleId), ...byName('Logs')),
    ...named('preference', 'Preferences', join(library, 'Preferences', `${bundleId}.plist`)),
    ...named('preference', 'Saved window state', join(library, 'Saved Application State', `${bundleId}.savedState`))
  ];
}

/**
 * A few folders are a container for many separate things, and reporting them as one number
 * hides the decision. Xcode's CoreSimulator is a folder per simulator device, and most of what
 * is in there usually belongs to devices whose runtime has since been removed — they can never
 * boot again, but the folders stay. Docker is the opposite: everything it holds is inside a
 * single sparse disk image, so it cannot be split at all, and the most useful thing to add is
 * what the daemon says is inside.
 */
async function openUp(candidate: Candidate, bytes: number): Promise<AppSlice[]> {
  if (candidate.path === join(HOME, 'Library/Developer/CoreSimulator')) {
    const { devices, liveByRuntime } = await simulatorDevices(candidate.path);
    if (!devices.length) return [];
    const runtimes = await simulatorRuntimes(liveByRuntime);
    const stranded = devices.filter(device => device.stranded);
    return [
      ...devices.map(device => ({
        label: device.name,
        path: tilde(device.path),
        bytes: device.bytes,
        impact: device.stranded
          ? `Cannot boot — its runtime (${device.runtime}) is no longer installed`
          : device.runtime ? `Boots on ${device.runtime}` : 'Still listed by Xcode'
      })),
      ...runtimes.map(runtime => ({
        label: `iOS ${runtime.version} runtime`,
        path: runtime.mountPath ?? '—',
        bytes: runtime.bytes,
        impact: runtime.devicesInUse
          ? `${runtime.devicesInUse} simulator${runtime.devicesInUse === 1 ? '' : 's'} boot on it · remove with xcrun simctl runtime delete`
          : `No simulator uses it · remove with xcrun simctl runtime delete ${runtime.version}`,
        // Reported, never ticked: the mount is root-owned and simctl is the only correct way out.
        offered: false
      })),
      ...(stranded.length ? [] : [])
    ].filter(slice => slice.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  }

  if (candidate.path === join(HOME, 'Library/Containers/com.docker.docker')) {
    const usage = await dockerUsage(candidate.path);
    if (!usage?.reachable) return [];
    const gb = (value: number) => `${(value / 1_073_741_824).toFixed(1)} GB`;
    const parts = usage.rows
      .filter(row => row.size !== '0B')
      .map(row => `${row.type.toLowerCase()} ${row.size}`)
      .join(', ');
    const trailing = usage.unreturnedBytes > 1_073_741_824
      ? ` · ${gb(usage.unreturnedBytes)} already freed inside but not yet returned to macOS`
      : '';
    // One file, so one row — but the row can say what the daemon sees inside it.
    return [{
      label: 'Virtual disk',
      path: tilde(join(candidate.path, 'Data/vms/0/data/Docker.raw')),
      bytes,
      impact: `Holds ${parts}${trailing}. Removing it takes every image, container and volume at once; docker builder prune and docker image prune -a reclaim most of it without that.`
    }];
  }

  return [];
}

async function scan(senderId: number, token: number): Promise<void> {
  const bundles = await listBundles();
  const [idle, artwork] = await Promise.all([lastUsed(bundles), icons(bundles)]);
  if (token !== scanToken) return;

  send(senderId, 'apps:scan-begin', { total: bundles.length });

  // A folder belongs to whichever app claims it first, so a shared cache is counted once
  // rather than inflating two apps by the same gigabytes.
  const claimed = new Set<string>();
  const installedIds = new Set<string>();
  let done = 0;

  for (const bundle of bundles) {
    if (token !== scanToken) return;
    const [bundleId, display, plistName, version] = await Promise.all([
      plistValue(bundle, 'CFBundleIdentifier'),
      plistValue(bundle, 'CFBundleDisplayName'),
      plistValue(bundle, 'CFBundleName'),
      plistValue(bundle, 'CFBundleShortVersionString')
    ]);
    const id = bundleId ?? bundle;
    if (bundleId) installedIds.add(bundleId.toLowerCase());
    // The folder name is what Finder and Launchpad show, so it is the name the list carries.
    // The plist names still matter for matching: Visual Studio Code.app calls itself "Code",
    // and "Code" is what it names its support folder.
    const label = basename(bundle).slice(0, -4);
    const aliases = [label, display, plistName].filter((value): value is string => Boolean(value));

    const candidates: Candidate[] = [];
    for (const candidate of candidatesFor(bundle, id, aliases)) {
      if (claimed.has(candidate.path)) continue;
      if (!(await exists(candidate.path))) continue;
      claimed.add(candidate.path);
      candidates.push(candidate);
    }
    const sizes = await sizesOf(candidates.map(candidate => candidate.path));

    const groups: AppGroup[] = [];
    for (const candidate of candidates) {
      const bytes = sizes.get(candidate.path);
      if (bytes === undefined || bytes === 0) continue;
      const group = groups.find(entry => entry.kind === candidate.kind) ?? (groups.push({ kind: candidate.kind, items: [] }), groups[groups.length - 1]);
      const opened = await openUp(candidate, bytes);
      if (opened.length) { group.items.push(...opened); continue; }
      const relative = candidate.path.startsWith(HOME + sep) ? candidate.path.slice(HOME.length + 1) : candidate.path;
      const impact = candidate.impact ?? PATH_IMPACT[relative] ?? GENERIC_IMPACT[candidate.kind];
      group.items.push({ label: candidate.label, path: tilde(candidate.path), bytes, impact });
    }

    const installed: InstalledApp = {
      id, name: label, path: bundle,
      icon: artwork.get(bundle) ?? null,
      version,
      vendor: bundleId ? vendorOf(bundleId) : 'Unknown',
      store: (await exists(join(bundle, 'Contents/_MASReceipt'))) ? 'App Store' : 'Other',
      daysIdle: idle.get(bundle) ?? null,
      groups
    };
    done++;
    send(senderId, 'apps:scan-app', { app: installed, done, total: bundles.length });
  }

  const [leftovers, installers] = await Promise.all([findLeftovers(installedIds, claimed), findInstallers()]);
  if (token !== scanToken) return;
  send(senderId, 'apps:scan-done', { leftovers, installers });
}

/**
 * Support folders named after a bundle identifier that nothing installed answers to. Apple's
 * own components are excluded throughout: they ship without a bundle in /Applications by
 * design, so calling them leftovers would be wrong.
 */
async function findLeftovers(installedIds: Set<string>, claimed: Set<string>): Promise<LooseFile[]> {
  const roots = [join(HOME, 'Library/Application Support'), join(HOME, 'Library/Containers')];
  const orphans: string[] = [];
  for (const root of roots) {
    try {
      for (const entry of await readdir(root)) {
        if (!entry.includes('.') || entry.startsWith('com.apple.')) continue;
        if (installedIds.has(entry.toLowerCase())) continue;
        const path = join(root, entry);
        if (claimed.has(path)) continue;
        orphans.push(path);
      }
    } catch { /* Unreadable without Full Disk Access; the section simply stays short. */ }
  }
  const sizes = await sizesOf(orphans);
  return orphans
    .map(path => ({ id: path, label: basename(path), path: tilde(path), bytes: sizes.get(path) ?? 0 }))
    // Below a megabyte a leftover is a line of noise, not a saving.
    .filter(entry => entry.bytes >= 1_048_576)
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Installers are found by where they are and what they are, not by extension alone: a disk
 * image inside a developer SDK is a runtime the toolchain needs, not a download to throw away.
 */
async function findInstallers(): Promise<LooseFile[]> {
  const roots = [join(HOME, 'Downloads'), join(HOME, 'Desktop'), join(HOME, 'Documents')];
  const files: string[] = [];
  for (const root of roots) {
    try {
      for (const entry of await readdir(root)) {
        if (/\.(dmg|pkg|xip)$/i.test(entry)) files.push(join(root, entry));
      }
    } catch { /* The folder does not exist, or is not readable. */ }
  }
  const sizes = await sizesOf(files);
  return files
    .map(path => ({ id: path, label: basename(path), path: tilde(path), bytes: sizes.get(path) ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** A path is removable only if it sits inside one of the roots this feature is allowed to touch. */
export function registerAppInventory(): void {
  ipcMain.handle('apps:scan', event => {
    // A new scan supersedes any earlier one, which stops at its next checkpoint; this one starts
    // right after instead of reporting that a scan the user already cancelled is still running.
    const token = ++scanToken;
    const senderId = event.sender.id;
    running = running.then(async () => {
      if (token !== scanToken) return;
      try { await scan(senderId, token); }
      catch (error) {
        console.error('Unable to scan applications', error);
        if (token === scanToken) send(senderId, 'apps:scan-failed', { reason: String(error) });
      }
    });
    return { started: true };
  });

  ipcMain.handle('apps:cancel-scan', () => { scanToken++; return { cancelled: true }; });

  ipcMain.handle('apps:trash', (_event, paths: unknown, label: unknown, source: unknown) =>
    trashPaths(paths, typeof label === 'string' ? label : 'Removal', source === 'applications' || source === 'cleanup' || source === 'files' ? source : undefined));

  ipcMain.handle('apps:reveal', (_event, path: unknown) => {
    if (typeof path !== 'string' || !removable(path)) return { revealed: false };
    shell.showItemInFolder(expand(path));
    return { revealed: true };
  });

  app.on('before-quit', () => { scanToken++; });
}
