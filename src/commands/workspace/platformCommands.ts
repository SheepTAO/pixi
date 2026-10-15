import { commands, Disposable, QuickPickItem, window } from 'vscode';

import { getHostCondaPlatform, runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { safeJsonParse } from '../../common/execUtils';
import { CONDA_PLATFORM_PRESETS } from '../../core/presets';
import { PixiProjectManager } from '../../core/projectManager';
import { formatScope, pickPixiProject, resolveWorkspaceOrFeatureScope } from './common';

interface RawPlatformListJson {
    platforms?: Array<{
        name: string;
        subdir?: string;
        virtual_packages?: string[];
        features?: string[];
        environments?: string[];
        is_autodetected?: boolean;
    }>;
}

export interface WorkspacePlatformEntry {
    name: string;
    subdir?: string;
    virtualPackages: string[];
    features: string[];
    environments: string[];
}

function isGlobalPlatform(p: WorkspacePlatformEntry): boolean {
    return p.features.length === 0 || p.environments.includes('default');
}

export async function getWorkspacePlatforms(projectPath: string): Promise<WorkspacePlatformEntry[]> {
    try {
        const jsonOut = await runPixi(['workspace', 'platform', 'list', '--json'], { cwd: projectPath });
        const parsed = safeJsonParse<RawPlatformListJson>(jsonOut);
        if (parsed?.platforms && Array.isArray(parsed.platforms)) {
            return parsed.platforms
                .filter((p) => !p.is_autodetected && Boolean(p.name))
                .map((p) => ({
                    name: p.name,
                    subdir: p.subdir,
                    virtualPackages: p.virtual_packages || [],
                    features: p.features || [],
                    environments: p.environments || [],
                }));
        }
    } catch {
        // Ignore CLI errors and return empty list
    }
    return [];
}

export function registerPlatformCommands(manager: PixiProjectManager): Disposable[] {
    return [
        // Pixi: Configure Target Platforms...
        commands.registerCommand('pixi.platform', async (targetItem?: unknown, presetFeature?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to configure target platforms for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const platformsPromise = getWorkspacePlatforms(projectPath);
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
                const baseDesc =
                    presetDescMap.get(p.name) ?? (p.subdir ? `Custom platform (${p.subdir})` : 'Custom platform');
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
                    description:
                        preset.name === hostPlatform ? `${preset.description} (Current OS)` : preset.description,
                    platform: preset.name,
                    picked: activeInScope.has(preset.name),
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

            if (!targetFeature && selected.length === 0) {
                window.showWarningMessage(
                    'Cannot remove all workspace platforms. A Pixi project must have at least one target platform.',
                );
                return;
            }

            const selectedSet = new Set(selected.map((s) => s.platform));
            const toAdd = [...selectedSet].filter((name) => !activeInScope.has(name));
            const toRemove = [...activeInScope].filter((name) => !selectedSet.has(name));

            if (toAdd.length === 0 && toRemove.length === 0) {
                return;
            }

            const scopeArgs = targetFeature ? ['-f', targetFeature] : [];
            const commandBatch: string[][] = [];
            if (toAdd.length > 0) {
                commandBatch.push(['workspace', 'platform', 'add', ...scopeArgs, ...toAdd]);
            }
            if (toRemove.length > 0) {
                commandBatch.push(['workspace', 'platform', 'remove', ...scopeArgs, ...toRemove]);
            }

            const projectName = manager.getProjectName(projectPath);
            const summary = selectedSet.size > 0 ? [...selectedSet].join(', ') : 'inherited from workspace';
            await runPixiWithProgress(
                `Pixi: Updating target platforms for ${scopeLabel} in '${projectName}'...`,
                commandBatch,
                projectPath,
                manager,
                `Pixi: Updated target platforms for ${scopeLabel} in '${projectName}' (${summary}).`,
            );
        }),
    ];
}
