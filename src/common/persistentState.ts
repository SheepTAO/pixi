import * as path from 'path';
import { ExtensionContext, Memento } from 'vscode';

export interface PersistentState {
    get<T>(key: string, defaultValue?: T): T | undefined;
    set<T>(key: string, value: T): Thenable<void>;
}

let workspaceState: Memento | undefined;

const persistentState: PersistentState = {
    get: <T>(key: string, defaultValue?: T) =>
        workspaceState ? workspaceState.get<T>(key, defaultValue as T) : defaultValue,
    set: <T>(key: string, value: T) => (workspaceState ? workspaceState.update(key, value) : Promise.resolve()),
};

export function setPersistentState(context: ExtensionContext): void {
    workspaceState = context.workspaceState;
}

export function getWorkspacePersistentState(): PersistentState {
    return persistentState;
}

export const GLOBAL_ENV_KEY = 'globalEnvName';

export function getProjectEnvStorageKey(projectPath: string): string {
    const normalized = path.normalize(projectPath).replace(/[/\\]+$/, '');
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    return `projectEnvName:${key}`;
}
