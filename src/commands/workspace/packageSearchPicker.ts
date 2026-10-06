import * as path from 'path';
import {
    CancellationTokenSource,
    commands,
    env as vscodeEnv,
    QuickPickItem,
    QuickPickItemKind,
    Uri,
    window,
} from 'vscode';

import { PixiPackageSearchResult, searchPixiPackages } from '../../cli/pixiCli';
import { getProjectConfiguredChannels } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import { handleGlobalInstall } from '../globalCommands';

export type SourceMode = 'conda' | 'pypi' | 'pypi-custom' | 'path' | 'git';

export interface SourceQuickPickItem extends QuickPickItem {
    mode: SourceMode;
}

export interface SearchResultQuickPickItem extends QuickPickItem {
    pkg?: PixiPackageSearchResult;
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

export interface DebouncedSearchController {
    triggerSearch: (query: string) => void;
    dispose: () => void;
}

export function createPackageQuickPickItem(pkg: PixiPackageSearchResult): SearchResultQuickPickItem {
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

export async function promptPackageVersionConstraint(pkg: PixiPackageSearchResult): Promise<string | undefined> {
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

export function attachDebouncedPackageSearch<T extends QuickPickItem>(
    quickPick: ReturnType<typeof window.createQuickPick<T>>,
    options: {
        projectPath?: string;
        channels?: string[];
        buildPrefixItems?: (query: string) => T[];
    },
): DebouncedSearchController {
    let debounceTimer: NodeJS.Timeout | undefined;
    let searchCts: CancellationTokenSource | undefined;
    const projectChannels =
        options.channels ?? (options.projectPath ? getProjectConfiguredChannels(options.projectPath) : []);

    const performSearch = (query: string) => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        if (searchCts) {
            searchCts.cancel();
            searchCts.dispose();
        }

        const trimmed = query.trim();
        const prefixItems = options.buildPrefixItems ? options.buildPrefixItems(trimmed) : [];

        if (trimmed.length < 2) {
            quickPick.items = [
                ...prefixItems,
                {
                    label: '$(info) Start typing to search...',
                    description: 'Type at least 2 characters to search Conda & PyPI packages',
                    alwaysShow: true,
                } as unknown as T,
            ];
            quickPick.busy = false;
            return;
        }

        quickPick.items = [
            ...prefixItems,
            {
                label: '$(sync~spin) Searching Conda & PyPI packages...',
                description: `Looking up "${trimmed}"...`,
                alwaysShow: true,
            } as unknown as T,
        ];
        quickPick.busy = true;

        debounceTimer = setTimeout(async () => {
            searchCts = new CancellationTokenSource();
            const token = searchCts.token;

            try {
                const results = await searchPixiPackages(
                    trimmed,
                    { cwd: options.projectPath, channels: projectChannels },
                    token,
                );
                if (token.isCancellationRequested) {
                    return;
                }

                if (results.length === 0) {
                    quickPick.items = [
                        ...prefixItems,
                        {
                            label: '$(info) No packages found',
                            description: `No Conda or PyPI packages matching "${trimmed}"`,
                            alwaysShow: true,
                        } as unknown as T,
                    ];
                } else {
                    const searchItems = results.map(createPackageQuickPickItem) as unknown as T[];
                    quickPick.items = [...prefixItems, ...searchItems];
                }
            } catch (err: unknown) {
                if (!token.isCancellationRequested) {
                    const rawMsg = (err instanceof Error ? err.message : String(err)).trim();
                    const firstLine = rawMsg.split(/\r?\n/)[0] || rawMsg;
                    quickPick.items = [
                        ...prefixItems,
                        {
                            label: '$(warning) Search failed',
                            description: firstLine,
                            detail: rawMsg.length > firstLine.length ? rawMsg : undefined,
                            alwaysShow: true,
                        } as unknown as T,
                    ];
                }
            } finally {
                if (!token.isCancellationRequested) {
                    quickPick.busy = false;
                }
            }
        }, 300);
    };

    const cleanup = () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        if (searchCts) {
            searchCts.cancel();
            searchCts.dispose();
        }
    };

    quickPick.onDidChangeValue(performSearch);

    return { triggerSearch: performSearch, dispose: cleanup };
}

export async function showPackageSearchPicker(
    _manager?: PixiProjectManager,
    initialQuery?: string,
    targetProjectPath?: string,
): Promise<void> {
    const quickPick = window.createQuickPick<SearchResultQuickPickItem>();
    quickPick.title = 'Pixi: Search Packages (Conda & PyPI)';
    quickPick.placeholder = 'Type package name to search Conda & PyPI... (e.g. numpy, uv, torch, ruff)';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    const search = attachDebouncedPackageSearch(quickPick, { projectPath: targetProjectPath });

    quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (!selected || !selected.pkg) {
            return;
        }
        quickPick.hide();
        await handlePackageSearchSelection(selected.pkg, targetProjectPath);
    });

    quickPick.onDidHide(() => {
        search.dispose();
        quickPick.dispose();
    });

    quickPick.show();
    const query = initialQuery?.trim() ?? '';
    if (query) {
        quickPick.value = query;
    }
    search.triggerSearch(query);
}

export async function handlePackageSearchSelection(
    pkg: PixiPackageSearchResult,
    targetProjectPath?: string,
): Promise<void> {
    const isPypi = pkg.sourceType === 'pypi';
    const primaryChan = pkg.channel ? pkg.channel.split(',')[0].trim() : 'conda-forge';
    const webUrl = isPypi
        ? `https://pypi.org/project/${encodeURIComponent(pkg.name)}/`
        : `https://prefix.dev/channels/${encodeURIComponent(primaryChan)}/packages/${encodeURIComponent(pkg.name)}`;

    interface PackageInspectionItem extends QuickPickItem {
        action?: 'add' | 'global-install' | 'open-browser' | 'copy-spec' | 'copy-name';
    }

    const items: PackageInspectionItem[] = [
        {
            label: 'Actions',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: isPypi ? '$(symbol-keyword) View on PyPI' : '$(globe) View on Prefix.dev',
            description: isPypi ? 'pypi.org' : `prefix.dev (${primaryChan})`,
            detail: webUrl,
            action: 'open-browser',
        },
        {
            label: '$(plus) Add to Project...',
            description: `Install ${pkg.name} into workspace project`,
            detail: 'Runs interactive add with target environment and version constraint picking',
            action: 'add',
        },
        ...(!isPypi
            ? [
                  {
                      label: '$(tools) Install Globally as CLI Tool...',
                      description: `pixi global install ${pkg.name}`,
                      detail: 'Install executable tool into Pixi global environment',
                      action: 'global-install' as const,
                  },
              ]
            : []),
        {
            label: '$(copy) Copy Dependency Spec',
            description: `${pkg.name}>=${pkg.latestVersion}`,
            detail: 'Copy dependency constraint string to clipboard',
            action: 'copy-spec',
        },
        {
            label: '$(copy) Copy Package Name',
            description: pkg.name,
            detail: `Copy "${pkg.name}" to clipboard`,
            action: 'copy-name',
        },
        {
            label: 'Package Information',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: '$(info) Summary',
            detail: pkg.summary || 'No description provided.',
        },
        {
            label: '$(server) Supported Platforms',
            description:
                pkg.platforms && pkg.platforms.length > 0
                    ? pkg.platforms.join(', ')
                    : isPypi
                      ? 'Universal / Python Wheels & sdist'
                      : 'Not specified',
        },
        {
            label: '$(repo) Channel / Source',
            description: isPypi ? 'PyPI (Python Package Index)' : `Conda • ${pkg.channel}`,
        },
        ...(pkg.license
            ? [
                  {
                      label: '$(law) License',
                      description: pkg.license,
                  },
              ]
            : []),
        ...(pkg.versions && pkg.versions.length > 0
            ? [
                  {
                      label: '$(versions) Available Versions',
                      description:
                          pkg.versions.slice(0, 8).join(', ') +
                          (pkg.versions.length > 8 ? ` (+${pkg.versions.length - 8} more)` : ''),
                  },
              ]
            : []),
    ];

    const pick = await window.showQuickPick(items, {
        title: `Pixi Package: ${pkg.name} v${pkg.latestVersion} (${isPypi ? 'PyPI' : `Conda • ${pkg.channel}`})`,
        placeHolder: `Select an action or view package information for '${pkg.name}'`,
    });
    if (!pick) {
        return;
    }

    switch (pick.action) {
        case 'open-browser': {
            await vscodeEnv.openExternal(Uri.parse(webUrl));
            break;
        }
        case 'add': {
            await commands.executeCommand('pixi.addPackage', targetProjectPath, undefined, pkg);
            break;
        }
        case 'global-install': {
            await handleGlobalInstall(pkg.name);
            break;
        }
        case 'copy-spec': {
            const spec = `${pkg.name}>=${pkg.latestVersion}`;
            await vscodeEnv.clipboard.writeText(spec);
            window.showInformationMessage(`Copied "${spec}" to clipboard.`);
            break;
        }
        case 'copy-name': {
            await vscodeEnv.clipboard.writeText(pkg.name);
            window.showInformationMessage(`Copied "${pkg.name}" to clipboard.`);
            break;
        }
        default: {
            const textToCopy = pick.description || pick.detail;
            if (textToCopy) {
                await vscodeEnv.clipboard.writeText(textToCopy);
                window.showInformationMessage(`Copied: ${textToCopy}`);
            }
            break;
        }
    }
}

export async function promptAddPackageSpec(
    projectPath: string,
    targetEnvName?: string,
    initialQuery?: string,
): Promise<AddPackagePromptResult | undefined> {
    return new Promise((resolve) => {
        interface AddPackageQuickPickItem extends QuickPickItem {
            pkg?: PixiPackageSearchResult;
            isDirectInput?: boolean;
        }

        const quickPick = window.createQuickPick<AddPackageQuickPickItem>();
        quickPick.title = targetEnvName
            ? `Pixi: Add Package to '${targetEnvName}' (Search Conda & PyPI)`
            : 'Pixi: Add Package (Search Conda & PyPI)';
        quickPick.placeholder =
            'Type package name to search or enter spec (e.g. numpy>=1.26, requests, or press Enter)';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;

        let resolved = false;

        const search = attachDebouncedPackageSearch(quickPick, {
            projectPath,
            buildPrefixItems: (query: string): AddPackageQuickPickItem[] => {
                if (!query) {
                    return [];
                }
                return [
                    {
                        label: `$(edit) Add: "${query}"`,
                        description: 'Press Enter to select source channel and install directly',
                        alwaysShow: true,
                        isDirectInput: true,
                    },
                ];
            },
        });

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
            search.dispose();
            quickPick.dispose();
            if (!resolved) {
                resolve(undefined);
            }
        });

        quickPick.show();
        const query = initialQuery?.trim() ?? '';
        if (query) {
            quickPick.value = query;
        }
        search.triggerSearch(query);
    });
}

export async function promptAddPackageSource(
    projectPath: string,
    specs: string[],
): Promise<{ args: string[]; sourceLabel: string } | undefined> {
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
        return undefined;
    }

    const args: string[] = [];
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
            return undefined;
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
            return undefined;
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
            return undefined;
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
            return undefined;
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

    return { args, sourceLabel };
}

