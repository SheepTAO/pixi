import * as ch from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import semver from 'semver';
import { CancellationError, CancellationToken, commands, window, workspace } from 'vscode';
import which from 'which';

import { quoteArgs, safeJsonParse, sanitizeArgsForLogging, untildify } from '../common/execUtils';
import { traceError, traceInfo, traceVerbose } from '../common/logging';
import { DEFAULT_CONDA_CHANNEL } from '../core/projectDiscovery';

let _cachedPixi: string | undefined;

export function clearPixiCache(): void {
    _cachedPixi = undefined;
    searchCache.clear();
    clearHostVirtualPackagesCache();
}

async function findPixi(): Promise<string | undefined> {
    try {
        return await which('pixi');
    } catch {
        // Fall back to standard pixi install path (~/.pixi/bin)
    }

    const home = os.homedir();
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'pixi.exe' : 'pixi';
    const standardPath = path.join(home, '.pixi', 'bin', binaryName);

    if (fs.existsSync(standardPath)) {
        return standardPath;
    }

    return undefined;
}

export async function getPixi(): Promise<string> {
    if (_cachedPixi) {
        return _cachedPixi;
    }

    const config = workspace.getConfiguration('pixi');
    const value = config.get<string>('executablePath');

    if (value) {
        let resolved = untildify(value);
        if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
            const firstFolder = workspace.workspaceFolders[0].uri.fsPath;
            resolved = resolved.replace(/\$\{workspaceFolder\}/g, firstFolder);
            if (!path.isAbsolute(resolved)) {
                resolved = path.resolve(firstFolder, resolved);
            }
        }
        _cachedPixi = resolved;
        return resolved;
    }

    const pixiPath = await findPixi();
    if (!pixiPath) {
        throw new Error(
            'Pixi executable not found. Please install Pixi or set "pixi.executablePath" in your settings.',
        );
    }
    _cachedPixi = pixiPath;
    return pixiPath;
}

export type PixiRunOptions = ch.SpawnOptions & {
    includeStderr?: boolean;
};

/**
 * Resolves whether child_process execution requires shell invocation on Windows (for non-.exe binaries)
 * and applies argument quoting accordingly.
 */
export function resolveSpawnArgs(executable: string, args: string[]): { useShell: boolean; finalArgs: string[] } {
    const isWindows = process.platform === 'win32';
    const useShell = isWindows && !executable.toLowerCase().endsWith('.exe');
    const finalArgs = useShell ? quoteArgs(args) : args;
    return { useShell, finalArgs };
}

export async function runPixi(args: string[], options?: PixiRunOptions, token?: CancellationToken): Promise<string> {
    const pixi = await getPixi();
    const defaultCwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
    const spawnOptions: PixiRunOptions = {
        ...(defaultCwd ? { cwd: defaultCwd } : {}),
        ...options,
    };

    const { useShell, finalArgs } = resolveSpawnArgs(pixi, args);

    return new Promise<string>((resolve, reject) => {
        const proc = ch.spawn(pixi, finalArgs, {
            shell: useShell,
            windowsHide: true,
            ...spawnOptions,
        });

        const cancelDisposable = token?.onCancellationRequested(() => {
            proc.kill();
            reject(new CancellationError());
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data) => {
            stdout += data.toString('utf-8');
        });
        proc.stderr?.on('data', (data) => {
            const d = data.toString('utf-8');
            stderr += d;
            traceVerbose(`[pixi stderr] ${d.trim()}`);
        });
        proc.on('error', reject);
        proc.on('close', (exitCode) => {
            cancelDisposable?.dispose();
            const isSilentTaskRemoveFailure =
                exitCode === 0 && args[0] === 'task' && args[1] === 'remove' && stderr.includes('does not exist');
            if (exitCode !== 0 || isSilentTaskRemoveFailure) {
                const safeCommand = `pixi ${sanitizeArgsForLogging(args).join(' ')}`;
                traceError(`Failed to run "${safeCommand}":\n${stderr}`);
                reject(new Error(`Failed to run "${safeCommand}":\n ${stderr}`));
            } else if (options?.includeStderr) {
                resolve(stdout ? (stderr ? `${stdout}\n${stderr}` : stdout) : stderr);
            } else {
                resolve(stdout);
            }
        });
    });
}

const MINIMUM_PIXI_VERSION = '0.80.0';

export async function validatePixiCli(): Promise<boolean> {
    try {
        const stdout = await runPixi(['--version']);
        const pixiBin = await getPixi();
        const versionMatch = stdout.trim().match(/pixi\s+([0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9\-\.]*)/);
        const parsedVersion = semver.coerce(versionMatch ? versionMatch[1] : stdout.trim());
        if (!parsedVersion) {
            window.showErrorMessage(`Found invalid Pixi binary at "${pixiBin}".`);
            return false;
        }

        if (!semver.gte(parsedVersion, MINIMUM_PIXI_VERSION)) {
            window.showErrorMessage(
                `Pixi version ${parsedVersion.version} is too old. Requires >= ${MINIMUM_PIXI_VERSION}. Run: pixi self-update`,
            );
            return false;
        }
        traceInfo(`Pixi CLI: ${pixiBin} (v${parsedVersion.version})`);
        return true;
    } catch (err) {
        traceError('Pixi validation failed:', err);
        const choice = await window.showErrorMessage(
            'Pixi executable not found. Please install Pixi or set "pixi.executablePath" in settings.',
            'Open Settings',
        );
        if (choice === 'Open Settings') {
            commands.executeCommand('workbench.action.openSettings', 'pixi.executablePath');
        }
        return false;
    }
}

export interface HostVirtualPackages {
    cuda?: string;
    glibc?: string;
    linux?: string;
    osx?: string;
    win?: string;
    archspec?: string;
    raw: string[];
}

let _cachedHostVirtualPackages: HostVirtualPackages | undefined;
let _cachedHostPlatform: string | undefined;

export function clearHostVirtualPackagesCache(): void {
    _cachedHostVirtualPackages = undefined;
    _cachedHostPlatform = undefined;
}

export function setCachedHostPlatform(platform: string): void {
    if (platform) {
        _cachedHostPlatform = platform;
    }
}

export async function getHostVirtualPackages(cwd?: string): Promise<HostVirtualPackages> {
    if (_cachedHostVirtualPackages) {
        return _cachedHostVirtualPackages;
    }

    try {
        const stdout = await runPixi(['info', '--json'], cwd ? { cwd } : undefined);
        const parsed = safeJsonParse<{ virtual_packages?: string[]; platform?: string }>(stdout, {});
        if (parsed?.platform) {
            _cachedHostPlatform = parsed.platform;
        }
        const raw = Array.isArray(parsed?.virtual_packages) ? parsed.virtual_packages : [];
        const result: HostVirtualPackages = { raw };

        for (const vp of raw) {
            const parts = vp.split('=');
            const name = parts[0];
            const version = parts[1];
            if (name === '__cuda') {
                result.cuda = version;
            } else if (name === '__glibc') {
                result.glibc = version;
            } else if (name === '__linux') {
                result.linux = version;
            } else if (name === '__osx') {
                result.osx = version;
            } else if (name === '__win') {
                result.win = version;
            } else if (name === '__archspec') {
                result.archspec = parts[2] || version;
            }
        }

        _cachedHostVirtualPackages = result;
        return result;
    } catch {
        return { raw: [] };
    }
}

export async function getHostDetectedVirtualPackageValue(propId: string, cwd?: string): Promise<string | undefined> {
    const vps = await getHostVirtualPackages(cwd);
    switch (propId.toLowerCase()) {
        case 'cuda':
            return vps.cuda;
        case 'libc':
        case 'glibc':
            return vps.glibc;
        case 'linux':
            return vps.linux;
        case 'macos':
        case 'osx':
            return vps.osx;
        case 'windows':
        case 'win':
            return vps.win;
        case 'archspec':
            return vps.archspec;
        default:
            return undefined;
    }
}

export interface PixiPackageSearchResult {
    name: string;
    latestVersion: string;
    versions: string[];
    platforms: string[];
    channel: string;
    sourceType: 'conda' | 'pypi';
    license?: string;
    summary?: string;
}

export function getHostCondaPlatform(): string {
    if (_cachedHostPlatform) {
        return _cachedHostPlatform;
    }
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'linux') {
        return arch === 'arm64' ? 'linux-aarch64' : 'linux-64';
    }
    if (platform === 'darwin') {
        return arch === 'arm64' ? 'osx-arm64' : 'osx-64';
    }
    if (platform === 'win32') {
        return arch === 'arm64' ? 'win-arm64' : 'win-64';
    }
    return 'linux-64';
}

const MAX_SEARCH_CACHE_SIZE = 100;
const searchCache = new Map<string, PixiPackageSearchResult[]>();

export function clearSearchCache(): void {
    searchCache.clear();
}

export interface CleanCacheOptions {
    target?: 'all' | 'conda' | 'pypi' | 'repodata' | 'exec' | 'build';
}

/**
 * Cleans the global package cache and invalidates in-memory caches.
 */
export async function cleanGlobalCache(
    token?: CancellationToken,
    cwd?: string,
    options?: CleanCacheOptions,
): Promise<string> {
    const args = ['clean', 'cache', '-y'];
    if (options?.target && options.target !== 'all') {
        args.push(`--${options.target}`);
    }
    const output = await runPixi(args, cwd ? { cwd } : undefined, token);
    clearSearchCache();
    return output;
}

export async function searchPixiPackages(
    query: string,
    options?: {
        cwd?: string;
        platform?: string;
        channels?: string[];
        limit?: number;
    },
    token?: CancellationToken,
): Promise<PixiPackageSearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
        return [];
    }

    const platform = options?.platform || getHostCondaPlatform();
    const allChannels = [...new Set((options?.channels || []).filter(Boolean))];

    const channelsKey = allChannels.slice().sort().join(',');
    const cacheKey = `${options?.cwd || ''}:${platform}:${channelsKey}:${cleanQuery}`;
    if (searchCache.has(cacheKey)) {
        const cached = searchCache.get(cacheKey)!;
        const limit = options?.limit ?? 30;
        return cached.slice(0, Math.max(1, limit));
    }

    const args = ['search', cleanQuery, '--json', '-p', platform];
    for (const ch of allChannels) {
        args.push('-c', ch);
    }

    const results: PixiPackageSearchResult[] = [];
    try {
        const stdout = await runPixi(args, { cwd: options?.cwd }, token);
        const rawJson = safeJsonParse(stdout, {});

        // Group packages by name across platforms
        const pkgMap = new Map<
            string,
            {
                name: string;
                versions: Set<string>;
                platforms: Set<string>;
                channels: Set<string>;
                license?: string;
                summary?: string;
            }
        >();

        if (rawJson && typeof rawJson === 'object') {
            for (const [subPlatform, records] of Object.entries(rawJson)) {
                if (Array.isArray(records)) {
                    for (const r of records) {
                        if (!r || !r.name || !r.version) {
                            continue;
                        }
                        let item = pkgMap.get(r.name);
                        if (!item) {
                            item = {
                                name: r.name,
                                versions: new Set<string>(),
                                platforms: new Set<string>(),
                                channels: new Set<string>(),
                                license: r.license || undefined,
                                summary: r.description || r.summary || undefined,
                            };
                            pkgMap.set(r.name, item);
                        }
                        item.versions.add(r.version);
                        item.platforms.add(subPlatform);
                        if (r.channel) {
                            const chan = r.channel.replace(/^https?:\/\/conda\.anaconda\.org\//, '').replace(/\/$/, '');
                            item.channels.add(chan || DEFAULT_CONDA_CHANNEL);
                        }
                    }
                }
            }
        }

        // Note: 'pixi search --json' conflicts with -n/--limit-packages and -l/--limit in Pixi CLI,
        // so package limit slicing and version sorting are performed in JS.
        const semverCache = new Map<string, semver.SemVer | null>();
        const getCoercedSemver = (v: string): semver.SemVer | null => {
            let parsed = semverCache.get(v);
            if (parsed === undefined) {
                parsed = semver.coerce(v);
                semverCache.set(v, parsed);
            }
            return parsed;
        };

        for (const item of pkgMap.values()) {
            const sortedVersions = Array.from(item.versions).sort((a, b) => {
                const sA = getCoercedSemver(a);
                const sB = getCoercedSemver(b);
                if (sA && sB) {
                    return semver.rcompare(sA, sB);
                }
                return b.localeCompare(a);
            });

            const channelStr = Array.from(item.channels).join(', ') || DEFAULT_CONDA_CHANNEL;
            results.push({
                name: item.name,
                latestVersion: sortedVersions[0] || 'unknown',
                versions: sortedVersions,
                platforms: Array.from(item.platforms),
                channel: channelStr,
                sourceType: 'conda',
                license: item.license,
                summary: item.summary,
            });
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('No packages found')) {
            return [];
        }
        traceError(`Conda package search failed for '${cleanQuery}':`, err);
        throw err;
    }

    // Sort Conda results: exact match first, then by name length / alphabetical
    const lowerQ = cleanQuery.toLowerCase();
    results.sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const aExact = aName === lowerQ;
        const bExact = bName === lowerQ;
        if (aExact !== bExact) {
            return aExact ? -1 : 1;
        }
        const aStarts = aName.startsWith(lowerQ);
        const bStarts = bName.startsWith(lowerQ);
        if (aStarts !== bStarts) {
            return aStarts ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });

    if (searchCache.size >= MAX_SEARCH_CACHE_SIZE) {
        const oldestKey = searchCache.keys().next().value;
        if (oldestKey !== undefined) {
            searchCache.delete(oldestKey);
        }
    }
    searchCache.set(cacheKey, results);

    const limit = options?.limit ?? 30;
    return results.slice(0, Math.max(1, limit));
}
