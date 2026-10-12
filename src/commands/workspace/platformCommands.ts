import * as path from 'path';
import { commands, Disposable, QuickPickItem, QuickPickItemKind, window } from 'vscode';

import { getHostCondaPlatform, runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { safeJsonParse } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import { extractFeatureName, getWorkspaceFeatures, pickPixiProject } from './common';

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
        // Fall back to text output parsing
    }

    try {
        const textOut = await runPixi(['workspace', 'platform', 'list'], { cwd: projectPath });
        const entries: WorkspacePlatformEntry[] = [];
        for (const rawLine of textOut.split(/\r?\n/)) {
            const line = rawLine.trim();
            const name = line.startsWith('- ')
                ? line.slice(2).trim()
                : rawLine.match(/^([a-zA-Z0-9_\-]+):\s+platform=/)?.[1];
            if (name) {
                entries.push({
                    name,
                    virtualPackages: [],
                    features: [],
                    environments: [],
                });
            }
        }
        return entries;
    } catch {
        return [];
    }
}

async function resolvePlatformTargetFeature(
    projectPath: string,
    targetItem?: unknown,
    presetFeature?: string,
): Promise<string | undefined | null> {
    const contextFeature = extractFeatureName(targetItem, presetFeature);
    if (contextFeature) {
        return contextFeature === 'default' ? undefined : contextFeature;
    }

    const features = await getWorkspaceFeatures(projectPath);
    const namedFeatures = features.filter((f) => f.name !== 'default');
    if (namedFeatures.length === 0) {
        return undefined;
    }

    interface ScopePickItem extends QuickPickItem {
        featureName?: string;
    }

    const items: ScopePickItem[] = [
        {
            label: 'Workspace Scope',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: '$(globe) [workspace] (Global Platforms)',
            description: 'Shared across all environments and features (default)',
            featureName: undefined,
        },
        {
            label: 'Feature Scope',
            kind: QuickPickItemKind.Separator,
        },
        ...namedFeatures.map((f) => ({
            label: `$(symbol-namespace) Feature: ${f.name}`,
            description: `Target platforms specific to feature '${f.name}'`,
            featureName: f.name,
        })),
    ];

    const selected = await window.showQuickPick(items, {
        title: 'Pixi: Select Platform Target Scope',
        placeHolder: 'Select scope to add platform(s) to',
    });

    if (!selected) {
        return null;
    }
    return selected.featureName;
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
            const targetFeature = await resolvePlatformTargetFeature(projectPath, targetItem, presetFeature);
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

            interface RemovePlatformItem extends QuickPickItem {
                platformName: string;
                featureScope?: string;
            }

            const items: RemovePlatformItem[] = [];
            for (const p of existingPlatforms) {
                const vpDetail = p.virtualPackages.length > 0 ? ` [${p.virtualPackages.join(', ')}]` : '';
                if (filterFeature) {
                    if (p.features.includes(filterFeature)) {
                        items.push({
                            label: `$(device-desktop) ${p.name}`,
                            description: `Feature: ${filterFeature}${vpDetail}`,
                            platformName: p.name,
                            featureScope: filterFeature,
                        });
                    }
                    continue;
                }

                if (isGlobalPlatform(p)) {
                    items.push({
                        label: `$(device-desktop) ${p.name}`,
                        description: `Workspace (global)${vpDetail}`,
                        platformName: p.name,
                        featureScope: undefined,
                    });
                }
                for (const feat of p.features) {
                    items.push({
                        label: `$(device-desktop) ${p.name}`,
                        description: `Feature: ${feat}${vpDetail}`,
                        platformName: p.name,
                        featureScope: feat,
                    });
                }
            }

            if (items.length === 0) {
                window.showInformationMessage(
                    filterFeature
                        ? `No custom platforms configured on feature '${filterFeature}'.`
                        : 'No removable platforms found in this Pixi project.',
                );
                return;
            }

            const selected = await window.showQuickPick(items, {
                title: filterFeature ? `Pixi: Remove Platform (feature '${filterFeature}')` : 'Pixi: Remove Platform',
                placeHolder: 'Select one or more platforms to remove from project manifest',
                canPickMany: true,
            });
            if (!selected || selected.length === 0) {
                return;
            }

            const totalGlobalCount = existingPlatforms.filter(isGlobalPlatform).length;
            const removingGlobalCount = selected.filter((s) => !s.featureScope).length;
            if (totalGlobalCount > 0 && removingGlobalCount >= totalGlobalCount) {
                window.showWarningMessage(
                    'Cannot remove all workspace platforms. A Pixi project must have at least one target platform.',
                );
                return;
            }

            const byScope = new Map<string | undefined, string[]>();
            for (const item of selected) {
                const list = byScope.get(item.featureScope) || [];
                list.push(item.platformName);
                byScope.set(item.featureScope, list);
            }

            const commandBatch: string[][] = [];
            for (const [feat, names] of byScope.entries()) {
                const args = ['workspace', 'platform', 'remove'];
                if (feat) {
                    args.push('-f', feat);
                }
                args.push(...names);
                commandBatch.push(args);
            }

            const projectName = path.basename(projectPath);
            const removedSummary = [...new Set(selected.map((s) => s.platformName))].join(', ');
            await runPixiWithProgress(
                `Pixi: Removing platform(s) ${removedSummary} from '${projectName}'...`,
                commandBatch,
                projectPath,
                manager,
                `Pixi: Removed platform(s) ${removedSummary} from '${projectName}'.`,
            );
        }),

        // Pixi: Platform Management (Hub)
        commands.registerCommand('pixi.platform', async (targetItem?: unknown) => {
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
                await commands.executeCommand(pick.command, targetItem);
            }
        }),
    ];
}
