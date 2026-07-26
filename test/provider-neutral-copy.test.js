import test from 'node:test';
import assert from 'node:assert/strict';
import { removeProviderBranding } from '../src/ui/provider-neutral-copy.js';

test('removes provider branding from errors shown to users', () => {
    assert.equal(
        removeProviderBranding('MinerU parsing failed'),
        'PDF conversion service parsing failed'
    );
    assert.doesNotMatch(
        removeProviderBranding('Unable to extract MinerU result'),
        /mineru/i
    );
});
