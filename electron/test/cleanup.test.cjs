// Cleanup: the scan's honesty about what it could read, and permanent Trash deletion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness.cjs');

h.load('junk-inventory.js').registerJunkInventory();

const DAY = 86_400_000;
const big = size => Buffer.alloc(size, 1);

async function scan() {
  h.sent.length = 0;
  const started = await h.invoke('cleanup:scan');
  assert.equal(started.started, true);
  const deadline = Date.now() + 110_000;
  while (!h.sent.some(message => message.channel === 'cleanup:scan-done' || message.channel === 'cleanup:scan-failed')) {
    if (Date.now() > deadline) throw new Error('Scan did not finish');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(h.sent.some(message => message.channel === 'cleanup:scan-failed'), false);
  return new Map(h.sent.filter(message => message.channel === 'cleanup:scan-category').map(message => [message.payload.category.key, message.payload.category]));
}

test('Empty Trash refuses anything that is not directly inside the Trash', async () => {
  const outside = h.write('Documents/keep.txt', 'mine');
  const nested = h.write('.Trash/folder/inner.txt', 'inner');
  h.state.dialogCalls = 0;
  const result = await h.invoke('cleanup:empty-trash', [
    outside,
    nested,
    path.join(h.trash, '..', 'Documents', 'keep.txt'),
    h.trash,
    42
  ]);
  assert.deepEqual(result, { deleted: 0, failures: ['No valid Trash items were selected.'], deletedPaths: [] });
  assert.equal(h.state.dialogCalls, 0, 'nothing valid means no confirmation is shown');
  assert.equal(h.read(outside), 'mine');
  assert.equal(h.read(nested), 'inner');
});

test('Empty Trash deletes nothing when the confirmation is cancelled', async () => {
  const item = h.write('.Trash/cancel-me.txt', 'still here');
  h.state.messageBoxResponse = 1;
  const result = await h.invoke('cleanup:empty-trash', [item]);
  assert.equal(result.cancelled, true);
  assert.equal(result.deleted, 0);
  assert.equal(h.read(item), 'still here');
});

test('Empty Trash deletes only the confirmed items and reports free space', async () => {
  const chosen = h.write('.Trash/chosen/deep/file.bin', 'bye');
  const other = h.write('.Trash/other.txt', 'stay');
  h.state.messageBoxResponse = 0;
  const result = await h.invoke('cleanup:empty-trash', [path.join(h.trash, 'chosen'), path.join(h.trash, 'chosen')]);
  h.state.messageBoxResponse = 1;
  assert.equal(result.deleted, 1, 'a duplicate request is deleted once');
  assert.deepEqual(result.deletedPaths, [path.join(h.trash, 'chosen')]);
  assert.deepEqual(result.failures, []);
  assert.equal(h.exists(chosen), false);
  assert.equal(h.read(other), 'stay');
  assert.equal(typeof result.freeBytesBefore, 'number');
  assert.equal(typeof result.freeBytesAfter, 'number');
});

test('the scan offers caches and logs, never ticks your own files, and filters noise', { timeout: 120_000 }, async () => {
  h.write('Library/Caches/com.example.big/blob', big(5 * 1024 * 1024));
  h.write('Library/Caches/com.example.tiny/blob', 'small');
  h.write('Library/Logs/Example/app.log', 'log line\n');
  h.write('Downloads/ancient.iso', big(8192), { mtime: new Date(Date.now() - 45 * DAY) });
  h.write('Downloads/recent.pdf', big(8192));
  h.write('.Trash/thrown-away.txt', 'old');

  const categories = await scan();

  const cache = categories.get('usercache');
  assert.equal(cache.state, 'found');
  assert.deepEqual(cache.items.map(item => item.label), ['com.example.big'], 'items under 4 MB are left out');
  assert.equal(cache.items[0].safe, true);
  assert.equal(cache.items[0].offered, true);
  assert.equal(cache.items[0].path, '~/Library/Caches/com.example.big');

  const logs = categories.get('userlog');
  assert.equal(logs.state, 'found');
  assert.ok(logs.items.some(item => item.label === 'Example' && item.safe));

  const downloads = categories.get('downloads');
  assert.deepEqual(downloads.items.map(item => item.label), ['ancient.iso']);
  assert.equal(downloads.items[0].safe, false, 'the user\'s own files are never selected for them');

  const trash = categories.get('trash');
  assert.equal(trash.state, 'found');
  assert.ok(trash.items.every(item => item.safe === false), 'permanent deletion is never pre-selected');
});

test('a folder the scan cannot read is reported as locked, not as empty', { timeout: 120_000 }, async () => {
  fs.chmodSync(h.at('Library/Mail'), 0o000);
  fs.chmodSync(h.at('Library/Caches'), 0o000);
  try {
    const categories = await scan();
    for (const key of ['mail', 'usercache']) {
      const category = categories.get(key);
      assert.equal(category.state, 'locked', `${key} should be locked`);
      assert.equal(category.items.length, 0);
      assert.match(category.reason, /protected by macOS/);
    }
  } finally {
    fs.chmodSync(h.at('Library/Mail'), 0o755);
    fs.chmodSync(h.at('Library/Caches'), 0o755);
  }
});

test('cancelling a scan stops it before it reports more categories', { timeout: 120_000 }, async () => {
  h.sent.length = 0;
  await h.invoke('cleanup:scan');
  await h.invoke('cleanup:cancel-scan');
  // Let the cancelled run unwind, then confirm it never announced completion.
  await new Promise(resolve => setTimeout(resolve, 3_000));
  assert.equal(h.sent.some(message => message.channel === 'cleanup:scan-done'), false);
});

test('scanning again right after Cancel starts a fresh scan that finishes once', { timeout: 120_000 }, async () => {
  h.sent.length = 0;
  await h.invoke('cleanup:scan');
  await h.invoke('cleanup:cancel-scan');
  const again = await h.invoke('cleanup:scan');
  assert.equal(again.started, true, 'a cancelled scan must not block the next one');
  const deadline = Date.now() + 110_000;
  while (!h.sent.some(message => message.channel === 'cleanup:scan-done')) {
    if (Date.now() > deadline) throw new Error('The new scan did not finish');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(h.sent.filter(message => message.channel === 'cleanup:scan-done').length, 1);
  assert.equal(h.sent.filter(message => message.channel === 'cleanup:scan-begin').length, 1, 'only the new scan reports progress');
});
