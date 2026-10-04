import * as path from 'path';
import {
    CancellationError,
    CancellationTokenSource,
    commands,
    Disposable,
    env as vscodeEnv,
    OutputChannel,
    ProgressLocation,
    QuickPickItem,
    QuickPickItemKind,
    Uri,
    window,
    workspace,
} from 'vscode';

import { PixiPackageSearchResult, runPixi, searchPixiPackages } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { escapeRegex, normalizeFolderPath, revealDefinitionInManifest } from '../../common/execUtils';
import { sortPixiPackages } from '../../core/packageManager';
import { getProjectConfiguredChannels } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiEnvironmentInfo, PixiPackage } from '../../core/types';
import { handleGlobalInstall } from '../globalCommands';
import {
    EnvironmentContextCandidate,
    extractEnvironmentName,
    pickPixiProject,
    pickTargetEnvironment,
    resolveTargetEnvironment,
} from './common';

export type SourceMode = 'conda' | 'pypi' | 'pypi-custom' | 'path' | 'git';

interface SourceQuickPickItem extends QuickPickItem {
    mode: SourceMode;
}

interface SearchResultQuickPickItem extends QuickPickItem {
    pkg?: PixiPackageSearchResult;
}

interface PackageItemContextCandidate extends EnvironmentContextCandidate {
    pkg?: PixiPackage;
    env?: PixiEnvironmentInfo;
    project?: { projectPath?: string; manifestPath?: string };
    manifestPath?: string;
    name?: string;
}

interface ExtractedPackageContext {
    pkg?: PixiPackage;
    env?: PixiEnvironmentInfo;
    projectPath?: string;
    manifestPath?: string;
    name?: string;
}

function extractPackageContext(arg?: unknown): ExtractedPackageContext {
    const item = arg as PackageItemContextCandidate | undefined;
    return {
        pkg: item?.pkg,
        env: item?.env,
        projectPath: item?.project?.projectPath || item?.env?.projectPath,
        manifestPath: item?.manifestPath || item?.project?.manifestPath || item?.env?.manifestPath,
        name:
            item?.pkg?.name ||
            (typeof item?.name === 'string' ? item.name : undefined) ||
            (typeof arg === 'string' ? arg : undefined),
    };
}

interface PickPackageOptions {
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

function createPackageQuickPickItem(pkg: PixiPackageSearchResult): SearchResultQuickPickItem {
    const isPypi = pkg.sourceType === 'pypi';
    const icon = isPypi ? '$(symbol-keyword)' : '$(package)';
    const sourceTag = isPypi ? '[PyPI]' : `[Conda: ${pkg.channel}]`;
    return {
        label: `${icon} ${pkg.name}`,
        description: `v${pkg.latestVersion}  •  ${sourceTag}`,
        detail: pkg.summary || (isPypi ? 'Python Package Index (pypi.org)' : `Platforms: ${pkg.platforms.join(', ')}`),
        pkg,
    };
}

async function promptPackageVersionConstraint(pkg: PixiPackageSearchResult): Promise<string | undefined> {
    const isPypi = pkg.sourceType === 'pypi';
    const versionConstraint = await window.showQuickPick(
        [
            {
                label: `$(check) Latest (>= ${pkg.latestVersion})`,
                description: 'Allow minor and patch updates (Recommended)',
                spec: `${pkg.name}>=${pkg.latestVersion}`,
            },
            {
                label: `$(pin) Exact (== ${pkg.latestVersion})`,
                description: 'Pin to exact current version',
                spec: `${pkg.name}==${pkg.latestVersion}`,
            },
            {
                label: `$(symbol-variable) Any Version (*)`,
                description: 'No version constraint',
                spec: pkg.name,
            },
            {
                label: `$(edit) Custom constraint...`,
                description: 'Enter a custom constraint',
                spec: 'custom',
            },
        ],
        {
            title: `Pixi: Version Constraint for ${pkg.name} (${isPypi ? 'PyPI' : 'Conda'})`,
            placeHolder: 'Select version constraint rule',
        },
    );
    if (!versionConstraint) {
        return undefined;
    }

    if (versionConstraint.spec === 'custom') {
        const input = await window.showInputBox({
            title: `Pixi: Custom Constraint for ${pkg.name}`,
            prompt: 'Enter package name and version specification',
            value: `${pkg.name}>=${pkg.latestVersion}`,
            ignoreFocusOut: true,
        });
        if (!input || !input.trim()) {
            return undefined;
        }
        return input.trim();
    }

    return versionConstraint.spec;
}

function parseAddedSpecsFromOutput(output: string, fallback: string): string {
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

export async function showPackageSearchPicker(
    manager: PixiProjectManager,
    initialQuery?: string,
    targetProjectPath?: string,
): Promise<void> {
    const quickPick = window.createQuickPick<SearchResultQuickPickItem>();
    quickPick.title = 'Pixi: Search Packages (Conda & PyPI)';
    quickPick.placeholder = 'Type package name to search Conda & PyPI... (e.g. numpy, uv, torch, ruff)';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    let debounceTimer: NodeJS.Timeout | undefined;
    let searchCts: CancellationTokenSource | undefined;
    const projectChannels = targetProjectPath ? getProjectConfiguredChannels(targetProjectPath) : [];

    const performSearch = (query: string) => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        if (searchCts) {
            searchCts.cancel();
            searchCts.dispose();
        }

        const trimmed = query.trim();
        if (trimmed.length < 2) {
            quickPick.items = [
                {
                    label: '$(info) Start typing to search...',
                    description: 'Enter at least 2 characters to search Conda and PyPI packages',
                    alwaysShow: true,
                },
            ];
            quickPick.busy = false;
            return;
        }

        quickPick.busy = true;
        debounceTimer = setTimeout(async () => {
            searchCts = new CancellationTokenSource();
            const token = searchCts.token;

            try {
                const results = await searchPixiPackages(
                    trimmed,
                    { cwd: targetProjectPath, channels: projectChannels },
                    token,
                );
                if (token.isCancellationRequested) {
                    return;
                }

                if (results.length === 0) {
                    quickPick.items = [
                        {
                            label: '$(info) No packages found',
                            description: `No Conda or PyPI packages matching "${trimmed}"`,
                            alwaysShow: true,
                        },
                    ];
                } else {
                    quickPick.items = results.map(createPackageQuickPickItem);
                }
            } catch (err: unknown) {
                if (!token.isCancellationRequested) {
                    const rawMsg = (err instanceof Error ? err.message : String(err)).trim();
                    const firstLine = rawMsg.split(/\r?\n/)[0] || rawMsg;
                    quickPick.items = [
                        {
                            label: '$(warning) Search failed',
                            description: firstLine,
                            detail: rawMsg.length > firstLine.length ? rawMsg : undefined,
                            alwaysShow: true,
                        },
                    ];
                }
            } finally {
                if (!token.isCancellationRequested) {
                    quickPick.busy = false;
                }
            }
        }, 300);
    };

    quickPick.onDidChangeValue((val) => performSearch(val));

    quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (!selected || !selected.pkg) {
            return;
        }
        const pkg = selected.pkg;
        quickPick.hide();

        await handlePackageSearchSelection(manager, pkg, targetProjectPath);
    });

    quickPick.onDidHide(() => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        if (searchCts) {
            searchCts.cancel();
            searchCts.dispose();
        }
        quickPick.dispose();
    });

    quickPick.show();
    if (initialQuery && initialQuery.trim()) {
        quickPick.value = initialQuery.trim();
        performSearch(initialQuery.trim());
    } else {
        performSearch('');
    }
}

async function handlePackageSearchSelection(
    manager: PixiProjectManager,
    pkg: PixiPackageSearchResult,
    targetProjectPath?: string,
): Promise<void> {
    const projects = manager.getProjects();
    const hasProjects = projects.length > 0;
    const isPypi = pkg.sourceType === 'pypi';

    interface ActionQuickPickItem extends QuickPickItem {
        action: 'add-project' | 'install-global' | 'open-browser' | 'copy';
    }

    const actions: ActionQuickPickItem[] = [];
    if (hasProjects) {
        actions.push({
            label: '$(plus) Add to Project Environment',
            description: `Add ${pkg.name} (${pkg.latestVersion}) to workspace Pixi project (${isPypi ? 'PyPI' : 'Conda'})`,
            action: 'add-project',
        });
    }
    if (!isPypi) {
        actions.push({
            label: '$(tools) Install Globally as CLI Tool',
            description: `Install into Pixi global environment (pixi global install ${pkg.name})`,
            action: 'install-global',
        });
        actions.push({
            label: '$(globe) View on Prefix.dev',
            description: 'Open prefix.dev package page in external browser',
            action: 'open-browser',
        });
    } else {
        actions.push({
            label: '$(symbol-keyword) View on PyPI',
            description: 'Open pypi.org project page in external browser',
            action: 'open-browser',
        });
    }
    actions.push({
        label: '$(copy) Copy Dependency String',
        description: `Copy "${pkg.name}>=${pkg.latestVersion}" to clipboard`,
        action: 'copy',
    });

    const actionPick = await window.showQuickPick(actions, {
        title: `Pixi: Package ${pkg.name} (v${pkg.latestVersion}) • ${isPypi ? 'PyPI' : `Conda (${pkg.channel})`}`,
        placeHolder: `Select action for package '${pkg.name}'`,
    });
    if (!actionPick) {
        return;
    }

    switch (actionPick.action) {
        case 'add-project': {
            const projectPath =
                targetProjectPath || (await pickPixiProject(manager, `Select Pixi project to add ${pkg.name} to`));
            if (!projectPath) {
                return;
            }

            const finalSpec = await promptPackageVersionConstraint(pkg);
            if (!finalSpec) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const targetEnv = await pickTargetEnvironment(envs, 'add');
            if (targetEnv === null) {
                return;
            }

            const args = ['add'];
            if (isPypi) {
                args.push('--pypi');
            }
            if (targetEnv) {
                args.push('-e', targetEnv);
            }
            args.push(finalSpec);

            const sourceLabel = isPypi ? 'PyPI' : `Conda (${pkg.channel || 'conda-forge'})`;
            await executeAddPackage(manager, projectPath, args, finalSpec, sourceLabel, targetEnv);
            break;
        }

        case 'install-global': {
            await handleGlobalInstall(pkg.name);
            break;
        }

        case 'open-browser': {
            if (isPypi) {
                const url = `https://pypi.org/project/${encodeURIComponent(pkg.name)}/`;
                await vscodeEnv.openExternal(Uri.parse(url));
            } else {
                const primaryChan = pkg.channel.split(',')[0].trim() || 'conda-forge';
                const url = `https://prefix.dev/channels/${encodeURIComponent(primaryChan)}/packages/${encodeURIComponent(pkg.name)}`;
                await vscodeEnv.openExternal(Uri.parse(url));
            }
            break;
        }

        case 'copy': {
            const specStr = `${pkg.name}>=${pkg.latestVersion}`;
            await vscodeEnv.clipboard.writeText(specStr);
            window.showInformationMessage(`Copied "${specStr}" to clipboard.`);
            break;
        }
    }
}

export type AddPackagePromptResult =
    | {
          kind: 'selected';
          pkg: PixiPackageSearchResult;
          spec: string;
      }
    | {
          kind: 'direct';
          specs: string[];
      };

async function promptAddPackageSpec(
    projectPath: string,
    targetEnvName?: string,
): Promise<AddPackagePromptResult | undefined> {
    return new Promise((resolve) => {
        interface AddPackageQuickPickItem extends QuickPickItem {
            pkg?: PixiPackageSearchResult;
            isDirectInput?: boolean;
        }

        const projectChannels = getProjectConfiguredChannels(projectPath);

        const quickPick = window.createQuickPick<AddPackageQuickPickItem>();
        quickPick.title = targetEnvName
            ? `Pixi: Add Package to '${targetEnvName}' (Search Conda & PyPI)`
            : 'Pixi: Add Package (Search Conda & PyPI)';
        quickPick.placeholder =
            'Type package name to search or enter spec (e.g. numpy>=1.26, requests, or press Enter)';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;

        let debounceTimer: NodeJS.Timeout | undefined;
        let searchCts: CancellationTokenSource | undefined;
        let resolved = false;

        const updateItems = (query: string) => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            if (searchCts) {
                searchCts.cancel();
                searchCts.dispose();
            }

            const trimmed = query.trim();
            const directItem: AddPackageQuickPickItem[] = trimmed
                ? [
                      {
                          label: `$(edit) Add: "${trimmed}"`,
                          description: 'Press Enter to select source channel and install directly',
                          alwaysShow: true,
                          isDirectInput: true,
                      },
                  ]
                : [];

            if (trimmed.length < 2) {
                quickPick.items = [
                    ...directItem,
                    {
                        label: '$(info) Start typing to search...',
                        description: 'Type at least 2 characters to search Conda & PyPI packages with live suggestions',
                        alwaysShow: true,
                    },
                ];
                quickPick.busy = false;
                return;
            }

            quickPick.items = [
                ...directItem,
                {
                    label: '$(sync~spin) Searching Conda & PyPI packages...',
                    description: `Looking up "${trimmed}"...`,
                    alwaysShow: true,
                },
            ];
            quickPick.busy = true;

            debounceTimer = setTimeout(async () => {
                searchCts = new CancellationTokenSource();
                const token = searchCts.token;

                try {
                    const results = await searchPixiPackages(
                        trimmed,
                        { cwd: projectPath, channels: projectChannels },
                        token,
                    );
                    if (token.isCancellationRequested) {
                        return;
                    }

                    const searchItems: AddPackageQuickPickItem[] = results.map(createPackageQuickPickItem);
                    quickPick.items = [...directItem, ...searchItems];
                } catch (err: unknown) {
                    if (!token.isCancellationRequested) {
                        const rawMsg = (err instanceof Error ? err.message : String(err)).trim();
                        const firstLine = rawMsg.split(/\r?\n/)[0] || rawMsg;
                        const errorItems: AddPackageQuickPickItem[] = [
                            {
                                label: `$(edit) Add: "${trimmed}"`,
                                description: 'Press Enter to select source channel and add directly to manifest',
                                alwaysShow: true,
                                isDirectInput: true,
                            },
                            {
                                label: '$(warning) Search failed',
                                description: firstLine,
                                detail: rawMsg.length > firstLine.length ? rawMsg : undefined,
                                alwaysShow: true,
                            },
                        ];
                        quickPick.items = errorItems;
                    }
                } finally {
                    if (!token.isCancellationRequested) {
                        quickPick.busy = false;
                    }
                }
            }, 300);
        };

        quickPick.onDidChangeValue((val) => updateItems(val));

        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0];
            const currentVal = quickPick.value.trim();

            if (
                selected?.label &&
                (selected.label.startsWith('$(warning) Search failed') ||
                    selected.label.startsWith('$(info) No packages'))
            ) {
                return;
            }

            quickPick.hide();
            resolved = true;

            if (selected?.pkg) {
                const pkg = selected.pkg;
                const finalSpec = await promptPackageVersionConstraint(pkg);
                if (!finalSpec) {
                    resolve(undefined);
                    return;
                }

                resolve({
                    kind: 'selected',
                    pkg,
                    spec: finalSpec,
                });
            } else if (selected?.isDirectInput || currentVal) {
                const rawSpec =
                    selected?.isDirectInput && currentVal
                        ? currentVal
                        : selected?.label && selected.label.startsWith('$(edit) Add: "')
                          ? selected.label.slice('$(edit) Add: "'.length).replace(/["].*$/, '')
                          : currentVal;
                const specs = rawSpec.trim().split(/\s+/).filter(Boolean);
                if (specs.length === 0) {
                    resolve(undefined);
                } else {
                    resolve({
                        kind: 'direct',
                        specs,
                    });
                }
            } else {
                resolve(undefined);
            }
        });

        quickPick.onDidHide(() => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            if (searchCts) {
                searchCts.cancel();
                searchCts.dispose();
            }
            quickPick.dispose();
            if (!resolved) {
                resolve(undefined);
            }
        });

        quickPick.show();
        updateItems('');
    });
}

export function registerPackageCommands(manager: PixiProjectManager): Disposable[] {
    const disposables: Disposable[] = [];
    let treeOutputChannel: OutputChannel | undefined;

    function exactPackageRegex(name: string): string {
        return `^${escapeRegex(name)}$`;
    }

    function buildTreeArgs(envName?: string, isReverse?: boolean): string[] {
        const args = ['tree', '--color', 'never'];
        if (isReverse) {
            args.push('-i');
        }
        if (envName && envName !== 'default') {
            args.push('-e', envName);
        }
        return args;
    }

    function getTreeOutputChannel(): OutputChannel {
        if (!treeOutputChannel) {
            treeOutputChannel = window.createOutputChannel('Pixi Tree');
        }
        return treeOutputChannel;
    }

    async function displayTreeOutput(
        label: string,
        args: string[],
        projectPath: string,
        isReverse?: boolean,
        exactPkgName?: string,
    ): Promise<void> {
        const channel = getTreeOutputChannel();
        const treeKind = isReverse ? 'reverse dependency tree' : 'dependency tree';
        const bannerTitle = isReverse
            ? `Pixi Reverse Dependency Tree (Why Installed): ${label}`
            : `Pixi Dependency Tree: ${label}`;

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Pixi: Generating ${treeKind} for ${label}...`,
                    cancellable: true,
                },
                async (_progress, token) => {
                    const output = await runPixi(args, { cwd: projectPath }, token);
                    const divider = '─'.repeat(60);
                    const banner = [
                        divider,
                        bannerTitle,
                        `Directory: ${projectPath}`,
                        `Command: pixi ${args.join(' ')}`,
                        divider,
                        '',
                    ].join('\n');

                    let processedOutput = output;
                    if (isReverse && exactPkgName) {
                        const lines = output
                            .split(/\r?\n/)
                            .map((l) => l.trim())
                            .filter(Boolean);
                        const hasBranches = lines.some(
                            (l) => l.includes('└──') || l.includes('├──') || l.includes('│'),
                        );
                        if (!hasBranches) {
                            processedOutput += `\n\nℹ️  '${exactPkgName}' is a direct top-level dependency specified in your project manifest.\n    No other packages in this environment depend on it.\n`;
                        }
                    }

                    const fullContent = banner + processedOutput;
                    channel.clear();
                    channel.appendLine(fullContent);
                    channel.show(true);

                    const capitalizedKind = isReverse ? 'Reverse dependency tree' : 'Dependency tree';
                    window
                        .showInformationMessage(
                            `${capitalizedKind} for ${label} displayed in Pixi Tree output.`,
                            'Open in Editor',
                        )
                        .then(async (action) => {
                            if (action === 'Open in Editor') {
                                const doc = await workspace.openTextDocument({
                                    content: fullContent,
                                    language: 'text',
                                });
                                await window.showTextDocument(doc, { preview: true });
                            }
                        });
                },
            );
        } catch (err) {
            if (err instanceof CancellationError) {
                return;
            }
            const rawMsg = err instanceof Error ? err.message : String(err);
            if (
                rawMsg.includes('No dependencies matched the given regular expression') ||
                rawMsg.includes('Nothing depends on the given regular expression')
            ) {
                window.showWarningMessage(`No packages or dependencies matched '${label}' in this environment.`);
                return;
            }
            window.showErrorMessage(`Failed to generate ${treeKind}: ${rawMsg}`);
        }
    }

    // Pixi: Search Packages...
    disposables.push(
        commands.registerCommand('pixi.searchPackages', async (folderUri?: unknown) => {
            const targetProjectPath = normalizeFolderPath(folderUri);
            await showPackageSearchPicker(manager, undefined, targetProjectPath);
        }),
    );

    // Pixi: Add Package...
    disposables.push(
        commands.registerCommand('pixi.addPackage', async (targetItem?: unknown, presetEnv?: string) => {
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

            const promptResult = await promptAddPackageSpec(projectPath, directEnvName);
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

            const source = await window.showQuickPick<SourceQuickPickItem>(
                [
                    {
                        label: '$(package) Conda (default)',
                        description: 'Install as Conda package from project channels (writes to [dependencies])',
                        mode: 'conda',
                    },
                    {
                        label: '$(symbol-keyword) PyPI',
                        description: 'Install from official Python Package Index (writes to [pypi-dependencies])',
                        mode: 'pypi',
                    },
                    {
                        label: '$(globe) PyPI (Custom Index / Mirror...)',
                        description: 'Install from custom PyPI index/mirror (e.g. Tsinghua, Aliyun, private index)',
                        mode: 'pypi-custom',
                    },
                    {
                        label: '$(folder) Local Path / Editable...',
                        description: 'Install a local directory as a path or editable dependency',
                        mode: 'path',
                    },
                    {
                        label: '$(git-branch) Git Repository...',
                        description: 'Install dependency directly from Git repository URL',
                        mode: 'git',
                    },
                ],
                {
                    title: 'Pixi: Select Package Source Channel',
                    placeHolder: 'Choose package source channel or dependency type',
                },
            );
            if (!source) {
                return;
            }

            const args = ['add'];
            if (targetEnv) {
                args.push('-e', targetEnv);
            }

            let sourceLabel = 'Conda';

            if (source.mode === 'conda') {
                const projectChannels = getProjectConfiguredChannels(projectPath);
                const primaryChannel = projectChannels[0] || 'conda-forge';
                sourceLabel = `Conda (${primaryChannel})`;
                args.push(...specs);
            } else if (source.mode === 'pypi') {
                sourceLabel = 'PyPI';
                args.push('--pypi', ...specs);
            } else if (source.mode === 'pypi-custom') {
                const indexUrl = await window.showInputBox({
                    title: 'Pixi: Custom PyPI Index URL',
                    prompt: 'Enter custom PyPI index/mirror URL',
                    placeHolder: 'https://pypi.tuna.tsinghua.edu.cn/simple',
                    value: 'https://pypi.tuna.tsinghua.edu.cn/simple',
                    ignoreFocusOut: true,
                });
                if (!indexUrl || !indexUrl.trim()) {
                    return;
                }
                sourceLabel = `PyPI (${indexUrl.trim()})`;
                args.push('--pypi', '--index', indexUrl.trim(), ...specs);
            } else if (source.mode === 'path') {
                const folderUris = await window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Select Package Directory',
                    title: 'Pixi: Select Local Package Directory',
                    defaultUri: Uri.file(projectPath),
                });
                if (!folderUris || folderUris.length === 0) {
                    return;
                }
                const selectedDir = folderUris[0].fsPath;
                const relPath = path.relative(projectPath, selectedDir) || '.';

                const modePick = await window.showQuickPick(
                    [
                        {
                            label: '$(edit) Editable Mode (--editable)',
                            description: 'Changes to local source code reflect immediately (PyPI dependency)',
                            isPypi: true,
                            editable: true,
                        },
                        {
                            label: '$(symbol-keyword) PyPI Path Dependency',
                            description: 'Install as standard local PyPI dependency (non-editable)',
                            isPypi: true,
                            editable: false,
                        },
                        {
                            label: '$(package) Conda Path Dependency',
                            description: 'Install as local Conda path dependency',
                            isPypi: false,
                            editable: false,
                        },
                    ],
                    {
                        title: 'Pixi: Select Path Dependency Type',
                        placeHolder: 'Choose installation mode for local directory',
                    },
                );
                if (!modePick) {
                    return;
                }

                if (modePick.isPypi) {
                    args.push('--pypi');
                }
                if (modePick.editable) {
                    args.push('--editable');
                }
                sourceLabel = modePick.editable ? `Local Path (Editable: ${relPath})` : `Local Path (${relPath})`;
                args.push(...specs, '--path', relPath);
            } else if (source.mode === 'git') {
                const gitUrl = await window.showInputBox({
                    title: 'Pixi: Git Repository URL',
                    prompt: 'Enter Git repository URL (e.g. https://github.com/org/repo.git)',
                    placeHolder: 'https://github.com/org/repo.git',
                    ignoreFocusOut: true,
                });
                if (!gitUrl || !gitUrl.trim()) {
                    return;
                }

                const rev = await window.showInputBox({
                    title: 'Pixi: Git Branch, Tag, or Revision (Optional)',
                    prompt: 'Enter branch, tag, or commit hash (leave empty for default branch)',
                    placeHolder: 'e.g. main, v1.0.0, or commit hash',
                    ignoreFocusOut: true,
                });

                const revPart = rev && rev.trim() ? ` @ ${rev.trim()}` : '';
                sourceLabel = `Git (${gitUrl.trim()}${revPart})`;
                args.push(...specs, '--git', gitUrl.trim());
                if (rev && rev.trim()) {
                    args.push('--rev', rev.trim());
                }
            }

            await executeAddPackage(
                manager,
                projectPath,
                args,
                specs.join(', '),
                sourceLabel,
                targetEnv || directEnvName,
            );
        }),
    );

    // Pixi: Remove Package...
    disposables.push(
        commands.registerCommand('pixi.removePackage', async (targetItem?: unknown) => {
            const ctx = extractPackageContext(targetItem);
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
            const ctx = extractPackageContext(targetItem);
            if (ctx.pkg && ctx.env && ctx.projectPath) {
                const args = buildTreeArgs(ctx.env.pixiEnvName);
                args.push(exactPackageRegex(ctx.pkg.name));
                await displayTreeOutput(`package '${ctx.pkg.name}' in '${ctx.env.pixiEnvName}'`, args, ctx.projectPath);
                return;
            }

            if (ctx.env && ctx.projectPath) {
                const args = buildTreeArgs(ctx.env.pixiEnvName);
                await displayTreeOutput(`environment '${ctx.env.pixiEnvName}'`, args, ctx.projectPath);
                return;
            }

            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to view dependency tree for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const targetEnv = await resolveTargetEnvironment(
                envs,
                targetItem,
                'Select environment to view dependency tree for',
            );
            if (targetEnv === null) {
                return;
            }

            const envLabel = targetEnv || 'default';
            const action = await window.showQuickPick(
                [
                    {
                        label: '$(list-tree) Full Environment Dependency Tree',
                        description: `Show the full dependency tree for '${envLabel}'`,
                        mode: 'full' as const,
                    },
                    {
                        label: '$(filter) Filter by Package Name / Regex...',
                        description: `Show dependency tree for a specific package in '${envLabel}'`,
                        mode: 'filter' as const,
                    },
                ],
                {
                    title: `Pixi: Dependency Tree for '${envLabel}'`,
                    placeHolder: 'Select tree view mode',
                },
            );
            if (!action) {
                return;
            }

            const args = buildTreeArgs(targetEnv);

            if (action.mode === 'filter') {
                const pkgInput = await window.showInputBox({
                    title: 'Pixi: Filter Dependency Tree',
                    prompt: 'Enter package name or regular expression',
                    placeHolder: 'e.g. numpy, python, torch',
                });
                if (!pkgInput?.trim()) {
                    return;
                }
                args.push(pkgInput.trim());
                await displayTreeOutput(`package '${pkgInput.trim()}' in '${envLabel}'`, args, projectPath);
            } else {
                await displayTreeOutput(`environment '${envLabel}'`, args, projectPath);
            }
        }),
    );

    // Pixi: Why is This Package Installed? (Reverse Tree)
    disposables.push(
        commands.registerCommand('pixi.whyPackage', async (targetItem?: unknown) => {
            const ctx = extractPackageContext(targetItem);
            if (ctx.pkg && ctx.env && ctx.projectPath) {
                const args = buildTreeArgs(ctx.env.pixiEnvName, true);
                args.push(exactPackageRegex(ctx.pkg.name));
                await displayTreeOutput(
                    `package '${ctx.pkg.name}' in '${ctx.env.pixiEnvName}'`,
                    args,
                    ctx.projectPath,
                    true,
                    ctx.pkg.name,
                );
                return;
            }

            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to inspect package dependencies',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const targetEnv = await resolveTargetEnvironment(
                envs,
                targetItem,
                'Select environment to inspect package dependencies',
            );
            if (targetEnv === null) {
                return;
            }

            const envLabel = targetEnv || 'default';
            const packages = await manager.getPackagesForEnvironment(envLabel, projectPath);
            let targetPkgName: string | undefined;

            if (packages.length > 0) {
                const sorted = sortPixiPackages(packages);
                const transitivePkgs = sorted.filter((p) => !p.is_explicit);
                const explicitPkgs = sorted.filter((p) => p.is_explicit);

                const items: (QuickPickItem & { pkgName?: string })[] = [];

                if (transitivePkgs.length > 0) {
                    items.push({
                        label: 'Transitive Dependencies',
                        kind: QuickPickItemKind.Separator,
                    });
                    for (const p of transitivePkgs) {
                        items.push({
                            label: `$(symbol-field) ${p.name}`,
                            description: p.version ? `v${p.version} (transitive)` : '(transitive)',
                            pkgName: p.name,
                        });
                    }
                }

                if (explicitPkgs.length > 0) {
                    items.push({
                        label: 'Explicit Dependencies (Top-level)',
                        kind: QuickPickItemKind.Separator,
                    });
                    for (const p of explicitPkgs) {
                        items.push({
                            label: `$(package) ${p.name}`,
                            description: p.version ? `v${p.version} (explicit)` : '(explicit)',
                            pkgName: p.name,
                        });
                    }
                }

                const pick = await window.showQuickPick(items, {
                    title: `Pixi: Select Package to Inspect (${envLabel})`,
                    placeHolder: 'Select a package to see what depends on it (reverse dependency tree)',
                    matchOnDescription: true,
                });
                if (!pick || !pick.pkgName) {
                    return;
                }
                targetPkgName = pick.pkgName;
            } else {
                const input = await window.showInputBox({
                    title: `Pixi: Inspect Package in '${envLabel}'`,
                    prompt: 'Enter package name to find what depends on it',
                    placeHolder: 'e.g. libgcc, certifi, urllib3',
                });
                if (!input?.trim()) {
                    return;
                }
                targetPkgName = input.trim();
            }

            const args = buildTreeArgs(targetEnv, true);
            args.push(exactPackageRegex(targetPkgName));
            await displayTreeOutput(
                `package '${targetPkgName}' in '${envLabel}'`,
                args,
                projectPath,
                true,
                targetPkgName,
            );
        }),
    );

    // Pixi: Update Package
    disposables.push(
        commands.registerCommand('pixi.updatePackage', async (targetItem?: unknown) => {
            const ctx = extractPackageContext(targetItem);
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
            const ctx = extractPackageContext(targetItem);
            let pkgName = ctx.pkg?.name;
            let projectPath = ctx.projectPath;
            let manifestPath = ctx.manifestPath;

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
            const ctx = extractPackageContext(targetItem);
            let pkgName = ctx.name;

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
            treeOutputChannel?.dispose();
            treeOutputChannel = undefined;
        },
    });

    return disposables;
}
