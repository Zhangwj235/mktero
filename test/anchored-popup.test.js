import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAnchoredPopup } from '../src/editor/anchored-popup.js';

test('closes the prior anchor, invokes cleanup once, and renders XHTML', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="one"></button>'
            + '<button id="two"></button></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const one = document.querySelector('#one');
    const two = document.querySelector('#two');
    one.getBoundingClientRect = two.getBoundingClientRect = () => ({
        left: 10,
        right: 30,
        top: 20,
        bottom: 40,
        width: 20,
        height: 20,
    });
    const popup = createAnchoredPopup(parent, {
        className: 'popup',
        idPrefix: 'test-popup',
    });
    let closed = 0;
    const renderContent = ({ document: ownerDocument }) => {
        const content = ownerDocument.createElementNS(
            'http://www.w3.org/1999/xhtml',
            'button'
        );
        content.textContent = 'close';
        return content;
    };

    popup.open({ anchor: one, label: 'One', renderContent, onClose: () => closed++ });
    const first = document.querySelector('.popup');
    assert.equal(first.namespaceURI, 'http://www.w3.org/1999/xhtml');
    popup.open({ anchor: two, label: 'Two', renderContent, onClose: () => closed++ });
    assert.equal(closed, 1);
    assert.equal(one.hasAttribute('aria-describedby'), false);

    document.querySelector('.popup').dispatchEvent(new dom.window.KeyboardEvent(
        'keydown',
        { key: 'Escape', bubbles: true, cancelable: true }
    ));
    assert.equal(closed, 2);
    assert.equal(popup.isOpen(), false);
    dom.window.close();
});
