// Moving items to the Trash and putting them back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness.cjs');

const { trashPaths } = h.load('fs-scan.js');
const removals = h.load('removals.js');
removals.registerRemovals();

async function removeOne(relative, content, label = 'Test') {
  const file = h.write(relative, content);
  const result = await trashPaths([file], label, 'cleanup');
  assert.equal(result.trashed, 1, `expected ${relative} to be trashed: ${result.failures.join('; ')}`);
  return { file, result };
}
const putBack = id => h.invoke('removals:restore', id);
const pending = () => h.invoke('removals:list');

test('moves the selected item to the Trash and puts it back with its contents', async () => {
  const { file, result } = await removeOne('Library/Caches/com.example.app/data.bin', 'cache bytes');
  assert.equal(h.exists(file), false);
  assert.deepEqual(result.trashedPaths, [file]);
  assert.ok(result.bytes >= 'cache bytes'.length, 'the reported size covers the file');

  const back = await putBack(result.removalId);
  assert.deepEqual(back, { restored: 1, failures: [] });
  assert.equal(h.read(file), 'cache bytes');
});

test('a name collision in the Trash restores the item that was actually removed', async () => {
  // Two different files with the same name, removed one after the other.
  const first = await removeOne('Documents/a/report.txt', 'first report');
  const second = await removeOne('Documents/b/report.txt', 'second report');

  const receipt = JSON.parse(fs.readFileSync(path.join(h.root, 'userData/removals.json'), 'utf8'))
    .find(removal => removal.id === second.result.removalId);
  assert.notEqual(receipt.entries[0].trashPath, path.join(h.trash, 'report.txt'),
    'the receipt must not point at the older item that already had this name');

  assert.deepEqual(await putBack(second.result.removalId), { restored: 1, failures: [] });
  assert.equal(h.read(second.file), 'second report');
  assert.equal(h.exists(first.file), false, 'the other removal stays in the Trash');

  assert.deepEqual(await putBack(first.result.removalId), { restored: 1, failures: [] });
  assert.equal(h.read(first.file), 'first report');
});

test('refuses anything outside the allowed folders and leaves it untouched', async () => {
  const secret = h.write('.ssh/id_ed25519', 'key');
  fs.symlinkSync(h.at('.ssh'), h.at('Documents/notes'));
  const requests = [
    secret,
    '/etc/hosts',
    h.at('Library/../.ssh/id_ed25519'),
    h.at('Documents/notes/id_ed25519'),  // a symlinked folder pointing outside
    h.at('Library'),                     // an allowed root itself
    h.at('Documents'),
    h.at('Downloads'),
    '~/Library',
    42
  ];
  const result = await trashPaths(requests, 'Attack');
  assert.equal(result.trashed, 0);
  assert.equal(result.failures.length, requests.length);
  assert.ok(result.failures.every(failure => failure.startsWith('Refused')), result.failures.join('\n'));
  assert.equal(h.read(secret), 'key');
  for (const folder of ['Library', 'Documents', 'Downloads']) assert.ok(h.exists(h.at(folder)));
  assert.equal(result.removalId, null, 'nothing removed means no receipt');

  assert.deepEqual(await trashPaths('not a list'), { trashed: 0, bytes: 0, failures: ['Bad request'], removalId: null, trashedPaths: [] });
});

test('accepts a home-relative path from the renderer', async () => {
  h.write('Downloads/installer.dmg', 'dmg');
  const result = await trashPaths(['~/Downloads/installer.dmg'], 'Old download');
  assert.equal(result.trashed, 1, result.failures.join('; '));
  assert.equal(h.exists(h.at('Downloads/installer.dmg')), false);
});

test('Put back never overwrites a file created at the original path', async () => {
  const { file, result } = await removeOne('Desktop/notes.txt', 'old notes');
  fs.writeFileSync(file, 'new notes the user wrote since');

  const back = await putBack(result.removalId);
  assert.equal(back.restored, 0);
  assert.match(back.failures[0], /already exists at the original location/);
  assert.equal(h.read(file), 'new notes the user wrote since');

  const listed = (await pending()).find(removal => removal.id === result.removalId);
  assert.ok(listed?.entries[0].available, 'the trashed copy is still offered for another attempt');
});

test('Put back does not nest a folder inside one an app re-created', async () => {
  const { result } = await removeOne('Library/Caches/com.example.cache/blob', 'old cache');
  const folder = h.at('Library/Caches/com.example.cache');
  // Moving the file left its folder behind; remove the folder itself the way Cleanup does.
  const folderRemoval = await trashPaths([folder], 'Cache folder', 'cleanup');
  assert.equal(folderRemoval.trashed, 1, folderRemoval.failures.join('; '));
  h.write('Library/Caches/com.example.cache/fresh', 'rebuilt by the app');

  const back = await putBack(folderRemoval.removalId);
  assert.equal(back.restored, 0);
  assert.match(back.failures[0], /already exists/);
  assert.equal(h.exists(path.join(folder, 'com.example.cache')), false, 'no Cache/Cache nesting');
  assert.deepEqual(fs.readdirSync(folder), ['fresh']);
  void result;
});

test('Put back re-creates a parent folder that no longer exists', async () => {
  const { file, result } = await removeOne('Library/Application Support/Gone/settings.json', '{}');
  fs.rmSync(h.at('Library/Application Support/Gone'), { recursive: true });
  assert.deepEqual(await putBack(result.removalId), { restored: 1, failures: [] });
  assert.equal(h.read(file), '{}');
});

test('a partial restore keeps the rest of the receipt for another attempt', async () => {
  const kept = h.write('Library/Logs/app/one.log', 'one');
  const emptied = h.write('Library/Logs/app/two.log', 'two');
  const result = await trashPaths([kept, emptied], 'Logs', 'cleanup');
  assert.equal(result.trashed, 2);

  // The user empties one of them from the Trash before pressing Put back.
  const receipt = JSON.parse(fs.readFileSync(path.join(h.root, 'userData/removals.json'), 'utf8')).find(r => r.id === result.removalId);
  fs.rmSync(receipt.entries.find(entry => entry.originalPath === emptied).trashPath);

  const back = await putBack(result.removalId);
  assert.equal(back.restored, 1);
  assert.deepEqual(back.failures, ['two.log: no longer in the Trash — it may have been emptied']);
  assert.equal(h.read(kept), 'one');

  const again = await putBack(result.removalId);
  assert.equal(again.restored, 0, 'an entry already restored is not moved twice');
  assert.equal(again.failures.length, 1);
});

test('the Put back list drops removals with nothing left in the Trash', async () => {
  const { result } = await removeOne('Downloads/old.zip', 'zip');
  assert.ok((await pending()).some(removal => removal.id === result.removalId));

  const receipt = JSON.parse(fs.readFileSync(path.join(h.root, 'userData/removals.json'), 'utf8')).find(r => r.id === result.removalId);
  fs.rmSync(receipt.entries[0].trashPath);
  assert.equal((await pending()).some(removal => removal.id === result.removalId), false);
});

test('a restored removal leaves the Put back list', async () => {
  const { result } = await removeOne('Downloads/restored.txt', 'r');
  await putBack(result.removalId);
  assert.equal((await pending()).some(removal => removal.id === result.removalId), false);
  assert.deepEqual(await putBack('no-such-id'), { restored: 0, failures: ['That removal is no longer on file'] });
  assert.deepEqual(await putBack(42), { restored: 0, failures: ['Bad request'] });
});
