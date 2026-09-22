import * as fs from 'fs';
import * as path from 'path';
import { commands, Disposable, Uri, window, workspace } from 'vscode';

import { runPixi } from './cli';
import { PixiEnvManager } from './envManager';

export function registerWorkspaceCommands(manager: PixiEnvManager): Disposable {
    return commands.registerCommand('pixi-python.init', async (folderUri?: Uri) => {
        let targetFolder: string | undefined;

        if (folderUri?.fsPath) {
            targetFolder = folderUri.fsPath;
        } else if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
            if (workspace.workspaceFolders.length === 1) {
                targetFolder = workspace.workspaceFolders[0].uri.fsPath;
            } else {
                const pick = await window.showWorkspaceFolderPick({
                    placeHolder: 'Select folder to initialize Pixi project in',
                });
                targetFolder = pick?.uri.fsPath;
            }
        }

        if (!targetFolder) {
            window.showWarningMessage('Please open a folder to initialize a Pixi project.');
            return;
        }

        const pixiToml = path.join(targetFolder, 'pixi.toml');
        const pyprojectToml = path.join(targetFolder, 'pyproject.toml');
        const manifestPath = fs.existsSync(pixiToml)
            ? pixiToml
            : fs.existsSync(pyprojectToml)
              ? pyprojectToml
              : undefined;

        if (manifestPath) {
            window.showInformationMessage(
                `A project manifest (${path.basename(manifestPath)}) already exists in this folder.`,
            );
            const doc = await workspace.openTextDocument(Uri.file(manifestPath));
            await window.showTextDocument(doc);
            return;
        }

        try {
            await runPixi(['init', '.'], { cwd: targetFolder });
            await commands.executeCommand('setContext', 'pixi-python.hasPixiProject', true);
            await manager.refresh(undefined);

            if (fs.existsSync(pixiToml)) {
                const doc = await workspace.openTextDocument(Uri.file(pixiToml));
                await window.showTextDocument(doc);
            }
            window.showInformationMessage('Pixi project initialized successfully.');
        } catch (error) {
            window.showErrorMessage(`Failed to initialize Pixi project: ${error}`);
        }
    });
}
