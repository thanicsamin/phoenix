import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const code = await readFile(new URL('../web/voice.js', import.meta.url), 'utf8');
function element() { return { hidden: true, value: '', attrs: {}, handlers: {}, setAttribute(name, value) { this.attrs[name] = value; }, addEventListener(name, fn) { this.handlers[name] = fn; }, dispatchEvent() {} }; }
test('voice dictation is explicit, preserves typed text, never auto-sends and stops cleanly', () => {
  const elements = { '#microphone': element(), '#message': element(), '#agent-error': element() };
  let recognition; class Recognition { constructor() { // eslint-disable-next-line @typescript-eslint/no-this-alias
recognition = this; } start() { this.started = true; } stop() { this.onend(); } }
  const window = { SpeechRecognition: Recognition };
  vm.runInNewContext(code, { window, document: { querySelector: id => elements[id] }, navigator: { language: 'en-US' }, Event: class {} });
  assert.equal(elements['#microphone'].hidden, false); assert.equal(recognition, undefined);
  elements['#message'].value = 'Existing'; elements['#microphone'].handlers.click(); assert.equal(recognition.started, true);
  recognition.onresult({ results: [[{ transcript: 'new words' }]] }); assert.equal(elements['#message'].value, 'Existing new words');
  recognition.onerror({ error: 'not-allowed' }); assert.match(elements['#agent-error'].textContent, /Microphone/);
  window.stopVoice(); assert.equal(elements['#microphone'].attrs['aria-pressed'], 'false');
});
test('unsupported browsers hide dictation; read aloud starts only after a click and toggles off', () => {
  const elements = { '#microphone': element(), '#message': element(), '#agent-error': element() }; let spoken;
  const speech = { speaking: false, cancel() { this.speaking = false; }, speak(value) { spoken = value; this.speaking = true; } };
  const window = { speechSynthesis: speech }; let button;
  vm.runInNewContext(code, { window, document: { querySelector: id => elements[id], createElement: () => button = element() }, navigator: { language: 'en-US' }, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  assert.equal(elements['#microphone'].hidden, true);
  window.addReadAloud({ append() {} }, { textContent: 'Read this.' }); assert.equal(spoken, undefined);
  button.handlers.click(); assert.equal(spoken.text, 'Read this.'); assert.equal(button.attrs['aria-pressed'], 'true');
  button.handlers.click(); assert.equal(speech.speaking, false); assert.equal(button.attrs['aria-pressed'], 'false');
});
