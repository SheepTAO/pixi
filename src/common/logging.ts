// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as util from 'util';
import { Disposable, LogOutputChannel } from 'vscode';

type Arguments = unknown[];
let channel: LogOutputChannel | undefined;
export function registerLogger(logChannel: LogOutputChannel): Disposable {
    channel = logChannel;
    return {
        dispose: () => {
            channel = undefined;
        },
    };
}

export function traceError(...args: Arguments): void {
    channel?.error(util.format(...args));
}

export function traceInfo(...args: Arguments): void {
    channel?.info(util.format(...args));
}

export function traceVerbose(...args: Arguments): void {
    channel?.debug(util.format(...args));
}
