/**
 * System probes behind an injectable seam so unit tests can substitute values
 * without spawning real commands.
 *
 * Real probes (best-effort, each individually guarded):
 *  - os.cpus()/os.totalmem()/os.arch()/os.platform() — process-local;
 *  - fs.statfs on the target directory — free disk space;
 *  - `sysctl -n machdep.cpu.brand_string` (darwin only) — CPU model and the
 *    Apple-Silicon / integrated-GPU signal;
 *  - `which python3|uv|node` + `--version` — runtime presence.
 * Every spawned command uses FIXED arguments (never user input) and a 3s
 * timeout; failure degrades that field to undefined.
 * @module
 */
import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { SystemReport } from './system.js';

function run(cmd: string, args: readonly string[], timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((res) => {
    try {
      execFile(cmd, [...args], { timeout: timeoutMs }, (err, stdout) => {
        if (err) return res(undefined);
        const text = String(stdout).trim();
        res(text === '' ? undefined : text);
      });
    } catch {
      res(undefined);
    }
  });
}

async function probeRuntime(name: string): Promise<string | undefined> {
  const which = await run('/usr/bin/env', ['which', name]);
  if (!which) return undefined;
  const version = await run(name, ['--version']);
  return version ? `${name} ${version.split('\n')[0]}` : name;
}

export type OsProbes = (targetDir: string) => Promise<SystemReport>;

export const osProbes: OsProbes = async (targetDir: string): Promise<SystemReport> => {
  const cpus = os.cpus();
  const cpuModel = await (os.platform() === 'darwin' ? run('sysctl', ['-n', 'machdep.cpu.brand_string']) : Promise.resolve(cpus[0]?.model));
  const appleSilicon = os.platform() === 'darwin' && os.arch() === 'arm64';
  const [freeDisk, python, uv, node] = await Promise.all([
    statfs(targetDir).then((s) => s.bsize * s.bavail).catch(() => undefined),
    probeRuntime('python3'),
    probeRuntime('uv'),
    probeRuntime('node'),
  ]);
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: cpus.length,
    ...(cpuModel ? { cpuModel } : {}),
    ...(typeof os.totalmem() === 'number' && os.totalmem() > 0 ? { totalMemBytes: os.totalmem() } : {}),
    ...(freeDisk !== undefined ? { freeDiskBytes: freeDisk } : {}),
    appleSilicon,
    gpuInfo: appleSilicon ? `Apple Silicon 集成 GPU（${cpuModel ?? 'arm64'}）` : undefined,
    runtimes: { python: python, uv: uv, node: node },
  };
};
