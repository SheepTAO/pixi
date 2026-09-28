import * as ch from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    commands,
    Disposable,
    env as vscodeEnv,
    Event,
    EventEmitter,
    ProgressLocation,
    QuickPickItem,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    window,
    workspace,
} from 'vscode';

import { clearGlobalManifestCache } from '../cli/globalCli';
import { clearPixiCache, clearSearchCache, runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let u = -1;
    let size = bytes;
    do {
        size /= 1024;
        u++;
    } while (size >= 1024 && u < units.length - 1);
    return `${size.toFixed(1)} ${units[u]}`;
}

export async function computeDirectorySize(dirPath: string): Promise<number | null> {
    try {
        if (!fs.existsSync(dirPath)) {
            return null;
        }
        if (process.platform !== 'win32') {
            return await new Promise<number | null>((resolve) => {
                ch.execFile('du', ['-sk', dirPath], { timeout: 15000 }, (err, stdout) => {
                    if (err || !stdout) {
                        return resolve(null);
                    }
                    const match = stdout.trim().match(/^(\d+)/);
                    if (match) {
                        resolve(parseInt(match[1], 10) * 1024);
                    } else {
                        resolve(null);
                    }
                });
            });
        }

        // Windows support via PowerShell
        return await new Promise<number | null>((resolve) => {
            const escaped = dirPath.replace(/'/g, "''");
            const psCmd = `(Get-ChildItem -LiteralPath '${escaped}' -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`;
            ch.execFile(
                'powershell',
                ['-NoProfile', '-NonInteractive', '-Command', psCmd],
                { timeout: 10000 },
                (err, stdout) => {
                    if (err || !stdout) {
                        return resolve(null);
                    }
                    const bytes = parseInt(stdout.trim(), 10);
                    resolve(isNaN(bytes) ? null : bytes);
                },
            );
        });
    } catch {
        // Fall back
    }
    return null;
}

export interface PixiSystemInfo {
    platform?: string;
    version?: string;
    tls_backend?: string;
    cache_dir?: string;
    cache_size?: string | number | null;
    auth_dir?: string;
    global_info?: {
        bin_dir?: string;
        env_dir?: string;
        manifest?: string;
    };
    virtual_packages?: string[];
    config_locations?: string[];
}

export class PixiInfoItem extends TreeItem {
    constructor(
        label: string,
        collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
        public readonly children?: PixiInfoItem[],
    ) {
        super(label, collapsibleState);
    }
}

export class PixiInfoTreeDataProvider implements TreeDataProvider<PixiInfoItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiInfoItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiInfoItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private readonly disposables: Disposable[] = [];
    private cachedSystemInfo: PixiSystemInfo | null = null;
    private cachedCacheSize: string | null = null;
    private isCalculatingCacheSize = false;
    private cacheCalculationEpoch = 0;

    public refresh(): void {
        this.cacheCalculationEpoch++;
        this.cachedSystemInfo = null;
        this.cachedCacheSize = null;
        this.isCalculatingCacheSize = false;
        this._onDidChangeTreeData.fire();
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    public registerCommands(): Disposable {
        const d1 = commands.registerCommand('pixi.selfUpdate', () => this.selfUpdate());
        const d2 = commands.registerCommand('pixi.refreshInfo', () => this.refresh());
        const d3 = commands.registerCommand('pixi.cleanCache', () => this.cleanCache());
        const d4 = commands.registerCommand('pixi.openLocation', (targetPath: string) => this.openLocation(targetPath));
        const d5 = commands.registerCommand('pixi.measureCacheSize', () => this.measureCacheSize());
        return Disposable.from(d1, d2, d3, d4, d5);
    }

    public async measureCacheSize(): Promise<void> {
        if (!this.cachedSystemInfo) {
            try {
                const rawJson = await runPixi(['info', '--json']);
                this.cachedSystemInfo = safeJsonParse<PixiSystemInfo>(rawJson);
            } catch {
                // ignore
            }
        }
        if (!this.cachedSystemInfo?.cache_dir || this.isCalculatingCacheSize) {
            return;
        }
        this.isCalculatingCacheSize = true;
        this._onDidChangeTreeData.fire();
        const currentEpoch = this.cacheCalculationEpoch;
        try {
            const bytes = await computeDirectorySize(this.cachedSystemInfo.cache_dir);
            if (this.cacheCalculationEpoch !== currentEpoch) {
                return;
            }
            this.isCalculatingCacheSize = false;
            if (bytes !== null) {
                this.cachedCacheSize = formatBytes(bytes);
            }
            this._onDidChangeTreeData.fire();
        } catch {
            if (this.cacheCalculationEpoch === currentEpoch) {
                this.isCalculatingCacheSize = false;
                this._onDidChangeTreeData.fire();
            }
        }
    }

    public getTreeItem(element: PixiInfoItem): TreeItem {
        return element;
    }

    public async getChildren(element?: PixiInfoItem): Promise<PixiInfoItem[]> {
        if (element) {
            return element.children || [];
        }

        try {
            if (!this.cachedSystemInfo) {
                const rawJson = await runPixi(['info', '--json']);
                this.cachedSystemInfo = safeJsonParse<PixiSystemInfo>(rawJson);
            }
            return this.buildInfoTree(this.cachedSystemInfo);
        } catch (err: unknown) {
            traceError('Failed to fetch Pixi info:', err);
            const errorItem = new PixiInfoItem('Pixi CLI Unavailable', TreeItemCollapsibleState.None);
            errorItem.description = 'Click to configure executable path';
            errorItem.iconPath = new ThemeIcon('warning');
            errorItem.tooltip =
                err instanceof Error
                    ? `${err.message}\nClick to configure "pixi.executablePath" in settings.`
                    : 'Pixi CLI is not available.';
            errorItem.command = {
                command: 'workbench.action.openSettings',
                title: 'Open Settings',
                arguments: ['pixi.executablePath'],
            };
            return [errorItem];
        }
    }

    private buildInfoTree(info: PixiSystemInfo): PixiInfoItem[] {
        const items: PixiInfoItem[] = [];

        // 1. Version
        const rawVersion = info.version || 'unknown';
        const cleanVersion = rawVersion.startsWith('v') ? rawVersion.slice(1) : rawVersion;
        const versionItem = new PixiInfoItem('Version', TreeItemCollapsibleState.None);
        versionItem.description = cleanVersion === 'unknown' ? 'unknown' : `v${cleanVersion}`;
        versionItem.iconPath = new ThemeIcon('tag');
        versionItem.tooltip =
            cleanVersion === 'unknown' ? 'Pixi CLI version unknown' : `Pixi CLI version: ${cleanVersion}`;
        items.push(versionItem);

        // 2. Platform & TLS Backend
        const platform = info.platform || 'unknown';
        const platformItem = new PixiInfoItem('Platform', TreeItemCollapsibleState.None);
        platformItem.description = platform;
        platformItem.iconPath = new ThemeIcon('server-process');
        platformItem.tooltip = `Platform: ${platform}${info.tls_backend ? `\nTLS Backend: ${info.tls_backend}` : ''}`;
        items.push(platformItem);

        // 3. Cache Directory
        if (info.cache_dir) {
            const autoMeasure = workspace.getConfiguration('pixi').get<boolean>('cache.autoMeasureSize', true);
            const cacheItem = new PixiInfoItem('Cache Directory', TreeItemCollapsibleState.None);
            const sizeStr =
                this.cachedCacheSize ||
                (this.isCalculatingCacheSize
                    ? 'Calculating...'
                    : autoMeasure
                      ? info.cache_size
                          ? String(info.cache_size)
                          : null
                      : null);
            cacheItem.description = sizeStr ? `${sizeStr} (${info.cache_dir})` : info.cache_dir;
            cacheItem.iconPath = new ThemeIcon('database');
            cacheItem.contextValue = 'pixiInfoCache';
            let tooltip = `Cache Directory: ${info.cache_dir}`;
            if (this.cachedCacheSize) {
                tooltip += `\nTotal Size: ${this.cachedCacheSize}`;
            } else if (this.isCalculatingCacheSize) {
                tooltip += '\nCalculating cache size...';
            } else if (!autoMeasure) {
                tooltip +=
                    '\nAuto-measure is disabled in settings (pixi.cache.autoMeasureSize). Click the dashboard icon to calculate.';
            }
            tooltip += '\nClick to open in terminal or copy path';
            cacheItem.tooltip = tooltip;
            cacheItem.command = {
                command: 'pixi.openLocation',
                title: 'Open Cache Directory',
                arguments: [info.cache_dir],
            };
            items.push(cacheItem);

            if (!this.cachedCacheSize && !this.isCalculatingCacheSize && autoMeasure) {
                this.isCalculatingCacheSize = true;
                const currentEpoch = this.cacheCalculationEpoch;
                computeDirectorySize(info.cache_dir)
                    .then((bytes) => {
                        if (this.cacheCalculationEpoch !== currentEpoch) {
                            return;
                        }
                        this.isCalculatingCacheSize = false;
                        if (bytes !== null) {
                            this.cachedCacheSize = formatBytes(bytes);
                            this._onDidChangeTreeData.fire();
                        }
                    })
                    .catch(() => {
                        if (this.cacheCalculationEpoch === currentEpoch) {
                            this.isCalculatingCacheSize = false;
                        }
                    });
            }
        }

        // 4. Auth Storage
        if (info.auth_dir) {
            const authItem = new PixiInfoItem('Auth Storage', TreeItemCollapsibleState.None);
            authItem.description = info.auth_dir;
            authItem.iconPath = new ThemeIcon('key');
            authItem.tooltip = `Credentials File: ${info.auth_dir}\nClick to open or copy path`;
            authItem.command = {
                command: 'pixi.openLocation',
                title: 'Open Credentials Location',
                arguments: [info.auth_dir],
            };
            items.push(authItem);
        }

        // 5. Global Paths
        if (info.global_info) {
            const globalChildren: PixiInfoItem[] = [];

            if (info.global_info.bin_dir) {
                const binItem = new PixiInfoItem('Bin Directory', TreeItemCollapsibleState.None);
                binItem.description = info.global_info.bin_dir;
                binItem.iconPath = new ThemeIcon('folder');
                binItem.tooltip = `Global Binaries: ${info.global_info.bin_dir}\nClick to open in terminal or copy path`;
                binItem.command = {
                    command: 'pixi.openLocation',
                    title: 'Open Bin Directory',
                    arguments: [info.global_info.bin_dir],
                };
                globalChildren.push(binItem);
            }

            if (info.global_info.env_dir) {
                const envItem = new PixiInfoItem('Environments Directory', TreeItemCollapsibleState.None);
                envItem.description = info.global_info.env_dir;
                envItem.iconPath = new ThemeIcon('folder');
                envItem.tooltip = `Global Environments: ${info.global_info.env_dir}\nClick to open in terminal or copy path`;
                envItem.command = {
                    command: 'pixi.openLocation',
                    title: 'Open Environments Directory',
                    arguments: [info.global_info.env_dir],
                };
                globalChildren.push(envItem);
            }

            if (info.global_info.manifest) {
                const manifestItem = new PixiInfoItem('Manifest', TreeItemCollapsibleState.None);
                manifestItem.description = info.global_info.manifest;
                manifestItem.iconPath = new ThemeIcon('file-code');
                manifestItem.tooltip = `Global Manifest: ${info.global_info.manifest}\nClick to open in editor`;
                manifestItem.command = {
                    command: 'pixi.openLocation',
                    title: 'Open Global Manifest',
                    arguments: [info.global_info.manifest],
                };
                globalChildren.push(manifestItem);
            }

            if (globalChildren.length > 0) {
                const globalGroup = new PixiInfoItem(
                    'Global Paths',
                    TreeItemCollapsibleState.Collapsed,
                    globalChildren,
                );
                globalGroup.iconPath = new ThemeIcon('folder');
                globalGroup.description = `${globalChildren.length} paths`;
                globalGroup.tooltip = 'Pixi global tools, binaries, and manifest locations';
                items.push(globalGroup);
            }
        }

        // 6. Virtual Packages
        if (info.virtual_packages && info.virtual_packages.length > 0) {
            const vpChildren = info.virtual_packages.map((pkg) => {
                const parts = pkg.split('=');
                const name = parts[0] || pkg;
                let versionStr = '';
                if (parts.length === 2) {
                    versionStr = parts[1];
                } else if (parts.length >= 3) {
                    versionStr = parts[2] === '0' ? parts[1] : `${parts[1]} (${parts[2]})`;
                }
                const vpItem = new PixiInfoItem(name, TreeItemCollapsibleState.None);
                vpItem.description = versionStr;
                vpItem.iconPath = new ThemeIcon('symbol-property');
                vpItem.tooltip = `Virtual Package: ${pkg}`;
                return vpItem;
            });

            const vpGroup = new PixiInfoItem('Virtual Packages', TreeItemCollapsibleState.Collapsed, vpChildren);
            vpGroup.iconPath = new ThemeIcon('layers');
            vpGroup.description = `(${vpChildren.length})`;
            vpGroup.tooltip = 'System virtual packages detected by Pixi';
            items.push(vpGroup);
        }

        // 7. Configuration Files
        if (info.config_locations && info.config_locations.length > 0) {
            const configChildren = info.config_locations.map((cfg) => {
                const cfgItem = new PixiInfoItem(path.basename(cfg), TreeItemCollapsibleState.None);
                cfgItem.description = cfg;
                cfgItem.iconPath = new ThemeIcon('file-code');
                cfgItem.tooltip = `Configuration File: ${cfg}\nClick to open in editor`;
                cfgItem.command = {
                    command: 'pixi.openLocation',
                    title: 'Open Configuration File',
                    arguments: [cfg],
                };
                return cfgItem;
            });

            const configGroup = new PixiInfoItem('Configuration', TreeItemCollapsibleState.Collapsed, configChildren);
            configGroup.iconPath = new ThemeIcon('gear');
            configGroup.description = `(${configChildren.length} file${configChildren.length > 1 ? 's' : ''})`;
            configGroup.tooltip = 'Active Pixi configuration files';
            items.push(configGroup);
        } else {
            const configItem = new PixiInfoItem('Configuration', TreeItemCollapsibleState.None);
            configItem.description = 'Default';
            configItem.iconPath = new ThemeIcon('gear');
            configItem.tooltip = 'No custom configuration files detected (using defaults)';
            items.push(configItem);
        }

        return items;
    }

    public async selfUpdate(): Promise<void> {
        const confirm = await window.showInformationMessage(
            'Check for updates and update Pixi CLI to the latest version?',
            { modal: true },
            'Update Pixi CLI',
        );
        if (confirm !== 'Update Pixi CLI') {
            return;
        }

        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Updating Pixi CLI...',
                cancellable: false,
            },
            async () => {
                try {
                    traceVerbose('Running pixi self-update...');
                    const output = await runPixi(['self-update'], { includeStderr: true });
                    const lines = output
                        .trim()
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);
                    const lastLine = lines[lines.length - 1] || output.trim();
                    const cleanOutput = lastLine.replace(/^✔\s*/, '');
                    if (cleanOutput.toLowerCase().includes('already up-to-date')) {
                        window.showInformationMessage(cleanOutput);
                    } else {
                        window.showInformationMessage(`Pixi update: ${cleanOutput}`);
                    }
                    clearPixiCache();
                    clearGlobalManifestCache();
                    clearSearchCache();
                    this.refresh();
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    traceError('Pixi self-update failed:', err);
                    window.showErrorMessage(`Failed to update Pixi CLI: ${msg}`);
                }
            },
        );
    }

    public async cleanCache(): Promise<void> {
        const confirm = await window.showWarningMessage(
            'Are you sure you want to clean the global Pixi package cache? Subsequent installations will re-download packages from the network.',
            { modal: true },
            'Clean Global Cache',
        );
        if (confirm !== 'Clean Global Cache') {
            return;
        }

        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Pixi: Cleaning global package cache...',
                cancellable: false,
            },
            async () => {
                try {
                    await runPixi(['clean', 'cache', '-y']);
                    clearPixiCache();
                    clearSearchCache();
                    this.refresh();
                    window.showInformationMessage('Pixi: Global package cache cleaned.');
                } catch (err: unknown) {
                    traceError('Failed to clean package cache:', err);
                    window.showErrorMessage(
                        `Failed to clean cache: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            },
        );
    }

    public async openLocation(targetPath: string): Promise<void> {
        if (!targetPath) {
            return;
        }
        if (!fs.existsSync(targetPath)) {
            window.showWarningMessage(`Path does not exist: ${targetPath}`);
            return;
        }

        try {
            const stat = fs.statSync(targetPath);
            if (!stat.isDirectory()) {
                const doc = await workspace.openTextDocument(Uri.file(targetPath));
                await window.showTextDocument(doc);
                return;
            }
        } catch {
            // Ignore stat error and continue
        }

        const isRemote = !!vscodeEnv.remoteName;
        if (isRemote) {
            const items: (QuickPickItem & { action: string })[] = [
                {
                    label: '$(terminal) Open in Integrated Terminal',
                    description: targetPath,
                    action: 'terminal',
                },
                {
                    label: '$(copy) Copy Path to Clipboard',
                    description: targetPath,
                    action: 'copy',
                },
                {
                    label: '$(folder) Reveal in File Manager (Client OS)',
                    description: 'Attempt to open client OS file manager',
                    action: 'reveal',
                },
            ];

            const choice = await window.showQuickPick(items, {
                title: `Pixi Directory: ${path.basename(targetPath)}`,
                placeHolder: 'Select an action for this directory',
            });

            if (!choice) {
                return;
            }

            if (choice.action === 'terminal') {
                const terminal = window.createTerminal({
                    name: `Pixi: ${path.basename(targetPath)}`,
                    cwd: targetPath,
                });
                terminal.show();
            } else if (choice.action === 'copy') {
                await vscodeEnv.clipboard.writeText(targetPath);
                window.showInformationMessage(`Copied path to clipboard: ${targetPath}`);
            } else if (choice.action === 'reveal') {
                try {
                    await commands.executeCommand('revealFileInOS', Uri.file(targetPath));
                } catch {
                    window.showWarningMessage('Unable to reveal remote path in client OS file manager.');
                }
            }
            return;
        }

        try {
            await commands.executeCommand('revealFileInOS', Uri.file(targetPath));
        } catch {
            const terminal = window.createTerminal({
                name: `Pixi: ${path.basename(targetPath)}`,
                cwd: targetPath,
            });
            terminal.show();
        }
    }
}
