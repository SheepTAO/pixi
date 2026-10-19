import { Disposable, Event, EventEmitter, Uri, workspace } from 'vscode';

import { runPixi } from '../cli/pixiCli';
import { escapeRegex, safeJsonParse } from '../common/execUtils';
import { traceVerbose } from '../common/logging';
import { normalizePkgName } from './packageManager';
import { PathMap } from './projectDiscovery';
import { PixiProjectManager } from './projectManager';

export interface DryRunPackageChange {
    name: string;
    type: 'conda' | 'pypi';
    beforeVer?: string;
    afterVer?: string;
    beforeBuild?: string;
    afterBuild?: string;
    isNew: boolean;
    isRemoved: boolean;
    platforms: string[];
    environment: string;
}

interface RawPackageItem {
    name: string;
    type?: 'conda' | 'pypi';
    before?: {
        conda?: string;
        pypi?: string;
        version?: string;
    };
    after?: {
        conda?: string;
        pypi?: string;
        version?: string;
    };
}

interface RawDryRunResult {
    version?: number;
    environment?: Record<string, Record<string, RawPackageItem[]>>;
}

/**
 * Extracts version and build strings from a Conda package URL or filename.
 * e.g., '.../bzip2-1.0.8-hda65f42_9.conda' -> { version: '1.0.8', build: 'hda65f42_9' }
 */
export function parseCondaInfo(url?: string, pkgName?: string): { version?: string; build?: string } {
    if (!url) {
        return {};
    }
    const filename =
        url
            .split('/')
            .pop()
            ?.replace(/(\.conda|\.tar\.bz2|\.whl|\.tar\.gz)$/, '') || '';
    let rest = filename;
    if (pkgName && new RegExp(`^${escapeRegex(pkgName).replace(/[-_]/g, '[-_]')}-`, 'i').test(rest)) {
        rest = rest.slice(pkgName.length + 1);
    }
    const lastDash = rest.lastIndexOf('-');
    if (lastDash > 0) {
        return {
            version: rest.substring(0, lastDash),
            build: rest.substring(lastDash + 1),
        };
    }
    return { version: rest };
}

/**
 * Parses the stdout JSON of `pixi update --dry-run --json`.
 */
export function parseDryRunOutput(jsonStr: string): DryRunPackageChange[] {
    const data = safeJsonParse<RawDryRunResult>(jsonStr, {});
    const envMap = data.environment || {};
    const result: DryRunPackageChange[] = [];

    for (const [envName, platformMap] of Object.entries(envMap)) {
        const pkgMap = new Map<string, DryRunPackageChange>();

        for (const [platform, pkgs] of Object.entries(platformMap)) {
            if (!Array.isArray(pkgs)) {
                continue;
            }
            for (const p of pkgs) {
                if (!p || !p.name) {
                    continue;
                }
                const isPypi = p.type === 'pypi';
                const beforeConda = isPypi ? undefined : parseCondaInfo(p.before?.conda, p.name);
                const afterConda = isPypi ? undefined : parseCondaInfo(p.after?.conda, p.name);
                const beforeVer = isPypi ? p.before?.version : beforeConda?.version;
                const afterVer = isPypi ? p.after?.version : afterConda?.version;
                const beforeBuild = beforeConda?.build;
                const afterBuild = afterConda?.build;

                const existing = pkgMap.get(p.name);
                if (!existing) {
                    pkgMap.set(p.name, {
                        name: p.name,
                        type: isPypi ? 'pypi' : 'conda',
                        beforeVer,
                        afterVer,
                        beforeBuild,
                        afterBuild,
                        isNew: !p.before && !!p.after,
                        isRemoved: !!p.before && !p.after,
                        platforms: [platform],
                        environment: envName,
                    });
                } else {
                    if (!existing.platforms.includes(platform)) {
                        existing.platforms.push(platform);
                    }
                    existing.beforeVer ||= beforeVer;
                    existing.afterVer ||= afterVer;
                    existing.beforeBuild ||= beforeBuild;
                    existing.afterBuild ||= afterBuild;
                }
            }
        }

        result.push(...pkgMap.values());
    }

    return result;
}

interface OutdatedCacheEntry {
    timestamp: number;
    byEnv: Map<string, Map<string, DryRunPackageChange>>;
}

const OUTDATED_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const FAILURE_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes backoff on failure

export class PixiPackageUpdateService implements Disposable {
    private readonly _onDidChangeOutdatedPackages = new EventEmitter<string>();
    public readonly onDidChangeOutdatedPackages: Event<string> = this._onDidChangeOutdatedPackages.event;

    private readonly cache = new PathMap<OutdatedCacheEntry>();
    private readonly inFlight = new PathMap<Promise<void>>();
    private readonly disposables: Disposable[] = [];

    constructor(private readonly projectManager: PixiProjectManager) {
        this.disposables.push(
            this._onDidChangeOutdatedPackages,
            this.projectManager.onDidChangeEnvironments(() => {
                this.clearCache();
                this.checkAllEnabledProjects();
            }),
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.packages.checkForUpdates')) {
                    this.clearCache();
                    this.checkAllEnabledProjects();
                }
            }),
        );
    }

    public isCheckEnabled(resourceUri?: Uri): boolean {
        const config = workspace.getConfiguration('pixi.packages', resourceUri);
        return config.get<boolean>('checkForUpdates', false);
    }

    public getOutdatedPackage(projectPath: string, envName: string, pkgName: string): DryRunPackageChange | undefined {
        const entry = this.cache.get(projectPath);
        if (!entry) {
            return undefined;
        }
        const envMap = entry.byEnv.get(envName);
        if (!envMap) {
            return undefined;
        }
        return envMap.get(normalizePkgName(pkgName));
    }

    public getOutdatedPackages(projectPath: string, envName: string): Map<string, DryRunPackageChange> {
        const entry = this.cache.get(projectPath);
        if (!entry) {
            return new Map();
        }
        return entry.byEnv.get(envName) ?? new Map();
    }

    public getAllOutdatedForProject(projectPath: string): Map<string, Map<string, DryRunPackageChange>> {
        const entry = this.cache.get(projectPath);
        if (!entry) {
            return new Map();
        }
        return entry.byEnv;
    }

    public populateCache(projectPath: string, changes: DryRunPackageChange[], options?: { targetEnv?: string }): void {
        const existing = this.cache.get(projectPath);

        let byEnv: Map<string, Map<string, DryRunPackageChange>>;
        if (options?.targetEnv && existing) {
            byEnv = new Map(existing.byEnv);
            byEnv.delete(options.targetEnv);
        } else {
            byEnv = new Map();
        }

        for (const change of changes) {
            if (!change.environment || change.isRemoved || change.isNew || !change.afterVer) {
                continue;
            }
            if (change.beforeVer && change.beforeVer === change.afterVer) {
                continue;
            }
            let envMap = byEnv.get(change.environment);
            if (!envMap) {
                envMap = new Map();
                byEnv.set(change.environment, envMap);
            }
            envMap.set(normalizePkgName(change.name), change);
        }

        this.cache.set(projectPath, {
            timestamp: Date.now(),
            byEnv,
        });
        this._onDidChangeOutdatedPackages.fire(projectPath);
    }

    public async checkForUpdates(projectPath: string, options?: { force?: boolean }): Promise<void> {
        const uri = Uri.file(projectPath);
        if (!options?.force && !this.isCheckEnabled(uri)) {
            return;
        }

        const cached = this.cache.get(projectPath);
        const now = Date.now();
        if (!options?.force && cached && now - cached.timestamp < OUTDATED_CACHE_TTL_MS) {
            return;
        }

        let pending = this.inFlight.get(projectPath);
        if (pending) {
            return pending;
        }

        pending = (async () => {
            try {
                traceVerbose(`Checking for package updates in ${projectPath}...`);
                const stdout = await runPixi(['update', '--dry-run', '--json'], { cwd: projectPath });
                const changes = parseDryRunOutput(stdout);
                this.populateCache(projectPath, changes);
            } catch (error) {
                traceVerbose(`Failed to check for package updates in ${projectPath}: ${error}`);
                const existing = this.cache.get(projectPath);
                this.cache.set(projectPath, {
                    timestamp: Date.now() - (OUTDATED_CACHE_TTL_MS - FAILURE_BACKOFF_MS),
                    byEnv: existing?.byEnv ?? new Map(),
                });
            } finally {
                this.inFlight.delete(projectPath);
            }
        })();

        this.inFlight.set(projectPath, pending);
        return pending;
    }

    public clearCache(projectPath?: string): void {
        if (projectPath) {
            if (this.cache.has(projectPath)) {
                this.cache.delete(projectPath);
                this._onDidChangeOutdatedPackages.fire(projectPath);
            }
        } else if (this.cache.size > 0) {
            this.cache.clear();
            for (const p of this.projectManager.getProjects()) {
                this._onDidChangeOutdatedPackages.fire(p.projectPath);
            }
        }
    }

    private checkAllEnabledProjects(): void {
        for (const project of this.projectManager.getProjects()) {
            if (this.isCheckEnabled(Uri.file(project.projectPath))) {
                void this.checkForUpdates(project.projectPath);
            }
        }
    }

    public dispose(): void {
        this.cache.clear();
        this.inFlight.clear();
        Disposable.from(...this.disposables).dispose();
    }
}
