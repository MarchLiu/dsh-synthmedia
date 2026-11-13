/**
 * Local toolchain detection: ffmpeg / imagemagick (magick or convert) /
 * gimp / blender. Every probe is which + a version flag with FIXED arguments
 * and a 3s timeout; nothing user-supplied ever reaches a shell (execFile with
 * an argv array only). Any failure — missing binary, non-zero exit, timeout —
 * degrades to installed:false (version 'unknownData' when a probe produced
 * nothing readable), never a thrown error.
 *
 * NOTE: ffmpeg's canonical version flag is `-version` (single dash); it
 * rejects `--version`. blender / gimp / magick use `--version`.
 * installHint strings are one-liners per platform, DISPLAYED only — never
 * executed.
 * @module
 */
import { execFile } from 'node:child_process';
import { TOOL_NAMES } from './priority.js';
const VERSION_TIMEOUT_MS = 3000;
function defaultProbes() {
    const run = (cmd, args) => new Promise((res) => {
        try {
            execFile(cmd, [...args], { timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
                if (err)
                    return res(undefined);
                const text = String(stdout).trim();
                res(text === '' ? undefined : text);
            });
        }
        catch {
            res(undefined);
        }
    });
    return {
        async which(name) {
            const out = await run('/usr/bin/env', ['which', name]);
            return out && out !== '' ? out : undefined;
        },
        version: run,
        platform: () => process.platform,
    };
}
function installHintFor(tool, platform) {
    const pkg = tool === 'imagemagick' ? 'imagemagick' : tool;
    if (platform === 'darwin')
        return `brew install ${pkg}`;
    if (platform === 'linux')
        return `sudo apt-get install ${pkg}`;
    if (platform === 'win32')
        return `winget install ${pkg === 'gimp' ? 'GIMP.GIMP' : pkg === 'blender' ? 'BlenderFoundation.Blender' : pkg}`;
    return `手动安装 ${pkg}（未知平台 ${platform}）`;
}
/** First line of a probe answer = the human-readable version banner. */
function firstLine(text) {
    if (!text)
        return undefined;
    const line = text.split('\n')[0]?.trim();
    return line === '' ? undefined : line;
}
/**
 * Detect the four tools. `enabled` is the parsed `enabledTools` list — a
 * tool not in it is reported enabled:false and is NOT probed (zero side
 * effects for tools the operator did not opt into). Pass `enabled` as the
 * full TOOL_NAMES list to probe everything regardless of config.
 */
export async function detectToolchain(enabled, probes = defaultProbes()) {
    const enabledSet = new Set(enabled);
    const platform = probes.platform?.() ?? process.platform;
    const out = [];
    for (const name of TOOL_NAMES) {
        const isEnabled = enabledSet.has(name);
        const hint = installHintFor(name, platform);
        if (!isEnabled) {
            out.push({ name, enabled: false, installed: false, installHint: hint });
            continue;
        }
        const args = name === 'ffmpeg' ? ['-version'] : ['--version'];
        // ImageMagick: probe the modern `magick` binary first; very old installs
        // ship only the legacy `convert` — fall back to it for both presence and
        // version when `magick` is absent or its version probe fails.
        let probed = name === 'imagemagick' ? 'magick' : name;
        let resolvedPath = await probes.which(probed);
        let version = resolvedPath
            ? firstLine(await probes.version(probed, args))
            : undefined;
        if (name === 'imagemagick' && version === undefined) {
            const legacyPath = await probes.which('convert');
            if (legacyPath) {
                probed = 'convert';
                resolvedPath = legacyPath;
                version = firstLine(await probes.version('convert', ['--version']));
            }
        }
        if (!resolvedPath) {
            out.push({ name, enabled: true, installed: false, installHint: hint });
            continue;
        }
        out.push({
            name,
            enabled: true,
            installed: true,
            path: resolvedPath,
            ...(version !== undefined ? { version } : { unknownData: true }),
            installHint: hint,
        });
    }
    return out;
}
//# sourceMappingURL=toolchain.js.map