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

async function runTargetPackageTree(
    manager: PixiProjectManager,
    targetItem: unknown,
    isReverse: boolean,
): Promise<boolean> {
    const ctx = extractCommandContext(targetItem);
    if (!ctx.pkg || !ctx.projectPath) {
        return false;
    }
    const envs = manager.getEnvironmentsForProject(ctx.projectPath);
    const placeholder = isReverse
        ? 'Select environment to inspect package dependencies'
        : 'Select environment to view dependency tree for';
    const envName = await resolveTargetEnvironment(envs, targetItem, placeholder);
    if (envName === null) {
        return true;
    }
    const envLabel = envName || 'default';
    const args = buildTreeArgs(envName, isReverse);
    args.push(exactPackageRegex(ctx.pkg.name));
    await displayTreeOutput(
        `package '${ctx.pkg.name}' in '${envLabel}'`,
        args,
        ctx.projectPath,
        isReverse,
        isReverse ? ctx.pkg.name : undefined,
    );
    return true;
}

export async function showDependencyTreeCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    if (await runTargetPackageTree(manager, targetItem, false)) {
        return;
    }

    const ctx = extractCommandContext(targetItem);
    if (ctx.envName && ctx.projectPath) {
        const args = buildTreeArgs(ctx.envName);
        await displayTreeOutput(`environment '${ctx.envName}'`, args, ctx.projectPath);
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
                label: '$(type-hierarchy-sub) Why is This Package Installed? (Reverse Tree)...',
                description: `Trace reverse dependency chains explaining why a package is needed in '${envLabel}'`,
                mode: 'why' as const,
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

    if (action.mode === 'why') {
        await whyPackageCommand(manager, targetItem || projectPath, targetEnv || 'default');
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

export async function whyPackageCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
    presetEnv?: string,
): Promise<void> {
    if (await runTargetPackageTree(manager, targetItem, true)) {
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

    let targetEnv: string | undefined;
    if (presetEnv !== undefined) {
        targetEnv = presetEnv === 'default' ? undefined : presetEnv;
    } else {
        const envs = manager.getEnvironmentsForProject(projectPath);
        const resolved = await resolveTargetEnvironment(
            envs,
            targetItem,
            'Select environment to inspect package dependencies',
        );
        if (resolved === null) {
            return;
        }
        targetEnv = resolved;
    }

    const envLabel = targetEnv || 'default';
    const packages = await manager.getPackagesForEnvironment(envLabel, projectPath);
    let targetPkgName: string | undefined;

    if (packages.length > 0) {
        const sorted = sortPixiPackages(packages);
        const groups = [
            {
                label: 'Transitive Dependencies',
                pkgs: sorted.filter((p) => !p.is_explicit),
                icon: 'symbol-field',
                tag: 'transitive',
            },
            {
                label: 'Explicit Dependencies (Top-level)',
                pkgs: sorted.filter((p) => p.is_explicit),
                icon: 'package',
                tag: 'explicit',
            },
        ];

        const items: (QuickPickItem & { pkgName?: string })[] = [];
        for (const g of groups) {
            if (g.pkgs.length > 0) {
                items.push({
                    label: g.label,
                    kind: QuickPickItemKind.Separator,
                });
                for (const p of g.pkgs) {
                    items.push({
                        label: `$(${g.icon}) ${p.name}`,
                        description: p.version ? `v${p.version} (${g.tag})` : `(${g.tag})`,
                        pkgName: p.name,
                    });
                }
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
