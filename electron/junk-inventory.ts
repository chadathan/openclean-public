// What is on the disk that nobody needs, and what it would cost to remove it.
//
// Same shape as the application scanner and for the same reasons: its own IPC channel, never the
// metrics loop, and results streamed a category at a time so a list that takes twenty seconds to
// build appears as it is found.
//
// The rule that shapes everything here: a category that cannot be read says so. Reporting an
// unreadable Trash as "0 B" is not a gap, it is a claim — and it is the claim that makes a
// cleaner untrustworthy. Every category therefore carries one of four states, and three of them
// mean "nothing is offered".
import { BrowserWindow, dialog, ipcMain, webContents, type MessageBoxOptions } from 'electron';
import { readdir, rm, stat, statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { HOME, execFileAsync, exists, icons, removable, sizesOf, tilde, writable } from './fs-scan';
import { simulatorDevices, simulatorRuntimes } from './dev-tools';

export type JunkState = 'found' | 'empty' | 'locked' | 'refused';

export type JunkItem = {
  id: string;
  label: string;
  path: string;
  bytes: number;
  icon?: string | null;
  /** What is lost. Present on everything offered; the user should never have to guess. */
  note?: string;
  /** True only where removing it costs nothing real. "Select smartly" takes these and nothing else. */
  safe?: boolean;
  /** The badge on a safe row, when the default "comes back on its own" would not be true. */
  flag?: string;
  /** False for a row that is reported but cannot be removed from here; it gets no checkbox. */
  offered?: boolean;
};

/** A figure worth showing beside a reason, on a category that offers nothing to tick. */
export type JunkFact = { label: string; value: string; detail?: string };

export type JunkCategory = {
  key: string;
  label: string;
  blurb: string;
  state: JunkState;
  status?: string;
  /** Why it is locked, empty or refused, in one sentence the user can act on. */
  reason?: string;
  facts?: JunkFact[];
  items: JunkItem[];
};

export type JunkSection = { key: string; label: string; blurb: string; categories: JunkCategory[] };

/** Below this a cache folder is a line of noise rather than a saving. */
const FLOOR_BYTES = 4 * 1024 * 1024;
const OLD_DOWNLOAD_DAYS = 30;

let scanToken = 0;
/** The scan in progress, if any. A cancelled one keeps running until its next checkpoint. */
let running: Promise<void> = Promise.resolve();

function send(id: number, channel: string, payload: unknown): void {
  const contents = webContents.fromId(id);
  if (contents && !contents.isDestroyed()) contents.send(channel, payload);
}

/** Readable at all? The Trash, Mail and document revisions are each behind Full Disk Access. */
async function readable(path: string): Promise<boolean> {
  try { await readdir(path); return true; } catch { return false; }
}

/**
 * A bundle identifier is what a cache folder is usually named, and it means nothing to anyone.
 * Resolved against what is installed so the row can say "Codex" rather than "com.openai.codex",
 * and carry the app's own icon. Built once per scan.
 */
function resolveApp(key: string, index: Map<string, { name: string; icon: string | null }>): { name: string; icon: string | null } | undefined {
  const lower = key.toLowerCase();
  const direct = index.get(lower);
  if (direct) return direct;
  // com.microsoft.VSCode.ShipIt belongs to com.microsoft.VSCode; walk the identifier back.
  const parts = lower.split('.');
  for (let end = parts.length - 1; end >= 2; end--) {
    const found = index.get(parts.slice(0, end).join('.'));
    if (found) return found;
  }
  return undefined;
}

async function installedIndex(): Promise<Map<string, { name: string; icon: string | null }>> {
  const index = new Map<string, { name: string; icon: string | null }>();
  const bundles: string[] = [];
  for (const root of ['/Applications', '/Applications/Utilities', join(HOME, 'Applications')]) {
    try {
      for (const entry of await readdir(root)) if (entry.endsWith('.app')) bundles.push(join(root, entry));
    } catch { /* Absent on this machine. */ }
  }
  const artwork = await icons(bundles);
  await Promise.all(bundles.map(async bundle => {
    try {
      const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(bundle, 'Contents/Info.plist')], { timeout: 2_000 });
      const id = stdout.trim();
      const entry = { name: basename(bundle).slice(0, -4), icon: artwork.get(bundle) ?? null };
      if (id) index.set(id.toLowerCase(), entry);
      // Folders named after the app rather than its identifier — "Microsoft Edge", "Firefox".
      index.set(entry.name.toLowerCase(), entry);
    } catch { /* No identifier; the folder name stands on its own. */ }
  }));
  return index;
}

/** Caches whose contents are known well enough to say what removing them actually costs. */
const CACHE_NOTES: Record<string, string> = {
  'com.microsoft.vscode.shipit': 'Installers already applied; nothing needs them',
  'ms-playwright': 'Browsers are downloaded again on the next test run',
  'go-build': 'Rebuilt by the next go build; the first one will be slower',
  electron: 'Downloaded again the next time a build needs that version',
  homebrew: 'Downloaded again the next time a formula is installed',
  'com.apple.dt.xcode': 'Rebuilt as Xcode works'
};

async function folderChildren(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).filter(entry => !entry.startsWith('.')).map(entry => join(root, entry));
  } catch {
    return [];
  }
}

async function cacheFolder(root: string, key: string, label: string, blurb: string, index?: Map<string, { name: string; icon: string | null }>): Promise<JunkCategory> {
  if (await exists(root) && !(await readable(root))) {
    return { key, label, blurb, state: 'locked', status: 'Full Disk Access required',
      reason: `${tilde(root)} is protected by macOS. Grant Full Disk Access to measure its contents.`, items: [] };
  }
  const children = await folderChildren(root);
  const sizes = await sizesOf(children);
  const items = (await Promise.all(children.map(async path => {
      const childKey = basename(path);
      const known = index ? resolveApp(childKey, index) : undefined;
      const canMove = await writable(path) && removable(path);
      return {
        id: path, label: known?.name ?? childKey, path: tilde(path), bytes: sizes.get(path) ?? 0,
        icon: known?.icon ?? null,
        note: canMove ? (CACHE_NOTES[childKey.toLowerCase()] ?? 'Rebuilt or downloaded again when the app next needs it') : 'Reported for reference; macOS does not allow OpenClean to move this item',
        offered: canMove,
        safe: canMove
      };
    })))
    .filter(item => item.bytes >= FLOOR_BYTES)
    .sort((a, b) => b.bytes - a.bytes);
  return {
    key, label, blurb,
    state: items.length ? 'found' : 'empty',
    status: items.length ? undefined : 'Nothing to clear',
    items
  };
}

async function applicationCache(index: Map<string, { name: string; icon: string | null }>): Promise<JunkCategory> {
  return cacheFolder(join(HOME, 'Library/Caches'), 'usercache', 'User Cache Files',
    'App caches in your home folder. Apps rebuild or download these again when needed.', index);
}

async function systemCache(): Promise<JunkCategory> {
  return cacheFolder('/Library/Caches', 'syscache', 'System Cache Files',
    'Shared caches macOS and installed software can rebuild. Protected items stay unavailable.');
}

async function userLogs(): Promise<JunkCategory> {
  const root = join(HOME, 'Library/Logs');
  const children = await folderChildren(root);
  const sizes = await sizesOf(children);
  const items = children
    .map(path => ({ id: path, label: basename(path), path: tilde(path), bytes: sizes.get(path) ?? 0, note: 'Diagnostic text; nothing reads it but a crash report', safe: true }))
    .filter(item => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 12);
  return {
    key: 'userlog', label: 'User Log Files',
    blurb: 'Diagnostic text your own apps write as they run.',
    state: items.length ? 'found' : 'empty',
    status: items.length ? undefined : 'Nothing to clear',
    items
  };
}

async function systemLogs(): Promise<JunkCategory> {
  const root = '/Library/Logs';
  if (await exists(root) && !(await readable(root))) {
    return { key: 'syslog', label: 'System Log Files', blurb: 'Shared diagnostic logs written by macOS and installed software.',
      state: 'locked', status: 'Full Disk Access required', reason: '/Library/Logs is protected by macOS.', items: [] };
  }
  const children = await folderChildren(root);
  const sizes = await sizesOf(children);
  const items = await Promise.all(children.map(async path => {
    const canMove = await writable(path) && removable(path);
    return { id: path, label: basename(path), path: tilde(path), bytes: sizes.get(path) ?? 0,
      note: canMove ? 'Diagnostic logs; not needed for normal use' : 'Reported for reference; protected by macOS',
      offered: canMove, safe: canMove };
  }));
  const found = items.filter(item => item.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  return { key: 'syslog', label: 'System Log Files', blurb: 'Shared diagnostic logs written by macOS and installed software.',
    state: found.length ? 'found' : 'empty', status: found.length ? undefined : 'Nothing to clear', items: found };
}

async function xcodeJunk(): Promise<JunkCategory> {
  const candidates = [
    { path: join(HOME, 'Library/Developer/Xcode/DerivedData'), label: 'Derived data', note: 'Rebuilt on the next build; the first one will be slow', safe: true },
    { path: join(HOME, 'Library/Developer/Xcode/Archives'), label: 'Archives and dSYMs', note: 'The only copy of the symbols for builds you have shipped' },
    { path: join(HOME, 'Library/Developer/Xcode/iOS DeviceSupport'), label: 'Device support', note: 'Re-created the next time each device is attached', safe: true }
  ];
  const present = [];
  for (const candidate of candidates) if (await exists(candidate.path)) present.push(candidate);
  const sizes = await sizesOf(present.map(candidate => candidate.path), true);
  const items: JunkItem[] = [];
  for (const candidate of present) {
    const bytes = sizes.get(candidate.path) ?? 0;
    if (!bytes) continue;
    // Root-owned trees are listed so the figure is honest, but not offered: removing them needs
    // an authorisation prompt this app does not raise, and simctl is the right tool anyway.
    const mine = await writable(candidate.path);
    items.push({
      id: candidate.path, label: candidate.label, path: tilde(candidate.path), bytes,
      note: mine ? candidate.note : `${candidate.note} · Administrator required, so it is not offered here`,
      safe: mine && candidate.safe
    });
  }
  // Listed device by device rather than as one folder: most of what is in there belongs to
  // simulators that no longer have a runtime to boot on.
  const simulators = await simulatorDevices(join(HOME, 'Library/Developer/CoreSimulator'));
  items.push(...simulators.devices.map(device => ({
    id: device.path, label: device.name, path: tilde(device.path), bytes: device.bytes,
    note: device.stranded
      ? `Its runtime (${device.runtime}) is no longer installed, so this device can never boot again`
      : device.runtime ? `Ready to boot on ${device.runtime}` : 'Still listed by Xcode',
    safe: device.stranded,
    flag: device.stranded ? 'cannot boot' : undefined
  })));
  items.push(...(await simulatorRuntimes(simulators.liveByRuntime)).map(runtime => ({
    id: runtime.mountPath ?? `runtime:${runtime.version}`,
    label: `iOS ${runtime.version} runtime`,
    path: runtime.mountPath ?? '—',
    bytes: runtime.bytes,
    note: runtime.devicesInUse
      ? `${runtime.devicesInUse} simulator${runtime.devicesInUse === 1 ? '' : 's'} boot on it. Removing it needs xcrun simctl runtime delete, and costs a download of the same size again.`
      : `No simulator uses it. Remove it with: xcrun simctl runtime delete ${runtime.version}`,
    // Reported, never ticked: the mount is root-owned and simctl is the only correct way out.
    offered: false,
    safe: false
  })));
  items.sort((a, b) => b.bytes - a.bytes);

  return {
    key: 'xcode', label: 'Xcode Junk',
    blurb: 'Build products, indexes and simulator images Xcode makes as it works.',
    state: items.length ? 'found' : 'empty',
    status: items.length ? undefined : 'Xcode has written nothing here',
    items
  };
}

async function oldDownloads(): Promise<JunkCategory> {
  const root = join(HOME, 'Downloads');
  const cutoff = Date.now() - OLD_DOWNLOAD_DAYS * 86_400_000;
  const old: Array<{ path: string; days: number }> = [];
  for (const path of await folderChildren(root)) {
    try {
      const info = await stat(path);
      // Access time is noisy on macOS: Finder previews, Spotlight and a backup can update it
      // without changing the download. Modified time is the stable signal people see in Finder
      // and the one that answers whether the file itself has gone untouched.
      const touched = info.mtimeMs;
      if (touched < cutoff) old.push({ path, days: Math.floor((Date.now() - touched) / 86_400_000) });
    } catch { /* Vanished between listing and stat. */ }
  }
  const sizes = await sizesOf(old.map(entry => entry.path));
  const items = old
    .map(entry => ({
      id: entry.path, label: basename(entry.path), path: tilde(entry.path),
      bytes: sizes.get(entry.path) ?? 0,
      note: `Untouched for ${entry.days} days`,
      // These are the user's own files. Nothing here is ever ticked for them.
      safe: false
    }))
    .filter(item => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  return {
    key: 'downloads', label: 'Old Downloads',
    blurb: `Files in Downloads untouched for more than ${OLD_DOWNLOAD_DAYS} days. These are yours — read the list.`,
    state: items.length ? 'found' : 'empty',
    status: items.length ? undefined : 'Nothing older than a month',
    items
  };
}

async function lockedOrFound(key: string, label: string, blurb: string, path: string, note: string, reason: string): Promise<JunkCategory> {
  if (!(await readable(path))) {
    return { key, label, blurb, state: 'locked', status: 'Full Disk Access required', reason, items: [] };
  }
  const children = await folderChildren(path);
  const sizes = await sizesOf(children);
  const items = children
    .map(child => ({ id: child, label: basename(child), path: tilde(child), bytes: sizes.get(child) ?? 0, note, safe: false }))
    .filter(item => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  return {
    key, label, blurb,
    state: items.length ? 'found' : 'empty',
    status: items.length ? undefined : 'Nothing in here',
    items
  };
}

async function scan(senderId: number, token: number): Promise<void> {
  const index = await installedIndex();
  if (token !== scanToken) return;

  const plan: Array<[string, () => Promise<JunkCategory | null>]> = [
    ['xcode', xcodeJunk],
    ['system', () => applicationCache(index)],
    ['system', systemCache],
    ['system', oldDownloads],
    ['system', userLogs],
    ['system', systemLogs],
    ['mail', () => lockedOrFound('mail', 'Mail Attachments',
      'Copies of attachments Mail keeps on disk after they have been downloaded.',
      join(HOME, 'Library/Mail'), 'Removing it means downloading the attachment again from the server',
      '~/Library/Mail is protected by macOS. Nothing can read it, or say how large it is, until you grant Full Disk Access.')],
    ['trash', () => lockedOrFound('trash', 'Trash Bins',
      'Files you already threw away. This is the one place where emptying is permanent.',
      join(HOME, '.Trash'), 'Already thrown away; emptying the Trash is the one removal that cannot be undone',
      '~/.Trash is protected by macOS. Reading it, and telling you how much is in there, needs Full Disk Access.')]
  ];

  send(senderId, 'cleanup:scan-begin', { total: plan.length });
  let done = 0;
  for (const [section, build] of plan) {
    if (token !== scanToken) return;
    try {
      const category = await build();
      done++;
      if (category) send(senderId, 'cleanup:scan-category', { section, category, done, total: plan.length });
    } catch (error) {
      done++;
      console.error('Unable to read a cleanup category', error);
    }
  }
  if (token !== scanToken) return;
  send(senderId, 'cleanup:scan-done', {});
}

export function registerJunkInventory(): void {
  ipcMain.handle('cleanup:scan', event => {
    // A new scan supersedes any earlier one. The earlier scan may still be waiting on du after
    // Cancel; it stops at its next checkpoint and this one starts right after, rather than the
    // user being told a scan they already cancelled is still running.
    const token = ++scanToken;
    const senderId = event.sender.id;
    running = running.then(async () => {
      if (token !== scanToken) return;
      try { await scan(senderId, token); }
      catch (error) {
        console.error('Unable to scan for clutter', error);
        if (token === scanToken) send(senderId, 'cleanup:scan-failed', { reason: String(error) });
      }
    });
    return { started: true };
  });

  ipcMain.handle('cleanup:cancel-scan', () => { scanToken++; return { cancelled: true }; });

  ipcMain.handle('cleanup:empty-trash', async (event, request: unknown, emptyAll: unknown) => {
    type EmptyTrashResult = { deleted: number; failures: string[]; deletedPaths: string[]; cancelled?: boolean; freeBytesBefore?: number | null; freeBytesAfter?: number | null };
    const trashRoot = resolve(HOME, '.Trash');
    let paths = Array.isArray(request)
      ? [...new Set(request.filter((path): path is string => typeof path === 'string').map(path => resolve(path)))].filter(path => dirname(path) === trashRoot)
      : [];
    if (emptyAll === true) {
      try { paths = (await readdir(trashRoot)).map(name => join(trashRoot, name)); }
      catch (error) { return { deleted: 0, failures: [`Could not read the Trash: ${(error as NodeJS.ErrnoException).code ?? 'access denied'}`], deletedPaths: [] } satisfies EmptyTrashResult; }
    }
    if (!paths.length) return {
      deleted: 0,
      failures: emptyAll === true ? [] : ['No valid Trash items were selected.'],
      deletedPaths: []
    } satisfies EmptyTrashResult;

    const parent = BrowserWindow.fromWebContents(event.sender);
    const confirmation: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Delete permanently', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: paths.length === 1 ? 'Permanently delete this Trash item?' : `Permanently delete ${paths.length} Trash items?`,
      detail: 'This cannot be undone. OpenClean will delete the selected items and their contents.'
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, confirmation)
      : await dialog.showMessageBox(confirmation);
    if (response !== 0) return { deleted: 0, failures: [], deletedPaths: [], cancelled: true } satisfies EmptyTrashResult;

    const freeBytesBefore = await statfs(HOME).then(info => info.bavail * info.bsize, () => null);

    const deletedPaths: string[] = [];
    const failures: string[] = [];
    for (const path of paths) {
      try {
        await rm(path, { recursive: true, force: false });
        deletedPaths.push(path);
      } catch (error) {
        failures.push(`${basename(path)}: ${(error as NodeJS.ErrnoException).code ?? 'could not delete'}`);
      }
    }
    const freeBytesAfter = await statfs(HOME).then(info => info.bavail * info.bsize, () => null);
    return { deleted: deletedPaths.length, failures, deletedPaths, freeBytesBefore, freeBytesAfter } satisfies EmptyTrashResult;
  });
}
