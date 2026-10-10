import * as path from 'path';
import { commands, Disposable, env as vscodeEnv, QuickPickItem, QuickPickItemKind, window } from 'vscode';

import { PixiPackageSearchResult } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { normalizeFolderPath, revealDefinitionInManifest } from '../../common/execUtils';
import { sortPixiPackages } from '../../core/packageManager';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiPackage } from '../../core/types';
import {
    extractCommandContext,
    extractEnvironmentName,
    extractFeatureName,
    findPackageScope,
    getWorkspaceEnvironments,
    getWorkspaceFeatures,
    PackageScopeResult,
    pickPixiProject,
    pickTargetScope,
    resolveTargetEnvironment,
    TargetScope,
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

export function extractPackageNameFromSpec(spec: string): string {
    const cleaned = spec.trim();
    const name = cleaned.split(/[<>=~!\s\[]/)[0].trim();
    return name || cleaned;
}

export interface DeclaredPackageItem {
    pkgName: string;
    rawSpec: string;
    kind: 'conda' | 'pypi';
    scope: PackageScopeResult;
    scopeLabel: string;
}

export interface PickDeclaredPackageOptions {
    title?: string;
    placeHolder?: string;
    filterFeature?: string;
    filterEnv?: string;
    emptyWarning?: string;
}

export async function pickDeclaredPackage(
    projectPath: string,
    options?: PickDeclaredPackageOptions,
): Promise<DeclaredPackageItem | undefined> {
    const [features, envs] = await Promise.all([
        getWorkspaceFeatures(projectPath),
        getWorkspaceEnvironments(projectPath),
    ]);

    const targetFeatures = options?.filterFeature
        ? features.filter((f) => f.name === options.filterFeature)
        : options?.filterEnv
          ? features.filter((f) => {
                const envEntry = envs.find((e) => e.name === options.filterEnv);
                return f.name === 'default' || Boolean(envEntry?.features?.includes(f.name));
            })
          : features;

    interface DeclaredQuickPickItem extends QuickPickItem {
        declaredPkg?: DeclaredPackageItem;
    }

    const items: DeclaredQuickPickItem[] = [];

    // Sort features so 'default' comes first, followed by others alphabetically
    const sortedFeatures = [...targetFeatures].sort((a, b) => {
        if (a.name === 'default') {
            return -1;
        }
        if (b.name === 'default') {
            return 1;
        }
        return a.name.localeCompare(b.name);
    });

    const toQuickPickItems = (
        specs: string[],
        kind: 'conda' | 'pypi',
        scope: PackageScopeResult,
        scopeLabel: string,
    ): DeclaredQuickPickItem[] => {
        const isPypi = kind === 'pypi';
        const icon = isPypi ? '$(symbol-keyword)' : '$(package)';
        const badge = isPypi ? '[PyPI]' : '[Conda]';

        return specs.map((rawSpec) => {
            const pkgName = extractPackageNameFromSpec(rawSpec);
            const versionConstraint = rawSpec.slice(pkgName.length).trim();
            return {
                label: `${icon} ${pkgName}`,
                description: versionConstraint ? `${badge} ${versionConstraint}` : badge,
                detail: `Scope: ${scopeLabel}`,
                declaredPkg: {
                    pkgName,
                    rawSpec,
                    kind,
                    scope: { ...scope, isPypi },
                    scopeLabel,
                },
            };
        });
    };

    for (const f of sortedFeatures) {
        const hasDeps = f.dependencies.length > 0 || f.pypiDependencies.length > 0;
        if (!hasDeps) {
            continue;
        }

        const isDefault = f.name === 'default';
        const sectionTitle = isDefault ? 'Global Dependencies ([default])' : `Feature: ${f.name}`;

        items.push({
            label: sectionTitle,
            kind: QuickPickItemKind.Separator,
        });

        const scope: PackageScopeResult = isDefault
            ? { kind: 'global', isPypi: false }
            : { kind: 'feature', scopeName: f.name, isPypi: false };
        const scopeLabel = isDefault ? 'global dependencies' : `feature '${f.name}'`;

        items.push(...toQuickPickItems(f.dependencies, 'conda', scope, scopeLabel));
        items.push(...toQuickPickItems(f.pypiDependencies, 'pypi', scope, scopeLabel));
    }

    // Process inline environments if not filtering by feature
    if (!options?.filterFeature) {
        const targetEnvs = options?.filterEnv ? envs.filter((e) => e.name === options.filterEnv) : envs;

        for (const e of targetEnvs) {
            const hasInline = e.dependencies.length > 0 || e.pypiDependencies.length > 0;
            if (!hasInline) {
                continue;
            }

            const scopeLabel = `environment '${e.name}'`;
            const envScope: PackageScopeResult = { kind: 'environment', scopeName: e.name, isPypi: false };

            items.push({
                label: `Environment: ${e.name} (Inline Dependencies)`,
                kind: QuickPickItemKind.Separator,
            });

            items.push(...toQuickPickItems(e.dependencies, 'conda', envScope, scopeLabel));
            items.push(...toQuickPickItems(e.pypiDependencies, 'pypi', envScope, scopeLabel));
        }
    }

    if (items.length === 0) {
        window.showInformationMessage(
            options?.emptyWarning || 'No declared packages found in this Pixi project manifest.',
        );
        return undefined;
    }

    const pick = await window.showQuickPick(items, {
        title: options?.title || 'Pixi: Select Declared Package',
        placeHolder: options?.placeHolder || 'Choose a package declared in the manifest',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    return pick?.declaredPkg;
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
    targetScopeLabel?: string,
): Promise<boolean> {
    const projectName = path.basename(projectPath);
    const displayScope = targetScopeLabel || 'default';
    const progressTitle = `Pixi: Adding '${specsLabel}' (${sourceLabel}) to ${displayScope} in '${projectName}'...`;

    const successMsg = (output: string) => {
        const resolvedSpec = parseAddedSpecsFromOutput(output, specsLabel);
        return `Pixi: Successfully added ${resolvedSpec} (${sourceLabel}) to ${displayScope} in '${projectName}'.`;
    };

    return runPixiWithProgress(progressTitle, args, projectPath, manager, successMsg);
}

export async function executeRemovePackage(
    manager: PixiProjectManager,
    projectPath: string,
    pkg: Pick<PixiPackage, 'name' | 'kind'>,
    scopeOverride?: PackageScopeResult,
): Promise<void> {
    const scope = scopeOverride ?? (await findPackageScope(projectPath, pkg.name));
    if (!scope) {
        window.showInformationMessage(
            `Pixi: '${pkg.name}' is a transitive dependency (installed automatically) and cannot be removed directly from the manifest.`,
        );
        return;
    }

    const isPypi = scope.isPypi || pkg.kind === 'pypi';
    const args = ['remove'];
    if (isPypi) {
        args.push('--pypi');
    }
    if (scope.kind === 'feature' && scope.scopeName) {
        args.push('-f', scope.scopeName);
    } else if (scope.kind === 'environment' && scope.scopeName) {
        args.push('-e', scope.scopeName);
    }
    args.push(pkg.name);

    const projectName = path.basename(projectPath);
    const scopeLabel =
        scope.kind === 'feature'
            ? `feature '${scope.scopeName}'`
            : scope.kind === 'environment'
              ? `environment '${scope.scopeName}'`
              : 'global dependencies';
    const sourceLabel = isPypi ? 'PyPI' : 'Conda';
    await runPixiWithProgress(
        `Pixi: Removing '${pkg.name}' (${sourceLabel}) from ${scopeLabel} in '${projectName}'...`,
        args,
        projectPath,
        manager,
        `Pixi: Successfully removed '${pkg.name}' (${sourceLabel}) from ${scopeLabel} in '${projectName}'.`,
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
        commands.registerCommand('pixi.searchPackages', async (targetItem?: unknown) => {
            const targetProjectPath = normalizeFolderPath(targetItem);
            await showPackageSearchPicker(manager, undefined, targetProjectPath);
        }),
    );

    // Pixi: Add Package...
    disposables.push(
        commands.registerCommand(
            'pixi.addPackage',
            async (
                targetItem?: unknown,
                presetEnvOrScope?: string | TargetScope,
                initialPkg?: string | PixiPackageSearchResult,
            ) => {
                const projectPath = await pickPixiProject(manager, 'Select Pixi project to add package to', targetItem);
                if (!projectPath) {
                    return;
                }

                const envs = manager.getEnvironmentsForProject(projectPath);

                const featureTargetName = extractFeatureName(targetItem);
                const explicitScope: TargetScope | undefined =
                    typeof presetEnvOrScope === 'object' && presetEnvOrScope !== null && 'kind' in presetEnvOrScope
                        ? presetEnvOrScope
                        : featureTargetName
                          ? { kind: 'feature', name: featureTargetName }
                          : undefined;

                const directScopeName =
                    explicitScope?.name ||
                    (typeof presetEnvOrScope === 'string' && presetEnvOrScope.trim()) ||
                    extractEnvironmentName(targetItem);

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
                        directScopeName,
                        typeof initialPkg === 'string' ? initialPkg : undefined,
                    );
                }
                if (!promptResult) {
                    return;
                }

                const targetScope = explicitScope ?? (await pickTargetScope(projectPath, envs, directScopeName));
                if (targetScope === null) {
                    return;
                }

                const scopeArgs: string[] = [];
                let scopeLabel = 'global dependencies';
                if (targetScope.kind === 'feature' && targetScope.name) {
                    scopeArgs.push('-f', targetScope.name);
                    scopeLabel = `feature '${targetScope.name}'`;
                } else if (targetScope.kind === 'environment' && targetScope.name) {
                    scopeArgs.push('-e', targetScope.name);
                    scopeLabel = `environment '${targetScope.name}'`;
                }

                if (promptResult.kind === 'selected') {
                    const pkg = promptResult.pkg;
                    const spec = promptResult.spec;
                    const isPypi = pkg.sourceType === 'pypi';

                    const args = ['add'];
                    if (isPypi) {
                        args.push('--pypi');
                    }
                    args.push(...scopeArgs, spec);

                    const sourceLabel = isPypi ? 'PyPI' : `Conda (${pkg.channel || 'conda-forge'})`;
                    await executeAddPackage(manager, projectPath, args, spec, sourceLabel, scopeLabel);
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

                const args = ['add', ...scopeArgs, ...sourceConfig.args];
                await executeAddPackage(
                    manager,
                    projectPath,
                    args,
                    specs.join(', '),
                    sourceConfig.sourceLabel,
                    scopeLabel,
                );
            },
        ),
    );

    // Pixi: Remove Package...
    disposables.push(
        commands.registerCommand('pixi.removePackage', async (targetItem?: unknown) => {
            const ctx = extractCommandContext(targetItem);
            if (ctx.pkg && ctx.projectPath) {
                const { pkg, projectPath } = ctx;

                const scope: PackageScopeResult | undefined = ctx.featureName
                    ? ctx.featureName === 'default'
                        ? { kind: 'global', isPypi: pkg.kind === 'pypi' }
                        : { kind: 'feature', scopeName: ctx.featureName, isPypi: pkg.kind === 'pypi' }
                    : await findPackageScope(projectPath, pkg.name, ctx.envName);
                if (!scope) {
                    window
                        .showWarningMessage(
                            `'${pkg.name}' is a transitive dependency (installed automatically by another package) and cannot be removed directly from the manifest.`,
                            'Why is this installed?',
                        )
                        .then((action) => {
                            if (action === 'Why is this installed?') {
                                commands.executeCommand('pixi.whyPackage', targetItem);
                            }
                        });
                    return;
                }

                const scopeDesc =
                    scope.kind === 'feature'
                        ? `feature '${scope.scopeName}'`
                        : scope.kind === 'environment'
                          ? `environment '${scope.scopeName}'`
                          : 'global dependencies';

                const confirmed = await window.showWarningMessage(
                    `Are you sure you want to remove package '${pkg.name}' from ${scopeDesc}?`,
                    'Remove',
                );
                if (confirmed !== 'Remove') {
                    return;
                }

                return executeRemovePackage(manager, projectPath, pkg, scope);
            }

            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to remove package from',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const filterFeature = ctx.featureName;
            const filterEnv = ctx.envName && ctx.envName !== 'default' ? ctx.envName : undefined;

            const picked = await pickDeclaredPackage(projectPath, {
                title: 'Pixi: Remove Package',
                placeHolder: 'Select a declared package to remove from manifest',
                filterFeature,
                filterEnv,
                emptyWarning: 'No declared packages found in this Pixi project manifest.',
            });
            if (!picked) {
                return;
            }

            const confirmed = await window.showWarningMessage(
                `Are you sure you want to remove package '${picked.pkgName}' from ${picked.scopeLabel}?`,
                'Remove',
            );
            if (confirmed !== 'Remove') {
                return;
            }

            return executeRemovePackage(
                manager,
                projectPath,
                { name: picked.pkgName, kind: picked.kind },
                picked.scope,
            );
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
                const picked = await pickDeclaredPackage(projectPath, {
                    title: 'Select Package to Reveal in Manifest',
                    placeHolder: 'Select a declared package to jump to its definition',
                    emptyWarning: 'No declared packages found to reveal in manifest.',
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
                const picked = await pickDeclaredPackage(projectPath, {
                    title: 'Select Package to Copy Name',
                    placeHolder: 'Select a declared package to copy its name to clipboard',
                    emptyWarning: 'No declared packages found in manifest.',
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
