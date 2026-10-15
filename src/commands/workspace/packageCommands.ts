import { commands, Disposable, env as vscodeEnv, QuickPickItem, QuickPickItemKind, window } from 'vscode';

import { PixiPackageSearchResult } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { normalizeFolderPath, revealDefinitionInManifest } from '../../common/execUtils';
import { getPackageKindBadge, sortPixiPackages, splitPackageSpec } from '../../core/packageManager';
import { PixiProjectManager } from '../../core/projectManager';
import {
    extractCommandContext,
    extractEnvironmentName,
    extractFeatureName,
    findPackageScope,
    formatScope,
    getScopeArgs,
    getWorkspaceEnvironments,
    getWorkspaceFeatures,
    PackageScopeResult,
    pickPixiProject,
    pickTargetScope,
    resolveTargetEnvironment,
    sortPixiFeatures,
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

export interface DeclaredQuickPickItem extends QuickPickItem {
    declaredPkg?: DeclaredPackageItem;
}

export async function buildDeclaredPackageQuickPickItems(
    projectPath: string,
    options?: Pick<PickDeclaredPackageOptions, 'filterFeature' | 'filterEnv'> & { pickedByDefault?: boolean },
): Promise<DeclaredQuickPickItem[]> {
    const [features, envs] = await Promise.all([
        getWorkspaceFeatures(projectPath),
        getWorkspaceEnvironments(projectPath),
    ]);

    const envFeatures = options?.filterEnv ? envs.find((e) => e.name === options.filterEnv)?.features : undefined;
    const targetFeatures = options?.filterFeature
        ? features.filter((f) => f.name === options.filterFeature)
        : options?.filterEnv
          ? features.filter((f) => f.name === 'default' || Boolean(envFeatures?.includes(f.name)))
          : features;

    const items: DeclaredQuickPickItem[] = [];
    const sortedFeatures = sortPixiFeatures(targetFeatures);

    const toQuickPickItems = (
        specs: string[],
        kind: 'conda' | 'pypi',
        scope: PackageScopeResult,
    ): DeclaredQuickPickItem[] => {
        const isPypi = kind === 'pypi';
        const icon = isPypi ? '$(symbol-keyword)' : '$(package)';
        const badge = getPackageKindBadge(kind);
        const scopeLabel = formatScope(scope);

        return specs.map((rawSpec) => {
            const { name: pkgName, constraint: versionConstraint } = splitPackageSpec(rawSpec);
            return {
                label: `${icon} ${pkgName}`,
                description: versionConstraint ? `${badge} ${versionConstraint}` : badge,
                detail: `Scope: ${scopeLabel}`,
                picked: options?.pickedByDefault,
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
            : { kind: 'feature', name: f.name, isPypi: false };

        items.push(...toQuickPickItems(f.dependencies, 'conda', scope));
        items.push(...toQuickPickItems(f.pypiDependencies, 'pypi', scope));
    }

    // Process inline environments if not filtering by feature
    if (!options?.filterFeature) {
        const targetEnvs = options?.filterEnv ? envs.filter((e) => e.name === options.filterEnv) : envs;

        for (const e of targetEnvs) {
            const hasInline = e.dependencies.length > 0 || e.pypiDependencies.length > 0;
            if (!hasInline) {
                continue;
            }

            const envScope: PackageScopeResult = { kind: 'environment', name: e.name, isPypi: false };

            items.push({
                label: `Environment: ${e.name} (Inline Dependencies)`,
                kind: QuickPickItemKind.Separator,
            });

            items.push(...toQuickPickItems(e.dependencies, 'conda', envScope));
            items.push(...toQuickPickItems(e.pypiDependencies, 'pypi', envScope));
        }
    }

    return items;
}

export async function pickDeclaredPackage(
    projectPath: string,
    options?: PickDeclaredPackageOptions,
): Promise<DeclaredPackageItem | undefined> {
    const items = await buildDeclaredPackageQuickPickItems(projectPath, options);

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
    const projectName = manager.getProjectName(projectPath);
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
    pkgName: string,
    scope: PackageScopeResult,
): Promise<void> {
    const args = ['remove'];
    if (scope.isPypi) {
        args.push('--pypi');
    }
    args.push(...getScopeArgs(scope), pkgName);

    const projectName = manager.getProjectName(projectPath);
    const scopeLabel = formatScope(scope);
    const sourceLabel = scope.isPypi ? 'PyPI' : 'Conda';
    await runPixiWithProgress(
        `Pixi: Removing '${pkgName}' (${sourceLabel}) from ${scopeLabel} in '${projectName}'...`,
        args,
        projectPath,
        manager,
        `Pixi: Successfully removed '${pkgName}' (${sourceLabel}) from ${scopeLabel} in '${projectName}'.`,
    );
}

export async function executeUpdatePackage(
    manager: PixiProjectManager,
    projectPath: string,
    pkgName: string,
    targetEnv?: string,
): Promise<void> {
    const projectName = manager.getProjectName(projectPath);
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
    async function resolveDeclaredPackageTarget(
        targetItem: unknown,
        projectPlaceHolder: string,
        pickerOptions: { title: string; placeHolder: string; emptyWarning: string },
    ): Promise<{ pkgName: string; manifestPath?: string } | undefined> {
        const ctx = extractCommandContext(targetItem);
        let { projectPath } = ctx;
        let pkgName = ctx.pkg?.name;

        if (!pkgName) {
            projectPath ||= await pickPixiProject(manager, projectPlaceHolder, targetItem);
            if (!projectPath) {
                return undefined;
            }
            const picked = await pickDeclaredPackage(projectPath, pickerOptions);
            if (!picked) {
                return undefined;
            }
            pkgName = picked.pkgName;
        }

        const manifestPath = ctx.manifestPath || (projectPath ? manager.getManifestPath(projectPath) : undefined);
        return { pkgName, manifestPath };
    }

    return [
        // Pixi: Search Packages...
        commands.registerCommand('pixi.searchPackages', async (targetItem?: unknown) => {
            const targetProjectPath = normalizeFolderPath(targetItem);
            await showPackageSearchPicker(targetProjectPath);
        }),

        // Pixi: Add Package...
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
                          ? featureTargetName === 'default'
                              ? { kind: 'global' }
                              : { kind: 'feature', name: featureTargetName }
                          : undefined;

                const directScopeName = explicitScope
                    ? (explicitScope.name ?? 'default')
                    : extractEnvironmentName(
                          targetItem,
                          typeof presetEnvOrScope === 'string' ? presetEnvOrScope : undefined,
                      );

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

                const scopeArgs = getScopeArgs(targetScope);
                const scopeLabel = formatScope(targetScope);

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

        // Pixi: Remove Package...
        commands.registerCommand('pixi.removePackage', async (targetItem?: unknown) => {
            const ctx = extractCommandContext(targetItem);
            if (ctx.pkg && ctx.projectPath) {
                const { pkg, projectPath } = ctx;

                const scope: PackageScopeResult | undefined = ctx.featureName
                    ? ctx.featureName === 'default'
                        ? { kind: 'global', isPypi: pkg.kind === 'pypi' }
                        : { kind: 'feature', name: ctx.featureName, isPypi: pkg.kind === 'pypi' }
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

                const scopeDesc = formatScope(scope);

                const confirmed = await window.showWarningMessage(
                    `Are you sure you want to remove package '${pkg.name}' from ${scopeDesc}?`,
                    'Remove',
                );
                if (confirmed !== 'Remove') {
                    return;
                }

                return executeRemovePackage(manager, projectPath, pkg.name, {
                    ...scope,
                    isPypi: scope.isPypi || pkg.kind === 'pypi',
                });
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

            return executeRemovePackage(manager, projectPath, picked.pkgName, picked.scope);
        }),

        // Pixi: Show Dependency Tree
        commands.registerCommand('pixi.showDependencyTree', async (targetItem?: unknown) => {
            await showDependencyTreeCommand(manager, targetItem);
        }),

        // Pixi: Why is This Package Installed? (Reverse Tree)
        commands.registerCommand('pixi.whyPackage', async (targetItem?: unknown) => {
            await whyPackageCommand(manager, targetItem);
        }),

        // Pixi: Update Package
        commands.registerCommand('pixi.updatePackage', async (targetItem?: unknown) => {
            const ctx = extractCommandContext(targetItem);
            if (ctx.pkg && ctx.projectPath) {
                return executeUpdatePackage(manager, ctx.projectPath, ctx.pkg.name, ctx.envName);
            }

            const projectPath = await pickPixiProject(manager, 'Select Pixi project to update package in', targetItem);
            if (!projectPath) {
                return;
            }

            const placeHolder = 'Select a package to update to latest compatible version';
            const envs = manager.getEnvironmentsForProject(projectPath);
            const targetEnv = await resolveTargetEnvironment(envs, targetItem, placeHolder);
            if (targetEnv === null) {
                return;
            }

            const envLabel = targetEnv || (envs.length > 0 ? envs[0].pixiEnvName : 'default');
            const packages = await manager.getPackagesForEnvironment(envLabel, projectPath);
            const updatablePackages = packages.filter((p) => !p.is_local && !p.is_editable);
            if (updatablePackages.length === 0) {
                window.showInformationMessage(
                    packages.length === 0
                        ? `No packages found in environment '${envLabel}'.`
                        : `No remotely updatable packages found in environment '${envLabel}'.`,
                );
                return;
            }

            const items = sortPixiPackages(updatablePackages).map((p) => {
                const channelBadge = getPackageKindBadge(p.kind);
                const explicitBadge = p.is_explicit ? 'explicit' : 'transitive';
                return {
                    label: `${p.is_explicit ? '$(package)' : '$(symbol-field)'} ${p.name}`,
                    description: p.version
                        ? `${channelBadge} v${p.version} (${explicitBadge})`
                        : `${channelBadge} (${explicitBadge})`,
                    pkgName: p.name,
                };
            });

            const picked = await window.showQuickPick(items, {
                title: 'Pixi: Update Package',
                placeHolder,
                matchOnDescription: true,
            });
            if (!picked) {
                return;
            }

            return executeUpdatePackage(manager, projectPath, picked.pkgName, targetEnv);
        }),

        // Pixi: Reveal Package in Manifest (pixi.toml / pyproject.toml)
        commands.registerCommand('pixi.revealPackageInManifest', async (targetItem?: unknown) => {
            const target = await resolveDeclaredPackageTarget(targetItem, 'Select Pixi project', {
                title: 'Select Package to Reveal in Manifest',
                placeHolder: 'Select a declared package to jump to its definition',
                emptyWarning: 'No declared packages found to reveal in manifest.',
            });
            if (!target) {
                return;
            }

            await revealDefinitionInManifest({
                manifestPath: target.manifestPath,
                targetName: target.pkgName,
                kind: 'package',
            });
        }),

        // Pixi: Copy Package Name
        commands.registerCommand('pixi.copyPackageName', async (targetItem?: unknown) => {
            const target = await resolveDeclaredPackageTarget(targetItem, 'Select Pixi project to copy package from', {
                title: 'Select Package to Copy Name',
                placeHolder: 'Select a declared package to copy its name to clipboard',
                emptyWarning: 'No declared packages found in manifest.',
            });
            if (!target) {
                return;
            }

            await vscodeEnv.clipboard.writeText(target.pkgName);
            window.showInformationMessage(`Copied '${target.pkgName}' to clipboard.`);
        }),

        { dispose: disposeTreeOutputChannel },
    ];
}
