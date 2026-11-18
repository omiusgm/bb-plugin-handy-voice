import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

test('status reports missing Handy without audio or returning a local path', async () => {
  const { bb, harness } = createFakePluginHost({
    settings: { warmOnLoad: false, handyPath: '/fixture/missing-handy' },
  });
  try {
    await plugin(bb);
    const result = await harness.behavior.callRpc('dictationStatus', {});
    assert.equal(result.ready, false);
    assert.match(result.message, /Handy/);
    assert.doesNotMatch(JSON.stringify(result), /fixture\/missing-handy/);
    assert.equal(harness.registrations.services.length, 0);
  } finally { await harness.lifecycle.dispose(); }
});

test('status accepts executable dependencies without running them', async () => {
  const { bb, harness } = createFakePluginHost({
    settings: { warmOnLoad: false, handyPath: process.execPath, ffmpegPath: process.execPath },
  });
  try {
    await plugin(bb);
    assert.deepEqual(await harness.behavior.callRpc('dictationStatus', {}), { ready: true, message: null });
    await assert.rejects(harness.behavior.callRpc('dictationStatus', { extra: true }));
  } finally { await harness.lifecycle.dispose(); }
});
