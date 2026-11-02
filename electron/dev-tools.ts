// What developer tools keep, asked of the tools themselves.
//
// Two things on this machine are large, opaque to a filesystem walk, and only honestly
// described by the program that owns them.
//
// Xcode's simulators are a folder per device, so they can be listed — but only simctl knows
// whether a device's runtime is still installed, and a device whose runtime has gone can never
// boot again while its folder stays behind. And a runtime is a sealed image mounted read-only,
// so walking it with du measures its expanded contents: 16.09 GB against the 7.91 GB simctl
// reports for the same runtime.
//
// Docker is the opposite case. Everything it holds lives inside one sparse disk image, so there
// is no file per image to find at all and the daemon is the only source of a breakdown.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileAsync, sizesOf, tilde } from './fs-scan';

export type SimulatorDevice = {
  /** The device folder itself, so it can be removed like any other path. */
  path: string;
  name: string;
  bytes: number;
  runtime: string | null;
  /** True when the runtime it needs is no longer installed: the device cannot boot at all. */
  stranded: boolean;
};

export type SimulatorRuntime = {
  version: string;
  bytes: number;
  mountPath: string | null;
  /** How many installed devices still boot on it. */
  devicesInUse: number;
};

export type DockerUsage = {
  /** Bytes the sparse disk image actually occupies, not the terabyte it claims. */
  onDiskBytes: number;
  rows: Array<{ type: string; size: string; reclaimable: string; total: string; active: string }>;
  /** Freed inside the virtual disk but not yet handed back to macOS. */
  unreturnedBytes: number;
  reachable: boolean;
};

export async function simulatorDevices(root: string): Promise<{ devices: SimulatorDevice[]; liveByRuntime: Map<string, number> }> {
  const folder = join(root, 'Devices');
  const liveByRuntime = new Map<string, number>();
  let ids: string[] = [];
  try { ids = (await readdir(folder)).filter(entry => entry.includes('-')); } catch { return { devices: [], liveByRuntime }; }
  if (!ids.length) return { devices: [], liveByRuntime };

  const live = new Map<string, string>();
  const stranded = new Map<string, string>();
  try {
    const { stdout } = await execFileAsync('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], { timeout: 15_000, maxBuffer: 8 << 20 });
    const listed = JSON.parse(stdout).devices as Record<string, Array<{ udid: string; isAvailable?: boolean }>>;
    for (const [runtime, entries] of Object.entries(listed)) {
      // com.apple.CoreSimulator.SimRuntime.iOS-26-4 is a version, not a phrase: the first dash
      // separates the platform from the version, the rest are decimal points.
      const suffix = runtime.split('SimRuntime.').pop() ?? runtime;
      const version = suffix.replace(/^([A-Za-z]+)-/, '$1 ').replace(/-/g, '.');
      for (const entry of entries) {
        (entry.isAvailable ? live : stranded).set(entry.udid, version);
        if (entry.isAvailable) liveByRuntime.set(version, (liveByRuntime.get(version) ?? 0) + 1);
      }
    }
  } catch { /* Without simctl every device is treated as one that might still work. */ }

  const paths = ids.map(id => join(folder, id));
  const sizes = await sizesOf(paths);
  const devices = await Promise.all(ids.map(async id => {
    const path = join(folder, id);
    let name = id.slice(0, 8);
    try {
      const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :name', join(path, 'device.plist')], { timeout: 2_000 });
      name = stdout.trim() || name;
    } catch { /* No plist; the identifier will have to do. */ }
    const gone = stranded.get(id);
    return { path, name, bytes: sizes.get(path) ?? 0, runtime: gone ?? live.get(id) ?? null, stranded: Boolean(gone) };
  }));
  return { devices: devices.filter(device => device.bytes > 0).sort((a, b) => b.bytes - a.bytes), liveByRuntime };
}

export async function simulatorRuntimes(liveByRuntime: Map<string, number>): Promise<SimulatorRuntime[]> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/xcrun', ['simctl', 'runtime', 'list', '-j'], { timeout: 15_000, maxBuffer: 8 << 20 });
    const listed = JSON.parse(stdout) as Record<string, { version?: string; runtimeIdentifier?: string; sizeBytes?: number; mountPath?: string }>;
    return Object.values(listed).map(runtime => {
      const version = runtime.version ?? runtime.runtimeIdentifier ?? 'Unknown';
      return {
        version,
        bytes: runtime.sizeBytes ?? 0,
        mountPath: runtime.mountPath ?? null,
        devicesInUse: liveByRuntime.get(`iOS ${version}`) ?? 0
      };
    });
  } catch {
    return [];
  }
}

/** docker prints "20.62GB", "47.81MB", "0B" — its own units, not ours. */
function parseDockerSize(value: string): number {
  const match = value.match(/^([\d.]+)\s*([KMGT]?)B$/i);
  if (!match) return 0;
  const scale = { '': 1, K: 1_000, M: 1_000_000, G: 1_000_000_000, T: 1_000_000_000_000 }[match[2].toUpperCase()] ?? 1;
  return Number(match[1]) * scale;
}

export async function dockerUsage(containerRoot: string): Promise<DockerUsage | null> {
  const raw = join(containerRoot, 'Data/vms/0/data/Docker.raw');
  let onDiskBytes = 0;
  try {
    const { stat } = await import('node:fs/promises');
    const info = await stat(raw);
    // The blocks actually allocated, not the size it claims: the file reports a terabyte.
    onDiskBytes = info.blocks * 512;
  } catch {
    return null;
  }

  const rows: DockerUsage['rows'] = [];
  let accounted = 0;
  let reachable = false;
  try {
    const { stdout } = await execFileAsync('/usr/local/bin/docker', ['system', 'df', '--format', '{{json .}}'], { timeout: 8_000 });
    for (const line of stdout.trim().split('\n')) {
      const row = JSON.parse(line) as { Type: string; Size: string; Reclaimable: string; TotalCount: string; Active: string };
      reachable = true;
      accounted += parseDockerSize(row.Size);
      rows.push({ type: row.Type, size: row.Size, reclaimable: row.Reclaimable, total: row.TotalCount, active: row.Active });
    }
  } catch { /* The daemon is not running; only the file size can be reported. */ }

  return { onDiskBytes, rows, unreturnedBytes: reachable ? Math.max(0, onDiskBytes - accounted) : 0, reachable };
}

export { tilde };
