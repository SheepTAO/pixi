import { CancellationError, commands, Disposable, ProgressLocation, QuickPickItem, window } from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { escapeRegex, safeJsonParse } from '../../common/execUtils';
import { getPackageKindBadge, normalizePkgName } from '../../core/packageManager';
import { PixiProjectManager } from '../../core/projectManager';
import { extractEnvironmentName, pickPixiProject, pickProjectEnvironmentName } from './common';
import { buildDeclaredPackageQuickPickItems } from './packageCommands';

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
function parseCondaInfo(url?: string, pkgName?: string): { version?: string; build?: string } {
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
 * Formats a human-readable version diff for a package change.
 */
function formatVersionDiff(pkg: DryRunPackageChange): string {
    const typeBadge = getPackageKindBadge(pkg.type);
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
function parseDryRunOutput(jsonStr: string): DryRunPackageChange[] {
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
        if (err instanceof CancellationError) {
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
            const explicitNames = new Set(pkgs.filter((p) => p.is_explicit).map((p) => normalizePkgName(p.name)));
            envExplicitMap.set(env, explicitNames);
            for (const name of explicitNames) {
                allExplicitSet.add(name);
            }
        }),
    );

    const explicitChanges = changes.filter((c) => {
        const normName = normalizePkgName(c.name);
        const envSet = c.environment ? envExplicitMap.get(c.environment) : undefined;
        return envSet ? envSet.has(normName) : allExplicitSet.has(normName);
    });

    const displayChanges = allExplicitSet.size > 0 ? explicitChanges : changes;
    if (displayChanges.length === 0) {
        window.showInformationMessage(`All manifest dependencies in ${projectName} (${envLabel}) are up to date!`);
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
                platforms: [...c.platforms],
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
            existing.afterVer ||= c.afterVer;
            existing.beforeVer ||= c.beforeVer;
        }
    }

    const aggregatedChanges = Array.from(pkgChangeMap.values()).sort((a, b) => a.name.localeCompare(b.name));

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

    const selectedPkgNames = picked.filter((p) => !p.pkgChange.isRemoved).map((p) => p.pkgChange.name);
    if (selectedPkgNames.length === 0) {
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
    filterEnv?: string,
): Promise<void> {
    const items = await buildDeclaredPackageQuickPickItems(
        projectPath,
        {
            filterEnv,
            pickedByDefault: true,
        },
        manager,
    );
    const extractUniqueNames = (list: typeof items): string[] => [
        ...new Set(list.flatMap((s) => (s.declaredPkg ? [s.declaredPkg.pkgName] : []))),
    ];

    const totalUniqueNames = extractUniqueNames(items).length;
    if (totalUniqueNames === 0) {
        window.showInformationMessage('No declared packages found in this Pixi project manifest.');
        return;
    }

    const selected = await window.showQuickPick(items, {
        title: `Pixi: Select Packages to Upgrade (${projectName}${filterEnv ? ` - ${filterEnv}` : ''})`,
        placeHolder: 'Select packages to bump version constraints in manifest (all selected by default)',
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!selected || selected.length === 0) {
        return;
    }

    interface PinningStrategyItem extends QuickPickItem {
        strategy: 'semver' | 'minor' | 'major' | 'latest-up' | 'exact-version' | 'no-pin';
    }

    const strategyItems: PinningStrategyItem[] = [
        {
            label: 'Default (semver)',
            description: 'Standard SemVer: e.g. >=1.2.3, <2 (>=0.1.0, <0.2 for 0.x)',
            strategy: 'semver',
        },
        {
            label: 'Minor',
            description: 'Pin latest minor: e.g. >=1.2.3, <1.3',
            strategy: 'minor',
        },
        {
            label: 'Major',
            description: 'Pin latest major: e.g. >=1.2.3, <2',
            strategy: 'major',
        },
        {
            label: 'Latest-Up',
            description: 'Pin to latest or higher: e.g. >=1.2.3',
            strategy: 'latest-up',
        },
        {
            label: 'Exact Version',
            description: 'Pin exact solver version: e.g. ==1.2.3',
            strategy: 'exact-version',
        },
        {
            label: 'No Pin',
            description: 'Unconstrained: e.g. *',
            strategy: 'no-pin',
        },
    ];

    const chosenStrategy = await window.showQuickPick(strategyItems, {
        title: `Pixi: Select Pinning Strategy (${projectName})`,
        placeHolder: 'Select how version constraints should be updated in manifest (Default: semver)',
    });
    if (!chosenStrategy) {
        return;
    }

    const selectedNames = extractUniqueNames(selected);
    const isUpgradeAll = !filterEnv && selectedNames.length === totalUniqueNames;

    const upgradeArgs = isUpgradeAll ? ['upgrade'] : ['upgrade', ...selectedNames];
    if (filterEnv) {
        upgradeArgs.push('-e', filterEnv);
    }
    if (chosenStrategy.strategy) {
        upgradeArgs.push('--pinning-strategy', chosenStrategy.strategy);
    }
    const pkgSummary = selectedNames.length <= 4 ? selectedNames.join(', ') : `${selectedNames.length} packages`;

    await runPixiWithProgress(
        isUpgradeAll
            ? `Pixi: Upgrading all dependencies for ${projectName}...`
            : `Pixi: Upgrading ${pkgSummary} for ${projectName}...`,
        upgradeArgs,
        projectPath,
        manager,
        isUpgradeAll
            ? `Pixi: All dependencies upgraded successfully for ${projectName}.`
            : `Pixi: Upgraded ${pkgSummary} successfully for ${projectName}.`,
    );
}

export async function executeUnifiedUpdate(
    manager: PixiProjectManager,
    targetItem?: unknown,
    envName?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to update dependencies', targetItem);
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    const directEnv = extractEnvironmentName(targetItem, envName);

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
        await handleUpgradeDependencies(manager, projectPath, projectName, directEnv);
        return;
    }

    let selectedEnv: string | undefined = directEnv;
    if (!selectedEnv) {
        const envs = manager.getEnvironmentsForProject(projectPath);
        if (envs.length > 1) {
            const pick = await pickProjectEnvironmentName(manager, projectPath, {
                title: `Pixi: Select Target Environment (${projectName})`,
                placeHolder: `Select environment scope for ${chosenAction.label}`,
                includeAllOption: true,
            });

            if (pick === undefined) {
                return;
            }
            selectedEnv = pick ?? undefined;
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
        commands.registerCommand('pixi.update', async (targetItem?: unknown, envName?: string) => {
            await executeUnifiedUpdate(manager, targetItem, envName);
        }),
        commands.registerCommand('pixi.upgrade', async (targetItem?: unknown, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to upgrade dependencies',
                targetItem,
            );
            if (!projectPath) {
                return;
            }
            const projectName = manager.getProjectName(projectPath);
            const directEnv = extractEnvironmentName(targetItem, envName);
            await handleUpgradeDependencies(manager, projectPath, projectName, directEnv);
        }),
    ];
}
