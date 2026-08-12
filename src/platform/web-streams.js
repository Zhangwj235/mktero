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
const hiddenWindow = globalThis.Services?.appShell?.hiddenDOMWindow;

for (const name of [
    'ReadableStream',
    'TransformStream',
    'WritableStream',
]) {
    if (typeof globalThis[name] !== 'function'
        && typeof (mainWindow?.[name] || hiddenWindow?.[name]) === 'function') {
        globalThis[name] = mainWindow?.[name] || hiddenWindow[name];
    }
}
