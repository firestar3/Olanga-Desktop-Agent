const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { observeMediaControllerFactory } = require('../helpers/media-smoke-observer');
const { createMediaController } = require('../../desktop/media-controller');

for (const failObservation of [false, true]) test(`native smoke observation preserves helper behavior${failObservation ? ' when reporting throws' : ''}`, async () => {
  const media = { createMediaController };
  const sent = [], observed = [];
  const worker = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new PassThrough(), stdin: new EventEmitter(), kill() {} });
  worker.stdout.setEncoding = () => {};
  worker.stdin.write = function (text) {
    assert.equal(this, worker.stdin);
    const command = JSON.parse(text); sent.push(command);
    queueMicrotask(() => worker.stdout.emit('data', JSON.stringify({ id: command.id, result: { ok: true, verified: true, message: 'System volume is 75%.', volume: 75 } }) + '\n'));
    return true;
  };
  const restore = observeMediaControllerFactory(media, (_file, _args, options) => { assert.equal(options.windowsHide, true); return worker; }, command => {
    observed.push(command);
    if (failObservation) throw new Error('Report unavailable');
  });
  const controller = media.createMediaController({ platform: 'win32' });
  restore();
  assert.equal(media.createMediaController, createMediaController);
  try {
    const result = await controller.execute({ action: 'VOLUME_SET', level: 75 });
    assert.equal(result.volume, 75); assert.equal(result.verified, true);
    assert.deepEqual(observed, sent);
    assert.deepEqual(sent, [{ action: 'VOLUME_SET', term: '', spotifyOnly: false, level: 75, id: 1 }]);
  } finally { controller.dispose(); }
});
