import * as fs from 'fs';
import * as path from 'path';
import {
    CancellationTokenSource,
    commands,
    Disposable,
    env as vscodeEnv,
    QuickPickItem,
    Uri,
    window,
    workspace,
} from 'vscode';

import { PixiPackageSearchResult, runPixi, searchPixiPackages } from '../cli/pixiCli';
import { runPixiWithProgress } from '../cli/workspaceCli';
import { getProjectConfiguredChannels, isPixiProject } from '../core/projectDiscovery';
import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo, PixiPackage } from '../core/types';
import { handleGlobalInstall } from './globalCommands';

interface ProjectQuickPickItem extends QuickPickItem {
    projectPath: string;
}

export type SourceMode = 'conda' | 'pypi' | 'pypi-custom' | 'path' | 'git';

interface SourceQuickPickItem extends QuickPickItem {
    mode: SourceMode;
}

interface PackageQuickPickItem extends QuickPickItem {
    pkg: PixiPackage;
}

interface EnvQuickPickItem extends QuickPickItem {
    envName?: string;
}

export async function pickManifestFormat(): Promise<'pixi' | 'pyproject' | undefined> {
    const pick = await window.showQuickPick(
        [
            {
                label: '$(file-code) pixi.toml',
                description: 'Dedicated Pixi manifest format (Recommended)',
                format: 'pixi' as const,
            },
            {
                label: '$(file) pyproject.toml',
                description: 'Standard Python pyproject.toml format',
                format: 'pyproject' as const,
            },
        ],
        { placeHolder: 'Select manifest format for the new Pixi project' },
    );
    return pick?.format;
}

async function pickTargetEnvironment(
    envs: PixiEnvironmentInfo[],
    action: 'add' | 'remove',
): Promise<string | undefined | null> {
    if (envs.length <= 1) {
        return undefined;
    }

    const isAdd = action === 'add';
    const namedEnvs = envs.filter((e) => e.pixiEnvName !== 'default');
    const items: EnvQuickPickItem[] = [
        {
            label: '$(globe) Default',
            description: `${isAdd ? 'Default environment / feature (available to all environments)' : 'Default environment'}`,
            envName: undefined,
        },
        ...namedEnvs.map((e) => {
            let icon = '$(layers)';
            let statusText = '';
            if (e.pixiStatus === 'uninstalled') {
                icon = '$(cloud-download)';
                statusText = '(not installed)';
            } else if (e.pixiStatus === 'incompatible') {
                icon = '$(circle-slash)';
                statusText = '(incompatible)';
            }
            return {
                label: `${icon} ${e.pixiEnvName}`,
                description: statusText ? `${e.projectName} ${statusText}` : e.projectName,
                envName: e.pixiEnvName,
            };
        }),
    ];

    const selected = await window.showQuickPick(items, {
        title: `Pixi: Target Environment${isAdd ? ' (Optional)' : ''}`,
        placeHolder: `Select target environment or feature to ${action} package`,
    });

    if (!selected) {
        return null;
    }
    return selected.envName;
}

function normalizeFolderPath(folderUri?: Uri | any): string | undefined {
    if (!folderUri) {
        return undefined;
    }
    if (folderUri.project?.projectPath) {
        return folderUri.project.projectPath;
    }
    if (folderUri.env?.projectPath) {
        return folderUri.env.projectPath;
    }
    if (folderUri.fsPath) {
        let p = folderUri.fsPath;
        if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
            p = path.dirname(p);
        }
        return p;
    }
    return undefined;
}

async function resolveTargetFolder(folderUri?: Uri, placeHolder?: string): Promise<string | undefined> {
    const direct = normalizeFolderPath(folderUri);
    if (direct) {
        return direct;
    }

    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
        return undefined;
    }

    if (workspace.workspaceFolders.length === 1) {
        return workspace.workspaceFolders[0].uri.fsPath;
    }

    const pick = await window.showWorkspaceFolderPick({
        placeHolder: placeHolder || 'Select workspace folder',
    });
    return pick?.uri.fsPath;
}

async function pickPixiProject(
    manager: PixiProjectManager,
    placeHolder: string,
    folderUri?: Uri,
): Promise<string | undefined> {
    const direct = normalizeFolderPath(folderUri);
    const projectPaths = manager.getProjectPaths();

    if (direct) {
        if (isPixiProject(direct)) {
            return direct;
        }
        for (const p of projectPaths) {
            if (direct === p || direct.startsWith(p + path.sep)) {
                return p;
            }
        }
    }

    if (projectPaths.length === 0) {
        window.showWarningMessage('No Pixi projects found in the current workspace.');
        return undefined;
    }

    if (projectPaths.length === 1) {
        return projectPaths[0];
    }

    const items: ProjectQuickPickItem[] = projectPaths.map((p) => ({
        label: path.basename(p),
        description: p,
        projectPath: p,
    }));

    const selected = await window.showQuickPick(items, {
        placeHolder,
        title: 'Pixi: Select Project',
    });

    return selected?.projectPath;
}

async function openDocumentIfExists(filePath: string): Promise<void> {
    if (fs.existsSync(filePath)) {
        const doc = await workspace.openTextDocument(Uri.file(filePath));
        await window.showTextDocument(doc);
    }
}

interface SearchResultQuickPickItem extends QuickPickItem {
    pkg?: PixiPackageSearchResult;
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
            } catch (err: any) {
                if (!token.isCancellationRequested) {
                    quickPick.items = [
                        {
                            label: '$(warning) Search failed',
                            description: err?.message || String(err),
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

            const projectName = path.basename(projectPath);
            const displayEnv = targetEnv || 'default';
            const sourceLabel = isPypi ? 'PyPI' : `Conda (${pkg.channel || 'conda-forge'})`;
            const progressTitle = `Pixi: Adding '${finalSpec}' (${sourceLabel}) to environment '${displayEnv}' in '${projectName}'...`;

            const successMsg = (output: string) => {
                const resolvedSpec = parseAddedSpecsFromOutput(output, finalSpec);
                return `Pixi: Successfully added ${resolvedSpec} (${sourceLabel}) to environment '${displayEnv}' in '${projectName}'.`;
            };

            await runPixiWithProgress(progressTitle, args, projectPath, manager, successMsg);
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
                } catch {
                    if (!token.isCancellationRequested) {
                        quickPick.items = [...directItem];
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
                          ? selected.label.slice('$(edit) Add: "'.length, -1)
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

export function registerWorkspaceCommands(manager: PixiProjectManager): Disposable {
    const disposables: Disposable[] = [];

    // Pixi: Initialize Project...
    disposables.push(
        commands.registerCommand('pixi.init', async (folderUri?: Uri) => {
            const targetFolder = await resolveTargetFolder(folderUri, 'Select folder to initialize Pixi project in');
            if (!targetFolder) {
                window.showWarningMessage('Please open a folder to initialize a Pixi project.');
                return;
            }

            const pixiToml = path.join(targetFolder, 'pixi.toml');
            const pyprojectToml = path.join(targetFolder, 'pyproject.toml');
            const manifestPath = fs.existsSync(pixiToml)
                ? pixiToml
                : fs.existsSync(pyprojectToml)
                  ? pyprojectToml
                  : undefined;

            if (manifestPath) {
                window.showInformationMessage(
                    `A project manifest (${path.basename(manifestPath)}) already exists in this folder.`,
                );
                const doc = await workspace.openTextDocument(Uri.file(manifestPath));
                await window.showTextDocument(doc);
                return;
            }

            const format = await pickManifestFormat();
            if (!format) {
                return;
            }

            await runPixiWithProgress(
                'Pixi: Initializing project...',
                ['init', '--format', format, '.'],
                targetFolder,
                manager,
                'Pixi: Project initialized successfully.',
            );

            const createdManifest = format === 'pyproject' ? pyprojectToml : pixiToml;
            await openDocumentIfExists(createdManifest);
        }),
    );

    // Pixi: Create Environment...
    disposables.push(
        commands.registerCommand('pixi.createEnvironment', async (folderUri?: Uri) => {
            const targetFolder = await resolveTargetFolder(folderUri, 'Select folder to create Pixi environment in');
            if (!targetFolder) {
                window.showWarningMessage('Please open a folder to create a Pixi environment.');
                return;
            }

            if (isPixiProject(targetFolder)) {
                const existingEnvs = manager.getEnvironmentsForProject(targetFolder);
                const envName = await window.showInputBox({
                    title: 'Pixi: Create Environment',
                    prompt: 'Enter a name for the new environment',
                    placeHolder: 'e.g. dev, test, native',
                    validateInput: (value) => {
                        const trimmed = value?.trim();
                        if (!trimmed) {
                            return 'Environment name cannot be empty.';
                        }
                        if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
                            return 'Environment name must only contain alphanumeric characters, underscores, and hyphens.';
                        }
                        if (trimmed === 'default' || existingEnvs.some((e) => e.pixiEnvName === trimmed)) {
                            return `Environment '${trimmed}' already exists in this project.`;
                        }
                        return null;
                    },
                });
                if (!envName) {
                    return;
                }

                const trimmedName = envName.trim();
                await runPixiWithProgress(
                    `Pixi: Creating and installing environment '${trimmedName}'...`,
                    [
                        ['workspace', 'environment', 'add', trimmedName],
                        ['install', '-e', trimmedName],
                    ],
                    targetFolder,
                    manager,
                    `Pixi: Environment '${trimmedName}' created and ready.`,
                );
            } else {
                const format = await pickManifestFormat();
                if (!format) {
                    return;
                }

                await runPixiWithProgress(
                    'Pixi: Initializing project and environment...',
                    [['init', '--format', format, '.'], ['install']],
                    targetFolder,
                    manager,
                    'Pixi: Project and default environment initialized successfully.',
                );

                const createdManifest =
                    format === 'pyproject'
                        ? path.join(targetFolder, 'pyproject.toml')
                        : path.join(targetFolder, 'pixi.toml');
                await openDocumentIfExists(createdManifest);
            }
        }),
    );

    // Pixi: Delete Environment...
    disposables.push(
        commands.registerCommand('pixi.deleteEnvironment', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to delete environment from',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const hasPixiDir = fs.existsSync(path.join(projectPath, '.pixi'));
            if (envs.length === 0 && !hasPixiDir) {
                window.showInformationMessage('No installed environments found to delete in this project.');
                return;
            }

            const envItems = [
                ...envs.map((e) => {
                    let icon = '$(layers)';
                    let statusText = '';
                    if (e.pixiStatus === 'uninstalled') {
                        icon = '$(cloud-download)';
                        statusText = '(not installed)';
                    } else if (e.pixiStatus === 'incompatible') {
                        icon = '$(circle-slash)';
                        statusText = '(incompatible)';
                    }
                    return {
                        label: `${icon} ${e.pixiEnvName}`,
                        description: statusText,
                        envName: e.pixiEnvName,
                    };
                }),
                {
                    label: '$(trash) All Environments (.pixi)',
                    description: 'Clean all installed environments in .pixi directory',
                    envName: '__ALL__',
                },
            ];

            const selected = await window.showQuickPick(envItems, {
                title: 'Pixi: Delete Environment',
                placeHolder: 'Select an environment to delete or clean',
            });
            if (!selected) {
                return;
            }

            if (selected.envName === '__ALL__') {
                const confirmed = await window.showWarningMessage(
                    'Are you sure you want to clean all installed Pixi environments in this project? (Can be re-installed using pixi install)',
                    { modal: true },
                    'Clean All',
                );
                if (confirmed !== 'Clean All') {
                    return;
                }

                await runPixiWithProgress(
                    'Pixi: Cleaning all environments...',
                    ['clean'],
                    projectPath,
                    manager,
                    'Pixi: All environments cleaned.',
                );
                return;
            }

            const envName = selected.envName;
            if (envName === 'default') {
                const confirmed = await window.showWarningMessage(
                    "Delete the installed 'default' environment on disk? (Can be re-installed using pixi install)",
                    { modal: true },
                    'Delete',
                );
                if (confirmed !== 'Delete') {
                    return;
                }

                await runPixiWithProgress(
                    "Pixi: Deleting 'default' environment...",
                    ['clean', '-e', 'default'],
                    projectPath,
                    manager,
                    "Pixi: 'default' environment deleted from disk.",
                );
            } else {
                const choice = await window.showWarningMessage(
                    `Delete Pixi environment '${envName}'?`,
                    { modal: true },
                    'Delete from Disk & Manifest',
                    'Clean from Disk Only',
                );
                if (!choice) {
                    return;
                }

                const removeManifest = choice === 'Delete from Disk & Manifest';
                const cmds: string[][] = [['clean', '-e', envName]];
                if (removeManifest) {
                    cmds.push(['workspace', 'environment', 'remove', envName]);
                }
                await runPixiWithProgress(
                    `Pixi: Deleting environment '${envName}'...`,
                    cmds,
                    projectPath,
                    manager,
                    removeManifest
                        ? `Pixi: Environment '${envName}' deleted from disk and manifest.`
                        : `Pixi: Environment '${envName}' cleaned from disk.`,
                );
            }
        }),
    );

    // Pixi: Clean...
    disposables.push(
        commands.registerCommand('pixi.clean', async (target?: Uri | any) => {
            if (target && target.env && target.env.pixiEnvName && target.env.projectPath) {
                const envName = target.env.pixiEnvName;
                const projectPath = target.env.projectPath;
                const confirmed = await window.showWarningMessage(
                    `Are you sure you want to clean installed environment '${envName}' on disk?`,
                    { modal: true },
                    'Clean Environment',
                );
                if (confirmed === 'Clean Environment') {
                    await runPixiWithProgress(
                        `Pixi: Cleaning environment '${envName}'...`,
                        [['clean', '-e', envName]],
                        projectPath,
                        manager,
                        `Pixi: Environment '${envName}' cleaned.`,
                    );
                }
                return;
            }

            const projectPath = await pickPixiProject(manager, 'Select Pixi project to clean', target);
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const installedEnvs = envs.filter((e) => e.pixiStatus === 'installed');

            interface CleanQuickPickItem extends QuickPickItem {
                targetKind: 'env' | 'all' | 'global-cache';
                envName?: string;
            }

            const items: CleanQuickPickItem[] = [
                ...installedEnvs.map((e) => ({
                    label: `$(layers) ${e.pixiEnvName}`,
                    description: e.projectName,
                    targetKind: 'env' as const,
                    envName: e.pixiEnvName,
                })),
                {
                    label: '$(trash) All Environments (.pixi)',
                    description: 'Clean all installed environments in this project',
                    targetKind: 'all' as const,
                },
                {
                    label: '$(alert) Global Package Cache',
                    description: 'Clean system-wide package tarball and repodata cache',
                    targetKind: 'global-cache' as const,
                },
            ];

            const selected = await window.showQuickPick(items, {
                title: 'Pixi: Clean',
                placeHolder: 'Select an environment or cache to clean',
            });
            if (!selected) {
                return;
            }

            if (selected.targetKind === 'env') {
                const envName = selected.envName!;
                await runPixiWithProgress(
                    `Pixi: Cleaning environment '${envName}'...`,
                    [['clean', '-e', envName]],
                    projectPath,
                    manager,
                    `Pixi: Environment '${envName}' cleaned.`,
                );
            } else if (selected.targetKind === 'all') {
                await runPixiWithProgress(
                    'Pixi: Cleaning all environments...',
                    [['clean']],
                    projectPath,
                    manager,
                    'Pixi: All environments cleaned in this project.',
                );
            } else if (selected.targetKind === 'global-cache') {
                const confirmed = await window.showWarningMessage(
                    'Are you sure you want to clean the global Pixi package cache? Subsequent installations will re-download packages from the network.',
                    { modal: true },
                    'Clean Global Cache',
                );
                if (confirmed !== 'Clean Global Cache') {
                    return;
                }

                await runPixiWithProgress(
                    'Pixi: Cleaning global package cache...',
                    [['clean', 'cache', '-y']],
                    projectPath,
                    manager,
                    'Pixi: Global package cache cleaned.',
                );
            }
        }),
    );

    // Pixi: Lock Dependencies
    disposables.push(
        commands.registerCommand('pixi.lock', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to lock dependencies', folderUri);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            await runPixiWithProgress(
                `Pixi: Solving and locking dependencies for ${projectName}...`,
                ['lock'],
                projectPath,
                manager,
                `Pixi: Lockfile (pixi.lock) updated successfully for ${projectName}.`,
            );
        }),
    );

    // Pixi: Install (Sync Environments)
    disposables.push(
        commands.registerCommand('pixi.install', async (folderUri?: Uri, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to install and sync environments',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const resolvedEnv = (typeof envName === 'string' && envName.trim()) || (folderUri as any)?.env?.pixiEnvName;
            const validEnvName = resolvedEnv ? resolvedEnv.trim() : undefined;
            const args = ['install'];
            if (validEnvName) {
                args.push('-e', validEnvName);
            }
            await runPixiWithProgress(
                validEnvName
                    ? `Pixi: Installing environment '${validEnvName}' for ${projectName}...`
                    : `Pixi: Installing environments for ${projectName}...`,
                args,
                projectPath,
                manager,
                validEnvName
                    ? `Pixi: Environment '${validEnvName}' installed successfully for ${projectName}.`
                    : `Pixi: Environments synchronized successfully for ${projectName}.`,
            );
        }),
    );

    // Pixi: Reinstall Environment...
    disposables.push(
        commands.registerCommand('pixi.reinstall', async (folderUri?: Uri, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to reinstall environments',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const resolvedEnv = (typeof envName === 'string' && envName.trim()) || (folderUri as any)?.env?.pixiEnvName;
            const validEnvName = resolvedEnv ? resolvedEnv.trim() : undefined;

            const runReinstall = async (target?: string, isAll?: boolean) => {
                const title = target
                    ? `Pixi: Re-installing environment '${target}' for ${projectName}...`
                    : isAll
                      ? `Pixi: Re-installing all environments for ${projectName}...`
                      : `Pixi: Re-installing environments for ${projectName}...`;
                const args = target ? ['reinstall', '-e', target] : isAll ? ['reinstall', '--all'] : ['reinstall'];
                const successMsg = target
                    ? `Pixi: Environment '${target}' re-installed successfully for ${projectName}.`
                    : isAll
                      ? `Pixi: All environments re-installed successfully for ${projectName}.`
                      : `Pixi: Environments re-installed successfully for ${projectName}.`;
                await runPixiWithProgress(title, args, projectPath, manager, successMsg);
            };

            if (validEnvName) {
                return runReinstall(validEnvName);
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const validEnvs = envs.filter((e) => e.pixiStatus !== 'incompatible');

            if (validEnvs.length <= 1) {
                return runReinstall(validEnvs[0]?.pixiEnvName);
            }

            interface ReinstallQuickPickItem extends QuickPickItem {
                targetKind: 'env' | 'all';
                envName?: string;
            }

            const items: ReinstallQuickPickItem[] = [
                ...validEnvs.map((e) => ({
                    label: `$(layers) ${e.pixiEnvName}`,
                    description: e.projectName,
                    targetKind: 'env' as const,
                    envName: e.pixiEnvName,
                })),
                {
                    label: '$(sync) All Environments',
                    description: `Re-install all environments in ${projectName}`,
                    targetKind: 'all' as const,
                },
            ];

            const selected = await window.showQuickPick(items, {
                title: 'Pixi: Reinstall Environment',
                placeHolder: `Select an environment to reinstall in ${projectName}`,
            });
            if (!selected) {
                return;
            }

            if (selected.targetKind === 'env') {
                return runReinstall(selected.envName);
            } else {
                return runReinstall(undefined, true);
            }
        }),
    );

    // Pixi: Update Dependencies
    disposables.push(
        commands.registerCommand('pixi.update', async (folderUri?: Uri, envName?: string) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to update dependencies', folderUri);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const validEnvName = typeof envName === 'string' && envName.trim() ? envName.trim() : undefined;
            const args = ['update'];
            if (validEnvName) {
                args.push('-e', validEnvName);
            }
            await runPixiWithProgress(
                validEnvName
                    ? `Pixi: Updating dependencies for environment '${validEnvName}' in ${projectName}...`
                    : `Pixi: Updating dependencies for ${projectName}...`,
                args,
                projectPath,
                manager,
                validEnvName
                    ? `Pixi: Dependencies updated successfully for environment '${validEnvName}' in ${projectName}.`
                    : `Pixi: Dependencies updated successfully for ${projectName}.`,
            );
        }),
    );

    // Pixi: Search Packages...
    disposables.push(
        commands.registerCommand('pixi.searchPackages', async (folderUri?: Uri | any) => {
            const targetProjectPath = normalizeFolderPath(folderUri);
            await showPackageSearchPicker(manager, undefined, targetProjectPath);
        }),
    );

    // Pixi: Add Package...
    disposables.push(
        commands.registerCommand('pixi.addPackage', async (targetItem?: any, presetEnv?: string) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add package to', targetItem);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const envs = manager.getEnvironmentsForProject(projectPath);

            // Context-aware target environment resolution:
            // 1. If invoked directly on an Environment tree item (or explicit presetEnv), lock to that environment and skip picking.
            // 2. If invoked on Project tree item, title bar, or Command Palette, targetItem.env is undefined, so prompt for environment if needed.
            const directEnvName =
                (typeof presetEnv === 'string' && presetEnv.trim()) ||
                (typeof targetItem?.env?.pixiEnvName === 'string' && targetItem.env.pixiEnvName.trim()) ||
                (typeof targetItem?.envName === 'string' && targetItem.envName.trim()) ||
                undefined;

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

            // Mode 1: User explicitly picked a search result -> Source is already known (Conda vs PyPI)
            if (promptResult.kind === 'selected') {
                const pkg = promptResult.pkg;
                const spec = promptResult.spec;
                const isPypi = pkg.sourceType === 'pypi';

                if (!isTargetEnvLocked) {
                    const picked = await pickTargetEnvironment(envs, 'add');
                    if (picked === null) {
                        return;
                    }
                    targetEnv = picked;
                }

                const args = ['add'];
                if (isPypi) {
                    args.push('--pypi');
                }
                if (targetEnv) {
                    args.push('-e', targetEnv);
                }
                args.push(spec);

                const displayEnv = targetEnv || directEnvName || 'default';
                const sourceLabel = isPypi ? 'PyPI' : `Conda (${pkg.channel || 'conda-forge'})`;
                const progressTitle = `Pixi: Adding '${spec}' (${sourceLabel}) to environment '${displayEnv}' in '${projectName}'...`;

                const successMsg = (output: string) => {
                    const resolvedSpec = parseAddedSpecsFromOutput(output, spec);
                    return `Pixi: Successfully added ${resolvedSpec} (${sourceLabel}) to environment '${displayEnv}' in '${projectName}'.`;
                };

                await runPixiWithProgress(progressTitle, args, projectPath, manager, successMsg);
                return;
            }

            // Mode 2: User entered directly / pressed Enter on custom input -> Ask for source channel
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

            if (!isTargetEnvLocked) {
                const picked = await pickTargetEnvironment(envs, 'add');
                if (picked === null) {
                    return;
                }
                targetEnv = picked;
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

            const displayEnv = targetEnv || directEnvName || 'default';
            const progressTitle = `Pixi: Adding '${specs.join(', ')}' (${sourceLabel}) to environment '${displayEnv}' in '${projectName}'...`;

            const successMsg = (output: string) => {
                const resolvedSpecs = parseAddedSpecsFromOutput(output, specs.join(', '));
                return `Pixi: Successfully added ${resolvedSpecs} (${sourceLabel}) to environment '${displayEnv}' in '${projectName}'.`;
            };

            await runPixiWithProgress(progressTitle, args, projectPath, manager, successMsg);
        }),
    );

    // Pixi: Remove Package...
    disposables.push(
        commands.registerCommand('pixi.removePackage', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to remove package from', folderUri);
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const targetEnv = await pickTargetEnvironment(envs, 'remove');
            if (targetEnv === null) {
                return;
            }

            const queryEnv = targetEnv || envs[0]?.pixiEnvName || 'default';

            const packages = await manager.getPackagesForEnvironment(queryEnv, projectPath);

            const explicitPkgs = packages.filter((p) => p.is_explicit);
            const candidates = explicitPkgs.length > 0 ? explicitPkgs : packages;

            if (candidates.length === 0) {
                window.showInformationMessage(`No packages found to remove in environment '${queryEnv}'.`);
                return;
            }

            const items: PackageQuickPickItem[] = candidates.map((p) => {
                const channelBadge = p.kind === 'pypi' ? '[PyPI]' : '[Conda]';
                return {
                    label: p.name,
                    description: `${channelBadge} ${p.version}`,
                    pkg: p,
                };
            });

            const selected = await window.showQuickPick(items, {
                title: 'Pixi: Remove Package',
                placeHolder: `Select a package to remove from '${queryEnv}'`,
                matchOnDescription: true,
            });
            if (!selected) {
                return;
            }

            const isPypi = selected.pkg.kind === 'pypi';
            const args = ['remove'];
            if (isPypi) {
                args.push('--pypi');
            }
            if (targetEnv) {
                args.push('-e', targetEnv);
            }
            args.push(selected.pkg.name);

            const projectName = path.basename(projectPath);
            const displayEnv = targetEnv || 'default';
            const sourceLabel = isPypi ? 'PyPI' : 'Conda';
            await runPixiWithProgress(
                `Pixi: Removing '${selected.pkg.name}' (${sourceLabel}) from environment '${displayEnv}' in '${projectName}'...`,
                args,
                projectPath,
                manager,
                `Pixi: Successfully removed '${selected.pkg.name}' (${sourceLabel}) from environment '${displayEnv}' in '${projectName}'.`,
            );
        }),
    );

    // Pixi: Add Channel...
    disposables.push(
        commands.registerCommand('pixi.addChannel', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add channel to', folderUri);
            if (!projectPath) {
                return;
            }

            interface ChannelPresetItem extends QuickPickItem {
                channel?: string;
                isCustom?: boolean;
            }

            const presets: ChannelPresetItem[] = [
                {
                    label: '$(globe) Custom Channel Name or URL...',
                    description: 'Enter a custom channel name, internal mirror, or URL',
                    isCustom: true,
                },
                {
                    label: '$(server) conda-forge',
                    description: 'Community-driven Conda repository (default)',
                    channel: 'conda-forge',
                },
                {
                    label: '$(rocket) Tsinghua Mirror (conda-forge)',
                    description: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
                    channel: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
                },
                {
                    label: '$(rocket) BFSU Mirror (conda-forge)',
                    description: 'https://mirrors.bfsu.edu.cn/anaconda/cloud/conda-forge',
                    channel: 'https://mirrors.bfsu.edu.cn/anaconda/cloud/conda-forge',
                },
                {
                    label: '$(rocket) Aliyun Mirror (conda-forge)',
                    description: 'https://mirrors.aliyun.com/anaconda/cloud/conda-forge',
                    channel: 'https://mirrors.aliyun.com/anaconda/cloud/conda-forge',
                },
                {
                    label: '$(server) pytorch',
                    description: 'Official PyTorch Conda channel',
                    channel: 'pytorch',
                },
                {
                    label: '$(server) nvidia',
                    description: 'Official NVIDIA CUDA packages channel',
                    channel: 'nvidia',
                },
                {
                    label: '$(server) bioconda',
                    description: 'Bioinformatics and biology package channel',
                    channel: 'bioconda',
                },
            ];

            const pick = await window.showQuickPick(presets, {
                title: 'Pixi: Add Channel',
                placeHolder: 'Select a channel preset or enter a custom channel / mirror URL',
            });
            if (!pick) {
                return;
            }

            let targetChannel = pick.channel;
            if (pick.isCustom) {
                const input = await window.showInputBox({
                    title: 'Pixi: Enter Channel Name or URL',
                    prompt: 'Enter Conda channel name or URL (e.g. bioconda or https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge)',
                    placeHolder: 'e.g. bioconda or https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
                    ignoreFocusOut: true,
                });
                if (!input || !input.trim()) {
                    return;
                }
                targetChannel = input.trim();
            }

            if (!targetChannel) {
                return;
            }

            const priorityPick = await window.showQuickPick(
                [
                    {
                        label: '$(arrow-down) Append (Default Priority)',
                        description: 'Add to the end of the channel list',
                        prepend: false,
                    },
                    {
                        label: '$(arrow-up) Prepend (--prepend, Highest Priority)',
                        description: 'Add to the start of the channel list (recommended for mirrors)',
                        prepend: true,
                    },
                ],
                {
                    title: 'Pixi: Channel Priority',
                    placeHolder: 'Choose priority position in channels list',
                },
            );
            if (!priorityPick) {
                return;
            }

            const args = ['workspace', 'channel', 'add'];
            if (priorityPick.prepend) {
                args.push('--prepend');
            }
            args.push(targetChannel);

            const projectName = path.basename(projectPath);
            await runPixiWithProgress(
                `Pixi: Adding channel '${targetChannel}' to '${projectName}'...`,
                args,
                projectPath,
                manager,
                `Pixi: Channel '${targetChannel}' added successfully to '${projectName}'.`,
            );
        }),
    );

    // Pixi: Remove Channel...
    disposables.push(
        commands.registerCommand('pixi.removeChannel', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to remove channel from', folderUri);
            if (!projectPath) {
                return;
            }

            let output = '';
            try {
                output = await runPixi(['workspace', 'channel', 'list'], { cwd: projectPath });
            } catch (err) {
                window.showErrorMessage(`Failed to list channels: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }

            const channels = output
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.startsWith('- '))
                .map((l) => l.substring(2).trim());

            const uniqueChannels = Array.from(new Set(channels));
            if (uniqueChannels.length === 0) {
                window.showInformationMessage('No configurable channels found in this Pixi project.');
                return;
            }

            const selected = await window.showQuickPick(
                uniqueChannels.map((c) => ({
                    label: `$(globe) ${c}`,
                    channel: c,
                })),
                {
                    title: 'Pixi: Remove Channel',
                    placeHolder: 'Select a channel to remove from project manifest',
                },
            );
            if (!selected) {
                return;
            }

            const projectName = path.basename(projectPath);
            await runPixiWithProgress(
                `Pixi: Removing channel '${selected.channel}' from '${projectName}'...`,
                ['workspace', 'channel', 'remove', selected.channel],
                projectPath,
                manager,
                `Pixi: Channel '${selected.channel}' removed successfully from '${projectName}'.`,
            );
        }),
    );

    disposables.push(
        commands.registerCommand('pixi.refreshProjects', async () => {
            await manager.refresh(undefined);
        }),
    );

    return Disposable.from(...disposables);
}
