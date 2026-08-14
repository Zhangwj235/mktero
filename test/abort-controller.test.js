import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeAbortController } from '../src/platform/abort-controller.js';

test('prefers the plugin global AbortController without consulting Zotero windows', () => {
    class SandboxAbortController {}
    const controller = createRuntimeAbortController({
        globalObject: { AbortController: SandboxAbortController },
        zotero: {
            getMainWindow() {
                assert.fail('the Zotero window should not be consulted');
            },
        },
    });

    assert.ok(controller instanceof SandboxAbortController);
});

test('uses the main window AbortController without consulting the hidden window', () => {
    class MainWindowAbortController {}
    const controller = createRuntimeAbortController({
        globalObject: {},
        zotero: {
            getMainWindow: () => ({
                AbortController: MainWindowAbortController,
            }),
        },
        services: {
            appShell: {
                get hiddenDOMWindow() {
                    throw new Error('NS_ERROR_FAILURE');
                },
            },
        },
    });

    assert.ok(controller instanceof MainWindowAbortController);
});

test('falls back to the hidden DOM AbortController without a main window', () => {
    class HiddenAbortController {}
    const controller = createRuntimeAbortController({
        globalObject: {},
        zotero: { getMainWindow: () => null },
        services: {
            appShell: {
                hiddenDOMWindow: { AbortController: HiddenAbortController },
            },
        },
    });

    assert.ok(controller instanceof HiddenAbortController);
});
