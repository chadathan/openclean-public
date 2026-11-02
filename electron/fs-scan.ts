// Filesystem primitives shared by the Applications and Cleanup scanners.
//
// Both walk the same disk, size the same way, and remove through the same guarded path. Keeping
// one copy means the removal allow-list cannot drift between the two pages — one of them growing
// a hole the other does not have is exactly the bug worth designing out.
import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { nativeHelper } from './system-metrics';
import { RemovalEntry, RemovalSource, moveAsAdmin, record } from './removals';
import { moveToTrash } from './trash';

export const execFileAsync = promisify(execFile);
export const HOME = homedir();

/** Home-relative, the way the user would write it themselves. */
export function tilde(path: string): string {
  return path === HOME || path.startsWith(HOME + sep) ? `~${path.slice(HOME.length)}` : path;
}

/** A tilde arriving back from the renderer has to become a real path again before anything acts on it. */
export function expand(path: string): string {
  return path.startsWith('~/') ? join(HOME, path.slice(2)) : path;
}

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** True when the current user could actually remove it; root-owned trees need an authorisation prompt. */
export async function writable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.uid === process.getuid?.();
  } catch {
    return false;
  }
}

/**
 * One fork for a whole batch rather than one per folder. du prints a line per argument, so the
 * sizes come back matched to the paths that produced them; a path it could not read is simply
 * absent from the map rather than reported as zero.
 */
export async function sizesOf(paths: string[], crossMounts = false): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!paths.length) return sizes;
  const collect = (stdout: string) => {
    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\d+)\t(.+)$/);
      if (match) sizes.set(match[2], Number(match[1]) * 1024);
    }
  };
  try {
    // -x normally keeps a walk from wandering into a mounted image while sizing an app. It has
    // to come off when the mount IS the thing being sized: the iOS simulator runtime lives on
    // its own sealed APFS volume, and with -x du reported 0 for sixteen gigabytes.
    const flags = crossMounts ? ['-sk'] : ['-sk', '-x'];
    const { stdout } = await execFileAsync('/usr/bin/du', [...flags, ...paths], { timeout: 120_000, maxBuffer: 8 << 20 });
    collect(stdout);
  } catch (error) {
    // du exits non-zero when any one path is unreadable, but still prints the ones that worked.
    collect((error as { stdout?: string }).stdout ?? '');
  }
  return sizes;
}

/** NSWorkspace artwork, one helper run for the batch. Electron's own getFileIcon returns blanks here. */
export async function icons(paths: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!paths.length) return found;
  try {
    const { stdout } = await execFileAsync(nativeHelper('openclean-app-icon'), paths, { timeout: 20_000, maxBuffer: 48 << 20 });
    const lines = stdout.split('\n');
    paths.forEach((path, index) => {
      const line = lines[index]?.trim();
      if (line) found.set(path, `data:image/png;base64,${line}`);
    });
  } catch { /* Without artwork the list falls back to a lettered tile. */ }
  return found;
}

/** Where a removal is allowed to reach. Anything outside is refused, whatever the renderer asks. */
const REMOVABLE_ROOTS = [
  '/Applications',
  '/Library/Caches',
  '/Library/Logs',
  join(HOME, 'Applications'),
  join(HOME, 'Library'),
  join(HOME, 'Downloads'),
  join(HOME, 'Desktop'),
  join(HOME, 'Documents')
];

/**
 * Something inside an allowed root, never the root itself: ~/Documents may hold a file the user
 * picked, but ~/Documents as a whole, or all of ~/Library, is never a cleanup target.
 */
export function removable(path: string): boolean {
  const target = resolve(expand(path));
  return REMOVABLE_ROOTS.some(root => target.startsWith(root + sep));
}

/**
 * removable() reads the path as written. A symlinked folder on the way — ~/Documents/notes
 * pointing at ~/.ssh — would let a path that looks allowed reach somewhere that is not, so the
 * real location of the parent folder has to pass the same check before anything moves.
 */
async function removableOnDisk(target: string): Promise<boolean> {
  if (!removable(target)) return false;
  try { return removable(join(await realpath(dirname(target)), basename(target))); }
  catch { return false; }
}

/**
 * NSFileManager can reject a root-owned app bundle even when this admin user can rename entries
 * in /Applications. In that one case, move the bundle into the user's Trash with a no-clobber
 * rename, preserving the app's own reversible receipt. Never use this for arbitrary paths or
 * cross-volume moves; the normal OS Trash operation remains the first choice.
 */
async function trashAdminOwnedApp(target: string): Promise<string> {
  if (dirname(target) !== '/Applications' || !basename(target).endsWith('.app')) {
    // ~/Library/Containers and Group Containers belong to sandboxed apps, and macOS guards them
    // with privacy protection rather than file ownership — no password gets past that, only access.
    if (/\/Library\/(Group )?Containers\//.test(target)) {
      throw new Error('macOS protects this app\'s sandbox data. Give OpenClean Full Disk Access in System Settings › Privacy & Security, then try again.');
    }
    throw new Error('This item needs administrator permission to move to the Trash.');
  }
  const trash = join(HOME, '.Trash');
  const [sourceInfo, trashInfo] = await Promise.all([stat(target), stat(trash)]);
  if (sourceInfo.dev !== trashInfo.dev) throw new Error('This app is on another volume and cannot be moved to your Trash without administrator permission.');

  const name = basename(target);
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let suffix = 1; suffix <= 100; suffix++) {
    const candidate = join(trash, suffix === 1 ? name : `${stem} ${suffix}${extension}`);
    try { await lstat(candidate); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

    try {
      await execFileAsync('/bin/mv', ['-n', target, candidate], { timeout: 30_000 });
    } catch (error) {
      if (!/permission denied|not permitted/i.test((error as { stderr?: string }).stderr ?? (error as Error).message)) throw error;
      await moveAsAdmin(target, candidate);
    }
    if (!(await exists(target)) && await exists(candidate)) return candidate;
  }
  throw new Error('Could not find an unused name in the Trash.');
}

/**
 * Trash, never unlink. Paths outside the allow-list are refused and named in the result rather
 * than skipped quietly.
 *
 * Finder cannot put these back, and nothing here can make it. Its Put Back reads an origin that
 * Finder records when Finder does the trashing; shell.trashItem goes through NSFileManager and
 * writes none. Setting com.apple.trash.putback by hand was tried and abandoned: on an app bundle
 * already in the Trash it fails outright with EPERM, and where it does write, Finder still does
 * not offer the command. A courtesy that fails on the case that matters is worse than none.
 *
 * So the undo is this app's own. Where each piece landed is recorded in a receipt at the moment
 * it moved, because ~/.Trash cannot be listed without Full Disk Access — but a file inside it
 * can be reached by exact path and moved back out, which was measured rather than assumed.
 */
export async function trashPaths(paths: unknown, label = 'Removal', source?: RemovalSource): Promise<{ trashed: number; bytes: number; failures: string[]; removalId: string | null; trashedPaths: string[] }> {
  if (!Array.isArray(paths)) return { trashed: 0, bytes: 0, failures: ['Bad request'], removalId: null, trashedPaths: [] };
  const failures: string[] = [];
  const entries: RemovalEntry[] = [];
  const trashedPaths: string[] = [];
  let trashed = 0;
  let bytes = 0;
  for (const entry of paths) {
    if (typeof entry !== 'string' || !removable(entry)) { failures.push(`Refused: ${entry}`); continue; }
    const target = resolve(expand(entry));
    if (!(await removableOnDisk(target))) { failures.push(`Refused: ${entry}`); continue; }
    let landedPath: string | null = null;
    try {
      const sizes = await sizesOf([target]);
      const size = sizes.get(target) ?? 0;
      try {
        landedPath = await moveToTrash(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = error instanceof Error ? error.message : String(error);
        if (code !== 'EPERM' && code !== 'EACCES' && !/permission|not permitted|access denied/i.test(message)) throw error;
        landedPath = await trashAdminOwnedApp(target);
      }
      trashed++;
      bytes += size;
      trashedPaths.push(target);
      entries.push({ originalPath: target, trashPath: landedPath, label: basename(target), bytes: size });
    } catch (error) {
      failures.push(`${basename(entry)}: ${(error as Error).message}`);
    }
  }
  const removal = entries.length ? await record(label, entries, source) : null;
  return { trashed, bytes, failures, removalId: removal?.id ?? null, trashedPaths };
}
