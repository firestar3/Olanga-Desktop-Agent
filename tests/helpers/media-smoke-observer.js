// Test-only observation of the exact JSON sent to the real native helper.
// Preserve every spawn/write argument and return value; never issue a request.
function observeMediaControllerFactory(mediaModule, spawnProcess, onCommand) {
  const original = mediaModule.createMediaController;
  const observed = options => {
    const spawnNative = options?.spawnProcess || spawnProcess;
    return original({ ...options, spawnProcess: (...args) => {
      const worker = spawnNative(...args);
      const write = worker.stdin.write;
      worker.stdin.write = function (...writeArgs) {
        try { onCommand(JSON.parse(String(writeArgs[0]).trim())); } catch (_) {}
        return write.apply(this, writeArgs);
      };
      return worker;
    } });
  };
  mediaModule.createMediaController = observed;
  return () => { if (mediaModule.createMediaController === observed) mediaModule.createMediaController = original; };
}

module.exports = { observeMediaControllerFactory };
