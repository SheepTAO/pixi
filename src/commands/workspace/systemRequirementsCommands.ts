import * as path from 'path';
import { commands, Disposable, QuickPickItem, QuickPickItemKind, Uri, window } from 'vscode';

import { revealDefinitionInManifest, unquoteString } from '../../common/execUtils';
import { findManifestPath } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import {
    getProjectSystemRequirements,
    SYSTEM_REQUIREMENT_DESCRIPTORS,
    SystemRequirementDescriptor,
    SystemRequirementsRecord,
    updateProjectSystemRequirements,
} from '../../core/systemRequirements';
import { extractCommandContext, pickPixiProject } from './common';

interface SystemRequirementItem extends QuickPickItem {
    descriptor?: SystemRequirementDescriptor;
    action?: 'reveal' | 'clear';
}

async function promptForPropertyValue(
    descriptor: SystemRequirementDescriptor,
    currentValue?: string,
): Promise<string | null | undefined> {
    interface ValuePickItem extends QuickPickItem {
        value?: string;
        isCustom?: boolean;
        isRemove?: boolean;
    }

    const items: ValuePickItem[] = descriptor.presets.map((p) => ({
        label: p === currentValue ? `$(check) ${p}` : p,
        description: p === currentValue ? '(Current)' : undefined,
        value: p,
    }));

    if (currentValue && !descriptor.presets.includes(currentValue)) {
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
            description: `Delete this requirement from manifest`,
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
    manifestPath: string,
    manager: PixiProjectManager,
    propId: string,
    newVal: string | null,
): Promise<void> {
    await updateProjectSystemRequirements(projectPath, { [propId]: newVal });
    await manager.refresh(Uri.file(projectPath));

    const manifestName = path.basename(manifestPath);
    const action = await window.showInformationMessage(
        `Pixi: Updated '${propId}' in ${manifestName} (${newVal ? `${propId} = "${newVal}"` : 'removed'}).`,
        'Install / Sync Environments',
    );
    if (action === 'Install / Sync Environments') {
        await commands.executeCommand('pixi.install', Uri.file(projectPath));
    }
}

export function registerSystemRequirementsCommands(manager: PixiProjectManager): Disposable[] {
    // 1. Configure System Requirements
    const configCommand = commands.registerCommand(
        'pixi.systemRequirements',
        async (targetItem?: unknown, preselectedProp?: string) => {
            const ctx = extractCommandContext(targetItem);
            const projectPath =
                ctx.projectPath ||
                (await pickPixiProject(
                    manager,
                    'Select Pixi project to configure system requirements for',
                    targetItem,
                ));
            if (!projectPath) {
                return;
            }

            const manifestPath = findManifestPath(projectPath);
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
                };
                const currentReqs = getProjectSystemRequirements(projectPath) ?? {};
                const newVal = await promptForPropertyValue(descriptor, currentReqs[descriptor.id]);
                if (newVal === undefined) {
                    return;
                }
                await applyRequirementUpdate(projectPath, manifestPath, manager, descriptor.id, newVal);
                return;
            }

            // Main QuickPick flow
            const currentReqs: SystemRequirementsRecord = getProjectSystemRequirements(projectPath) ?? {};
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
                    description: 'Jump to [system-requirements] in manifest file',
                    action: 'reveal',
                });
                items.push({
                    label: '$(trash) Remove All System Requirements',
                    description: 'Delete entire [system-requirements] section',
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
                    targetName: 'system-requirements',
                    kind: 'system-requirements',
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
                const nullUpdates: Record<string, string | null> = {};
                for (const k of Object.keys(currentReqs)) {
                    nullUpdates[k] = null;
                }
                await updateProjectSystemRequirements(projectPath, nullUpdates);
                await manager.refresh(Uri.file(projectPath));
                window.showInformationMessage(`Pixi: Removed all system requirements from '${projectName}'.`);
                return;
            }

            if (picked.descriptor) {
                const desc = picked.descriptor;
                const newVal = await promptForPropertyValue(desc, currentReqs[desc.id]);
                if (newVal === undefined) {
                    return;
                }
                await applyRequirementUpdate(projectPath, manifestPath, manager, desc.id, newVal);
            }
        },
    );

    // 2. Reveal in Manifest
    const revealCommand = commands.registerCommand('pixi.systemRequirements.reveal', async (targetItem?: unknown) => {
        const ctx = extractCommandContext(targetItem);
        const projectPath =
            ctx.projectPath ||
            (await pickPixiProject(manager, 'Select Pixi project to reveal system requirements for', targetItem));
        if (!projectPath) {
            return;
        }
        const manifestPath = findManifestPath(projectPath);
        if (!manifestPath) {
            window.showErrorMessage('No manifest file found for this project.');
            return;
        }

        await revealDefinitionInManifest({
            manifestPath,
            targetName: ctx.propertyName || 'system-requirements',
            kind: 'system-requirements',
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
            const projectPath =
                ctx.projectPath ||
                (await pickPixiProject(manager, 'Select Pixi project to remove system requirement from', targetItem));
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

            await updateProjectSystemRequirements(projectPath, { [targetProp]: null });
            await manager.refresh(Uri.file(projectPath));
            window.showInformationMessage(`Pixi: Removed '${targetProp}' system requirement.`);
        },
    );

    return [configCommand, revealCommand, editPropCommand, removePropCommand];
}
