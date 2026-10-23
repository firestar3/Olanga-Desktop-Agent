/* Fixture-only failure, rendered offline without microphone or speaker output. */
class FailedAudioProcessor extends AudioWorkletProcessor {
  process() { throw new Error('Expected offline voice fixture failure'); }
}
registerProcessor('olanga-fixture-failure', FailedAudioProcessor);
