import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../lib/availability.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { probeDictationAvailability: probe } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('backend down stays unavailable; a later successful probe recovers', async () => {
  assert.equal((await probe(async () => { throw new Error('offline'); })).ready, false);
  assert.deepEqual(await probe(async () => ({ ready: true, message: null })), { ready: true, message: null });
});

test('late backend reply cannot replace a timed-out result', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const timedOut = await probe(() => pending, 5);
  assert.equal(timedOut.ready, false);
  resolve({ ready: true, message: null });
  await new Promise(done => setImmediate(done));
  assert.equal(timedOut.ready, false);
});
