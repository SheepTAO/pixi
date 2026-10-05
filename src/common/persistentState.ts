import { ExtensionContext, Memento } from 'vscode';

export interface PersistentState {
    get<T>(key: string, defaultValue?: T): T | undefined;
    set<T>(key: string, value: T): Thenable<void>;
}

class PersistentStateImpl implements PersistentState {
    constructor(private readonly memento: Memento) {}

    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.memento.get<T>(key, defaultValue as T);
    }

    set<T>(key: string, value: T): Thenable<void> {
        return this.memento.update(key, value);
    }
}

let _workspace: PersistentState | undefined;

export function setPersistentState(context: ExtensionContext): void {
    _workspace = new PersistentStateImpl(context.workspaceState);
}

export function getWorkspacePersistentState(): PersistentState {
    if (!_workspace) {
        throw new Error('PersistentState has not been initialized.');
    }
    return _workspace;
}
