// Zotero's privileged bootstrap sandbox can omit Web Streams globals even
// though the owning browser window provides them. AI SDK Core evaluates its
// event-stream parser while the extension bundle loads, so these constructors
// must be bridged before importing the SDK.
let mainWindow = null;
try {
    mainWindow = globalThis.Zotero?.getMainWindow?.() || null;
}
catch {
    mainWindow = null;
}

let hiddenWindow = null;
let hiddenWindowResolved = false;

function resolveHiddenWindow() {
    if (hiddenWindowResolved) return hiddenWindow;
    hiddenWindowResolved = true;
    try {
        hiddenWindow = globalThis.Services?.appShell?.hiddenDOMWindow || null;
    }
    catch {
        hiddenWindow = null;
    }
    return hiddenWindow;
}

function resolveConstructor(owner, name) {
    try {
        const Constructor = owner?.[name];
        return typeof Constructor === 'function' ? Constructor : null;
    }
    catch {
        return null;
    }
}

for (const name of [
    'ReadableStream',
    'TransformStream',
    'WritableStream',
    'TextDecoderStream',
    'TextEncoderStream',
]) {
    if (typeof globalThis[name] === 'function') continue;
    const Constructor = resolveConstructor(mainWindow, name)
        || resolveConstructor(resolveHiddenWindow(), name);
    if (Constructor) globalThis[name] = Constructor;
}
