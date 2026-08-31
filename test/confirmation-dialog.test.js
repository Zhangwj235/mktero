import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LUCIDE_ICONS } from '../src/icons/lucide-icon.js';
import {
    createConfirmationDialog,
} from '../src/ui/confirmation-dialog.js';

function createFixture() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const trigger = document.createElement('button');
    trigger.textContent = 'Open';
    const parent = document.createElement('main');
    document.body.append(trigger, parent);
    trigger.focus();
    const dialog = createConfirmationDialog({ document, parent });
    return { dom, document, trigger, parent, dialog };
}

function keydown(window, target, key, { shiftKey = false } = {}) {
    target.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
        shiftKey,
    }));
}

test('renders an accessible Mktero confirmation and defaults focus to Cancel',
    async () => {
        const fixture = createFixture();
        const confirmation = fixture.dialog.confirm({
            title: 'Restore all corrections?',
            message: 'Restore all 2 corrections to the original result?',
            confirmLabel: 'Restore all',
            cancelLabel: 'Cancel',
            tone: 'danger',
            icon: LUCIDE_ICONS.triangleAlert,
            confirmIcon: LUCIDE_ICONS.rotateCcw,
        });
        await Promise.resolve();

        const backdrop = fixture.parent.querySelector(
            '.mktero-confirmation-backdrop'
        );
        const modal = backdrop.querySelector('[role="dialog"]');
        const cancel = backdrop.querySelector(
            '[data-confirmation-action="cancel"]'
        );
        const confirm = backdrop.querySelector(
            '[data-confirmation-action="confirm"]'
        );
        assert.equal(modal.getAttribute('aria-modal'), 'true');
        assert.equal(
            backdrop.querySelector('.mktero-confirmation-title').textContent,
            'Restore all corrections?'
        );
        assert.equal(
            backdrop.querySelector('.mktero-confirmation-message').textContent,
            'Restore all 2 corrections to the original result?'
        );
        assert.equal(
            backdrop.querySelector('.mktero-confirmation-symbol svg')
                .getAttribute('data-lucide'),
            'triangle-alert'
        );
        assert.equal(confirm.querySelector('svg').getAttribute('data-lucide'),
            'rotate-ccw');
        assert.equal(fixture.document.activeElement, cancel);

        keydown(fixture.dom.window, cancel, 'Tab', { shiftKey: true });
        assert.equal(fixture.document.activeElement, confirm);
        keydown(fixture.dom.window, confirm, 'Tab');
        assert.equal(fixture.document.activeElement, cancel);

        confirm.click();
        assert.equal(await confirmation, true);
        assert.equal(fixture.parent.querySelector('[role="dialog"]'), null);
        assert.equal(fixture.document.activeElement, fixture.trigger);
        fixture.dialog.destroy();
        fixture.dom.window.close();
    });

test('Escape and backdrop clicks cancel without invoking the confirm action',
    async () => {
        const fixture = createFixture();
        const escaped = fixture.dialog.confirm({
            title: 'Retranslate changed block?',
            message: 'Retranslate only this block?',
            confirmLabel: 'Retranslate',
            cancelLabel: 'Cancel',
        });
        await Promise.resolve();
        keydown(
            fixture.dom.window,
            fixture.parent.querySelector('[role="dialog"]'),
            'Escape'
        );
        assert.equal(await escaped, false);

        const backdropCancelled = fixture.dialog.confirm({
            title: 'Reparse PDF?',
            message: 'Saved corrections will be removed.',
            confirmLabel: 'Reparse PDF',
            cancelLabel: 'Cancel',
        });
        await Promise.resolve();
        fixture.parent.querySelector('.mktero-confirmation-backdrop').click();
        assert.equal(await backdropCancelled, false);
        assert.equal(fixture.document.activeElement, fixture.trigger);
        fixture.dialog.destroy();
        fixture.dom.window.close();
    });

test('a newer request cancels the prior request and destroy cancels the active one',
    async () => {
        const fixture = createFixture();
        const first = fixture.dialog.confirm({
            title: 'First',
            message: 'First request',
            confirmLabel: 'Continue',
            cancelLabel: 'Cancel',
        });
        const second = fixture.dialog.confirm({
            title: 'Second',
            message: 'Second request',
            confirmLabel: 'Continue',
            cancelLabel: 'Cancel',
        });
        assert.equal(await first, false);
        assert.equal(
            fixture.parent.querySelector('.mktero-confirmation-title').textContent,
            'Second'
        );
        fixture.dialog.destroy();
        assert.equal(await second, false);
        assert.equal(fixture.parent.querySelector('[role="dialog"]'), null);
        fixture.dom.window.close();
    });
