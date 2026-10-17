import { commands, Disposable, QuickPickItem, QuickPickItemKind, Uri, window } from 'vscode';

import { getHostDetectedVirtualPackageValue } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { revealDefinitionInManifest, unquoteString } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import {
    getProjectSystemRequirements,
    getWorkspacePlatforms,
    SYSTEM_REQUIREMENT_DESCRIPTORS,
    SystemRequirementDescriptor,
    SystemRequirementsRecord,
    WorkspacePlatformEntry,
} from '../../core/systemRequirements';
import { extractCommandContext, pickPixiProject } from './common';

interface SystemRequirementItem extends QuickPickItem {
    descriptor?: SystemRequirementDescriptor;
    action?: 'reveal' | 'clear';
}

async function promptForPropertyValue(
    descriptor: SystemRequirementDescriptor,
    currentValue?: string,
    projectPath?: string,
): Promise<string | null | undefined> {
    interface ValuePickItem extends QuickPickItem {
        value?: string;
        isCustom?: boolean;
        isRemove?: boolean;
    }

    const hostDetectedValue = await getHostDetectedVirtualPackageValue(descriptor.id, projectPath);

    const items: ValuePickItem[] = [];

    if (hostDetectedValue) {
        items.push({
            label:
                hostDetectedValue === currentValue
                    ? `$(check) $(chip) ${hostDetectedValue}`
                    : `$(chip) ${hostDetectedValue}`,
            description:
                hostDetectedValue === currentValue
                    ? '(Current & Detected on Host Machine)'
                    : '(Detected on Host Machine)',
            value: hostDetectedValue,
        });
    }

    for (const p of descriptor.presets) {
        if (p === hostDetectedValue) {
            continue;
        }
        items.push({
            label: p === currentValue ? `$(check) ${p}` : p,
            description: p === currentValue ? '(Current)' : undefined,
            value: p,
        });
    }

    if (currentValue && currentValue !== hostDetectedValue && !descriptor.presets.includes(currentValue)) {
        items.unshift({
            label: `$(check) ${currentValue}`,
            description: '(Current custom value)',
            value: currentValue,
        });
    }

    items.push({
        label: `$(edit) Custom value...`,
        description: `Enter custom ${descriptor.label}`,
        isCustom: true,
    });

    if (currentValue !== undefined) {
        items.push({
            label: '',
            kind: QuickPickItemKind.Separator,
        });
        items.push({
            label: `$(trash) Remove '${descriptor.id}'`,
            description: `Delete this requirement from project platforms`,
            isRemove: true,
        });
    }

    const selected = await window.showQuickPick(items, {
        title: `Pixi: Configure ${descriptor.label} (${descriptor.id})`,
        placeHolder: `Select a preset version or enter a custom value${currentValue ? ` (Current: ${currentValue})` : ''}`,
    });

    if (!selected) {
        return undefined; // user cancelled
    }

    if (selected.isRemove) {
        return null; // remove
    }

    if (selected.isCustom) {
        const input = await window.showInputBox({
            title: `Pixi: Enter ${descriptor.label} Requirement`,
            prompt: descriptor.description,
            value: currentValue ?? '',
            placeHolder: descriptor.placeholder,
            validateInput: (val) => {
                const trimmed = unquoteString(val);
                if (!trimmed) {
                    return 'Value cannot be empty (cancel or use remove option instead).';
                }
                return null;
            },
        });
        if (input === undefined) {
            return undefined;
        }
        const cleaned = unquoteString(input);
        return cleaned || undefined;
    }

    return selected.value;
}

async function applyRequirementUpdate(
    projectPath: string,
    manager: PixiProjectManager,
    descriptor: SystemRequirementDescriptor,
    newVal: string | null,
): Promise<void> {
    const existingPlatforms = await getWorkspacePlatforms(projectPath, manager);
    if (existingPlatforms.length === 0) {
        window.showWarningMessage('No platforms found in workspace. Please add a target platform first.');
        return;
    }

    let compatiblePlatforms = existingPlatforms.filter((p) => {
        const sub = (p.subdir || p.name).toLowerCase();
        if (descriptor.id === 'linux' || descriptor.id === 'libc') {
            return sub.startsWith('linux');
        }
        if (descriptor.id === 'macos') {
            return sub.startsWith('osx');
        }
        if (descriptor.id === 'windows') {
            return sub.startsWith('win');
        }
        return true;
    });

    if (compatiblePlatforms.length === 0) {
        compatiblePlatforms = existingPlatforms;
    }

    let targetPlatforms: WorkspacePlatformEntry[] = [];
    if (compatiblePlatforms.length === 1) {
        targetPlatforms = compatiblePlatforms;
    } else {
        interface PlatformPickItem extends QuickPickItem {
            platforms: WorkspacePlatformEntry[];
        }
        const pickItems: PlatformPickItem[] = [
            {
                label: '$(globe) All Compatible Platforms',
                description: compatiblePlatforms.map((p) => p.name).join(', '),
                platforms: compatiblePlatforms,
            },
            ...compatiblePlatforms.map((p) => ({
                label: `$(device-desktop) ${p.name}`,
                description: p.subdir ? `subdir: ${p.subdir}` : undefined,
                platforms: [p],
            })),
        ];

        const picked = await window.showQuickPick(pickItems, {
            title: `Pixi: Select Platform for ${descriptor.label}`,
            placeHolder: `Select target platform to apply ${descriptor.label} = "${newVal ?? 'removed'}"`,
        });
        if (!picked) {
            return;
        }
        targetPlatforms = picked.platforms;
    }

    const commandBatch: string[][] = [];
    for (const p of targetPlatforms) {
        if (newVal === null) {
            const removeName = descriptor.virtualPackageName || `__${descriptor.id}`;
            commandBatch.push(['workspace', 'platform', 'edit', p.name, '--remove-virtual-package', removeName]);
        } else if (descriptor.cliFlag) {
            commandBatch.push(['workspace', 'platform', 'edit', p.name, descriptor.cliFlag, newVal]);
        } else if (descriptor.id === 'unix') {
            if (newVal === 'true') {
                commandBatch.push(['workspace', 'platform', 'edit', p.name, '__unix=0=0']);
            } else {
                commandBatch.push(['workspace', 'platform', 'edit', p.name, '--remove-virtual-package', '__unix']);
            }
        }
    }

    if (commandBatch.length === 0) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    const targetNames = targetPlatforms.map((p) => p.name).join(', ');
    await runPixiWithProgress(
        `Pixi: Updating '${descriptor.label}' for [${targetNames}] in '${projectName}'...`,
        commandBatch,
        projectPath,
        manager,
        `Pixi: Updated '${descriptor.label}' (${newVal ? `${descriptor.id} = "${newVal}"` : 'removed'}) for [${targetNames}].`,
    );
}

export function registerSystemRequirementsCommands(manager: PixiProjectManager): Disposable[] {
    // 1. Configure System Requirements
    const configCommand = commands.registerCommand(
        'pixi.systemRequirements',
        async (targetItem?: unknown, preselectedProp?: string) => {
            const ctx = extractCommandContext(targetItem);
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to configure system requirements for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const manifestPath = manager.getManifestPath(projectPath);
            if (!manifestPath) {
                window.showErrorMessage('No pixi.toml or pyproject.toml found in this project.');
                return;
            }

            const targetProp = preselectedProp || ctx.propertyName;
            if (targetProp) {
                const descriptor = SYSTEM_REQUIREMENT_DESCRIPTORS.find((d) => d.id === targetProp) || {
                    id: targetProp,
                    label: targetProp,
                    description: `System requirement '${targetProp}'`,
                    icon: 'symbol-property',
                    presets: [],
                    placeholder: `Enter value for '${targetProp}'`,
                    virtualPackageName: `__${targetProp}`,
                };
                const currentReqs = (await getProjectSystemRequirements(projectPath, manager)) ?? {};
                const newVal = await promptForPropertyValue(descriptor, currentReqs[descriptor.id], projectPath);
                if (newVal === undefined) {
                    return;
                }
                await applyRequirementUpdate(projectPath, manager, descriptor, newVal);
                return;
            }

            // Main QuickPick flow
            const currentReqs: SystemRequirementsRecord =
                (await getProjectSystemRequirements(projectPath, manager)) ?? {};
            const items: SystemRequirementItem[] = SYSTEM_REQUIREMENT_DESCRIPTORS.map((desc) => {
                const val = currentReqs[desc.id];
                return {
                    label: `$(${desc.icon}) ${desc.label} (${desc.id})`,
                    description: val ? `Current: ${val}` : '(Not configured)',
                    detail: desc.description,
                    descriptor: desc,
                };
            });

            const hasAny = Object.keys(currentReqs).length > 0;
            if (hasAny) {
                items.push({
                    label: 'Actions',
                    kind: QuickPickItemKind.Separator,
                });
                items.push({
                    label: '$(go-to-file) Reveal in Manifest',
                    description: 'Jump to platforms in manifest file',
                    action: 'reveal',
                });
                items.push({
                    label: '$(trash) Remove All System Requirements',
                    description: 'Clear virtual package requirements across all platforms',
                    action: 'clear',
                });
            }

            const projectName = manager.getProjectName(projectPath);
            const picked = await window.showQuickPick(items, {
                title: `Pixi: System Requirements (${projectName})`,
                placeHolder: 'Select a system requirement to configure, edit, or remove',
                matchOnDescription: true,
                matchOnDetail: true,
            });

            if (!picked) {
                return;
            }

            if (picked.action === 'reveal') {
                await revealDefinitionInManifest({
                    manifestPath,
                    targetName: 'platforms',
                    kind: 'platforms',
                });
                return;
            }

            if (picked.action === 'clear') {
                const confirm = await window.showWarningMessage(
                    `Are you sure you want to remove all system requirements from '${projectName}'?`,
                    { modal: true },
                    'Remove All',
                );
                if (confirm !== 'Remove All') {
                    return;
                }

                const existingPlatforms = await getWorkspacePlatforms(projectPath, manager);
                const platformsWithVp = existingPlatforms.filter((p) => p.virtualPackages.length > 0);
                const commandBatch: string[][] = [];
                for (const p of platformsWithVp) {
                    commandBatch.push(['workspace', 'platform', 'edit', p.name, '--clear-virtual-packages']);
                }

                if (commandBatch.length > 0) {
                    await runPixiWithProgress(
                        `Pixi: Clearing system requirements in '${projectName}'...`,
                        commandBatch,
                        projectPath,
                        manager,
                        `Pixi: Cleared all system requirements from '${projectName}'.`,
                    );
                } else {
                    await manager.refresh(Uri.file(projectPath));
                    window.showInformationMessage(`Pixi: Removed all system requirements from '${projectName}'.`);
                }
                return;
            }

            if (picked.descriptor) {
                const desc = picked.descriptor;
                const newVal = await promptForPropertyValue(desc, currentReqs[desc.id], projectPath);
                if (newVal === undefined) {
                    return;
                }
                await applyRequirementUpdate(projectPath, manager, desc, newVal);
            }
        },
    );

    // 2. Reveal in Manifest
    const revealCommand = commands.registerCommand('pixi.systemRequirements.reveal', async (targetItem?: unknown) => {
        const ctx = extractCommandContext(targetItem);
        const projectPath = await pickPixiProject(
            manager,
            'Select Pixi project to reveal system requirements for',
            targetItem,
        );
        if (!projectPath) {
            return;
        }
        const manifestPath = manager.getManifestPath(projectPath);
        if (!manifestPath) {
            window.showErrorMessage('No manifest file found for this project.');
            return;
        }

        await revealDefinitionInManifest({
            manifestPath,
            targetName: ctx.propertyName || 'platforms',
            kind: 'platforms',
        });
    });

    // 3. Edit single property
    const editPropCommand = commands.registerCommand(
        'pixi.systemRequirements.editProperty',
        async (targetItem?: unknown, propName?: string) => {
            const ctx = extractCommandContext(targetItem);
            const targetProp = propName || ctx.propertyName;
            await commands.executeCommand('pixi.systemRequirements', ctx.projectPath || targetItem, targetProp);
        },
    );

    // 4. Remove single property
    const removePropCommand = commands.registerCommand(
        'pixi.systemRequirements.removeProperty',
        async (targetItem?: unknown, propName?: string) => {
            const ctx = extractCommandContext(targetItem);
            const targetProp = propName || ctx.propertyName;
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to remove system requirement from',
                targetItem,
            );
            if (!projectPath || !targetProp) {
                return;
            }

            const confirm = await window.showWarningMessage(
                `Remove '${targetProp}' requirement from project?`,
                'Remove',
            );
            if (confirm !== 'Remove') {
                return;
            }

            const descriptor = SYSTEM_REQUIREMENT_DESCRIPTORS.find((d) => d.id === targetProp) || {
                id: targetProp,
                label: targetProp,
                description: `System requirement '${targetProp}'`,
                icon: 'symbol-property',
                presets: [],
                placeholder: '',
                virtualPackageName: `__${targetProp}`,
            };
            await applyRequirementUpdate(projectPath, manager, descriptor, null);
        },
    );

    return [configCommand, revealCommand, editPropCommand, removePropCommand];
}
