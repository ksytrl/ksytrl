/**
 * 朗读（听书）：用浏览器自带的语音合成逐句朗读，
 * 朗读到哪句就高亮哪句，一章读完自动接下一章。
 * 不联网、不依赖第三方服务，用的是系统里已有的语音。
 */

export const TTS_RATES = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.8, 2];

/** 把一段正文切成句子；句末标点后面紧跟的引号、括号算在同一句里 */
export function splitSentences(text) {
  const END = '。！？…；!?;';
  const CLOSERS = '”’"\'）)】》」』〉>…';
  const sentences = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const chars = [...line];
    let buffer = '';
    for (let i = 0; i < chars.length; i += 1) {
      buffer += chars[i];
      if (END.includes(chars[i])) {
        // 把紧随其后的收尾标点一起吃掉（「……。」这种）
        while (i + 1 < chars.length && (END.includes(chars[i + 1]) || CLOSERS.includes(chars[i + 1]))) {
          i += 1;
          buffer += chars[i];
        }
        sentences.push(buffer.trim());
        buffer = '';
      }
    }
    if (buffer.trim()) sentences.push(buffer.trim());
  }
  return sentences.filter((s) => s.replace(/\s/g, '').length > 0);
}

export function supportsTts() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
}

/** 取可用音色，中文的排前面 */
export function listVoices() {
  if (!supportsTts()) return [];
  const voices = window.speechSynthesis.getVoices() || [];
  const score = (v) => {
    const lang = (v.lang || '').toLowerCase();
    if (lang.startsWith('zh')) return 0;
    if (lang.startsWith('yue') || lang.startsWith('cmn')) return 1;
    return 2;
  };
  return [...voices].sort((a, b) => score(a) - score(b) || (a.name || '').localeCompare(b.name || ''));
}

/** 音色列表在部分浏览器里是异步到位的 */
export function whenVoicesReady(timeout = 2000) {
  if (!supportsTts()) return Promise.resolve([]);
  const existing = listVoices();
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(listVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, timeout);
  });
}

/**
 * 朗读器：只管"把给定的句子依次读出来"，
 * 高亮、翻章这些交给回调，方便界面自己决定怎么表现。
 */
export function createSpeaker(options = {}) {
  const state = {
    sentences: [],
    index: 0,
    playing: false,
    rate: options.rate || 1,
    voice: null,
    current: null,
  };

  const emit = (name, payload) => {
    const fn = options[name];
    if (typeof fn === 'function') fn(payload);
  };

  function cancel() {
    if (!supportsTts()) return;
    state.current = null;
    try { window.speechSynthesis.cancel(); } catch { /* 忽略 */ }
  }

  function speakCurrent() {
    if (!state.playing) return;
    const text = state.sentences[state.index];
    if (text == null) {
      state.playing = false;
      emit('onFinish', { index: state.index });
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = state.rate;
    if (state.voice) {
      utterance.voice = state.voice;
      utterance.lang = state.voice.lang;
    } else {
      utterance.lang = 'zh-CN';
    }
    utterance.onend = () => {
      if (!state.playing || state.current !== utterance) return;
      state.index += 1;
      if (state.index >= state.sentences.length) {
        state.playing = false;
        emit('onFinish', { index: state.index });
        return;
      }
      emit('onSentence', { index: state.index, text: state.sentences[state.index] });
      speakCurrent();
    };
    utterance.onerror = (e) => {
      if (!state.playing) return;
      // interrupted / canceled 是我们自己打断的，不算错误
      if (e && /interrupted|canceled/i.test(e.error || '')) return;
      state.playing = false;
      emit('onError', e && e.error ? e.error : 'speech-error');
    };
    state.current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  return {
    get playing() { return state.playing; },
    get index() { return state.index; },
    get total() { return state.sentences.length; },
    setVoice(voice) {
      state.voice = voice || null;
      if (state.playing) { cancel(); speakCurrent(); }
    },
    setRate(rate) {
      state.rate = Number(rate) || 1;
      if (state.playing) { cancel(); speakCurrent(); }
    },
    load(sentences, startIndex = 0) {
      cancel();
      state.sentences = sentences || [];
      state.index = Math.max(0, Math.min(startIndex, state.sentences.length - 1));
    },
    play(startIndex) {
      if (!supportsTts()) { emit('onError', 'unsupported'); return; }
      if (!state.sentences.length) { emit('onError', 'empty'); return; }
      if (typeof startIndex === 'number') state.index = Math.max(0, Math.min(startIndex, state.sentences.length - 1));
      cancel();
      state.playing = true;
      emit('onSentence', { index: state.index, text: state.sentences[state.index] });
      speakCurrent();
    },
    pause() {
      state.playing = false;
      cancel();
      emit('onPause', { index: state.index });
    },
    jump(delta) {
      const next = state.index + delta;
      if (next < 0 || next >= state.sentences.length) return false;
      if (state.playing) this.play(next);
      else {
        state.index = next;
        emit('onSentence', { index: next, text: state.sentences[next] });
      }
      return true;
    },
    stop() {
      state.playing = false;
      state.index = 0;
      cancel();
    },
  };
}
