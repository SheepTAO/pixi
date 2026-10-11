import { ExtensionContext } from 'vscode';

export interface PersistentState {
    get<T>(key: string, defaultValue?: T): T | undefined;
    set<T>(key: string, value: T): Thenable<void>;
}

let _workspace: PersistentState | undefined;

export function setPersistentState(context: ExtensionContext): void {
    _workspace = {
        get: <T>(key: string, defaultValue?: T) => context.workspaceState.get<T>(key, defaultValue as T),
        set: <T>(key: string, value: T) => context.workspaceState.update(key, value),
    };
}

export function getWorkspacePersistentState(): PersistentState {
    if (!_workspace) {
        throw new Error('PersistentState has not been initialized.');
    }
    return _workspace;
}
