import { commands, Disposable, StatusBarAlignment, StatusBarItem, ThemeColor, window } from 'vscode';

import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo } from '../core/types';

export class PixiStatusBarController implements Disposable {
    private readonly statusBarItem: StatusBarItem;
    private readonly disposables: Disposable[] = [];

    constructor(private readonly projectManager: PixiProjectManager) {
        this.statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'pixi.statusBarAction';
        this.disposables.push(this.statusBarItem);

        this.disposables.push(
            commands.registerCommand('pixi.statusBarAction', async () => {
                await this.showQuickMenu();
            }),
        );

        this.disposables.push(
            projectManager.onDidProjectsChanged(() => this.update()),
            projectManager.onDidChangeEnvironments(() => this.update()),
            window.onDidChangeActiveTextEditor(() => this.update()),
        );

        this.update();
    }

    public update(): void {
        const activeEditor = window.activeTextEditor;
        let currentEnv: PixiEnvironmentInfo | undefined;
        let projectName: string | undefined;

        if (activeEditor?.document?.uri) {
            currentEnv = this.projectManager.getEnvironmentForUri(activeEditor.document.uri);
            if (currentEnv) {
                projectName = currentEnv.projectName;
            }
        }

        if (!currentEnv) {
            const projects = this.projectManager.getProjects();
            if (projects.length > 0) {
                const firstProject = projects[0];
                projectName = firstProject.name;
                const envs = this.projectManager.getEnvironmentsForProject(firstProject.projectPath);
                currentEnv = envs.find((e) => e.pixiEnvName === 'default') || envs[0];
            }
        }

        if (!currentEnv && !projectName) {
            this.statusBarItem.hide();
            return;
        }

        const envName = currentEnv ? currentEnv.pixiEnvName : 'default';

        this.statusBarItem.text = `$(package) Pixi: ${envName}`;
        if (currentEnv && currentEnv.pixiStatus === 'incompatible') {
            this.statusBarItem.color = new ThemeColor('statusBarItem.errorForeground');
        } else if (currentEnv && currentEnv.pixiStatus === 'uninstalled') {
            this.statusBarItem.color = new ThemeColor('statusBarItem.warningForeground');
        } else {
            this.statusBarItem.color = undefined;
        }

        const tooltipLines = [
            `Pixi Project: ${projectName || 'Unknown'}`,
            `Environment: ${envName}`,
            `Status: ${currentEnv ? currentEnv.pixiStatus : 'not loaded'}`,
        ];
        if (currentEnv?.prefix) {
            tooltipLines.push(`Prefix: ${currentEnv.prefix}`);
        }
        if (currentEnv?.toolchains?.python?.version) {
            tooltipLines.push(`Python: ${currentEnv.toolchains.python.version}`);
        }
        tooltipLines.push('\nClick to view Pixi actions');

        this.statusBarItem.tooltip = tooltipLines.join('\n');
        this.statusBarItem.show();
    }

    private async showQuickMenu(): Promise<void> {
        const items = [
            {
                label: '$(terminal) Open Terminal in Environment...',
                description: 'Open a shell with pixi environment activated',
                command: 'pixi.openTerminal',
            },
            {
                label: '$(play) Run Task...',
                description: 'Execute a pixi task defined in manifest',
                command: 'pixi.runTask',
            },
            {
                label: '$(cloud-download) Install / Sync Environment...',
                description: 'Install packages and solve dependencies',
                command: 'pixi.install',
            },
            {
                label: '$(lock) Lock Dependencies',
                description: 'Update or verify pixi.lock file',
                command: 'pixi.lock',
            },
            {
                label: '$(search) Search Packages...',
                description: 'Search Conda & PyPI packages to inspect or install',
                command: 'pixi.searchPackages',
            },
            {
                label: '$(plus) Add Package...',
                description: 'Add a dependency to current environment',
                command: 'pixi.addPackage',
            },
            {
                label: '$(tools) Global Tools...',
                description: 'Manage global CLI tools and applications',
                command: 'pixi.global',
            },
        ];

        const picked = await window.showQuickPick(items, {
            title: 'Pixi: Quick Actions',
            placeHolder: 'Select an action to perform',
        });

        if (picked) {
            await commands.executeCommand(picked.command);
        }
    }

    public dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
