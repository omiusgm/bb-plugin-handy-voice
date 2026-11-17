import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../lib/dictation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
let sequence = 0;

async function setup(getMedia) {
  const tracks = [];
  const recorders = [];
  const stream = () => {
    const track = { stops: 0, stop() { this.stops++; } };
    tracks.push(track);
    return { getTracks: () => [track] };
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: getMedia ?? (async () => stream()) } } });
  globalThis.MediaRecorder = class {
    static isTypeSupported(type) { return type === 'audio/webm'; }
    constructor(media, { mimeType }) { this.stream = media; this.mimeType = mimeType; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    emit(text) { this.ondataavailable?.({ data: new Blob([text]) }); }
    stop() {
      assert.equal(this.state, 'recording');
      this.state = 'inactive';
      queueMicrotask(() => { this.emit('final'); this.onstop?.(); });
    }
  };
  const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// ${sequence++}`).toString('base64')}`);
  return { mod, tracks, recorders, stream };
}
function composer(key) {
  return { key, inserts: [], focuses: 0, insert(text, options) { this.inserts.push({ text, options }); }, focus() { this.focuses++; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const result = text => ({ text, audioSecs: 1, ms: 1 });

test('recording survives unmount and B stops it; final chunk goes to A', async () => {
  const { mod, tracks, recorders } = await setup();
  const a = composer('A'), b = composer('B');
  let audio;
  const unmountA = mod.registerComposer(a);
  let notifications = 0;
  const unsubscribe = mod.subscribe(() => notifications++);
  await mod.startDictation(a, async blob => { audio = await blob.text(); return result('  распознано  '); }, assert.fail);
  assert.equal(mod.getSnapshot().status, 'recording');
  recorders[0].emit('before-');
  unsubscribe(); unmountA();
  const unmountB = mod.registerComposer(b);
  recorders[0].emit('after-');
  mod.stopDictation(); mod.stopDictation();
  await tick();
  assert.equal(audio, 'before-after-final');
  assert.deepEqual(a.inserts, [{ text: 'распознано', options: { at: 'end' } }]);
  assert.equal(a.focuses, 0);
  assert.deepEqual(b.inserts, []);
  assert.equal(tracks[0].stops, 1);
  assert.equal(mod.getSnapshot().status, 'idle');
  assert.ok(notifications > 0);
  unmountB();
});

test('pending permission retains original target and blocks another start', async () => {
  let resolveMedia;
  const pending = new Promise(resolve => { resolveMedia = resolve; });
  const { mod, stream, recorders, tracks } = await setup(() => pending);
  const a = composer('A'), b = composer('B');
  const unmount = mod.registerComposer(a);
  let callsB = 0;
  const starting = mod.startDictation(a, async () => result('A text'), assert.fail);
  assert.equal(mod.getSnapshot().isStarting, true);
  assert.equal(mod.getSnapshot().targetKey, 'A');
  unmount(); mod.registerComposer(b);
  await mod.startDictation(b, async () => { callsB++; return result('B text'); }, assert.fail);
  resolveMedia(stream());
  await starting;
  assert.equal(recorders.length, 1);
  mod.stopDictation(); await tick();
  assert.equal(callsB, 0);
  assert.equal(a.inserts[0].text, 'A text');
  assert.equal(a.focuses, 0);
  assert.deepEqual(b.inserts, []);
  assert.equal(tracks[0].stops, 1);
});

test('denied microphone releases lock so a later start can succeed', async () => {
  let fail = true, makeStream;
  const env = await setup(async () => {
    if (fail) { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; }
    return makeStream();
  });
  makeStream = env.stream;
  const errors = [], a = composer('A');
  await env.mod.startDictation(a, async () => result('ok'), message => errors.push(message));
  assert.match(errors[0], /доступа к микрофону/i);
  assert.deepEqual(env.mod.getSnapshot(), { status: 'idle', elapsedSecs: 0, isStarting: false, targetKey: null });
  fail = false;
  await env.mod.startDictation(a, async () => result('ok'), assert.fail);
  env.mod.stopDictation(); await tick();
  assert.equal(a.inserts[0].text, 'ok');
  assert.equal(env.tracks[0].stops, 1);
});

test('RPC failure returns idle, releases tracks and allows retry', async () => {
  const { mod, tracks } = await setup();
  const a = composer('A'), errors = [];
  await mod.startDictation(a, async () => { throw new Error('RPC'); }, message => errors.push(message));
  mod.stopDictation(); await tick();
  assert.equal(mod.getSnapshot().status, 'idle');
  assert.equal(tracks[0].stops, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(a.inserts, []);
  await mod.startDictation(a, async () => result('retry'), assert.fail);
  mod.stopDictation(); await tick();
  assert.equal(a.inserts[0].text, 'retry');
  assert.equal(tracks[1].stops, 1);
});

test('recorder error releases microphone even when recorder.stop throws', async () => {
  const { mod, recorders, tracks } = await setup();
  const errors = [];
  await mod.startDictation(composer('A'), async () => result('unused'), message => errors.push(message));
  const originalStop = recorders[0].stop.bind(recorders[0]);
  recorders[0].stop = () => { throw new Error('stop failed'); };
  try {
    assert.doesNotThrow(() => recorders[0].onerror());
    assert.equal(mod.getSnapshot().status, 'idle');
    assert.equal(tracks[0].stops, 1);
    assert.equal(errors.length, 1);
  } finally {
    // Cleanup also when this regression fails, so its interval cannot hang the test process.
    if (mod.getSnapshot().status === 'recording') {
      recorders[0].stop = originalStop;
      mod.stopDictation();
    }
  }
});
