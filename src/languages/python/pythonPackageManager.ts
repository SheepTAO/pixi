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
import * as path from 'path';
import { Disposable, Event, EventEmitter, LogOutputChannel, ProgressLocation, ThemeIcon, window } from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import { traceError, traceInfo, traceVerbose } from '../../common/logging';
import { listPixiPackages } from '../../core/packageManager';
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
        public readonly log?: LogOutputChannel,
        private readonly envManager?: PixiPythonEnvManager,
        private readonly projectManager?: PixiProjectManager,
    ) {
        if (this.envManager) {
            this.disposables.push(
                this.envManager.onDidChangeEnvironments(() => {
                    this.packagesCache.clear();
                }),
            );
        }
    }

    dispose() {
        this._onDidChangePackages.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    async clearCache(): Promise<void> {
        this.packagesCache.clear();
    }

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        traceVerbose(`Called manage with options: ${JSON.stringify(options)}`);

        const details = this.resolveEnvDetails(environment);
        if (!details) {
            window.showErrorMessage('Unable to determine Pixi project for this environment.');
            return;
        }

        const installList = 'install' in options ? options.install : [];
        const uninstallList = 'uninstall' in options && options.uninstall ? options.uninstall : [];

        if (installList && installList.length > 0) {
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
            args.push('-e', details.envName, ...installList);

            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Pixi: Installing ${installList.join(', ')} (${channel.isPypi ? 'PyPI' : 'Conda'})...`,
                    cancellable: true,
                },
                async (_progress, token) => {
                    await runPixi(args, { cwd: details.projectPath }, token);
                    this.projectManager?.clearPackagesCache(details.projectPath);
                    await this.refresh(environment);
                },
            );
        } else if (uninstallList && uninstallList.length > 0) {
            const cached = this.packagesCache.get(environment.envId.id) || [];
            const pypiPkgs: string[] = [];
            const condaPkgs: string[] = [];

            for (const pkg of uninstallList) {
                const found = cached.find((p) => p.name === pkg);
                if (found?.tooltip?.toString().includes('(pypi)')) {
                    pypiPkgs.push(pkg);
                } else {
                    condaPkgs.push(pkg);
                }
            }

            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Pixi: Uninstalling ${uninstallList.join(', ')}...`,
                    cancellable: true,
                },
                async (_progress, token) => {
                    if (condaPkgs.length > 0) {
                        await runPixi(
                            ['remove', '-e', details.envName, ...condaPkgs],
                            { cwd: details.projectPath },
                            token,
                        );
                    }
                    if (pypiPkgs.length > 0) {
                        await runPixi(
                            ['remove', '--pypi', '-e', details.envName, ...pypiPkgs],
                            { cwd: details.projectPath },
                            token,
                        );
                    }
                    this.projectManager?.clearPackagesCache(details.projectPath);
                    await this.refresh(environment);
                },
            );
        }
    }

    private resolveEnvDetails(environment: PythonEnvironment): { envName: string; projectPath: string } | undefined {
        const envId = environment.envId.id;
        const pixiEnv = this.envManager?.getPixiEnvironment(envId);

        let envName = pixiEnv?.pixiEnvName;
        let projectPath = pixiEnv?.projectPath;

        if (!envName || !projectPath) {
            const normalized = path.normalize(envId);
            const parsedEnvName = path.basename(normalized);
            const envsDir = path.dirname(normalized);
            const dotPixiDir = path.dirname(envsDir);

            if (!envName) {
                envName = parsedEnvName;
            }

            if (!projectPath && path.basename(envsDir) === 'envs' && path.basename(dotPixiDir) === '.pixi') {
                projectPath = path.dirname(dotPixiDir);
            }
        }

        if (envName && projectPath) {
            return { envName, projectPath };
        }

        return undefined;
    }

    private async fetchAndCachePackages(
        environment: PythonEnvironment,
        pixiEnv?: PixiPythonEnvironment,
    ): Promise<Package[] | undefined> {
        const envId = environment.envId.id;
        const details = this.resolveEnvDetails(environment);
        if (!details) {
            traceError(`Unable to resolve Pixi environment details for: ${envId}`);
            return undefined;
        }

        try {
            const pixiPackages = this.projectManager
                ? await this.projectManager.getPackagesForEnvironment(details.envName, details.projectPath)
                : await listPixiPackages(details.envName, details.projectPath);
            const packages = pixiPkgsToPackages(pixiPackages, envId);
            this.packagesCache.set(envId, packages);
            if (pixiEnv) {
                pixiEnv.packages = packages;
            }
            traceInfo(`Loaded ${packages.length} packages for environment '${details.envName}'`);
            return packages;
        } catch (error) {
            traceError(`Failed to fetch packages for environment '${details.envName}': ${error}`);
            return undefined;
        }
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        const envId = environment.envId.id;
        traceInfo(`Called refresh for environment: ${envId}`);

        return (await window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing Pixi packages',
            },
            async () => {
                const pixiEnv = this.envManager?.getPixiEnvironment(envId);
                const before = this.packagesCache.get(envId) || pixiEnv?.packages || [];
                const after = (await this.fetchAndCachePackages(environment, pixiEnv)) || [];

                this.triggerOnDidChangePackages(environment, before, after);
                return after;
            },
        )) as unknown as void;
    }

    async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        const envId = environment.envId.id;
        traceVerbose(`Called getPackages for environment: ${envId}`);

        const cached = this.packagesCache.get(envId);
        if (cached && cached.length > 0) {
            return cached;
        }

        const pixiEnv = this.envManager?.getPixiEnvironment(envId);
        if (pixiEnv?.packages && pixiEnv.packages.length > 0) {
            this.packagesCache.set(envId, pixiEnv.packages);
            return pixiEnv.packages;
        }

        return this.fetchAndCachePackages(environment, pixiEnv);
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
