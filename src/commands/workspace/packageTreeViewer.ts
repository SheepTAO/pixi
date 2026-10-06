import {
    CancellationError,
    OutputChannel,
    ProgressLocation,
    QuickPickItem,
    QuickPickItemKind,
    window,
    workspace,
} from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import { escapeRegex } from '../../common/execUtils';
import { sortPixiPackages } from '../../core/packageManager';
import { PixiProjectManager } from '../../core/projectManager';
import { extractCommandContext, pickPixiProject, resolveTargetEnvironment } from './common';

let treeOutputChannel: OutputChannel | undefined;

export function exactPackageRegex(name: string): string {
    return `^${escapeRegex(name)}$`;
}

export function buildTreeArgs(envName?: string, isReverse?: boolean): string[] {
    const args = ['tree', '--color', 'never'];
    if (isReverse) {
        args.push('-i');
    }
    if (envName && envName !== 'default') {
        args.push('-e', envName);
    }
    return args;
}

export function getTreeOutputChannel(): OutputChannel {
    if (!treeOutputChannel) {
        treeOutputChannel = window.createOutputChannel('Pixi Tree');
    }
    return treeOutputChannel;
}

export function disposeTreeOutputChannel(): void {
    treeOutputChannel?.dispose();
    treeOutputChannel = undefined;
}

export async function displayTreeOutput(
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
                    const hasBranches = lines.some((l) => l.includes('└──') || l.includes('├──') || l.includes('│'));
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

export async function showDependencyTreeCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const ctx = extractCommandContext(targetItem);
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

    const projectPath = await pickPixiProject(manager, 'Select Pixi project to view dependency tree for', targetItem);
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
}

export async function whyPackageCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const ctx = extractCommandContext(targetItem);
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
    await displayTreeOutput(`package '${targetPkgName}' in '${envLabel}'`, args, projectPath, true, targetPkgName);
}
