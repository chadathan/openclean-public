// File Manager: exact duplicate detection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const h = require('./harness.cjs');

h.load('file-inventory.js').registerFileInventory();

async function scanFolder(folder) {
  h.sent.length = 0;
  const started = await h.invoke('files:scan', folder, 'test');
  assert.equal(started.started, true, started.error);
  const deadline = Date.now() + 30_000;
  while (!h.sent.some(message => message.channel === 'files:done')) {
    if (Date.now() > deadline) throw new Error('File scan did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const MB = 1024 * 1024;
const content = (byte, size = 2 * MB) => Buffer.alloc(size, byte);

test('groups byte-for-byte copies and leaves same-size different files apart', async () => {
  const folder = h.at('Documents/dupes');
  const a = h.write('Documents/dupes/photo.jpg', content(1));
  const b = h.write('Documents/dupes/backup/photo copy.jpg', content(1));
  h.write('Documents/dupes/other.jpg', content(2));          // same size, different bytes
  h.write('Documents/dupes/small-a.txt', content(3, 1000));  // identical but under 1 MB
  h.write('Documents/dupes/small-b.txt', content(3, 1000));

  await scanFolder(folder);
  const result = await h.invoke('files:duplicates', folder);
  assert.equal(result.error, '');
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].files.map(file => file.path).sort(), [a, b].sort());
  assert.ok(result.groups[0].files.every(file => file.removable));
});

test('hard links are one file, not duplicates that would free space', async () => {
  const folder = h.at('Documents/links');
  const original = h.write('Documents/links/movie.mov', content(4));
  fs.linkSync(original, h.at('Documents/links/movie-link.mov'));
  const copy = h.write('Documents/links/movie-copy.mov', content(4));

  await scanFolder(folder);
  const result = await h.invoke('files:duplicates', folder);
  assert.equal(result.groups.length, 1);
  const paths = result.groups[0].files.map(file => file.path);
  assert.equal(paths.length, 2, `a hard link must not be counted: ${paths.join(', ')}`);
  assert.ok(paths.includes(copy));
});

test('symbolic links are never reported as duplicates', async () => {
  const folder = h.at('Documents/symlinks');
  const real = h.write('Documents/symlinks/archive.zip', content(5));
  fs.symlinkSync(real, h.at('Documents/symlinks/archive-alias.zip'));

  await scanFolder(folder);
  const result = await h.invoke('files:duplicates', folder);
  assert.equal(result.groups.length, 0);
});

test('rejects a relative or missing folder', async () => {
  assert.equal((await h.invoke('files:duplicates', 'Documents')).error, 'Invalid duplicate scan request.');
  assert.equal((await h.invoke('files:duplicates', h.at('Documents/nope'))).error, 'The scanned folder is no longer available.');
});
