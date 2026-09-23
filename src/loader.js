/**
 * 加载进度条：让用户"感觉到进度在走"。
 *
 * 几个手法：
 * 1. 永不停滞：每个阶段开始时，用一段很长的 ease-out 过渡慢慢"蠕动"到本阶段上限附近，
 *    前快后慢、但一直在动；真实进度到了就快速追上去。
 * 2. 走合成器：进度用 transform 表示（右侧一块"遮罩"按 scaleX 收缩），
 *    即使主线程在做清洗、分章这类重活被卡住，动画也照样流畅。
 * 3. 反向条纹：填充区里的斜条纹往"反方向"移动，视觉上显得更快。
 * 4. 收尾冲刺：完成时用很短的时间冲到 100%，给一个干脆的结束感。
 * 5. 快的操作不闪：250ms 内做完的根本不显示。
 */

const EASE_CREEP = 'cubic-bezier(0.08, 0.72, 0.22, 1)';   // 起步快、尾巴长
const EASE_CATCH = 'cubic-bezier(0.25, 0.8, 0.3, 1)';

export const nextPaint = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

/** 某个阶段"蠕动"的上限：永远留一点余量，不会在真实完成前走满 */
export function creepCeiling(from, to) {
  return from + (to - from) * 0.94;
}

/** 蠕动时长：预计耗时的 3 倍——预计准的话，到点时大约走到阶段的 85% */
export function creepDuration(expectedMs) {
  return Math.max(900, Math.min(120000, (Number(expectedMs) || 1000) * 3));
}

/**
 * 在一个容器里造一条进度条，返回控制器。
 * @param {HTMLElement} host
 */
export function createProgressBar(host) {
  host.classList.add('nr-bar');
  host.innerHTML = '<div class="nr-ribs"></div><div class="nr-cover"></div>';
  const cover = host.querySelector('.nr-cover');
  let target = 0;

  const apply = (value, ms, ease) => {
    target = Math.max(0, Math.min(1, value));
    cover.style.transition = ms ? `transform ${ms}ms ${ease}` : 'none';
    cover.style.transform = `scaleX(${1 - target})`;
  };

  return {
    /** 当前"看得见的"进度（过渡进行中也能读到实时值） */
    value() {
      const m = getComputedStyle(cover).transform;
      if (!m || m === 'none') return 0;
      const a = Number(m.replace(/^matrix\(/, '').split(',')[0]);
      return Number.isFinite(a) ? 1 - a : target;
    },
    get target() { return target; },
    set(value, ms = 320) {
      apply(value, ms, EASE_CATCH);
    },
    creep(ceiling, ms) {
      apply(ceiling, ms, EASE_CREEP);
    },
    reset() {
      apply(0, 0);
    },
  };
}

/* =========================================================
 * 全局加载层：导入、打开大书、备份这类"可能要等一会"的操作都用它
 * =======================================================*/

const TIPS = [
  '小提示：按 T 打开目录，按 G 直接跳到第几章',
  '小提示：选中正文里的一段字，就能写笔记',
  '小提示：按 P 开始朗读，一章读完会自动接下一章',
  '小提示：书多了可以用「智能整理」按系列归类',
  '小提示：扫描版 PDF 可以用 OCR 识别成文字',
  '小提示：设置里能导出完整备份，换电脑也不丢进度',
];

export function createLoader(els) {
  const bar = createProgressBar(els.bar);
  const state = {
    active: false, visible: false, stage: null, startedAt: 0, showTimer: null, tipTimer: null, pctTimer: null,
    catchTimer: null, onFinish: null,
  };

  const renderPct = () => {
    if (!state.active) return;
    const pct = Math.min(99, Math.floor(bar.value() * 100));
    els.pct.textContent = `${pct}%`;
    els.root.setAttribute('aria-valuenow', String(pct));
  };

  const show = () => {
    if (!state.active || state.visible) return;
    state.visible = true;
    els.root.classList.remove('hidden', 'leaving');
    state.pctTimer = setInterval(renderPct, 80);
    let tipIndex = Math.floor(Math.random() * TIPS.length);
    els.tip.textContent = TIPS[tipIndex];
    state.tipTimer = setInterval(() => {
      tipIndex = (tipIndex + 1) % TIPS.length;
      els.tip.textContent = TIPS[tipIndex];
    }, 3800);
    // 等超过 2 秒才提示可以玩游戏，快的操作不打扰
    setTimeout(() => { if (state.active) els.playBtn.classList.remove('hidden'); }, 2000);
  };

  const creepStage = () => {
    const s = state.stage;
    if (!s) return;
    bar.creep(creepCeiling(s.from, s.to), creepDuration(s.expectedMs));
  };

  return {
    get active() { return state.active; },
    get visible() { return state.visible; },
    value: () => bar.value(),

    /** 开始一次加载；delayMs 内结束的话根本不显示 */
    start(title, { delayMs = 250 } = {}) {
      clearTimeout(state.showTimer);
      state.active = true;
      state.visible = false;
      state.startedAt = performance.now();
      state.stage = null;
      els.title.textContent = title || '正在处理';
      els.stage.textContent = '准备中…';
      els.pct.textContent = '0%';
      els.done.classList.add('hidden');
      els.playBtn.classList.add('hidden');
      bar.reset();
      // 明知会很慢（大文件）就立即显示：后面紧跟的同步解码会卡住计时器，等它触发就晚了
      if (delayMs <= 0) show();
      else state.showTimer = setTimeout(show, delayMs);
    },

    /**
     * 进入一个阶段：进度会从当前位置朝 `to` 慢慢蠕动，直到下一个阶段或真实进度更新。
     * @param {string} label 阶段说明
     * @param {number} to 这个阶段结束时的整体进度（0~1）
     * @param {number} expectedMs 预计耗时，用来决定蠕动速度
     * @param {{show?: boolean}} opts show=true 时立即显示（后面紧跟着会卡主线程的重活）
     */
    stage(label, to, expectedMs = 1000, opts = {}) {
      if (!state.active) return;
      const from = Math.max(bar.target, bar.value());
      state.stage = { label, from, to: Math.max(from, to), expectedMs };
      els.stage.textContent = label;
      clearTimeout(state.catchTimer);
      creepStage();
      if (opts.show) show();
    },

    /** 当前阶段里的真实进度（0~1），比如 PDF 解析到第几页 */
    progress(fraction, label) {
      const s = state.stage;
      if (!state.active || !s) return;
      if (label) els.stage.textContent = label;
      const real = s.from + (s.to - s.from) * Math.max(0, Math.min(1, fraction));
      if (real > bar.value() + 0.004) {
        bar.set(real, 260);
        clearTimeout(state.catchTimer);
        state.catchTimer = setTimeout(creepStage, 280);   // 追上之后接着蠕动，不停下
      }
    },

    /** 完成：冲刺到 100%，然后淡出（如果用户正在玩游戏，就留着让他自己关） */
    finish({ keepOpen, message = '完成！' } = {}) {
      return new Promise((resolve) => {
        clearTimeout(state.showTimer);
        clearTimeout(state.catchTimer);
        if (!state.visible) {
          state.active = false;
          resolve();
          return;
        }
        els.playBtn.classList.add('hidden');     // 冲刺阶段不再提供"开一局"
        bar.set(1, 380);
        setTimeout(() => {
          els.pct.textContent = '100%';
          els.stage.textContent = message;
          clearInterval(state.pctTimer);
          clearInterval(state.tipTimer);
          state.active = false;
          // 在真正要关的这一刻再看：用户只要主动打开了小游戏（哪怕还没按第一下），
          // 就留给他自己决定什么时候走，不要刚点开就被收掉
          const playing = !!(els.game && els.game.__game);
          const stay = keepOpen === undefined ? playing : keepOpen;
          if (stay) {
            els.stage.textContent = `${message} 玩完这局再走也行～`;
            els.done.classList.remove('hidden');
            state.onFinish = resolve;
            return;
          }
          this.close();
          resolve();
        }, 420);
      });
    },

    fail() {
      clearTimeout(state.showTimer);
      clearTimeout(state.catchTimer);
      clearInterval(state.pctTimer);
      clearInterval(state.tipTimer);
      state.active = false;
      this.close();
    },

    close() {
      if (els.onClose) els.onClose();          // 比如收起小游戏，免得下次打开还挂着
      if (state.visible) {
        els.root.classList.add('leaving');
        setTimeout(() => { els.root.classList.add('hidden'); els.root.classList.remove('leaving'); }, 220);
      }
      state.visible = false;
      if (state.onFinish) { const fn = state.onFinish; state.onFinish = null; fn(); }
    },
  };
}
