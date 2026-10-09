import * as path from 'path';
import { commands, Disposable, ProgressLocation, QuickPickItem, window } from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { safeJsonParse } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import { extractEnvironmentName, pickPixiProject } from './common';

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
    if (pkgName) {
        const altPkg = pkgName.includes('_') ? pkgName.replace(/_/g, '-') : pkgName.replace(/-/g, '_');
        if (rest.toLowerCase().startsWith(`${pkgName.toLowerCase()}-`)) {
            rest = rest.slice(pkgName.length + 1);
        } else if (rest.toLowerCase().startsWith(`${altPkg.toLowerCase()}-`)) {
            rest = rest.slice(altPkg.length + 1);
        }
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
 * Formats a human-readable version diff for a package change.
 */
export function formatVersionDiff(pkg: DryRunPackageChange): string {
    const typeBadge = pkg.type === 'pypi' ? '[PyPI]' : '[Conda]';
    if (pkg.isNew) {
        return `(new) -> v${pkg.afterVer || 'unknown'} ${typeBadge}`;
    }
    if (pkg.isRemoved) {
        return `v${pkg.beforeVer || 'unknown'} -> (removed) ${typeBadge}`;
    }
    if (pkg.beforeVer && pkg.afterVer && pkg.beforeVer === pkg.afterVer && pkg.beforeBuild && pkg.afterBuild) {
        return `v${pkg.beforeVer} (${pkg.beforeBuild} -> ${pkg.afterBuild}) ${typeBadge}`;
    }
    return `v${pkg.beforeVer || '?'} -> v${pkg.afterVer || '?'} ${typeBadge}`;
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
                const beforeVer = isPypi ? p.before?.version : parseCondaInfo(p.before?.conda, p.name).version;
                const afterVer = isPypi ? p.after?.version : parseCondaInfo(p.after?.conda, p.name).version;
                const beforeBuild = !isPypi ? parseCondaInfo(p.before?.conda, p.name).build : undefined;
                const afterBuild = !isPypi ? parseCondaInfo(p.after?.conda, p.name).build : undefined;

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
                    if (!existing.beforeVer && beforeVer) {
                        existing.beforeVer = beforeVer;
                    }
                    if (!existing.afterVer && afterVer) {
                        existing.afterVer = afterVer;
                    }
                    if (!existing.beforeBuild && beforeBuild) {
                        existing.beforeBuild = beforeBuild;
                    }
                    if (!existing.afterBuild && afterBuild) {
                        existing.afterBuild = afterBuild;
                    }
                }
            }
        }

        result.push(...pkgMap.values());
    }

    return result;
}

async function handleCheckOutdated(
    manager: PixiProjectManager,
    projectPath: string,
    projectName: string,
    targetEnv?: string,
): Promise<void> {
    const envLabel = targetEnv || 'All Environments';
    let stdout = '';
    try {
        stdout = await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: `Pixi: Checking for updates in ${projectName} (${envLabel})...`,
                cancellable: true,
            },
            async (_progress, token) => {
                const args = ['update', '--dry-run', '--json'];
                if (targetEnv) {
                    args.push('-e', targetEnv);
                }
                return runPixi(args, { cwd: projectPath }, token);
            },
        );
    } catch (err) {
        if (err instanceof Error && err.name === 'CancellationError') {
            return;
        }
        window.showErrorMessage(
            `Failed to check for updates in ${projectName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
    }

    const changes = parseDryRunOutput(stdout);
    if (changes.length === 0) {
        window.showInformationMessage(`All dependencies in ${projectName} (${envLabel}) are up to date!`);
        return;
    }

    // Collect explicit (manifest) dependency names to filter out transitive packages
    const envExplicitMap = new Map<string, Set<string>>();
    const allExplicitSet = new Set<string>();

    const targetEnvs = targetEnv
        ? [targetEnv]
        : manager.getEnvironmentsForProject(projectPath).map((e) => e.pixiEnvName);

    await Promise.all(
        targetEnvs.map(async (env) => {
            const pkgs = await manager.getPackagesForEnvironment(env, projectPath);
            const explicitNames = new Set(pkgs.filter((p) => p.is_explicit).map((p) => p.name.toLowerCase()));
            envExplicitMap.set(env, explicitNames);
            for (const name of explicitNames) {
                allExplicitSet.add(name);
            }
        }),
    );

    const explicitChanges = changes.filter((c) => {
        const lowerName = c.name.toLowerCase();
        const envSet = c.environment ? envExplicitMap.get(c.environment) : undefined;
        return envSet ? envSet.has(lowerName) : allExplicitSet.has(lowerName);
    });

    const displayChanges = allExplicitSet.size > 0 ? explicitChanges : changes;
    if (displayChanges.length === 0) {
        window.showInformationMessage(
            changes.length > 0
                ? `All manifest dependencies in ${projectName} (${envLabel}) are up to date!`
                : `All dependencies in ${projectName} (${envLabel}) are up to date!`,
        );
        return;
    }

    // Aggregate package changes by name across environments
    const pkgChangeMap = new Map<string, DryRunPackageChange & { environments: string[] }>();

    for (const c of displayChanges) {
        const existing = pkgChangeMap.get(c.name);
        if (!existing) {
            pkgChangeMap.set(c.name, {
                ...c,
                environments: c.environment ? [c.environment] : [],
                platforms: Array.from(new Set(c.platforms)),
            });
        } else {
            if (c.environment && !existing.environments.includes(c.environment)) {
                existing.environments.push(c.environment);
            }
            for (const plat of c.platforms) {
                if (!existing.platforms.includes(plat)) {
                    existing.platforms.push(plat);
                }
            }
            if (!existing.afterVer && c.afterVer) {
                existing.afterVer = c.afterVer;
            }
            if (!existing.beforeVer && c.beforeVer) {
                existing.beforeVer = c.beforeVer;
            }
        }
    }

    const aggregatedChanges = Array.from(pkgChangeMap.values());
    aggregatedChanges.sort((a, b) => a.name.localeCompare(b.name));

    interface PackagePickItem extends QuickPickItem {
        pkgChange: DryRunPackageChange;
    }

    const items: PackagePickItem[] = aggregatedChanges.map((c) => {
        let icon = '$(arrow-up)';
        if (c.isNew) {
            icon = '$(diff-added)';
        } else if (c.isRemoved) {
            icon = '$(diff-removed)';
        }

        const envText = !targetEnv && c.environments.length > 0 ? `Environments: ${c.environments.join(', ')}` : '';
        const platformText = c.platforms.length > 0 ? `Platforms: ${c.platforms.join(', ')}` : '';
        const detail = [envText, platformText].filter(Boolean).join(' | ');

        return {
            label: `${icon} ${c.name}`,
            description: formatVersionDiff(c),
            detail,
            picked: !c.isRemoved,
            pkgChange: c,
        };
    });

    const picked = await window.showQuickPick(items, {
        title: `Pixi: Outdated Packages (${projectName} - ${envLabel}) [${aggregatedChanges.length} Available]`,
        placeHolder: 'Select package(s) to update, or press Esc to cancel',
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (!picked || picked.length === 0) {
        return;
    }

    const selectedPkgNames = Array.from(
        new Set(picked.filter((p) => !p.pkgChange.isRemoved).map((p) => p.pkgChange.name)),
    );
    if (selectedPkgNames.length === 0) {
        return;
    }

    const confirmMsg =
        selectedPkgNames.length === 1
            ? `Update package '${selectedPkgNames[0]}' in ${projectName}${targetEnv ? ` (${targetEnv})` : ''}?`
            : `Update ${selectedPkgNames.length} selected packages in ${projectName}${targetEnv ? ` (${targetEnv})` : ''}?`;

    const confirm = await window.showInformationMessage(confirmMsg, { modal: true }, 'Update Now');
    if (confirm !== 'Update Now') {
        return;
    }

    const updateArgs = ['update'];
    if (targetEnv) {
        updateArgs.push('-e', targetEnv);
    }
    updateArgs.push(...selectedPkgNames);

    await runPixiWithProgress(
        `Pixi: Updating ${selectedPkgNames.length} packages in ${projectName}...`,
        updateArgs,
        projectPath,
        manager,
        `Pixi: Successfully updated ${selectedPkgNames.length} packages in ${projectName}.`,
    );
}

async function handleUpdateDependencies(
    manager: PixiProjectManager,
    projectPath: string,
    projectName: string,
    targetEnv?: string,
): Promise<void> {
    const updateArgs = ['update'];
    if (targetEnv) {
        updateArgs.push('-e', targetEnv);
    }

    await runPixiWithProgress(
        targetEnv
            ? `Pixi: Updating dependencies for environment '${targetEnv}' in ${projectName}...`
            : `Pixi: Updating all dependencies for ${projectName}...`,
        updateArgs,
        projectPath,
        manager,
        targetEnv
            ? `Pixi: Dependencies updated successfully for environment '${targetEnv}' in ${projectName}.`
            : `Pixi: All dependencies updated successfully for ${projectName}.`,
    );
}

async function handleUpgradeDependencies(
    manager: PixiProjectManager,
    projectPath: string,
    projectName: string,
): Promise<void> {
    const warning =
        `Upgrade dependencies will loosen and bump version constraints in manifest (pixi.toml / pyproject.toml) to latest available versions.` +
        `\n\nAre you sure you want to proceed for ${projectName}?`;

    const confirmed = await window.showWarningMessage(warning, { modal: true }, 'Upgrade Manifest');
    if (confirmed !== 'Upgrade Manifest') {
        return;
    }

    const upgradeArgs = ['upgrade'];

    await runPixiWithProgress(
        `Pixi: Upgrading dependencies for ${projectName}...`,
        upgradeArgs,
        projectPath,
        manager,
        `Pixi: All dependencies upgraded successfully for ${projectName}.`,
    );
}

export async function executeUnifiedUpdate(
    manager: PixiProjectManager,
    folderUri?: unknown,
    envName?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to update dependencies', folderUri);
    if (!projectPath) {
        return;
    }

    const projectName = path.basename(projectPath);
    const directEnv = (typeof envName === 'string' && envName.trim()) || extractEnvironmentName(folderUri);

    interface UpdateActionItem extends QuickPickItem {
        action: 'check' | 'update' | 'upgrade';
    }

    const actionItems: UpdateActionItem[] = [
        {
            label: '$(search) Check Outdated Packages (Dry Run)',
            detail: 'Preview available package updates without modifying files or environments',
            action: 'check',
        },
        {
            label: '$(sync) Update Dependencies (Within Constraints)',
            detail: 'Update lockfile and environments within existing manifest version rules',
            action: 'update',
        },
        {
            label: '$(rocket) Upgrade Dependencies (Bump Manifest)',
            detail: 'Loosen and bump version requirements in manifest (pixi.toml / pyproject.toml)',
            action: 'upgrade',
        },
    ];

    const chosenAction = await window.showQuickPick(actionItems, {
        title: `Pixi: Update / Upgrade (${projectName}${directEnv ? ` - ${directEnv}` : ''})`,
        placeHolder: 'Select update mode',
    });

    if (!chosenAction) {
        return;
    }

    if (chosenAction.action === 'upgrade') {
        await handleUpgradeDependencies(manager, projectPath, projectName);
        return;
    }

    let selectedEnv: string | undefined = directEnv;
    if (!selectedEnv) {
        const envs = manager.getEnvironmentsForProject(projectPath);
        if (envs.length > 1) {
            interface ScopeItem extends QuickPickItem {
                envName?: string;
            }
            const scopeItems: ScopeItem[] = [
                {
                    label: '$(globe) All Environments',
                    description: `All ${envs.length} environments in ${projectName}`,
                    envName: undefined,
                },
                ...envs.map((e) => ({
                    label: `$(layers) ${e.pixiEnvName}`,
                    description: `Environment '${e.pixiEnvName}' (${e.pixiStatus})`,
                    envName: e.pixiEnvName,
                })),
            ];

            const chosenScope = await window.showQuickPick(scopeItems, {
                title: `Pixi: Select Target Environment (${projectName})`,
                placeHolder: `Select environment scope for ${chosenAction.label}`,
            });

            if (!chosenScope) {
                return;
            }
            selectedEnv = chosenScope.envName;
        }
    }

    switch (chosenAction.action) {
        case 'check':
            await handleCheckOutdated(manager, projectPath, projectName, selectedEnv);
            break;
        case 'update':
            await handleUpdateDependencies(manager, projectPath, projectName, selectedEnv);
            break;
    }
}

export function registerUpdateCommands(manager: PixiProjectManager): Disposable[] {
    return [
        commands.registerCommand('pixi.update', async (folderUri?: unknown, envName?: string) => {
            await executeUnifiedUpdate(manager, folderUri, envName);
        }),
    ];
}
