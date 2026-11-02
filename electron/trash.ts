// The one place an item is moved to the Trash.
//
// Kept in its own module so the native call can be replaced in tests: nothing in the test suite
// may move a real file into the user's real Trash.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeHelper } from './system-metrics';

const execFileAsync = promisify(execFile);

/** Moves one item to the Trash and returns the exact path macOS gave it there. */
export async function moveToTrash(path: string): Promise<string> {
  const { stdout } = await execFileAsync(nativeHelper('openclean-trash'), [path], { timeout: 60_000 });
  const [status, first, ...rest] = stdout.trim().split('\t');
  if (status === 'ok' && first) return first;
  const message = rest.join('\t') || 'The item could not be moved to the Trash.';
  throw Object.assign(new Error(message), { code: status === 'err' ? first : 'EIO' });
}
