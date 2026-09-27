import * as path from 'path';
import {
    commands,
    Disposable,
    Event,
    EventEmitter,
    ProgressLocation,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    window,
} from 'vscode';

import { clearPixiCache, runPixi } from '../cli/pixiCli';
import { traceError, traceVerbose } from '../common/logging';

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
    private cachedInfoItems: PixiInfoItem[] | null = null;

    public refresh(): void {
        this.cachedInfoItems = null;
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
        return Disposable.from(d1, d2);
    }

    public getTreeItem(element: PixiInfoItem): TreeItem {
        return element;
    }

    public async getChildren(element?: PixiInfoItem): Promise<PixiInfoItem[]> {
        if (element) {
            return element.children || [];
        }

        if (this.cachedInfoItems) {
            return this.cachedInfoItems;
        }

        try {
            const rawJson = await runPixi(['info', '--json']);
            const info = JSON.parse(rawJson) as PixiSystemInfo;
            const items = this.buildInfoTree(info);
            this.cachedInfoItems = items;
            return items;
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
        versionItem.description = `v${cleanVersion}`;
        versionItem.iconPath = new ThemeIcon('tag');
        versionItem.tooltip = `Pixi CLI version: ${cleanVersion}\nClick to check for updates or update Pixi CLI`;
        versionItem.command = {
            command: 'pixi.selfUpdate',
            title: 'Update Pixi CLI',
        };
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
            const cacheItem = new PixiInfoItem('Cache Directory', TreeItemCollapsibleState.None);
            cacheItem.description = info.cache_dir;
            cacheItem.iconPath = new ThemeIcon('database');
            let tooltip = `Cache Directory: ${info.cache_dir}`;
            if (info.cache_size) {
                tooltip += `\nSize: ${info.cache_size}`;
            }
            tooltip += '\nClick to reveal in file manager';
            cacheItem.tooltip = tooltip;
            cacheItem.command = {
                command: 'revealFileInOS',
                title: 'Open Cache Directory',
                arguments: [Uri.file(info.cache_dir)],
            };
            items.push(cacheItem);
        }

        // 4. Auth Storage
        if (info.auth_dir) {
            const authItem = new PixiInfoItem('Auth Storage', TreeItemCollapsibleState.None);
            authItem.description = info.auth_dir;
            authItem.iconPath = new ThemeIcon('key');
            authItem.tooltip = `Credentials File: ${info.auth_dir}\nClick to reveal in file manager`;
            authItem.command = {
                command: 'revealFileInOS',
                title: 'Open Credentials Location',
                arguments: [Uri.file(info.auth_dir)],
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
                binItem.tooltip = `Global Binaries: ${info.global_info.bin_dir}\nClick to reveal in file manager`;
                binItem.command = {
                    command: 'revealFileInOS',
                    title: 'Open Bin Directory',
                    arguments: [Uri.file(info.global_info.bin_dir)],
                };
                globalChildren.push(binItem);
            }

            if (info.global_info.env_dir) {
                const envItem = new PixiInfoItem('Environments Directory', TreeItemCollapsibleState.None);
                envItem.description = info.global_info.env_dir;
                envItem.iconPath = new ThemeIcon('folder');
                envItem.tooltip = `Global Environments: ${info.global_info.env_dir}\nClick to reveal in file manager`;
                envItem.command = {
                    command: 'revealFileInOS',
                    title: 'Open Environments Directory',
                    arguments: [Uri.file(info.global_info.env_dir)],
                };
                globalChildren.push(envItem);
            }

            if (info.global_info.manifest) {
                const manifestItem = new PixiInfoItem('Manifest', TreeItemCollapsibleState.None);
                manifestItem.description = info.global_info.manifest;
                manifestItem.iconPath = new ThemeIcon('file-code');
                manifestItem.tooltip = `Global Manifest: ${info.global_info.manifest}\nClick to open in editor`;
                manifestItem.command = {
                    command: 'vscode.open',
                    title: 'Open Global Manifest',
                    arguments: [Uri.file(info.global_info.manifest)],
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
                    command: 'vscode.open',
                    title: 'Open Configuration File',
                    arguments: [Uri.file(cfg)],
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
                    this.refresh();
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    traceError('Pixi self-update failed:', err);
                    window.showErrorMessage(`Failed to update Pixi CLI: ${msg}`);
                }
            },
        );
    }
}
