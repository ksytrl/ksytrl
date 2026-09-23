/**
 * 等待小游戏「墨点跳跳」：一本小书在进度条上奔跑，
 * 空格 / ↑ / 点一下 跳过墨点，顺手接住飘着的「字」加分。
 * 地面那条线就是当前的加载进度，玩着玩着书就加载好了。
 */

const BEST_KEY = 'novel-reader:gameBest';
const GRAVITY = 2300;
const JUMP_V = 580;   // 最高点约 73px：跳得过高墨点、够得着飘着的字，又不会跳出画面
const GROUND_PAD = 26;
const GLYPHS = ['书', '字', '文', '墨', '章', '卷', '诗', '读'];

function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function writeBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* 忽略 */ }
}

/** 两个矩形是否相交（各自往里收一点，手感更宽容） */
export function hit(a, b, shrink = 5) {
  return a.x + shrink < b.x + b.w - shrink && a.x + a.w - shrink > b.x + shrink
    && a.y + shrink < b.y + b.h - shrink && a.y + a.h - shrink > b.y + shrink;
}

/** 速度随时间变快，但有上限 */
export function speedAt(seconds) {
  return Math.min(520, 230 + seconds * 9);
}

/**
 * @param {HTMLElement} container
 * @param {{progress?: () => number, palette?: () => object}} options
 */
export function createInkRunner(container, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ink-runner';
  canvas.setAttribute('aria-label', '墨点跳跳小游戏：按空格或点击跳跃');
  canvas.tabIndex = 0;
  container.innerHTML = '';
  container.appendChild(canvas);

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = 0;
  const H = 150;
  const resize = () => {
    W = Math.max(260, Math.min(620, container.clientWidth || 520));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
  };
  resize();
  const ctx = canvas.getContext('2d');

  const game = {
    running: false,
    over: false,
    started: false,
    time: 0,
    score: 0,
    best: readBest(),
    runner: { x: 44, y: 0, w: 30, h: 36, vy: 0, onGround: true },
    blots: [],
    glyphs: [],
    spawnIn: 1.1,
    glyphIn: 1.8,
    raf: 0,
    last: 0,
    jumps: 0,
  };
  const ground = () => H - GROUND_PAD;

  const colors = () => {
    const css = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    return {
      text: pick('--text', '#2b2a27'),
      dim: pick('--text-dim', '#6f6a60'),
      accent: pick('--accent', '#9a6a3a'),
      soft: pick('--surface-2', '#f0ece2'),
      surface: pick('--surface', '#fffdf8'),
    };
  };

  function reset() {
    game.over = false;
    game.time = 0;
    game.score = 0;
    game.blots = [];
    game.glyphs = [];
    game.spawnIn = 1.1;
    game.glyphIn = 1.8;
    game.runner.y = ground() - game.runner.h;
    game.runner.vy = 0;
    game.runner.onGround = true;
  }

  function jump() {
    if (game.over) { reset(); if (!game.running) start(); return; }
    if (!game.running) start();
    const r = game.runner;
    if (r.onGround) {
      r.vy = -JUMP_V;
      r.onGround = false;
      game.jumps += 1;
    }
  }

  function spawnBlot() {
    const size = 16 + Math.random() * 16;
    const tall = Math.random() < 0.25;
    game.blots.push({ x: W + 10, y: ground() - (tall ? size * 1.7 : size), w: size, h: tall ? size * 1.7 : size, tall });
  }

  function spawnGlyph() {
    game.glyphs.push({
      x: W + 10, y: ground() - 70 - Math.random() * 30, w: 22, h: 22,
      ch: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], bob: Math.random() * 6,
    });
  }

  function update(dt) {
    game.time += dt;
    const speed = speedAt(game.time);
    game.score += dt * speed / 12;

    const r = game.runner;
    r.vy += GRAVITY * dt;
    r.y += r.vy * dt;
    // 只在下落时判断落地：否则开局第一帧 dt=0 时，刚起跳就会被判成"已落地"，第一下按键就不跳
    if (r.vy >= 0 && r.y >= ground() - r.h) {
      r.y = ground() - r.h;
      r.vy = 0;
      r.onGround = true;
    }

    game.spawnIn -= dt;
    if (game.spawnIn <= 0) {
      spawnBlot();
      game.spawnIn = Math.max(0.55, 1.35 - game.time * 0.02) + Math.random() * 0.7;
    }
    game.glyphIn -= dt;
    if (game.glyphIn <= 0) {
      spawnGlyph();
      game.glyphIn = 1.4 + Math.random() * 1.6;
    }

    for (const b of game.blots) b.x -= speed * dt;
    for (const g of game.glyphs) g.x -= speed * dt;
    game.blots = game.blots.filter((b) => b.x + b.w > -10);
    game.glyphs = game.glyphs.filter((g) => g.x + g.w > -10 && !g.taken);

    for (const g of game.glyphs) {
      if (hit(r, g, 2)) { g.taken = true; game.score += 25; }
    }
    for (const b of game.blots) {
      if (hit(r, b)) {
        game.over = true;
        game.running = false;
        const final = Math.floor(game.score);
        if (final > game.best) { game.best = final; writeBest(final); }
        break;
      }
    }
  }

  /* ---- 画面 ---- */
  function drawRunner(c, t) {
    const r = game.runner;
    const legPhase = r.onGround ? Math.sin(t * 22) : 0.6;
    ctx.save();
    ctx.translate(r.x, r.y);
    // 两条小腿
    ctx.strokeStyle = c.text;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(10, r.h); ctx.lineTo(10 + legPhase * 5, r.h + 7);
    ctx.moveTo(20, r.h); ctx.lineTo(20 - legPhase * 5, r.h + 7);
    ctx.stroke();
    // 书身：封面 + 书脊 + 书页
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, r.w, r.h, 4) : ctx.rect(0, 0, r.w, r.h);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.fillRect(0, 0, 5, r.h);
    ctx.fillStyle = c.surface;
    ctx.fillRect(r.w - 4, 3, 3, r.h - 6);
    // 眼睛（跳起来时眯眼）
    ctx.fillStyle = '#fff';
    const eyeY = 12;
    if (r.onGround) {
      ctx.beginPath(); ctx.arc(14, eyeY, 3.2, 0, Math.PI * 2); ctx.arc(23, eyeY, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(15, eyeY + 0.5, 1.5, 0, Math.PI * 2); ctx.arc(24, eyeY + 0.5, 1.5, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(11, eyeY); ctx.lineTo(17, eyeY); ctx.moveTo(20, eyeY); ctx.lineTo(26, eyeY); ctx.stroke();
    }
    // 书名签
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fillRect(10, 20, 14, 3);
    ctx.fillRect(10, 26, 10, 3);
    ctx.restore();
  }

  function drawBlot(c, b) {
    ctx.fillStyle = c.text;
    const cx = b.x + b.w / 2;
    ctx.beginPath();
    if (b.tall) {
      ctx.ellipse(cx, b.y + b.h * 0.55, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(cx, b.y + b.h / 2, b.w / 2, 0, Math.PI * 2);
    }
    ctx.fill();
    // 溅出来的小墨点
    ctx.beginPath();
    ctx.arc(b.x - 3, b.y + b.h - 3, 2.4, 0, Math.PI * 2);
    ctx.arc(b.x + b.w + 3, b.y + b.h - 5, 2, 0, Math.PI * 2);
    ctx.arc(cx + 4, b.y - 4, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(t) {
    const c = colors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 地面 = 加载进度
    const progress = options.progress ? Math.max(0, Math.min(1, options.progress())) : 0;
    const gy = ground() + 8;
    ctx.fillStyle = c.soft;
    ctx.fillRect(0, gy, W, 6);
    ctx.fillStyle = c.accent;
    ctx.fillRect(0, gy, W * progress, 6);
    ctx.fillStyle = c.dim;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`加载 ${Math.floor(progress * 100)}%`, W - 6, gy + 20);

    // 飘着的字
    ctx.textAlign = 'center';
    ctx.font = '600 18px "Noto Serif SC", serif';
    for (const g of game.glyphs) {
      ctx.fillStyle = c.accent;
      ctx.fillText(g.ch, g.x + g.w / 2, g.y + 17 + Math.sin(t * 4 + g.bob) * 3);
    }
    for (const b of game.blots) drawBlot(c, b);
    drawRunner(c, t);

    // 分数
    ctx.textAlign = 'left';
    ctx.fillStyle = c.dim;
    ctx.font = '12px sans-serif';
    ctx.fillText(`得分 ${Math.floor(game.score)}　最高 ${game.best}`, 8, 16);

    if (!game.started || game.over) {
      ctx.fillStyle = 'rgba(0,0,0,.04)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = c.text;
      ctx.font = '600 15px sans-serif';
      ctx.fillText(game.over ? `被墨点溅到了！得分 ${Math.floor(game.score)}` : '墨点跳跳', W / 2, 52);
      ctx.font = '12px sans-serif';
      ctx.fillStyle = c.dim;
      ctx.fillText('按 空格 / ↑ 或 点一下 跳跃，接住飘着的字加分', W / 2, 74);
    }
  }

  function frame(now) {
    const t = now / 1000;
    const dt = Math.min(0.05, (now - (game.last || now)) / 1000);
    game.last = now;
    if (game.running && !document.hidden) update(dt);
    draw(t);
    game.raf = requestAnimationFrame(frame);
  }

  function start() {
    game.started = true;
    game.running = true;
    game.last = 0;
  }

  const onKey = (e) => {
    if (!container.isConnected || container.offsetParent === null) return;
    if (e.code === 'Space' || e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      jump();
    }
  };
  const onPointer = (e) => { e.preventDefault(); canvas.focus({ preventScroll: true }); jump(); };

  document.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', onPointer);
  window.addEventListener('resize', resize);
  reset();
  game.raf = requestAnimationFrame(frame);

  const api = {
    get score() { return Math.floor(game.score); },
    get best() { return game.best; },
    get running() { return game.running; },
    get over() { return game.over; },
    get jumps() { return game.jumps; },
    get runnerY() { return game.runner.y; },
    jump,
    destroy() {
      cancelAnimationFrame(game.raf);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', resize);
      container.innerHTML = '';
    },
  };
  container.__game = api;   // 方便测试读取状态
  return api;
}
