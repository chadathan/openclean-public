// A receipt for every removal, so a removal can be undone without hunting through the Trash.
//
// shell.trashItem puts each path at the top of ~/.Trash on its own. Remove an app and its four
// or five pieces land there loose, mixed in with everything else already in the bin, and
// nothing on screen says they belonged together. Finder's own Put Back works per item — if you
// can find the items.
//
// Listing ~/.Trash needs Full Disk Access, which this app does not have. But a file already in
// the Trash can be reached by its exact path and moved back out, which was measured rather than
// assumed. So the receipt records where each piece landed at the moment it was moved, and
// putting a removal back is then a rename per entry — no listing, no permission, no searching.
import { app, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export type RemovalEntry = {
  /** Where it came from, and where Put back will return it. */
  originalPath: string;
  /** Where it actually landed in the Trash, resolved at the moment it was moved. */
  trashPath: string | null;
  label: string;
  bytes: number;
  /** Still sitting in the Trash, checked when the list is read rather than when Put back is pressed. */
  available?: boolean;
  /** This entry has already been restored, even if other entries in its receipt have not. */
  restoredAt?: number;
};

/** The page a removal was made from, so each page's Put back lists only what it removed. */
export type RemovalSource = 'applications' | 'cleanup' | 'files';

export type Removal = {
  id: string;
  source?: RemovalSource;
  /** What the user thought they were removing: "OBS", "Application Cache". */
  label: string;
  removedAt: number;
  bytes: number;
  entries: RemovalEntry[];
  restoredAt: number | null;
};

let receipts: Removal[] | null = null;

/**
 * A root-owned bundle (every App Store app) cannot be renamed into or out of the Trash by this
 * user, even though /Applications itself is admin-writable: moving a directory to a new parent
 * rewrites its `..`, which needs write access on the directory itself. Finder asks for the admin
 * password here, so this does the same — the system prompt, then a no-clobber mv as root. The
 * paths travel as argv so nothing in a filename is ever parsed as shell or AppleScript.
 */
export async function moveAsAdmin(from: string, to: string): Promise<void> {
  const script = [
    'on run argv',
    'do shell script "/bin/mv -n " & quoted form of item 1 of argv & " " & quoted form of item 2 of argv with administrator privileges',
    'end run'
  ];
  try {
    await promisify(execFile)('/usr/bin/osascript', [...script.flatMap(line => ['-e', line]), from, to], { timeout: 120_000 });
  } catch (error) {
    const message = (error as { stderr?: string }).stderr ?? (error as Error).message;
    if (/-128|cancel/i.test(message)) throw new Error('Cancelled at the administrator password prompt.');
    throw new Error(message.trim() || 'The administrator move failed.');
  }
  const [gone, landed] = await Promise.all([stat(from).then(() => false, () => true), stat(to).then(() => true, () => false)]);
  if (!gone || !landed) throw new Error('The administrator move did not complete.');
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES';
}

function storePath(): string {
  return join(app.getPath('userData'), 'removals.json');
}

async function load(): Promise<Removal[]> {
  if (receipts) return receipts;
  try {
    receipts = JSON.parse(await readFile(storePath(), 'utf8')) as Removal[];
  } catch {
    receipts = [];
  }
  return receipts;
}

async function save(): Promise<void> {
  try {
    await mkdir(dirname(storePath()), { recursive: true });
    // Only the last fifty are worth keeping; beyond that the Trash has usually been emptied.
    await writeFile(storePath(), JSON.stringify((receipts ?? []).slice(-50), null, 2));
  } catch (error) {
    console.error('Unable to record the removal', error);
  }
}

export async function record(label: string, entries: RemovalEntry[], source?: RemovalSource): Promise<Removal> {
  const all = await load();
  const removal: Removal = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    label,
    removedAt: Date.now(),
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    restoredAt: null
  };
  all.push(removal);
  await save();
  return removal;
}

/**
 * Put a whole removal back where it came from. Each entry is a rename out of the Trash; a parent
 * folder that no longer exists is re-created, because removing an app can take the folder that
 * held its data with it.
 */
async function restore(id: string): Promise<{ restored: number; failures: string[] }> {
  const all = await load();
  const removal = all.find(entry => entry.id === id);
  if (!removal) return { restored: 0, failures: ['That removal is no longer on file'] };

  const failures: string[] = [];
  let restored = 0;
  for (const entry of removal.entries) {
    if (entry.restoredAt) continue;
    if (!entry.trashPath) { failures.push(`${entry.label}: never found in the Trash`); continue; }
    try {
      await mkdir(dirname(entry.originalPath), { recursive: true });
      try { await moveNoClobber(entry.trashPath, entry.originalPath); }
      catch (error) {
        // An app that needed the password to leave needs it again to come back.
        if (!isPermissionError(error) || !entry.originalPath.endsWith('.app')) throw error;
        await moveAsAdmin(entry.trashPath, entry.originalPath);
      }
      entry.restoredAt = Date.now();
      restored++;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code === 'ENOENT' ? 'no longer in the Trash — it may have been emptied'
        : code === 'EEXIST' ? 'an item already exists at the original location'
        : code === 'EPERM' || code === 'EACCES' ? 'macOS did not allow OpenClean to move it back'
        : (error as Error).message || code || 'it could not be moved back';
      failures.push(`${entry.label}: ${reason}`);
    }
  }
  if (restored) {
    removal.restoredAt = removal.entries.every(entry => entry.restoredAt !== undefined) ? Date.now() : null;
    await save();
  }
  return { restored, failures };
}

/**
 * Move without replacing anything the user may have created at the original path meanwhile.
 *
 * The existence check comes first because mv treats an existing folder as a destination to move
 * INTO: an app that re-created its cache folder would get the old one nested inside as
 * Cache/Cache, and the move would look successful.
 */
async function moveNoClobber(from: string, to: string): Promise<void> {
  if (!(await lstat(from).then(() => true, () => false))) {
    throw Object.assign(new Error('The item is no longer in the Trash.'), { code: 'ENOENT' });
  }
  if (await lstat(to).then(() => true, () => false)) {
    throw Object.assign(new Error('An item already exists at the original location.'), { code: 'EEXIST' });
  }
  try {
    await promisify(execFile)('/bin/mv', ['-n', from, to], { timeout: 30_000 });
  } catch (error) {
    // execFile reports mv's exit status (1) as the code; the reason is only in stderr. Map it
    // back to an errno so the caller can tell a permission problem, which the admin prompt can
    // solve, from anything else.
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const code = /permission denied|operation not permitted/i.test(stderr) ? 'EPERM'
      : /no such file/i.test(stderr) ? 'ENOENT' : 'EIO';
    throw Object.assign(new Error(stderr.trim() || 'The restore move failed.'), { code });
  }
  const [source, destination] = await Promise.all([
    lstat(from).then(() => true, () => false),
    lstat(to).then(() => true, () => false)
  ]);
  if (!source && destination) return;
  if (source && destination) {
    throw Object.assign(new Error('An item already exists at the original location.'), { code: 'EEXIST' });
  }
  throw new Error('The restore move did not complete.');
}

/**
 * Emptying the Trash makes a receipt a promise nothing can keep, so each entry is checked before
 * the list is handed over. ~/.Trash still cannot be listed without Full Disk Access, but a path
 * inside it can be stat'd — which is the same door the restore itself goes through.
 */
async function withAvailability(removal: Removal): Promise<Removal> {
  const entries = await Promise.all(removal.entries.map(async entry => {
    if (entry.restoredAt) return { ...entry, available: false };
    if (!entry.trashPath) return { ...entry, available: false };
    try { await stat(entry.trashPath); return { ...entry, available: true }; }
    catch { return { ...entry, available: false }; }
  }));
  return { ...removal, entries };
}

/**
 * Receipts written before the source was recorded. An app bundle means the Applications page;
 * the File Manager labels a single file with its own name, or a batch as "Duplicate files";
 * everything else came from Cleanup, which labels by category.
 */
function guessSource(removal: Removal): RemovalSource {
  if (removal.entries.some(entry => entry.originalPath.endsWith('.app'))) return 'applications';
  if (removal.label === 'Duplicate files' || (removal.entries.length === 1 && removal.label === removal.entries[0].label)) return 'files';
  return 'cleanup';
}

export function registerRemovals(): void {
  ipcMain.handle('removals:list', async () => {
    const all = await load();
    // Filtered per page in the renderer, so the cap is the whole store rather than twenty: one
    // busy page must not push another page's removals off its list.
    const pending = all.filter(entry => entry.restoredAt === null).reverse().map(entry => ({ ...entry, source: entry.source ?? guessSource(entry) }));
    const checked = await Promise.all(pending.map(withAvailability));
    // A removal with nothing left in the Trash is not something the user can act on, so it is
    // dropped rather than listed as a button that could only fail.
    return checked.filter(removal => removal.entries.some(entry => entry.available));
  });

  ipcMain.handle('removals:restore', async (_event, id: unknown) => {
    if (typeof id !== 'string') return { restored: 0, failures: ['Bad request'] };
    return restore(id);
  });
}
