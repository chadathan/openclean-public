// Applications: which folders an uninstall attributes to an app.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./harness.cjs');

const { candidatesFor, safeComponent } = h.load('app-inventory.js');
const bundle = '/Applications/Example.app';
const library = h.at('Library');
const inside = candidate => candidate.path === bundle || candidate.path.startsWith(library + path.sep);

test('finds the usual folders by bundle identifier and app name', () => {
  const paths = candidatesFor(bundle, 'com.example.app', ['Example']).map(candidate => candidate.path);
  for (const expected of [
    bundle,
    path.join(library, 'Containers/com.example.app'),
    path.join(library, 'Application Support/com.example.app'),
    path.join(library, 'Application Support/Example'),
    path.join(library, 'Caches/Example'),
    path.join(library, 'Preferences/com.example.app.plist')
  ]) assert.ok(paths.includes(expected), `missing ${expected}`);
});

test('a name from the app\'s Info.plist cannot point outside ~/Library', () => {
  const hostile = ['../../Documents/Projects', '..', '.', '...', 'a/b', '../../../..', ''];
  for (const name of hostile) assert.equal(safeComponent(name), false, JSON.stringify(name));
  const candidates = candidatesFor(bundle, 'com.example.app', ['Example', ...hostile]);
  assert.ok(candidates.every(inside), candidates.filter(candidate => !inside(candidate)).map(candidate => candidate.path).join('\n'));
  assert.ok(candidates.every(candidate => !candidate.path.includes('..')));
});

test('a malformed bundle identifier only matches folders named after the app', () => {
  for (const id of ['../../Documents', '/Applications/Example.app', 'noperiods', 'com.example/../..']) {
    const candidates = candidatesFor(bundle, id, ['Example']);
    assert.ok(candidates.every(inside), `${id}: ${candidates.map(candidate => candidate.path).join(', ')}`);
    const fromName = candidate => candidate.path === bundle || path.basename(candidate.path) === 'Example';
    assert.ok(candidates.every(fromName), `${id}: ${candidates.filter(candidate => !fromName(candidate)).map(candidate => candidate.path).join(', ')}`);
  }
});

test('names with spaces and non-English characters still match', () => {
  assert.equal(safeComponent('Visual Studio Code'), true);
  assert.equal(safeComponent('แอปตัวอย่าง'), true);
  assert.equal(safeComponent('com.example.app'), true);
});
