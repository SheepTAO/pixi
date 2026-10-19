import * as path from 'path';
import {
    CancellationToken,
    commands,
    Disposable,
    ExtensionContext,
    TerminalOptions,
    TerminalProfile,
    TerminalProfileProvider,
    ThemeIcon,
    Uri,
    window,
    workspace,
} from 'vscode';

import { PixiExtensionApi } from '../api/types';
import { getPixi, runPixi } from '../cli/pixiCli';
import { resolveReadyEnvironment } from '../commands/workspace/common';
import { safeJsonParse } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo } from '../core/types';

export class PixiTerminalProvider implements TerminalProfileProvider, Disposable {
    private readonly disposables: Disposable[] = [];
    private lastSyncedEnvKey?: string;
    private syncSeq = 0;

    constructor(
        private readonly projectManager: PixiProjectManager,
        private readonly context?: ExtensionContext,
        private readonly pixiApi?: PixiExtensionApi,
    ) {
        this.disposables.push(
            window.registerTerminalProfileProvider('pixi.terminal', this),
            commands.registerCommand('pixi.openTerminal', (target?: unknown) => this.openTerminal(target)),
            this.projectManager.onDidChangeEnvironments(() => {
                this.lastSyncedEnvKey = undefined;
                void this.syncEnvironmentVariableCollection();
            }),
            window.onDidChangeActiveTextEditor(() => this.syncEnvironmentVariableCollection()),
            window.onDidChangeActiveNotebookEditor(() => this.syncEnvironmentVariableCollection()),
            workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration('pixi.terminal.autoActivateOnCreate') ||
                    e.affectsConfiguration('pixi.terminal.defaultEnvironment') ||
                    e.affectsConfiguration('pixi.terminal.activationMode') ||
                    e.affectsConfiguration('pixi.environmentRules')
                ) {
                    this.lastSyncedEnvKey = undefined;
                    void this.syncEnvironmentVariableCollection();
                }
            }),
        );
        if (this.pixiApi) {
            this.disposables.push(
                this.pixiApi.onDidChangeActiveEnvironment(() => {
                    this.lastSyncedEnvKey = undefined;
                    void this.syncEnvironmentVariableCollection();
                }),
            );
        }
        void this.syncEnvironmentVariableCollection();
    }

    public dispose(): void {
        Disposable.from(...this.disposables).dispose();
    }

    private async syncEnvironmentVariableCollection(): Promise<void> {
        if (!this.context) {
            return;
        }

        const autoActivate = workspace.getConfiguration('pixi.terminal').get<boolean>('autoActivateOnCreate', false);

        if (!autoActivate) {
            this.lastSyncedEnvKey = undefined;
            this.context.environmentVariableCollection.clear();
            this.context.environmentVariableCollection.description = undefined;
            return;
        }

        const projects = this.projectManager.getProjects();
        if (projects.length === 0) {
            this.lastSyncedEnvKey = undefined;
            this.context.environmentVariableCollection.clear();
            this.context.environmentVariableCollection.description = undefined;
            return;
        }

        const activeUri = window.activeTextEditor?.document?.uri ?? window.activeNotebookEditor?.notebook?.uri;
        const matchedPath = activeUri ? this.projectManager.findProjectForUri(activeUri) : undefined;
        const targetPath = matchedPath || projects[0].projectPath;
        const envs = this.projectManager.getEnvironmentsForProject(targetPath);
        if (envs.length === 0) {
            this.lastSyncedEnvKey = undefined;
            this.context.environmentVariableCollection.clear();
            this.context.environmentVariableCollection.description = undefined;
            return;
        }

        const config = workspace.getConfiguration('pixi.terminal', Uri.file(targetPath));
        const defaultEnvSetting = config.get<string>('defaultEnvironment')?.trim();
        let targetEnv: PixiEnvironmentInfo | undefined;

        if (defaultEnvSetting) {
            targetEnv = envs.find((e) => e.pixiEnvName === defaultEnvSetting);
        }

        if (!targetEnv) {
            targetEnv =
                activeUri && matchedPath
                    ? this.projectManager.getEnvironmentForUri(activeUri)
                    : this.projectManager.resolveProjectActiveOrDefault(targetPath, envs);
        }

        if (!targetEnv || targetEnv.pixiStatus !== 'installed') {
            targetEnv = envs.find((e) => e.pixiStatus === 'installed');
        }

        if (!targetEnv) {
            this.lastSyncedEnvKey = undefined;
            this.context.environmentVariableCollection.clear();
            this.context.environmentVariableCollection.description = undefined;
            return;
        }

        const targetKey = `${targetPath}:${targetEnv.pixiEnvName}`;
        if (this.lastSyncedEnvKey === targetKey) {
            return;
        }

        const currentSeq = ++this.syncSeq;

        try {
            const hookArgs = ['shell-hook', '--json'];
            if (targetEnv.manifestPath) {
                hookArgs.push('--manifest-path', targetEnv.manifestPath);
            }
            hookArgs.push('-e', targetEnv.pixiEnvName);
            const stdout = await runPixi(hookArgs, { cwd: targetEnv.projectPath });
            if (this.syncSeq !== currentSeq) {
                return;
            }
            const data = safeJsonParse<{ environment_variables?: Record<string, string> }>(stdout, {});
            if (data?.environment_variables && Object.keys(data.environment_variables).length > 0) {
                this.context.environmentVariableCollection.clear();
                const isMulti = projects.length > 1;
                this.context.environmentVariableCollection.description = isMulti
                    ? `Pixi: ${targetEnv.projectName} (${targetEnv.pixiEnvName})`
                    : `Pixi: ${targetEnv.pixiEnvName}`;
                this.lastSyncedEnvKey = targetKey;

                for (const [key, value] of Object.entries(data.environment_variables)) {
                    if (key.toUpperCase() === 'PATH') {
                        const originalPaths = new Set(process.env.PATH ? process.env.PATH.split(path.delimiter) : []);
                        const newPaths = value.split(path.delimiter).filter((p) => !originalPaths.has(p));
                        if (newPaths.length > 0) {
                            this.context.environmentVariableCollection.prepend(
                                key,
                                newPaths.join(path.delimiter) + path.delimiter,
                            );
                        } else {
                            this.context.environmentVariableCollection.replace(key, value);
                        }
                    } else {
                        this.context.environmentVariableCollection.replace(key, value);
                    }
                }
            }
        } catch (err) {
            traceVerbose(`Failed to synchronize terminal environment variable collection: ${err}`);
        }
    }

    private async createTerminalOptions(env: PixiEnvironmentInfo, token?: CancellationToken): Promise<TerminalOptions> {
        const config = workspace.getConfiguration('pixi.terminal', Uri.file(env.projectPath));
        const mode = config.get<'shell' | 'shellHook'>('activationMode', 'shellHook');
        const isMultiProject = this.projectManager.getProjects().length > 1;
        const terminalName = isMultiProject
            ? `Pixi: ${env.projectName} (${env.pixiEnvName})`
            : `Pixi: ${env.pixiEnvName}`;

        if (mode === 'shellHook') {
            try {
                const hookArgs = ['shell-hook', '--json'];
                if (env.manifestPath) {
                    hookArgs.push('--manifest-path', env.manifestPath);
                }
                hookArgs.push('-e', env.pixiEnvName);
                const stdout = await runPixi(hookArgs, { cwd: env.projectPath }, token);
                const data = safeJsonParse<{ environment_variables?: Record<string, string> }>(stdout, {});
                if (data?.environment_variables && Object.keys(data.environment_variables).length > 0) {
                    return {
                        name: terminalName,
                        env: data.environment_variables,
                        cwd: env.projectPath,
                        iconPath: new ThemeIcon('prefix-dev'),
                    };
                }
            } catch (err) {
                traceVerbose(`pixi shell-hook activation failed, falling back to pixi shell: ${err}`);
            }
        }

        const pixi = await getPixi();
        const cwd = env.projectPath;
        const args = ['shell'];
        if (env.manifestPath) {
            args.push('--manifest-path', env.manifestPath);
        }
        args.push('-e', env.pixiEnvName);

        return {
            name: terminalName,
            shellPath: pixi,
            shellArgs: args,
            cwd,
            iconPath: new ThemeIcon('prefix-dev'),
        };
    }

    async provideTerminalProfile(token: CancellationToken): Promise<TerminalProfile | undefined> {
        traceVerbose('Terminal profile requested for Pixi');
        try {
            const env = await resolveReadyEnvironment(this.projectManager, undefined, {
                action: 'open terminal for environment',
                title: 'Pixi: Open Terminal',
                placeHolder: 'Select a Pixi environment for the terminal',
                defaultEnvConfigKey: 'terminal.defaultEnvironment',
                token,
            });
            if (!env) {
                return undefined;
            }

            const options = await this.createTerminalOptions(env, token);
            return new TerminalProfile(options);
        } catch (error) {
            traceError(`Failed to provide Pixi terminal profile: ${error}`);
            return undefined;
        }
    }

    async openTerminal(target?: unknown): Promise<void> {
        try {
            const env = await resolveReadyEnvironment(this.projectManager, target, {
                action: 'open terminal for environment',
                title: 'Pixi: Open Terminal',
                placeHolder: 'Select a Pixi environment for the terminal',
                defaultEnvConfigKey: 'terminal.defaultEnvironment',
            });
            if (!env) {
                return;
            }

            const options = await this.createTerminalOptions(env);
            const terminal = window.createTerminal(options);
            terminal.show();
        } catch (error) {
            traceError(`Failed to open Pixi terminal: ${error}`);
            window.showErrorMessage(`Failed to open Pixi terminal: ${error}`);
        }
    }
}
