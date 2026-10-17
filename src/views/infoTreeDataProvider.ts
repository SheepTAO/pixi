import * as path from 'path';
import {
    Disposable,
    Event,
    EventEmitter,
    ThemeColor,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    workspace,
} from 'vscode';

import { isTokenAuthMethod, readStoredCredentials, setCachedAuthDir } from '../cli/authCli';
import { runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';
import { traceError } from '../common/logging';

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
        public readonly hostPattern?: string,
    ) {
        super(label, collapsibleState);
    }
}

export class PixiInfoTreeDataProvider implements TreeDataProvider<PixiInfoItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiInfoItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiInfoItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private cachedSystemInfo: PixiSystemInfo | null = null;
    private cachedCacheSize: string | null = null;
    private cacheSizeStatus: 'idle' | 'calculating' | 'done' = 'idle';
    private cacheCalculationEpoch = 0;

    public refresh(): void {
        this.cacheCalculationEpoch++;
        this.cachedSystemInfo = null;
        this.cachedCacheSize = null;
        this.cacheSizeStatus = 'idle';
        this._onDidChangeTreeData.fire();
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    private async getSystemInfo(): Promise<PixiSystemInfo> {
        if (!this.cachedSystemInfo) {
            const rawJson = await runPixi(['info', '--json']);
            this.cachedSystemInfo = safeJsonParse<PixiSystemInfo>(rawJson);
        }
        return this.cachedSystemInfo;
    }

    public async measureCacheSize(): Promise<void> {
        if (this.cacheSizeStatus === 'calculating') {
            return;
        }
        this.cacheSizeStatus = 'idle';
        try {
            await this.calculateCacheSize(true);
        } catch {
            // ignore
        }
    }

    private async calculateCacheSize(notifyStart = false): Promise<void> {
        if (this.cacheSizeStatus === 'calculating') {
            return;
        }
        this.cacheSizeStatus = 'calculating';
        if (notifyStart) {
            this._onDidChangeTreeData.fire();
        }
        const currentEpoch = this.cacheCalculationEpoch;
        try {
            const extendedJson = await runPixi(['info', '--json', '--extended']);
            const extendedInfo = safeJsonParse<PixiSystemInfo>(extendedJson);
            if (extendedInfo?.cache_size && this.cacheCalculationEpoch === currentEpoch) {
                this.cachedCacheSize = String(extendedInfo.cache_size);
                if (this.cachedSystemInfo) {
                    this.cachedSystemInfo.cache_size = extendedInfo.cache_size;
                }
            }
        } catch {
            // Ignore failure if pixi info calculation is interrupted
        } finally {
            if (this.cacheCalculationEpoch === currentEpoch) {
                this.cacheSizeStatus = 'done';
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
            return await this.buildInfoTree(await this.getSystemInfo());
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

    private async buildInfoTree(info: PixiSystemInfo): Promise<PixiInfoItem[]> {
        const items: PixiInfoItem[] = [];

        // 1. Version
        const cleanVersion = info.version?.replace(/^v/, '');
        const versionItem = new PixiInfoItem('Version', TreeItemCollapsibleState.None);
        versionItem.description = cleanVersion ? `v${cleanVersion}` : 'unknown';
        versionItem.iconPath = new ThemeIcon('tag');
        versionItem.tooltip = cleanVersion ? `Pixi CLI version: ${cleanVersion}` : 'Pixi CLI version unknown';
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
            if (!this.cachedCacheSize && this.cacheSizeStatus === 'idle' && autoMeasure) {
                void this.calculateCacheSize(false);
            }

            const isCalculating = this.cacheSizeStatus === 'calculating';
            const cacheItem = new PixiInfoItem('Cache Directory', TreeItemCollapsibleState.None);
            const sizeStr =
                this.cachedCacheSize ||
                (isCalculating ? 'Calculating...' : autoMeasure && info.cache_size ? String(info.cache_size) : null);
            cacheItem.description = sizeStr ? `${sizeStr} (${info.cache_dir})` : info.cache_dir;
            cacheItem.iconPath = new ThemeIcon('database');
            cacheItem.contextValue = 'pixiInfoCache';
            let tooltip = `Cache Directory: ${info.cache_dir}`;
            if (this.cachedCacheSize) {
                tooltip += `\nTotal Size: ${this.cachedCacheSize}`;
            } else if (isCalculating) {
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
        }

        // 4. Auth Storage
        if (info.auth_dir) {
            setCachedAuthDir(info.auth_dir);
            const entries = await readStoredCredentials(info.auth_dir);
            const authChildren: PixiInfoItem[] = [];

            for (const entry of entries) {
                const hasToken = isTokenAuthMethod(entry.method);
                const userDesc = entry.username ? ` (${entry.username})` : '';
                const item = new PixiInfoItem(
                    entry.hostPattern,
                    TreeItemCollapsibleState.None,
                    undefined,
                    entry.hostPattern,
                );
                item.description = `[${entry.method}]${userDesc}`;
                item.iconPath = new ThemeIcon('shield', new ThemeColor('charts.green'));
                item.tooltip = `Host: ${entry.hostPattern}\nMethod: ${entry.method}${userDesc}\nStorage: ${info.auth_dir}\nClick to copy token or manage`;
                item.contextValue = hasToken ? 'pixiInfoAuthHostWithToken' : 'pixiInfoAuthHost';
                if (hasToken) {
                    item.command = {
                        command: 'pixi.auth.copyToken',
                        title: 'Copy Token',
                        arguments: [item],
                    };
                }
                authChildren.push(item);
            }

            const authGroup = new PixiInfoItem(
                'Auth Storage',
                entries.length > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None,
                authChildren.length > 0 ? authChildren : undefined,
            );
            authGroup.iconPath = new ThemeIcon('key');
            authGroup.description = entries.length > 0 ? `${entries.length} hosts` : info.auth_dir;
            authGroup.tooltip =
                entries.length > 0
                    ? `Credentials File: ${info.auth_dir}\n${entries.length} authenticated host(s)\nClick to open credentials location`
                    : `Credentials File: ${info.auth_dir}\nNo authenticated hosts yet\nClick to login or manage authentication`;
            authGroup.contextValue = 'pixiInfoAuthStorage';
            if (entries.length === 0) {
                authGroup.command = {
                    command: 'pixi.auth.login',
                    title: 'Login to Host / Registry',
                };
            }
            items.push(authGroup);
        }

        // 5. Global Paths
        if (info.global_info) {
            const globalChildren: PixiInfoItem[] = [];

            const globalPathDescriptors = [
                {
                    label: 'Bin Directory',
                    targetPath: info.global_info.bin_dir,
                    icon: 'folder',
                    tooltipPrefix: 'Global Binaries',
                    actionHint: 'Click to open in terminal or copy path',
                },
                {
                    label: 'Environments Directory',
                    targetPath: info.global_info.env_dir,
                    icon: 'folder',
                    tooltipPrefix: 'Global Environments',
                    actionHint: 'Click to open in terminal or copy path',
                },
                {
                    label: 'Manifest',
                    targetPath: info.global_info.manifest,
                    icon: 'file-code',
                    tooltipPrefix: 'Global Manifest',
                    actionHint: 'Click to open in editor',
                },
            ];

            for (const desc of globalPathDescriptors) {
                if (desc.targetPath) {
                    const item = new PixiInfoItem(desc.label, TreeItemCollapsibleState.None);
                    item.description = desc.targetPath;
                    item.iconPath = new ThemeIcon(desc.icon);
                    item.tooltip = `${desc.tooltipPrefix}: ${desc.targetPath}\n${desc.actionHint}`;
                    item.command = {
                        command: 'pixi.openLocation',
                        title: `Open ${desc.label}`,
                        arguments: [desc.targetPath],
                    };
                    globalChildren.push(item);
                }
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
}
