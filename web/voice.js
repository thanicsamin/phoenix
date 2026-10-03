// Browser-provided speech keeps voice optional and needs no second API key.
(() => {
  const mic = document.querySelector('#microphone');
  const input = document.querySelector('#message');
  const error = document.querySelector('#agent-error');
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition; let speaking;
  window.stopDictation = () => recognition?.stop();
  window.stopVoice = () => { window.stopDictation(); window.speechSynthesis?.cancel(); };
  if (Recognition) {
    mic.hidden = false;
    mic.addEventListener('click', () => {
      if (recognition) { recognition.stop(); return; }
      const current = new Recognition(); recognition = current;
      const prefix = input.value.trimEnd(); current.lang = navigator.language; current.interimResults = true; current.continuous = true;
      mic.setAttribute('aria-pressed', 'true'); mic.setAttribute('aria-label', 'Stop dictation');
      current.onresult = event => { input.value = [prefix, [...event.results].map(result => result[0].transcript).join(' ')].filter(Boolean).join(' ').slice(0, 32000); input.dispatchEvent(new Event('input')); };
      current.onerror = event => { error.textContent = event.error === 'not-allowed' ? 'Microphone access is disabled.' : event.error === 'no-speech' ? 'No speech detected.' : 'Dictation is unavailable in this browser.'; };
      current.onend = () => { if (recognition === current) recognition = undefined; mic.setAttribute('aria-pressed', 'false'); mic.setAttribute('aria-label', 'Dictate message'); };
      try { current.start(); } catch { current.onend(); error.textContent = 'Dictation is unavailable in this browser.'; }
    });
  }
  window.addReadAloud = (label, body) => {
    if (!window.speechSynthesis) return;
    const button = document.createElement('button'); button.className = 'read-aloud'; button.textContent = '♫'; button.title = 'Read aloud'; button.setAttribute('aria-label', 'Read aloud');
    button.addEventListener('click', () => {
      const wasSpeaking = speaking === button && window.speechSynthesis.speaking;
      window.speechSynthesis.cancel(); speaking?.setAttribute('aria-pressed', 'false'); speaking = undefined;
      if (wasSpeaking) return;
      const utterance = new SpeechSynthesisUtterance(body.textContent); utterance.lang = navigator.language;
      utterance.onend = utterance.onerror = () => { button.setAttribute('aria-pressed', 'false'); if (speaking === button) speaking = undefined; };
      speaking = button; button.setAttribute('aria-pressed', 'true'); window.speechSynthesis.speak(utterance);
    });
    label.append(button);
  };
})();
