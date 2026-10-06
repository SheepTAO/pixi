import * as path from 'path';
import { commands, Disposable, env as vscodeEnv, QuickPickItem, window } from 'vscode';

import { PixiPackageSearchResult } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { normalizeFolderPath, revealDefinitionInManifest } from '../../common/execUtils';
import { sortPixiPackages } from '../../core/packageManager';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiPackage } from '../../core/types';
import {
    extractCommandContext,
    extractEnvironmentName,
    pickPixiProject,
    pickTargetEnvironment,
    resolveTargetEnvironment,
} from './common';
import {
    AddPackagePromptResult,
    promptAddPackageSource,
    promptAddPackageSpec,
    promptPackageVersionConstraint,
    showPackageSearchPicker,
} from './packageSearchPicker';
import { disposeTreeOutputChannel, showDependencyTreeCommand, whyPackageCommand } from './packageTreeViewer';

export * from './packageSearchPicker';
export * from './packageTreeViewer';

export interface PickPackageOptions {
    title: string;
    placeHolder: string;
    emptyWarning?: string;
    preferExplicit?: boolean;
    formatItem?: (pkg: PixiPackage) => QuickPickItem;
}

export async function pickPackageFromEnvironment(
    manager: PixiProjectManager,
    projectPath: string,
    targetEnvName: string | undefined | null,
    options: PickPackageOptions,
): Promise<{ pkg: PixiPackage; pkgName: string; envLabel: string; targetEnv?: string } | undefined> {
    const envs = manager.getEnvironmentsForProject(projectPath);
    const resolvedEnv =
        targetEnvName !== undefined
            ? targetEnvName
            : await resolveTargetEnvironment(envs, undefined, options.placeHolder);
    if (resolvedEnv === null) {
        return undefined;
    }
    const envLabel = resolvedEnv || (envs.length > 0 ? envs[0].pixiEnvName : 'default');
    const packages = await manager.getPackagesForEnvironment(envLabel, projectPath);
    let candidates = packages;
    if (options.preferExplicit) {
        const explicit = packages.filter((p) => p.is_explicit);
        if (explicit.length > 0) {
            candidates = explicit;
        }
    }
    if (candidates.length === 0) {
        window.showInformationMessage(options.emptyWarning || `No packages found in environment '${envLabel}'.`);
        return undefined;
    }
    const sorted = sortPixiPackages(candidates);
    const items = options.formatItem
        ? sorted.map((p) => ({ ...options.formatItem!(p), pkgName: p.name, pkg: p }))
        : sorted.map((p) => ({
              label: p.name,
              description: p.version ? `v${p.version}` : undefined,
              pkgName: p.name,
              pkg: p,
          }));
    const pick = await window.showQuickPick(items, {
        title: options.title,
        placeHolder: options.placeHolder,
        matchOnDescription: true,
    });
    if (!pick) {
        return undefined;
    }
    return { pkg: pick.pkg, pkgName: pick.pkgName, envLabel, targetEnv: resolvedEnv };
}

export function parseAddedSpecsFromOutput(output: string, fallback: string): string {
    const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const addedMatches = Array.from(cleanOutput.matchAll(/(?:✔|✓)\s*Added\s+([^\r\n]+)/g)).map((m) => m[1].trim());
    return addedMatches.length > 0 ? addedMatches.join(', ') : fallback;
}

export async function executeAddPackage(
    manager: PixiProjectManager,
    projectPath: string,
    args: string[],
    specsLabel: string,
    sourceLabel: string,
    targetEnv?: string,
): Promise<boolean> {
    const projectName = path.basename(projectPath);
    const displayEnv = targetEnv || 'default';
    const progressTitle = `Pixi: Adding '${specsLabel}' (${sourceLabel}) to environment '${displayEnv}' in '${projectName}'...`;

    const successMsg = (output: string) => {
        const resolvedSpec = parseAddedSpecsFromOutput(output, specsLabel);
        return `Pixi: Successfully added ${resolvedSpec} (${sourceLabel}) to environment '${displayEnv}' in '${projectName}'.`;
    };

    return runPixiWithProgress(progressTitle, args, projectPath, manager, successMsg);
}

export async function executeRemovePackage(
    manager: PixiProjectManager,
    projectPath: string,
    pkg: Pick<PixiPackage, 'name' | 'kind'>,
    targetEnv?: string,
): Promise<void> {
    const isPypi = pkg.kind === 'pypi';
    const args = ['remove'];
    if (isPypi) {
        args.push('--pypi');
    }
    if (targetEnv && targetEnv !== 'default') {
        args.push('-e', targetEnv);
    }
    args.push(pkg.name);

    const projectName = path.basename(projectPath);
    const displayEnv = targetEnv || 'default';
    const sourceLabel = isPypi ? 'PyPI' : 'Conda';
    await runPixiWithProgress(
        `Pixi: Removing '${pkg.name}' (${sourceLabel}) from environment '${displayEnv}' in '${projectName}'...`,
        args,
        projectPath,
        manager,
        `Pixi: Successfully removed '${pkg.name}' (${sourceLabel}) from environment '${displayEnv}' in '${projectName}'.`,
    );
}

export async function executeUpdatePackage(
    manager: PixiProjectManager,
    projectPath: string,
    pkgName: string,
    targetEnv?: string,
): Promise<void> {
    const projectName = path.basename(projectPath);
    const args = ['update'];
    if (targetEnv && targetEnv !== 'default') {
        args.push('-e', targetEnv);
    }
    args.push(pkgName);
    const displayEnv = targetEnv || 'default';
    await runPixiWithProgress(
        `Pixi: Updating package '${pkgName}' in '${displayEnv}' (${projectName})...`,
        args,
        projectPath,
        manager,
        `Pixi: Package '${pkgName}' updated successfully in '${displayEnv}'.`,
    );
}

export function registerPackageCommands(manager: PixiProjectManager): Disposable[] {
    const disposables: Disposable[] = [];

    // Pixi: Search Packages...
    disposables.push(
        commands.registerCommand('pixi.searchPackages', async (folderUri?: unknown) => {
            const targetProjectPath = normalizeFolderPath(folderUri);
            await showPackageSearchPicker(manager, undefined, targetProjectPath);
        }),
    );

    // Pixi: Add Package...
    disposables.push(
        commands.registerCommand(
            'pixi.addPackage',
            async (targetItem?: unknown, presetEnv?: string, initialPkg?: string | PixiPackageSearchResult) => {
                const projectPath = await pickPixiProject(manager, 'Select Pixi project to add package to', targetItem);
                if (!projectPath) {
                    return;
                }

                const envs = manager.getEnvironmentsForProject(projectPath);

                const directEnvName =
                    (typeof presetEnv === 'string' && presetEnv.trim()) || extractEnvironmentName(targetItem);

                let targetEnv: string | undefined;
                let isTargetEnvLocked = false;
                if (directEnvName) {
                    isTargetEnvLocked = true;
                    targetEnv = directEnvName === 'default' ? undefined : directEnvName;
                }

                let promptResult: AddPackagePromptResult | undefined;
                if (initialPkg && typeof initialPkg === 'object') {
                    const pkg = initialPkg;
                    const spec = await promptPackageVersionConstraint(pkg);
                    if (!spec) {
                        return;
                    }
                    promptResult = { kind: 'selected', pkg, spec };
                } else {
                    promptResult = await promptAddPackageSpec(
                        projectPath,
                        directEnvName,
                        typeof initialPkg === 'string' ? initialPkg : undefined,
                    );
                }
                if (!promptResult) {
                    return;
                }

                if (!isTargetEnvLocked) {
                    const picked = await pickTargetEnvironment(envs, 'add');
                    if (picked === null) {
                        return;
                    }
                    targetEnv = picked;
                }

                if (promptResult.kind === 'selected') {
                    const pkg = promptResult.pkg;
                    const spec = promptResult.spec;
                    const isPypi = pkg.sourceType === 'pypi';

                    const args = ['add'];
                    if (isPypi) {
                        args.push('--pypi');
                    }
                    if (targetEnv) {
                        args.push('-e', targetEnv);
                    }
                    args.push(spec);

                    const sourceLabel = isPypi ? 'PyPI' : `Conda (${pkg.channel || 'conda-forge'})`;
                    await executeAddPackage(manager, projectPath, args, spec, sourceLabel, targetEnv || directEnvName);
                    return;
                }

                const specs = promptResult.specs;
                if (specs.length === 0) {
                    return;
                }

                const sourceConfig = await promptAddPackageSource(projectPath, specs);
                if (!sourceConfig) {
                    return;
                }

                const args = ['add'];
                if (targetEnv) {
                    args.push('-e', targetEnv);
                }
                args.push(...sourceConfig.args);

                await executeAddPackage(
                    manager,
                    projectPath,
                    args,
                    specs.join(', '),
                    sourceConfig.sourceLabel,
                    targetEnv || directEnvName,
                );
            },
        ),
    );

    // Pixi: Remove Package...
    disposables.push(
        commands.registerCommand('pixi.removePackage', async (targetItem?: unknown) => {
            const ctx = extractCommandContext(targetItem);
            if (ctx.pkg && ctx.env && ctx.projectPath) {
                const { pkg, env, projectPath } = ctx;
                const envName = env.pixiEnvName;

                if (!pkg.is_explicit) {
                    window
                        .showWarningMessage(
                            `'${pkg.name}' is a transitive dependency (installed automatically by another package) and cannot be removed directly. Remove the top-level package that depends on it.`,
                            'Why is this installed?',
                        )
                        .then((action) => {
                            if (action === 'Why is this installed?') {
                                commands.executeCommand('pixi.whyPackage', targetItem);
                            }
                        });
                    return;
                }

                const confirmed = await window.showWarningMessage(
                    `Are you sure you want to remove package '${pkg.name}' from environment '${envName}'?`,
                    'Remove',
                );
                if (confirmed !== 'Remove') {
                    return;
                }

                return executeRemovePackage(manager, projectPath, pkg, envName);
            }

            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to remove package from',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const directEnvName = extractEnvironmentName(targetItem);
            const targetEnvName = directEnvName === 'default' ? undefined : directEnvName;

            const picked = await pickPackageFromEnvironment(manager, projectPath, targetEnvName, {
                title: 'Pixi: Remove Package',
                placeHolder: 'Select a package to remove',
                emptyWarning: 'No packages found to remove in this environment.',
                preferExplicit: true,
                formatItem: (p) => {
                    const channelBadge = p.kind === 'pypi' ? '[PyPI]' : '[Conda]';
                    const explicitBadge = p.is_explicit ? '' : ' (transitive)';
                    return {
                        label: p.name,
                        description: `${channelBadge} ${p.version}${explicitBadge}`,
                    };
                },
            });
            if (!picked) {
                return;
            }

            if (!picked.pkg.is_explicit) {
                const proceed = await window.showWarningMessage(
                    `'${picked.pkg.name}' is marked as a transitive dependency. Removing it directly may fail if it is not declared in the manifest. Continue?`,
                    'Remove Anyway',
                );
                if (proceed !== 'Remove Anyway') {
                    return;
                }
            }

            return executeRemovePackage(manager, projectPath, picked.pkg, picked.targetEnv);
        }),
    );

    // Pixi: Show Dependency Tree
    disposables.push(
        commands.registerCommand('pixi.showDependencyTree', async (targetItem?: unknown) => {
            await showDependencyTreeCommand(manager, targetItem);
        }),
    );

    // Pixi: Why is This Package Installed? (Reverse Tree)
    disposables.push(
        commands.registerCommand('pixi.whyPackage', async (targetItem?: unknown) => {
            await whyPackageCommand(manager, targetItem);
        }),
    );

    // Pixi: Update Package
    disposables.push(
        commands.registerCommand('pixi.updatePackage', async (targetItem?: unknown) => {
            const ctx = extractCommandContext(targetItem);
            if (ctx.pkg && ctx.env && ctx.projectPath) {
                return executeUpdatePackage(manager, ctx.projectPath, ctx.pkg.name, ctx.env.pixiEnvName);
            }

            const projectPath = await pickPixiProject(manager, 'Select Pixi project to update package in', targetItem);
            if (!projectPath) {
                return;
            }

            const targetEnv = extractEnvironmentName(targetItem);
            const picked = await pickPackageFromEnvironment(manager, projectPath, targetEnv, {
                title: 'Pixi: Update Package',
                placeHolder: 'Select a package to update to latest compatible version',
                formatItem: (p) => {
                    const channelBadge = p.kind === 'pypi' ? '[PyPI]' : '[Conda]';
                    const explicitBadge = p.is_explicit ? 'explicit' : 'transitive';
                    return {
                        label: `${p.is_explicit ? '$(package)' : '$(symbol-field)'} ${p.name}`,
                        description: p.version
                            ? `${channelBadge} v${p.version} (${explicitBadge})`
                            : `${channelBadge} (${explicitBadge})`,
                    };
                },
            });
            if (!picked) {
                return;
            }

            return executeUpdatePackage(manager, projectPath, picked.pkgName, picked.targetEnv);
        }),
    );

    // Pixi: Reveal Package in Manifest (pixi.toml / pyproject.toml)
    disposables.push(
        commands.registerCommand('pixi.revealPackageInManifest', async (targetItem?: unknown) => {
            const ctx = extractCommandContext(targetItem);
            let pkgName = ctx.pkgName;
            let projectPath = ctx.projectPath;
            const manifestPath = ctx.manifestPath;

            if (!projectPath) {
                projectPath = await pickPixiProject(manager, 'Select Pixi project', targetItem);
                if (!projectPath) {
                    return;
                }
            }

            if (!pkgName) {
                const picked = await pickPackageFromEnvironment(manager, projectPath, undefined, {
                    title: 'Select Package to Reveal in Manifest',
                    placeHolder: 'Select a package to jump to its definition',
                    emptyWarning: 'No packages found to reveal in manifest.',
                    preferExplicit: true,
                });
                if (!picked) {
                    return;
                }
                pkgName = picked.pkgName;
            }

            await revealDefinitionInManifest({
                manifestPath: manifestPath || manager.getManifestPath(projectPath),
                targetName: pkgName,
                kind: 'package',
            });
        }),
    );

    // Pixi: Copy Package Name
    disposables.push(
        commands.registerCommand('pixi.copyPackageName', async (targetItem?: unknown) => {
            const ctx = extractCommandContext(targetItem);
            let pkgName = ctx.pkgName;

            if (!pkgName) {
                const projectPath = await pickPixiProject(
                    manager,
                    'Select Pixi project to copy package from',
                    targetItem,
                );
                if (!projectPath) {
                    return;
                }
                const picked = await pickPackageFromEnvironment(manager, projectPath, undefined, {
                    title: 'Select Package to Copy Name',
                    placeHolder: 'Select a package to copy its name to clipboard',
                });
                if (!picked) {
                    return;
                }
                pkgName = picked.pkgName;
            }

            await vscodeEnv.clipboard.writeText(pkgName);
            window.showInformationMessage(`Copied '${pkgName}' to clipboard.`);
        }),
    );

    disposables.push({
        dispose: () => {
            disposeTreeOutputChannel();
        },
    });

    return disposables;
}
