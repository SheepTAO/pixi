import {
    DidChangePackagesEventArgs,
    IconPath,
    Package,
    PackageChangeKind,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '@vscode/python-environments';
import { Disposable, Event, EventEmitter, ProgressLocation, ThemeIcon, window } from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import {
    findPackageScope,
    getScopeArgs,
    getWorkspaceEnvironments,
    getWorkspaceFeatures,
} from '../../commands/workspace/common';
import { runWithProgressNotification } from '../../common/execUtils';
import { traceError, traceInfo, traceVerbose } from '../../common/logging';
import { normalizePkgName } from '../../core/packageManager';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiPackage } from '../../core/types';
import { PIXI_MANAGER_ID } from './constants';
import { PixiPythonEnvManager } from './pythonEnvManager';
import { PixiPythonEnvironment } from './types';

export function pixiPkgsToPackages(pixiPackages: PixiPackage[], environmentId: string): Package[] {
    return pixiPackages.map((pkg) => {
        const tooltip = pkg.kind ? `${pkg.name} ${pkg.version} (${pkg.kind})` : `${pkg.name} ${pkg.version}`;
        return {
            name: pkg.name,
            displayName: pkg.name,
            description: pkg.version,
            version: pkg.version,
            tooltip,
            isTransitive: !pkg.is_explicit,
            pkgId: {
                id: pkg.name,
                managerId: PIXI_MANAGER_ID,
                environmentId,
            },
        } as Package;
    });
}

export class PixiPythonPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;
    private packagesCache = new Map<string, Package[]>();
    private readonly disposables: Disposable[] = [];

    readonly name = 'pixi';
    readonly displayName = 'Pixi';
    readonly description = 'Pixi Package Manager';
    readonly tooltip = 'Pixi Package Manager';
    readonly iconPath: IconPath = new ThemeIcon('prefix-dev');

    constructor(
        public readonly api: PythonEnvironmentApi,
        private readonly envManager: PixiPythonEnvManager,
        private readonly projectManager: PixiProjectManager,
    ) {
        this.disposables.push(
            this.projectManager.onDidChangeEnvironments(() => {
                this.packagesCache.clear();
            }),
        );
    }

    public dispose(): void {
        this._onDidChangePackages.dispose();
        Disposable.from(...this.disposables).dispose();
    }

    async clearCache(): Promise<void> {
        this.packagesCache.clear();
        this.projectManager.clearPackagesCache();
    }

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        traceVerbose(`Called manage with options: ${JSON.stringify(options)}`);

        const details = this.resolveEnvDetails(environment);
        if (!details) {
            window.showErrorMessage('Unable to determine Pixi project for this environment.');
            return;
        }

        const installList = options.install ?? [];
        const uninstallList = options.uninstall ?? [];

        if (installList.length > 0) {
            const channel = await window.showQuickPick(
                [
                    {
                        label: '$(package) Conda (default)',
                        description: 'Install as Conda package from project channels',
                        isPypi: false,
                    },
                    {
                        label: '$(symbol-keyword) PyPI',
                        description: 'Install as PyPI package from Python Package Index',
                        isPypi: true,
                    },
                ],
                {
                    title: 'Pixi: Select Package Channel',
                    placeHolder: `Choose channel to install ${installList.join(', ')}`,
                },
            );
            if (!channel) {
                return;
            }

            const args = ['add'];
            if (channel.isPypi) {
                args.push('--pypi');
            }
            if (details.envName !== 'default') {
                args.push('-e', details.envName);
            }
            args.push(...installList);

            await runWithProgressNotification(
                `Pixi: Installing ${installList.join(', ')} (${channel.isPypi ? 'PyPI' : 'Conda'})...`,
                async (token) => {
                    await runPixi(args, { cwd: details.projectPath }, token);
                    await this.refresh(environment);
                },
            );
        } else if (uninstallList.length > 0) {
            await runWithProgressNotification(`Pixi: Uninstalling ${uninstallList.join(', ')}...`, async (token) => {
                const [features, envs] = await Promise.all([
                    getWorkspaceFeatures(details.projectPath),
                    getWorkspaceEnvironments(details.projectPath),
                ]);
                let cachedPkgs: PixiPackage[] | undefined;
                for (const pkg of uninstallList) {
                    if (token.isCancellationRequested) {
                        break;
                    }
                    const scope = await findPackageScope(details.projectPath, pkg, details.envName, {
                        features,
                        envs,
                    });
                    let isPypi = scope?.isPypi ?? false;
                    if (!scope) {
                        cachedPkgs ??= await this.projectManager.getPackagesForEnvironment(
                            details.envName,
                            details.projectPath,
                        );
                        const normPkg = normalizePkgName(pkg);
                        isPypi = cachedPkgs.find((p) => normalizePkgName(p.name) === normPkg)?.kind === 'pypi';
                    }

                    const args = ['remove'];
                    if (isPypi) {
                        args.push('--pypi');
                    }
                    const scopeArgs = getScopeArgs(scope);
                    if (scopeArgs.length > 0) {
                        args.push(...scopeArgs);
                    } else if (!scope && details.envName !== 'default') {
                        args.push('-e', details.envName);
                    }
                    args.push(pkg);

                    await runPixi(args, { cwd: details.projectPath }, token);
                }
                await this.refresh(environment);
            });
        }
    }

    private resolveEnvDetails(environment: PythonEnvironment): { envName: string; projectPath: string } | undefined {
        const pyEnv = environment as Partial<PixiPythonEnvironment>;
        const resolved =
            pyEnv.pixiEnvName && pyEnv.projectPath
                ? (pyEnv as PixiPythonEnvironment)
                : this.envManager.getPixiEnvironment(environment.envId.id);
        return resolved ? { envName: resolved.pixiEnvName, projectPath: resolved.projectPath } : undefined;
    }

    private async fetchAndCachePackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        const envId = environment.envId.id;
        const details = this.resolveEnvDetails(environment);
        if (!details) {
            traceError(`Unable to resolve Pixi environment details for: ${envId}`);
            return undefined;
        }

        const pixiPackages = await this.projectManager.getPackagesForEnvironment(details.envName, details.projectPath);
        const packages = pixiPkgsToPackages(pixiPackages, envId);
        this.packagesCache.set(envId, packages);
        traceInfo(`Loaded ${packages.length} packages for environment '${details.envName}'`);
        return packages;
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        const envId = environment.envId.id;
        traceInfo(`Called refresh for environment: ${envId}`);

        await window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing Pixi packages',
            },
            async () => {
                const before = this.packagesCache.get(envId) || [];
                const details = this.resolveEnvDetails(environment);
                if (details) {
                    this.projectManager.clearPackagesCache(details.projectPath);
                }
                const after = (await this.fetchAndCachePackages(environment)) || [];

                this.triggerOnDidChangePackages(environment, before, after);
            },
        );
    }

    async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        const envId = environment.envId.id;
        traceVerbose(`Called getPackages for environment: ${envId}`);

        if (this.packagesCache.has(envId)) {
            return this.packagesCache.get(envId);
        }

        return this.fetchAndCachePackages(environment);
    }

    private triggerOnDidChangePackages(environment: PythonEnvironment, before: Package[], after: Package[]): void {
        const changes: { kind: PackageChangeKind; pkg: Package }[] = [];

        const beforeByName = new Map(before.map((p) => [p.name, p]));
        const afterByName = new Map(after.map((p) => [p.name, p]));

        for (const pkg of before) {
            if (!afterByName.has(pkg.name)) {
                changes.push({ kind: PackageChangeKind.remove, pkg });
            }
        }

        for (const pkg of after) {
            const prev = beforeByName.get(pkg.name);
            if (!prev) {
                changes.push({ kind: PackageChangeKind.add, pkg });
            } else if (prev.version !== pkg.version) {
                changes.push({ kind: PackageChangeKind.remove, pkg: prev });
                changes.push({ kind: PackageChangeKind.add, pkg });
            }
        }

        if (changes.length > 0) {
            this._onDidChangePackages.fire({ environment, manager: this, changes });
        }
    }
}
