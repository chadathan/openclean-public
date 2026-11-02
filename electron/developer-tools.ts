// What is installed outside /Applications: Homebrew, npm, pip, and the runtimes on the path.
//
// Two things separate this from the application scanner. Sizes here are a package FOOTPRINT —
// what the package itself occupies — not a promise of space returned, because removing a package
// leaves its dependencies installed. And removal goes through each package manager rather than
// through the Trash: a Cellar directory moved to the Trash leaves Homebrew's receipts behind and
// a broken symlink in /opt/homebrew/bin. The cost is that there is no Put Back for these, so
// every removal hands back the exact command that reinstalls it.
import { ipcMain } from 'electron';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HOME, execFileAsync, exists, sizesOf } from './fs-scan';

export type ToolManager = 'brew' | 'brew-cask' | 'npm' | 'pip';

export type DeveloperTool = {
  name: string;
  version: string | null;
  source: string;
  /** Bytes the package itself occupies. Null where it cannot be measured — a linked package, a runtime. */
  bytes: number | null;
  path: string | null;
  /** Null means nothing here can remove it. */
  manager: ToolManager | null;
  /** Installed packages that name this one as a dependency. */
  requiredBy: string[];
  /** Why it cannot be removed, in words the user can act on. */
  protection: string | null;
  note: string | null;
};
export type DeveloperToolGroup = { label: string; detail: string; bytes: number; items: DeveloperTool[] };
export type DeveloperToolsReport = { groups: DeveloperToolGroup[]; scannedAt: number };

export type UninstallRequest = { manager: ToolManager; name: string };
export type UninstallOutcome = { name: string; manager: ToolManager; removed: boolean; message: string; reinstall: string | null };
export type UninstallReport = { outcomes: UninstallOutcome[]; removed: number; bytes: number };

const CELLAR = '/opt/homebrew/Cellar';
const CASKROOM = '/opt/homebrew/Caskroom';
const BREW = '/opt/homebrew/bin/brew';
const PYTHON = '/usr/bin/python3';

async function run(command: string, args: string[], timeout = 20_000): Promise<string | null> {
  try { return (await execFileAsync(command, args, { timeout, maxBuffer: 8 << 20 })).stdout.trim(); }
  catch { return null; }
}

async function npmPath(): Promise<string | null> {
  const root = join(HOME, '.nvm/versions/node');
  try {
    // v8.17.0 sorts after v23.4.0 as text, which is how the newest Node came to be ignored.
    const order = (name: string) => name.replace(/^v/, '').split('.').map(Number);
    const versions = (await readdir(root)).sort((a, b) => {
      const [left, right] = [order(a), order(b)];
      return (right[0] - left[0]) || (right[1] - left[1]) || (right[2] - left[2]);
    });
    for (const version of versions) {
      const candidate = join(root, version, 'bin/npm');
      if (await exists(candidate)) return candidate;
    }
  } catch { /* NVM is optional. */ }
  return (await exists('/opt/homebrew/bin/npm')) ? '/opt/homebrew/bin/npm' : null;
}

/**
 * One `brew info --json=v2 --installed` call carries everything: versions, casks, whether each
 * formula was asked for or pulled in, and the runtime dependencies actually linked at install.
 *
 * `brew deps --installed` was tried first and is wrong for this. It prints what a formula
 * declares, which left openssl@3 with no dependents while `brew uses --installed openssl@3`
 * named seven. The graph below reproduces `brew leaves` exactly — nine formulae, not the
 * twenty-three the declared list implied.
 */
type BrewFormula = {
  name: string;
  installed?: { version?: string; installed_on_request?: boolean; runtime_dependencies?: { full_name?: string }[] }[];
};
type BrewCask = { token: string; installed?: string | null };

async function homebrew(): Promise<{ formulae: DeveloperTool[]; casks: DeveloperTool[] }> {
  const json = await run(BREW, ['info', '--json=v2', '--installed'], 60_000);
  let payload: { formulae?: BrewFormula[]; casks?: BrewCask[] };
  try { payload = JSON.parse(json ?? '{}'); } catch { return { formulae: [], casks: [] }; }
  const installed = payload.formulae ?? [];
  const casked = payload.casks ?? [];

  const needed = new Map<string, string[]>();
  for (const formula of installed) {
    for (const dependency of formula.installed?.[0]?.runtime_dependencies ?? []) {
      const name = dependency.full_name;
      if (name) needed.set(name, [...(needed.get(name) ?? []), formula.name]);
    }
  }

  const sizes = await sizesOf([
    ...installed.map(formula => join(CELLAR, formula.name)),
    ...casked.map(cask => join(CASKROOM, cask.token))
  ]);

  const formulae = installed.map(formula => {
    const path = join(CELLAR, formula.name);
    const requiredBy = needed.get(formula.name) ?? [];
    const onRequest = formula.installed?.[0]?.installed_on_request === true;
    return {
      name: formula.name, version: formula.installed?.[0]?.version ?? null, source: 'Homebrew',
      bytes: sizes.get(path) ?? null, path, manager: 'brew' as const, requiredBy, protection: null,
      note: requiredBy.length ? null
        : onRequest ? 'You asked for this one. Nothing else needs it.'
        : 'Pulled in as a dependency, and nothing needs it any more.'
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const casks = casked.map(cask => {
    const path = join(CASKROOM, cask.token);
    return {
      name: cask.token, version: cask.installed ?? null, source: 'Homebrew',
      bytes: sizes.get(path) ?? null, path, manager: 'brew-cask' as const, requiredBy: [],
      protection: null, note: 'The app bundle it installed is removed with it.'
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { formulae, casks };
}

/** npm's own package and corepack ship with Node; removing them globally breaks the command that would put them back. */
const NPM_PROTECTED = new Set(['npm', 'corepack']);

async function npmPackages(npm: string | null): Promise<DeveloperTool[]> {
  if (!npm) return [];
  const root = await run(npm, ['root', '-g']);
  const json = await run(npm, ['--global', 'ls', '--depth=0', '--json'], 60_000);
  if (!root) return [];
  let names: string[] = [];
  let versions = new Map<string, string | null>();
  try {
    const dependencies = JSON.parse(json ?? '{}').dependencies ?? {};
    for (const [name, item] of Object.entries<any>(dependencies)) {
      names.push(name);
      versions.set(name, item?.version ?? null);
    }
  } catch { /* An unavailable npm installation is simply omitted. */ }
  // du follows the argument itself but not what a symlink points at, so a linked package would
  // report zero. Reporting "linked" is the truth; reporting 0 B is not.
  const links = new Map<string, string | null>();
  await Promise.all(names.map(async name => {
    try { links.set(name, (await lstat(join(root, name))).isSymbolicLink() ? await readlink(join(root, name)) : null); }
    catch { links.set(name, null); }
  }));
  const sizes = await sizesOf(names.filter(name => !links.get(name)).map(name => join(root, name)));
  return names.map(name => {
    const path = join(root, name);
    const link = links.get(name) ?? null;
    return {
      name, version: versions.get(name) ?? null, source: 'npm global',
      bytes: link ? null : sizes.get(path) ?? null, path, manager: 'npm' as const, requiredBy: [],
      protection: NPM_PROTECTED.has(name) ? 'Ships with Node. Removing it globally would take away the command that reinstalls it.' : null,
      note: link ? `Linked from ${link} — removing it unlinks, it does not delete your folder.` : null
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * pip list answers what is installed but not where or how large. One Python process answers all
 * three: RECORD carries a byte count per installed file, METADATA carries the dependencies, and
 * the dist-info location says whether removing it would need root.
 */
const PYTHON_PROBE = `
import csv, email.parser, glob, json, os, site, sys
seen, out = set(), []
roots = []
try: roots.append(site.getusersitepackages())
except Exception: pass
roots += list(site.getsitepackages() or [])
for root in roots:
    for dist in sorted(glob.glob(os.path.join(root, "*.dist-info")) + glob.glob(os.path.join(root, "*.egg-info"))):
        meta = os.path.join(dist, "METADATA") if os.path.exists(os.path.join(dist, "METADATA")) else os.path.join(dist, "PKG-INFO")
        if not os.path.exists(meta): continue
        with open(meta, errors="replace") as handle:
            headers = email.parser.Parser().parse(handle, headersonly=True)
        name = headers.get("Name")
        if not name or name.lower() in seen: continue
        seen.add(name.lower())
        size = 0
        record = os.path.join(dist, "RECORD")
        if os.path.exists(record):
            with open(record, newline="", errors="replace") as handle:
                for row in csv.reader(handle):
                    if len(row) >= 3 and row[2].isdigit(): size += int(row[2])
        out.append({
            "name": name, "version": headers.get("Version"), "root": root, "bytes": size or None,
            "requires": [r.split(";")[0].strip() for r in (headers.get_all("Requires-Dist") or [])],
            "writable": os.access(root, os.W_OK),
        })
json.dump(out, sys.stdout)
`;

function normalise(requirement: string): string {
  return requirement.split(/[\s(<>=!~\[]/)[0].trim().toLowerCase().replace(/[-_.]+/g, '-');
}

async function pythonPackages(): Promise<DeveloperTool[]> {
  const json = await run(PYTHON, ['-c', PYTHON_PROBE], 60_000);
  let found: any[] = [];
  try { found = JSON.parse(json ?? '[]'); } catch { return []; }
  const needed = new Map<string, string[]>();
  for (const item of found) {
    for (const requirement of item.requires ?? []) {
      const key = normalise(requirement);
      // A package may declare the same dependency several times under different extras.
      if (key) needed.set(key, [...new Set([...(needed.get(key) ?? []), item.name])]);
    }
  }
  return found.map(item => ({
    name: item.name, version: item.version ?? null, source: 'pip',
    bytes: item.bytes ?? null, path: item.root, manager: 'pip' as const,
    requiredBy: needed.get(normalise(item.name)) ?? [],
    protection: item.writable ? null : `Installed in ${item.root}, which this user cannot write to. Removing it would need sudo.`,
    note: null
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function runtime(name: string, output: string | null, source: string): DeveloperTool[] {
  if (!output) return [];
  // `\w+` ate the major digit out of "v23.4.0" and left ".4.0" on screen.
  const version = output.match(/\d+(\.\d+)+\w*/)?.[0] ?? output;
  return [{
    name, version, source, bytes: null, path: null, manager: null,
    requiredBy: [], protection: 'A language runtime is shared by everything installed for it. Removing one here would take the packages above with it.',
    note: null
  }];
}

/** Keyed manager|name, rebuilt on every scan. An uninstall request that is not in it is refused. */
const known = new Map<string, DeveloperTool>();
const key = (manager: string, name: string) => `${manager}|${name}`;

async function scanDeveloperTools(): Promise<DeveloperToolsReport> {
  const brew = await exists(BREW);
  const npm = await npmPath();
  const [{ formulae: brewFormulae, casks: brewCasks }, npmGlobal, pip, npmVersion, pythonVersion, rubyVersion] = await Promise.all([
    brew ? homebrew() : Promise.resolve({ formulae: [], casks: [] }),
    npmPackages(npm),
    pythonPackages(),
    npm ? run(join(dirname(npm), 'node'), ['--version']) : null,
    run(PYTHON, ['--version']),
    run('/usr/bin/ruby', ['--version'])
  ]);

  const groups: DeveloperToolGroup[] = [
    { label: 'Homebrew Formulae', detail: 'Command-line tools and libraries installed by Homebrew. A formula that other formulae need cannot be removed on its own — Homebrew will say so.', items: brewFormulae, bytes: 0 },
    { label: 'Homebrew Casks', detail: 'Packages installed by Homebrew that also carry an app bundle.', items: brewCasks, bytes: 0 },
    { label: 'Global npm packages', detail: 'Tools installed globally for Node.js.', items: npmGlobal, bytes: 0 },
    { label: 'Python packages', detail: 'Packages installed for the system Python. Sizes come from each package’s own install record.', items: pip, bytes: 0 },
    { label: 'Runtimes', detail: 'Language runtimes available on this Mac. None of these can be removed here.', items: [
      ...runtime('Python', pythonVersion, 'system'), ...runtime('Node.js', npmVersion, 'NVM'), ...runtime('Ruby', rubyVersion, 'system')
    ], bytes: 0 }
  ].filter(group => group.items.length > 0)
   .map(group => ({ ...group, bytes: group.items.reduce((total, item) => total + (item.bytes ?? 0), 0) }));

  known.clear();
  for (const group of groups) {
    for (const item of group.items) if (item.manager) known.set(key(item.manager, item.name), item);
  }
  return { groups, scannedAt: Date.now() };
}

function reinstallCommand(tool: DeveloperTool): string | null {
  const version = tool.version ?? null;
  switch (tool.manager) {
    case 'brew': return `brew install ${tool.name}`;
    case 'brew-cask': return `brew install --cask ${tool.name}`;
    case 'npm': return `npm install -g ${tool.name}${version ? `@${version}` : ''}`;
    case 'pip': return `python3 -m pip install ${tool.name}${version ? `==${version}` : ''}`;
    default: return null;
  }
}

async function uninstallOne(tool: DeveloperTool, npm: string | null): Promise<UninstallOutcome> {
  const base = { name: tool.name, manager: tool.manager as ToolManager, reinstall: reinstallCommand(tool) };
  const plan: Record<ToolManager, [string | null, string[]]> = {
    'brew': [BREW, ['uninstall', '--formula', tool.name]],
    'brew-cask': [BREW, ['uninstall', '--cask', tool.name]],
    'npm': [npm, ['uninstall', '--global', tool.name]],
    'pip': [PYTHON, ['-m', 'pip', 'uninstall', '-y', tool.name]]
  };
  const [command, args] = plan[tool.manager as ToolManager];
  if (!command) return { ...base, removed: false, message: 'Its package manager is not on this Mac any more.' };
  try {
    await execFileAsync(command, args, { timeout: 300_000, maxBuffer: 8 << 20 });
    return { ...base, removed: true, message: 'Removed.' };
  } catch (error) {
    // The package manager's own refusal is the most useful thing to show — Homebrew names the
    // formulae that still need this one, pip names the permission it lacked.
    const detail = (error as { stderr?: string; message?: string });
    const text = (detail.stderr || detail.message || '').split('\n').map(line => line.trim()).filter(Boolean);
    return { ...base, removed: false, message: text.slice(0, 3).join(' ') || 'The package manager refused.' };
  }
}

/**
 * Sequential on purpose. Homebrew takes a lock, and two uninstalls racing for it is a failure
 * report the user would have to untangle rather than a faster removal.
 */
async function uninstall(requests: unknown): Promise<UninstallReport> {
  if (!Array.isArray(requests)) return { outcomes: [], removed: 0, bytes: 0 };
  const npm = await npmPath();
  const outcomes: UninstallOutcome[] = [];
  let bytes = 0;
  for (const request of requests as UninstallRequest[]) {
    const tool = request && typeof request.name === 'string' && typeof request.manager === 'string'
      ? known.get(key(request.manager, request.name)) : undefined;
    if (!tool) {
      outcomes.push({ name: String(request?.name ?? '?'), manager: request?.manager, removed: false, reinstall: null, message: 'Not in the last scan. Scan again and retry.' });
      continue;
    }
    if (tool.protection) {
      outcomes.push({ name: tool.name, manager: tool.manager as ToolManager, removed: false, reinstall: null, message: tool.protection });
      continue;
    }
    const outcome = await uninstallOne(tool, npm);
    if (outcome.removed) {
      bytes += tool.bytes ?? 0;
      known.delete(key(tool.manager as ToolManager, tool.name));
    }
    outcomes.push(outcome);
  }
  return { outcomes, removed: outcomes.filter(outcome => outcome.removed).length, bytes };
}

export function registerDeveloperTools(): void {
  ipcMain.handle('developer-tools:scan', () => scanDeveloperTools());
  ipcMain.handle('developer-tools:uninstall', (_event, requests) => uninstall(requests));
}
