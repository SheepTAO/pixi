import * as path from 'path';
import { commands, Disposable, window } from 'vscode';

import { getHostCondaPlatform, runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { safeJsonParse } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import {
    executeScopedWorkspaceRemove,
    extractFeatureName,
    pickPixiProject,
    resolveWorkspaceOrFeatureScope,
    ScopedRemovalQuickPickItem,
} from './common';

export interface CondaPlatformPreset {
    name: string;
    description: string;
}

export const CONDA_PLATFORM_PRESETS: readonly CondaPlatformPreset[] = [
    { name: 'linux-64', description: 'Linux x86_64 architecture' },
    { name: 'linux-aarch64', description: 'Linux ARM64 / aarch64 architecture' },
    { name: 'osx-arm64', description: 'macOS Apple Silicon (M1/M2/M3/M4)' },
    { name: 'osx-64', description: 'macOS Intel x86_64 architecture' },
    { name: 'win-64', description: 'Windows x86_64 architecture' },
    { name: 'win-arm64', description: 'Windows ARM64 architecture' },
];

interface RawPlatformListJson {
    platforms?: Array<{
        name: string;
        virtual_packages?: string[];
        features?: string[];
        environments?: string[];
        is_autodetected?: boolean;
    }>;
}

export interface WorkspacePlatformEntry {
    name: string;
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
        // Pixi: Add Platform...
        commands.registerCommand('pixi.addPlatform', async (targetItem?: unknown, presetFeature?: string) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add platform to', targetItem);
            if (!projectPath) {
                return;
            }

            const platformsPromise = getWorkspacePlatforms(projectPath);
            const targetFeature = await resolveWorkspaceOrFeatureScope(
                projectPath,
                {
                    title: 'Pixi: Select Platform Target Scope',
                    placeHolder: 'Select scope to add platform(s) to',
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
            const existingInScope = new Set(
                existingPlatforms
                    .filter((p) => (targetFeature ? p.features.includes(targetFeature) : isGlobalPlatform(p)))
                    .map((p) => p.name),
            );

            const hostPlatform = getHostCondaPlatform();
            const availableItems = CONDA_PLATFORM_PRESETS.filter((p) => !existingInScope.has(p.name)).map((p) => ({
                label: `$(device-desktop) ${p.name}`,
                description: p.name === hostPlatform ? `${p.description} (Current OS)` : p.description,
                platform: p.name,
            }));

            const scopeLabel = targetFeature ? `feature '${targetFeature}'` : 'workspace';
            if (availableItems.length === 0) {
                window.showInformationMessage(`All standard Conda platforms are already configured in ${scopeLabel}.`);
                return;
            }

            const selected = await window.showQuickPick(availableItems, {
                title: `Pixi: Add Platform (${scopeLabel})`,
                placeHolder: 'Select one or more target platforms to add',
                canPickMany: true,
            });
            if (!selected || selected.length === 0) {
                return;
            }

            const platformNames = selected.map((s) => s.platform);
            const args = ['workspace', 'platform', 'add'];
            if (targetFeature) {
                args.push('-f', targetFeature);
            }
            args.push(...platformNames);

            const projectName = path.basename(projectPath);
            const formattedList = platformNames.join(', ');
            await runPixiWithProgress(
                `Pixi: Adding platform(s) ${formattedList} to ${scopeLabel} in '${projectName}'...`,
                args,
                projectPath,
                manager,
                `Pixi: Added platform(s) ${formattedList} to ${scopeLabel} in '${projectName}'.`,
            );
        }),

        // Pixi: Remove Platform...
        commands.registerCommand('pixi.removePlatform', async (targetItem?: unknown, presetFeature?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to remove platform from',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const existingPlatforms = await getWorkspacePlatforms(projectPath);
            if (existingPlatforms.length === 0) {
                window.showInformationMessage('No configured platforms found in this Pixi project.');
                return;
            }

            const contextFeature = extractFeatureName(targetItem, presetFeature);
            const filterFeature = contextFeature && contextFeature !== 'default' ? contextFeature : undefined;

            const items: ScopedRemovalQuickPickItem[] = [];
            for (const p of existingPlatforms) {
                const vpDetail = p.virtualPackages.length > 0 ? ` [${p.virtualPackages.join(', ')}]` : '';
                if (filterFeature) {
                    if (p.features.includes(filterFeature)) {
                        items.push({
                            label: `$(device-desktop) ${p.name}`,
                            description: `Feature: ${filterFeature}${vpDetail}`,
                            itemName: p.name,
                            featureScope: filterFeature,
                        });
                    }
                    continue;
                }

                if (isGlobalPlatform(p)) {
                    items.push({
                        label: `$(device-desktop) ${p.name}`,
                        description: `Workspace (global)${vpDetail}`,
                        itemName: p.name,
                        featureScope: undefined,
                    });
                }
                for (const feat of p.features) {
                    items.push({
                        label: `$(device-desktop) ${p.name}`,
                        description: `Feature: ${feat}${vpDetail}`,
                        itemName: p.name,
                        featureScope: feat,
                    });
                }
            }

            await executeScopedWorkspaceRemove({
                subcommand: 'platform',
                noun: 'platform',
                nounPlural: 'platforms',
                projectPath,
                manager,
                items,
                totalGlobalCount: existingPlatforms.filter(isGlobalPlatform).length,
                filterFeature,
                emptyGlobalWarning:
                    'Cannot remove all workspace platforms. A Pixi project must have at least one target platform.',
            });
        }),

        // Pixi: Platform Management (Hub)
        commands.registerCommand('pixi.platform', async (targetItem?: unknown, presetFeature?: string) => {
            const actions = [
                {
                    label: '$(plus) Add Platform...',
                    description: 'Add target Conda platform(s) to the workspace or a specific feature',
                    command: 'pixi.addPlatform',
                },
                {
                    label: '$(trash) Remove Platform...',
                    description: 'Remove configured target platform(s) from the project manifest',
                    command: 'pixi.removePlatform',
                },
            ];

            const pick = await window.showQuickPick(actions, {
                title: 'Pixi: Platform Management',
                placeHolder: 'Select platform operation',
            });
            if (pick) {
                await commands.executeCommand(pick.command, targetItem, presetFeature);
            }
        }),
    ];
}
