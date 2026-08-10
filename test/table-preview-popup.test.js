import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTablePreviewPopup } from '../src/editor/table-preview-popup.js';

test('keeps a table preview away from the viewport edge', () => {
    const dom = new JSDOM('<!doctype html><main><button>Table 1</button></main>');
    const { document } = dom.window;
    const parent = document.querySelector('main');
    const anchor = document.querySelector('button');
    Object.defineProperty(dom.window, 'innerWidth', {
        configurable: true,
        value: 800,
    });
    anchor.getBoundingClientRect = () => ({
        bottom: 40,
        height: 20,
        left: 0,
        right: 20,
        top: 20,
        width: 20,
    });
    const originalGetBoundingClientRect =
        dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.classList.contains('mktero-table-preview-popup')) {
            return { height: 200, width: 700 };
        }
        return originalGetBoundingClientRect.call(this);
    };
    const preview = createTablePreviewPopup(parent);

    preview.open({
        anchor,
        target: {
            caption: 'Table 1. Result',
            table: {
                source: '| Result |\n| --- |\n| 1 |',
            },
        },
    });

    assert.equal(
        document.querySelector('.mktero-table-preview-popup')?.style.left,
        '24px'
    );

    preview.destroy();
    dom.window.HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
    dom.window.close();
});
