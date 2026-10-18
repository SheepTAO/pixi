import { commands, Disposable, QuickPickItem, window } from 'vscode';

import { getHostCondaPlatform } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { CONDA_PLATFORM_PRESETS } from '../../core/presets';
import { PixiProjectManager } from '../../core/projectManager';
import { getWorkspacePlatforms, type WorkspacePlatformEntry } from '../../core/systemRequirements';
import { formatScope, pickPixiProject, resolveWorkspaceOrFeatureScope } from './common';

function isGlobalPlatform(p: WorkspacePlatformEntry): boolean {
    return p.features.length === 0 || p.environments.includes('default');
}

export async function handleConfigurePlatformsCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
    presetFeature?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(
        manager,
        'Select Pixi project to configure target platforms for',
        targetItem,
    );
    if (!projectPath) {
        return;
    }

    const platformsPromise = getWorkspacePlatforms(projectPath, manager);
    const targetFeature = await resolveWorkspaceOrFeatureScope(
        projectPath,
        {
            title: 'Pixi: Select Platform Target Scope',
            placeHolder: 'Select scope to configure target platforms for',
            globalLabel: '$(globe) [workspace] (Global Platforms)',
            globalDescription: 'Shared across all environments and features (default)',
            featureDescription: (name) => `Target platforms specific to feature '${name}'`,
        },
        targetItem,
        presetFeature,
    );
    if (targetFeature === null) {
        return;
    }

    const existingPlatforms = await platformsPromise;
    const activeInScope = new Set(
        existingPlatforms
            .filter((p) => (targetFeature ? p.features.includes(targetFeature) : isGlobalPlatform(p)))
            .map((p) => p.name),
    );

    const hostPlatform = getHostCondaPlatform();
    const presetDescMap = new Map(CONDA_PLATFORM_PRESETS.map((p) => [p.name, p.description]));
    const seenNames = new Set<string>();

    interface PlatformPickItem extends QuickPickItem {
        platform: string;
    }

    const items: PlatformPickItem[] = [];

    for (const p of existingPlatforms) {
        seenNames.add(p.name);
        const baseDesc = presetDescMap.get(p.name) ?? (p.subdir ? `Custom platform (${p.subdir})` : 'Custom platform');
        const osTag = p.name === hostPlatform ? ' (Current OS)' : '';
        const vpTag = p.virtualPackages.length > 0 ? ` [${p.virtualPackages.join(', ')}]` : '';
        items.push({
            label: `$(device-desktop) ${p.name}`,
            description: `${baseDesc}${osTag}${vpTag}`,
            platform: p.name,
            picked: activeInScope.has(p.name),
        });
    }

    for (const preset of CONDA_PLATFORM_PRESETS) {
        if (seenNames.has(preset.name)) {
            continue;
        }
        items.push({
            label: `$(device-desktop) ${preset.name}`,
            description: preset.name === hostPlatform ? `${preset.description} (Current OS)` : preset.description,
            platform: preset.name,
            picked: activeInScope.has(preset.name),
        });
    }

    if (!targetFeature) {
        items.unshift({
            label: '$(sparkle) Auto-detect Host Platform',
            description: 'Auto-detect host OS, architecture, and virtual packages (CUDA, glibc)',
            platform: '__auto_detect__',
            picked: false,
        });
    }

    const scopeLabel = formatScope(targetFeature);
    const selected = await window.showQuickPick(items, {
        title: `Pixi: Configure Target Platforms (${scopeLabel})`,
        placeHolder: 'Select target platforms to enable in this scope (Check/Uncheck)',
        canPickMany: true,
    });
    if (!selected) {
        return;
    }

    const selectedSet = new Set(selected.map((s) => s.platform));
    const autoDetectRequested = selectedSet.has('__auto_detect__');
    selectedSet.delete('__auto_detect__');

    if (!targetFeature && selectedSet.size === 0 && !autoDetectRequested) {
        window.showWarningMessage(
            'Cannot remove all workspace platforms. A Pixi project must have at least one target platform.',
        );
        return;
    }

    const toAdd = [...selectedSet].filter((name) => !activeInScope.has(name));
    const toRemove = [...activeInScope].filter((name) => !selectedSet.has(name));

    if (!autoDetectRequested && toAdd.length === 0 && toRemove.length === 0) {
        return;
    }

    const scopeArgs = targetFeature ? ['-f', targetFeature] : [];
    const commandBatch: string[][] = [];
    if (autoDetectRequested) {
        commandBatch.push(['workspace', 'platform', 'add', ...scopeArgs, '--auto-detect']);
    }
    if (toAdd.length > 0) {
        commandBatch.push(['workspace', 'platform', 'add', ...scopeArgs, ...toAdd]);
    }
    if (toRemove.length > 0) {
        commandBatch.push(['workspace', 'platform', 'remove', ...scopeArgs, ...toRemove]);
    }

    const projectName = manager.getProjectName(projectPath);
    const summaryParts: string[] = [];
    if (autoDetectRequested) {
        summaryParts.push('auto-detected host');
    }
    if (selectedSet.size > 0) {
        summaryParts.push([...selectedSet].join(', '));
    }
    const summary = summaryParts.length > 0 ? summaryParts.join(', ') : 'inherited from workspace';
    await runPixiWithProgress(
        `Pixi: Updating target platforms for ${scopeLabel} in '${projectName}'...`,
        commandBatch,
        projectPath,
        manager,
        `Pixi: Updated target platforms for ${scopeLabel} in '${projectName}' (${summary}).`,
    );
}

export async function handleAutoDetectPlatformCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
): Promise<void> {
    const projectPath = await pickPixiProject(
        manager,
        'Select Pixi project to add detected host platform to',
        targetItem,
    );
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    await runPixiWithProgress(
        `Pixi: Auto-detecting host platform for '${projectName}'...`,
        [['workspace', 'platform', 'add', '--auto-detect']],
        projectPath,
        manager,
        `Pixi: Successfully added detected host platform to '${projectName}'.`,
    );
}

export function registerPlatformCommands(manager: PixiProjectManager): Disposable[] {
    return [
        commands.registerCommand('pixi.platform', (targetItem?: unknown, presetFeature?: string) =>
            handleConfigurePlatformsCommand(manager, targetItem, presetFeature),
        ),
        commands.registerCommand('pixi.platform.autoDetect', (targetItem?: unknown) =>
            handleAutoDetectPlatformCommand(manager, targetItem),
        ),
    ];
}
