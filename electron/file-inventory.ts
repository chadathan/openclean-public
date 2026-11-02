import { ipcMain, shell } from 'electron';
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { exists, expand, HOME, removable } from './fs-scan';

type FileEntry = { name: string; path: string; bytes: number; extension: string; modifiedAt: number; removable: boolean };
type FolderMapEntry = { name: string; path: string; bytes: number; isDirectory: boolean; removable: boolean };

export function registerFileInventory(): void {
  const jobs = new Map<number, { cancelled: boolean }>();
  const inventory = new DatabaseSync(':memory:');
  inventory.exec('CREATE TABLE files (name TEXT NOT NULL, path TEXT PRIMARY KEY, bytes INTEGER NOT NULL, extension TEXT NOT NULL, modifiedAt REAL NOT NULL, removable INTEGER NOT NULL)');
  inventory.exec('CREATE INDEX files_rank ON files(bytes DESC, path ASC)');
  inventory.exec('CREATE INDEX files_size ON files(bytes)');
  const insertFiles = inventory.prepare('INSERT OR REPLACE INTO files (name,path,bytes,extension,modifiedAt,removable) VALUES (?,?,?,?,?,?)');
  let currentRoot = '';
  const fileKinds: Record<string, string[]> = {
    video: ['mp4','mov','mkv','avi','webm','m4v'], audio: ['mp3','wav','flac','aac','m4a','aiff','ogg'],
    image: ['jpg','jpeg','png','gif','heic','webp','tiff','raw','svg','psd'],
    archive: ['zip','dmg','iso','tar','gz','7z','rar','pkg'],
    document: ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv','pages','numbers','key']
  };
  const runQuery = inventory.prepare(`SELECT name,path,bytes,extension,modifiedAt,removable FROM files
    WHERE bytes >= ? AND (? = '' OR instr(lower(path), lower(?)) > 0)
      AND (? = 'all' OR (? = 'other' AND extension NOT IN (${Object.values(fileKinds).flat().map(() => '?').join(',')})) OR extension IN (SELECT value FROM json_each(?)))
    ORDER BY bytes DESC, path ASC LIMIT ? OFFSET ?`);
  const stats = inventory.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes, (SELECT name FROM files ORDER BY bytes DESC,path ASC LIMIT 1) AS largestName, (SELECT bytes FROM files ORDER BY bytes DESC,path ASC LIMIT 1) AS largestBytes FROM files');
  const matches = inventory.prepare(`SELECT count(*) AS count FROM files WHERE bytes >= ? AND (? = '' OR instr(lower(path), lower(?)) > 0)
      AND (? = 'all' OR (? = 'other' AND extension NOT IN (${Object.values(fileKinds).flat().map(() => '?').join(',')})) OR extension IN (SELECT value FROM json_each(?)))`);
  ipcMain.handle('files:page', (_event, request: { page?: unknown; pageSize?: unknown; query?: unknown; kind?: unknown; minimum?: unknown }) => {
    const page = Number.isSafeInteger(request?.page) ? Math.max(0, Number(request.page)) : 0;
    const pageSize = Number.isSafeInteger(request?.pageSize) ? Math.min(200, Math.max(1, Number(request.pageSize))) : 100;
    const query = typeof request?.query === 'string' ? request.query.trim().slice(0, 300) : '';
    const kind = typeof request?.kind === 'string' && (request.kind === 'all' || request.kind === 'other' || fileKinds[request.kind]) ? request.kind : 'all';
    const minimum = Number.isSafeInteger(request?.minimum) && Number(request.minimum) >= 0 ? Number(request.minimum) : 0;
    const extensions = JSON.stringify(fileKinds[kind] ?? []);
    const args = [minimum, query, query, kind, kind, ...Object.values(fileKinds).flat(), extensions];
    const totals = stats.get() as { count: number; bytes: number; largestName: string | null; largestBytes: number | null };
    const count = (matches.get(...args) as { count: number }).count;
    const entries = runQuery.all(...args, pageSize, page * pageSize) as unknown as FileEntry[];
    return { entries: entries.map(file => ({ ...file, removable: !!file.removable })), count, page, pageSize, totalFiles: totals.count, totalBytes: totals.bytes, largestName: totals.largestName, largestBytes: totals.largestBytes };
  });
  ipcMain.handle('files:remove-from-inventory', (_event, paths: unknown) => {
    if (!Array.isArray(paths) || paths.length > 5000) return { removed: 0 };
    const remove = inventory.prepare('DELETE FROM files WHERE path = ?');
    const txn = inventory.prepare('BEGIN'); txn.run();
    let removed = 0;
    try { for (const path of paths) if (typeof path === 'string') removed += Number(remove.run(path).changes); inventory.exec('COMMIT'); }
    catch (error) { inventory.exec('ROLLBACK'); throw error; }
    return { removed };
  });
  ipcMain.handle('files:folders', (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== 'string' || !currentRoot) return { entries: [], root: currentRoot, truncated: false, error: 'Scan a folder first.' };
    const path = resolve(requestedPath);
    const rel = relative(currentRoot, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { entries: [], root: currentRoot, truncated: false, error: 'Choose a folder inside the current scan.' };
    }
    const prefix = path.endsWith(sep) ? path : path + sep;
    const rows = inventory.prepare(`SELECT name, isDirectory, SUM(bytes) AS bytes,
        MAX(CASE WHEN isDirectory = 0 THEN filePath END) AS filePath,
        MAX(CASE WHEN isDirectory = 0 THEN removable ELSE 0 END) AS removable
      FROM (
        SELECT CASE WHEN slash = 0 THEN relative ELSE substr(relative,1,slash-1) END AS name,
          CASE WHEN slash = 0 THEN 0 ELSE 1 END AS isDirectory,
          bytes, CASE WHEN slash = 0 THEN path END AS filePath, removable
        FROM (
          SELECT path, bytes, removable, substr(path,length(?)+1) AS relative,
            instr(substr(path,length(?)+1), ?) AS slash
          FROM files WHERE substr(path,1,length(?))=?
        )
      )
      GROUP BY name, isDirectory ORDER BY bytes DESC, name ASC LIMIT 101`).all(prefix, prefix, sep, prefix, prefix) as Array<{ name: string; isDirectory: number; bytes: number; filePath: string | null; removable: number }>;
    const entries: FolderMapEntry[] = rows.slice(0, 100).map(row => ({
      name: String(row.name),
      path: row.isDirectory ? join(path, String(row.name)) : String(row.filePath),
      bytes: Number(row.bytes),
      isDirectory: !!row.isDirectory,
      removable: !!row.removable
    }));
    return { entries, root: currentRoot, truncated: rows.length > 100, error: '' };
  });
  ipcMain.handle('files:duplicates', async (event, requestedRoot: unknown) => {
    if (typeof requestedRoot !== 'string' || !isAbsolute(requestedRoot)) return { groups: [], error: 'Invalid duplicate scan request.' };
    const sender = event.sender;
    const root = resolve(requestedRoot);
    const rootInfo = await stat(root).catch(() => null);
    if (!rootInfo?.isDirectory()) return { groups: [], error: 'The scanned folder is no longer available.' };
    const send = (channel: string, payload: object) => { if (!sender.isDestroyed()) sender.send(channel, payload); };
    const bySize = new Map<number, string[]>();
    const repeatedSizes = inventory.prepare('SELECT bytes FROM files WHERE bytes >= 1048576 GROUP BY bytes HAVING count(*) > 1').iterate();
    const pathsForSize = inventory.prepare('SELECT path FROM files WHERE bytes = ?');
    for (const size of repeatedSizes) {
      const bytes = Number(size.bytes); const paths: string[] = [];
      for (const row of pathsForSize.iterate(bytes)) {
        const path = resolve(String(row.path)); const rel = relative(root, path);
        if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) paths.push(path);
      }
      bySize.set(bytes, paths);
    }
    const groups: Array<{ bytes: number; files: Array<{ path: string; name: string; removable: boolean }> }> = [];
    const sizes = [...bySize].filter(([, paths]) => paths.length > 1);
    let completed = 0;
    const total = sizes.reduce((n, [, paths]) => n + paths.length, 0);
    for (const [bytes, paths] of sizes) {
      const hashes = new Map<string, Array<{ path: string; name: string; removable: boolean }>>();
      // Hard links are one file under several names: removing one frees nothing and the data
      // stays reachable through the other, so only the first name of each file is compared.
      const seenFiles = new Set<string>();
      for (const path of paths) {
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.blocks * 512 !== bytes || info.dev !== rootInfo.dev) continue;
          const identity = `${info.dev}:${info.ino}`;
          if (seenFiles.has(identity)) continue;
          seenFiles.add(identity);
          const hash = createHash('sha256');
          await new Promise<void>((ok, fail) => { const stream = createReadStream(path); stream.on('data', chunk => hash.update(chunk)); stream.on('error', fail); stream.on('end', ok); });
          const key = hash.digest('hex');
          const list = hashes.get(key) ?? []; list.push({ path, name: basename(path), removable: removable(path) }); hashes.set(key, list);
        } catch { /* Files can disappear or become unreadable during a scan. */ }
        completed++;
        if (completed % 5 === 0 || completed === total) send('files:duplicates-progress', { completed, total });
      }
      for (const files of hashes.values()) if (files.length > 1) groups.push({ bytes, files });
    }
    return { groups: groups.sort((a, b) => b.bytes - a.bytes), error: '' };
  });
  ipcMain.handle('files:volumes', async () => {
    const volumes: Array<{ name: string; path: string }> = [];
    try {
      const startupDevice = (await stat(await exists('/System/Volumes/Data') ? '/System/Volumes/Data' : '/')).dev;
      const entries = await readdir('/Volumes', { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const path = join('/Volumes', entry.name);
        try {
          const info = await stat(path);
          if (!info.isDirectory() || info.dev === startupDevice) continue;
          volumes.push({ name: entry.name, path });
        } catch { /* The volume may have been ejected while its name was being read. */ }
      }
    } catch { /* No mounted volumes, or the list is not readable. */ }
    return volumes.sort((a, b) => a.name.localeCompare(b.name));
  });
  ipcMain.handle('files:reveal', async (_event, path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return { revealed: false };
    try { if (!(await stat(path)).isFile()) return { revealed: false }; shell.showItemInFolder(path); return { revealed: true }; }
    catch { return { revealed: false }; }
  });
  ipcMain.handle('files:cancel', event => {
    const job = jobs.get(event.sender.id);
    if (job) job.cancelled = true;
    return { cancelled: !!job };
  });
  ipcMain.handle('files:scan', async (event, requestedRoot?: unknown, scanId?: unknown) => {
    const sender = event.sender;
    if (jobs.has(sender.id)) return { started: false, error: 'A file scan is already running.' };
    const job = { cancelled: false };
    jobs.set(sender.id, job);
    const send = (channel: string, payload: object) => { if (!sender.isDestroyed()) sender.send(channel, { ...payload, scanId }); };
    let root = '';
    let rootDevice = 0;
    try {
      root = requestedRoot === '__home__' ? HOME : typeof requestedRoot === 'string' && requestedRoot.trim() ? expand(requestedRoot) : await exists('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';
      const info = await stat(root);
      if (!info.isDirectory()) throw new Error('That location is not a folder.');
      rootDevice = info.dev;
      await access(root, constants.R_OK | constants.X_OK);
    } catch {
      jobs.delete(sender.id);
      return { started: false, error: 'This folder cannot be read. Choose another folder or check its permissions.' };
    }
    let batch: FileEntry[] = [];
    let files = 0;
    let bytes = 0;
    let skipped = 0;
    let directories = 0;
    inventory.exec('DELETE FROM files');
    currentRoot = root;
    const flush = () => {
      if (batch.length) {
        const txn = inventory.prepare('BEGIN'); txn.run();
        try { for (const file of batch) insertFiles.run(file.name, file.path, file.bytes, file.extension, file.modifiedAt, Number(file.removable)); inventory.exec('COMMIT'); }
        catch (error) { inventory.exec('ROLLBACK'); throw error; }
        batch = [];
      }
      send('files:progress', { files, bytes, skipped, directories, root });
    };
    const timer = setInterval(() => { if (!job.cancelled) flush(); }, 300);
    void (async () => {
      // File sizes are allocated bytes (blocks), so sparse files such as Docker.raw count what
      // they occupy on disk, not the size they claim. Links and other mounted filesystems are not traversed.
      const queue = [root];
      let cursor = 0;
      while (cursor < queue.length && !job.cancelled && !sender.isDestroyed()) {
        // Keep only two directories in flight. Large directory reads cannot be aborted by
        // Node's filesystem API, so a wide wave made Stop wait for as many as eight at once.
        const wave = queue.slice(cursor, cursor + 2);
        cursor += wave.length;
        await Promise.all(wave.map(async directory => {
          try {
            const entries = await readdir(directory, { withFileTypes: true });
            directories++;
            for (const entry of entries) {
              if (job.cancelled || sender.isDestroyed()) break;
              if (entry.isSymbolicLink()) continue;
              const path = join(directory, entry.name);
              try {
                const info = await lstat(path);
                if (info.dev !== rootDevice || info.isSymbolicLink()) continue;
                if (info.isDirectory()) queue.push(path);
                else if (info.isFile()) {
                  const onDisk = info.blocks * 512;
                  files++; bytes += onDisk;
                  batch.push({ name: basename(path), path, bytes: onDisk, extension: extname(path).slice(1).toLowerCase(), modifiedAt: info.mtimeMs, removable: removable(path) });
                  if (batch.length >= 1000) flush();
                }
              } catch { skipped++; }
            }
          } catch { skipped++; }
        }));
      }
      flush();
      send('files:done', { files, bytes, skipped, directories, root, cancelled: job.cancelled, scannedAt: Date.now() });
    })().catch(error => { flush(); send('files:failed', { reason: String(error) }); }).finally(() => {
      clearInterval(timer);
      jobs.delete(sender.id);
    });
    return { started: true, root };
  });
}
