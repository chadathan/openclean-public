// Test harness for the Electron main-process file operations.
//
// Every test runs against a throwaway home folder. HOME is pointed at it before any module
// loads, so the removal allow-list, ~/.Trash and the scan roots all resolve inside it. Electron
// is replaced with a fake, and so is the native trash call: nothing here may move a real file
// or put anything in the user's real Trash.
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// realpath: macOS's temp folder sits behind the /var -> /private/var symlink, and the removal
// guard compares real paths.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'openclean-test-'));
const home = path.join(root, 'home');
const trash = path.join(home, '.Trash');
for (const dir of ['.Trash', 'Library/Caches', 'Library/Logs', 'Library/Mail', 'Downloads', 'Documents', 'Desktop', '.ssh']) {
  fs.mkdirSync(path.join(home, dir), { recursive: true });
}
process.env.HOME = home;
if (os.homedir() !== home) throw new Error('HOME override did not take effect; refusing to run against the real home folder.');

const dist = path.join(__dirname, '..', '..', 'dist-electron');
const handlers = new Map();
const sent = [];
const state = { messageBoxResponse: 1, dialogCalls: 0 };

function inject(file, exports) {
  const module = new Module(file);
  module.filename = file;
  module.loaded = true;
  module.exports = exports;
  require.cache[file] = module;
}

inject(require.resolve('electron'), {
  app: { getPath: () => path.join(root, 'userData'), isPackaged: false, focus() {} },
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  dialog: { showMessageBox: async () => { state.dialogCalls++; return { response: state.messageBoxResponse }; } },
  BrowserWindow: { fromWebContents: () => null },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) }) },
  shell: { trashItem: async () => { throw new Error('Tests must not call the real shell.trashItem.'); } },
  safeStorage: { isEncryptionAvailable: () => false }
});

// Mirrors what macOS does, as measured with NSFileManager on macOS 26: the first item keeps its
// name; a collision gets a timestamp, appended after the full name for a plain file
// ("report.txt 22-29-45-142.txt") and before the extension for a bundle ("OBS 22-29-45-162.app").
let collisions = 0;
async function moveToTrash(target) {
  if (!target.startsWith(home + path.sep)) throw new Error(`Fake trash refused a path outside the test home: ${target}`);
  const name = path.basename(target);
  let destination = path.join(trash, name);
  if (fs.existsSync(destination)) {
    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    const stamp = `22-29-45-${String(100 + ++collisions).padStart(3, '0')}`;
    destination = path.join(trash, extension && !/\.(app|bundle|pkg)$/.test(name) ? `${name} ${stamp}${extension}` : `${stem} ${stamp}${extension}`);
  }
  fs.renameSync(target, destination);
  return destination;
}
inject(path.join(dist, 'trash.js'), { moveToTrash });

/** Writes a file (and its folders) inside the test home. */
function write(relative, content = 'x', { mtime } = {}) {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

const load = name => require(path.join(dist, name));
const at = relative => path.join(home, relative);
const read = file => fs.readFileSync(file, 'utf8');
const exists = file => { try { fs.lstatSync(file); return true; } catch { return false; } };
const invoke = (channel, ...args) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No IPC handler for ${channel}`);
  return handler({ sender: { id: 1, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) }, senderFrame: { url: 'file:///dist/openclean/browser/index.html' } }, ...args);
};

process.on('exit', () => {
  // Restore permissions changed by tests so the folder can be removed.
  try { fs.chmodSync(path.join(home, 'Library/Mail'), 0o755); fs.chmodSync(path.join(home, 'Library/Caches'), 0o755); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

module.exports = { root, home, trash, handlers, sent, state, write, load, at, read, exists, invoke };
