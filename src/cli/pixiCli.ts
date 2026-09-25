import * as ch from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import semver from 'semver';
import { CancellationError, CancellationToken, commands, window, workspace } from 'vscode';
import which from 'which';

import { createDeferred } from '../common/deferred';
import { quoteArgs, untildify } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';

let _cachedPixi: string | undefined;

export function clearPixiCache(): void {
    _cachedPixi = undefined;
}

async function findPixi(): Promise<string | undefined> {
    try {
        return await which('pixi');
    } catch {
        return undefined;
    }
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
                for (const folder of workspace.workspaceFolders) {
                    const candidate = path.resolve(folder.uri.fsPath, resolved);
                    if (fs.existsSync(candidate)) {
                        resolved = candidate;
                        break;
                    }
                }
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

async function _runPixi(
    pixi: string,
    args: string[],
    options?: PixiRunOptions,
    token?: CancellationToken,
): Promise<string> {
    const deferred = createDeferred<string>();

    const isWindows = process.platform === 'win32';
    const useShell = isWindows && !pixi.toLowerCase().endsWith('.exe');
    const finalArgs = useShell ? quoteArgs(args) : args;

    const proc = ch.spawn(pixi, finalArgs, {
        shell: useShell,
        windowsHide: true,
        ...options,
    });

    const cancelDisposable = token?.onCancellationRequested(() => {
        proc.kill();
        deferred.reject(new CancellationError());
    });

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;

    proc.stdout?.on('data', (data) => {
        stdout += data.toString('utf-8');
    });
    proc.stderr?.on('data', (data) => {
        const d = data.toString('utf-8');
        stderr += d;
        traceVerbose(`[pixi stderr] ${d.trim()}`);
    });
    proc.on('error', (err) => {
        deferred.reject(err);
    });
    proc.on('exit', (code) => {
        exitCode = code;
    });
    proc.on('close', () => {
        cancelDisposable?.dispose();
        if (exitCode !== 0) {
            traceError(`Failed to run "pixi ${args.join(' ')}":\n${stderr}`);
            deferred.reject(new Error(`Failed to run "pixi ${args.join(' ')}":\n ${stderr}`));
        } else {
            if (options?.includeStderr) {
                const combined = stdout ? (stderr ? `${stdout}\n${stderr}` : stdout) : stderr;
                deferred.resolve(combined);
            } else {
                deferred.resolve(stdout);
            }
        }
    });

    return deferred.promise;
}

export async function runPixi(args: string[], options?: PixiRunOptions, token?: CancellationToken): Promise<string> {
    const pixi = await getPixi();
    const defaultCwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
    const spawnOptions: PixiRunOptions = {
        ...(defaultCwd ? { cwd: defaultCwd } : {}),
        ...options,
    };
    return _runPixi(pixi, args, spawnOptions, token);
}

export const MINIMUM_PIXI_VERSION = '0.53.0';

export async function validatePixiCli(): Promise<boolean> {
    try {
        const stdout = await runPixi(['--version']);
        const versionMatch = stdout.trim().match(/pixi\s+([0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9\-\.]*)/);
        const parsedVersion = semver.coerce(versionMatch ? versionMatch[1] : stdout.trim());
        if (!parsedVersion) {
            window.showErrorMessage(`Found invalid Pixi binary at "${await getPixi()}".`);
            return false;
        }

        if (!semver.gte(parsedVersion, MINIMUM_PIXI_VERSION)) {
            window.showErrorMessage(
                `Pixi version ${parsedVersion.version} is too old. Requires >= ${MINIMUM_PIXI_VERSION}. Run: pixi self-update`,
            );
            return false;
        }
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

async function fetchPypiPackage(
    packageName: string,
    token?: CancellationToken,
): Promise<PixiPackageSearchResult | null> {
    return new Promise((resolve) => {
        if (token?.isCancellationRequested) {
            return resolve(null);
        }

        const targetUrl = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;
        const parsedUrl = new URL(targetUrl);
        const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy;
        const timeoutMs = 2500;
        let isDone = false;

        const cancelDisposable = token?.onCancellationRequested(() => {
            safeResolve(null);
        });

        const safeResolve = (val: PixiPackageSearchResult | null) => {
            if (!isDone) {
                isDone = true;
                cancelDisposable?.dispose();
                resolve(val);
            }
        };

        const onResponse = (res: http.IncomingMessage) => {
            if (res.statusCode !== 200) {
                return safeResolve(null);
            }
            let raw = '';
            res.on('data', (chunk) => (raw += chunk));
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    if (!data?.info?.name || !data?.info?.version) {
                        return safeResolve(null);
                    }
                    safeResolve({
                        name: data.info.name,
                        latestVersion: data.info.version,
                        versions: [data.info.version],
                        platforms: ['all'],
                        channel: 'pypi',
                        sourceType: 'pypi',
                        license: data.info.license || undefined,
                        summary: data.info.summary || undefined,
                    });
                } catch {
                    safeResolve(null);
                }
            });
            res.on('error', () => safeResolve(null));
        };

        if (proxy && parsedUrl.protocol === 'https:') {
            try {
                const p = new URL(proxy);
                const connectReq = http.request({
                    host: p.hostname,
                    port: p.port,
                    method: 'CONNECT',
                    path: `${parsedUrl.hostname}:443`,
                });
                connectReq.setTimeout(timeoutMs, () => {
                    connectReq.destroy();
                    safeResolve(null);
                });
                connectReq.on('connect', (_res, socket) => {
                    const agent = new https.Agent({ socket });
                    const req = https.get(targetUrl, { agent }, onResponse);
                    req.setTimeout(timeoutMs, () => {
                        req.destroy();
                        safeResolve(null);
                    });
                    req.on('error', () => safeResolve(null));
                });
                connectReq.on('error', () => safeResolve(null));
                connectReq.end();
            } catch {
                safeResolve(null);
            }
        } else {
            try {
                const req = https.get(targetUrl, onResponse);
                req.setTimeout(timeoutMs, () => {
                    req.destroy();
                    safeResolve(null);
                });
                req.on('error', () => safeResolve(null));
            } catch {
                safeResolve(null);
            }
        }
    });
}

export async function searchPixiPackages(
    query: string,
    options?: {
        cwd?: string;
        platform?: string;
        channel?: string;
        channels?: string[];
        includePypi?: boolean;
    },
    token?: CancellationToken,
): Promise<PixiPackageSearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
        return [];
    }

    const platform = options?.platform || getHostCondaPlatform();
    const allChannels: string[] = [];
    if (options?.channels && options.channels.length > 0) {
        for (const ch of options.channels) {
            if (ch && !allChannels.includes(ch)) {
                allChannels.push(ch);
            }
        }
    }
    if (options?.channel && !allChannels.includes(options.channel)) {
        allChannels.push(options.channel);
    }

    const channelsKey = allChannels.slice().sort().join(',');
    const cacheKey = `${options?.cwd || ''}:${platform}:${channelsKey}:${cleanQuery}`;
    if (searchCache.has(cacheKey)) {
        return searchCache.get(cacheKey)!;
    }

    const args = ['search', cleanQuery, '--json'];
    if (platform) {
        args.push('-p', platform);
    }
    if (allChannels.length > 0) {
        for (const ch of allChannels) {
            args.push('-c', ch);
        }
    }

    const condaPromise = (async (): Promise<PixiPackageSearchResult[]> => {
        try {
            const stdout = await runPixi(args, { cwd: options?.cwd }, token);
            const rawJson = JSON.parse(stdout);

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
                                const chan = r.channel
                                    .replace(/^https?:\/\/conda\.anaconda\.org\//, '')
                                    .replace(/\/$/, '');
                                item.channels.add(chan || 'conda-forge');
                            }
                        }
                    }
                }
            }

            const results: PixiPackageSearchResult[] = [];
            for (const item of pkgMap.values()) {
                const sortedVersions = Array.from(item.versions).sort((a, b) => {
                    const sA = semver.coerce(a);
                    const sB = semver.coerce(b);
                    if (sA && sB) {
                        return semver.rcompare(sA, sB);
                    }
                    return b.localeCompare(a);
                });

                const channelStr = Array.from(item.channels).join(', ') || 'conda-forge';
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

            return results;
        } catch (err: any) {
            if (err?.message?.includes('No packages found')) {
                return [];
            }
            traceError(`Conda package search failed for '${cleanQuery}':`, err);
            return [];
        }
    })();

    const pypiPromise = options?.includePypi === false ? Promise.resolve(null) : fetchPypiPackage(cleanQuery, token);

    const [condaRes, pypiRes] = await Promise.allSettled([condaPromise, pypiPromise]);
    const condaResults = condaRes.status === 'fulfilled' ? condaRes.value : [];
    const pypiResult = pypiRes.status === 'fulfilled' ? pypiRes.value : null;

    const combined: PixiPackageSearchResult[] = [...condaResults];

    // Sort Conda results: exact match first, then by name length / alphabetical
    const lowerQ = cleanQuery.toLowerCase();
    combined.sort((a, b) => {
        const aExact = a.name.toLowerCase() === lowerQ;
        const bExact = b.name.toLowerCase() === lowerQ;
        if (aExact && !bExact) {
            return -1;
        }
        if (!aExact && bExact) {
            return 1;
        }
        const aStarts = a.name.toLowerCase().startsWith(lowerQ);
        const bStarts = b.name.toLowerCase().startsWith(lowerQ);
        if (aStarts && !bStarts) {
            return -1;
        }
        if (!aStarts && bStarts) {
            return 1;
        }
        return a.name.localeCompare(b.name);
    });

    // If PyPI returned a match for this package, insert PyPI item
    if (pypiResult) {
        const exactIndex = combined.findIndex((p) => p.name.toLowerCase() === lowerQ);
        if (exactIndex !== -1) {
            combined.splice(exactIndex + 1, 0, pypiResult);
        } else {
            combined.unshift(pypiResult);
        }
    }

    const limited = combined.slice(0, 30);
    if (searchCache.has(cacheKey)) {
        searchCache.delete(cacheKey);
    } else if (searchCache.size >= MAX_SEARCH_CACHE_SIZE) {
        const oldestKey = searchCache.keys().next().value;
        if (oldestKey !== undefined) {
            searchCache.delete(oldestKey);
        }
    }
    searchCache.set(cacheKey, limited);
    return limited;
}
