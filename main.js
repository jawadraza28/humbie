(() => {
  'use strict';

  const weapons = [
    { id: 'pistol', name: 'Pistol', price: 0, fireDelayMs: 280, bulletsBonus: 0, coinsPerKill: 2, description: 'Balanced starter weapon.' },
    { id: 'smg', name: 'SMG', price: 60, fireDelayMs: 140, bulletsBonus: 6, coinsPerKill: 2, description: 'Fast fire rate, great for beginners.' },
    { id: 'rifle', name: 'Rifle', price: 140, fireDelayMs: 220, bulletsBonus: 10, coinsPerKill: 3, description: 'Steady damage output and more bullets.' },
    { id: 'sniper', name: 'Sniper', price: 220, fireDelayMs: 480, bulletsBonus: 3, coinsPerKill: 6, description: 'Slow shots, big coin rewards.' }
  ];
  const weaponById = new Map(weapons.map((w) => [w.id, w]));

  const dom = {
    stage: document.getElementById('stage'),
    startBtn: document.getElementById('start-btn'),
    rules: document.getElementById('rules'),

    bulletsNum: document.getElementById('bullets-num'),
    timerNum: document.getElementById('timer-num'),
    scoreNum: document.getElementById('score-num'),
    coinsNum: document.getElementById('coins-num'),
    levelNum: document.getElementById('level-num'),
    weaponNum: document.getElementById('weapon-num'),

    startTimer: document.getElementById('start-timer'),
    zombie: document.getElementById('zombie'),
    crosshair: document.getElementById('crosshair'),
    bulletHole: document.getElementById('bulletHole'),
    bloodSpot: document.getElementById('bloodSpot'),

    overlay: document.getElementById('overlay'),
    overlayContent: document.getElementById('overlay-content'),

    shopBtn: document.getElementById('shop-btn'),
    shopModal: document.getElementById('shop-modal'),
    closeShop: document.getElementById('close-shop'),
    shopCoins: document.getElementById('shop-coins'),
    weaponsGrid: document.getElementById('weapons-grid')
  };

  /** @type {{coins:number, ownedWeapons:string[], equippedWeaponId:string, level:number, bestLevel:number}} */
  // In-memory only: closing the tab resets everything.
  let save = defaultSave();

  let stageRect = dom.stage.getBoundingClientRect();
  let running = false;
  let canShoot = true;
  let lastShotAt = 0;

  let level = 1;
  let kills = 0;
  let killGoal = 0;
  let bullets = 0;
  let timeLeft = 0;
  let earnedThisRun = 0;

  let moveTimer = null;
  let secondTimer = null;
  let countdownTimer = null;
  /** @type {{level:number, kind:'complete'|'gameover'} | null} */
  let overlayContext = null;

  // Offline-safe sound via WebAudio (no external links).
  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
  }
  function playBeep({ freq = 220, durationMs = 70, type = 'square', gain = 0.02 } = {}) {
    ensureAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.value = gain;
    osc.connect(amp);
    amp.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  }
  function sfxShoot() {
    playBeep({ freq: 180, durationMs: 55, type: 'square', gain: 0.03 });
  }
  function sfxHit() {
    playBeep({ freq: 110, durationMs: 80, type: 'sawtooth', gain: 0.02 });
  }
  function sfxCoin() {
    playBeep({ freq: 880, durationMs: 70, type: 'triangle', gain: 0.02 });
  }

  // AdSense H5 Games Ads (beta)
  function pauseForAd() {
    running = false;
    stopTimers();
    if (audioCtx && audioCtx.state === 'running') {
      audioCtx.suspend().catch(() => {});
    }
  }

  function resumeAfterAd() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }

  function requestAdBreak({ type, name }) {
    try {
      if (typeof window.adBreak !== 'function') return;
      window.adBreak({
        type,
        name,
        beforeAd: pauseForAd,
        afterAd: resumeAfterAd
      });
    } catch {
      // ignore
    }
  }

  // Service worker (only works over http/https, not file://)
  if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Initial UI
  dom.zombie.classList.add('hidden');
  updateHUD();
  renderShop();

  // Events
  const startGameFromButton = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    hideOverlay();
    overlayContext = null;
    startFromMenu();
  };
  dom.startBtn.addEventListener('pointerdown', startGameFromButton);
  dom.startBtn.addEventListener('click', startGameFromButton);
  dom.shopBtn.addEventListener('click', () => openShop());
  dom.closeShop.addEventListener('click', () => closeShop());
  dom.shopModal.addEventListener('click', (e) => {
    if (e.target === dom.shopModal) closeShop();
  });

  dom.weaponsGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const weaponId = btn.getAttribute('data-weapon');
    const action = btn.getAttribute('data-action');
    if (!weaponId || !action) return;
    if (action === 'buy') buyWeapon(weaponId);
    if (action === 'equip') equipWeapon(weaponId);
  });

  dom.overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-overlay-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-overlay-action');
    if (!action) return;

    const baseLevel = overlayContext?.level ?? level;

    if (action === 'next') {
      hideOverlay();
      requestAdBreak({ type: 'start', name: 'next-level' });
      startCountdown(() => startLevel(baseLevel + 1));
      return;
    }
    if (action === 'retry') {
      hideOverlay();
      requestAdBreak({ type: 'start', name: 'retry-level' });
      startCountdown(() => startLevel(baseLevel));
      return;
    }
    if (action === 'menu') {
      hideOverlay();
      showMenu();
      return;
    }
    if (action === 'shop') {
      openShop();
      return;
    }
  });

  dom.stage.addEventListener('pointermove', (e) => {
    if (!running) return;
    stageRect = dom.stage.getBoundingClientRect();
    const pos = toStagePos(e);
    placeCrosshair(pos.x, pos.y);
  });
  dom.stage.addEventListener('pointerdown', (e) => {
    if (!running) return;
    handleShot(e);
  });
  window.addEventListener('resize', () => {
    stageRect = dom.stage.getBoundingClientRect();
  });

  // Allow keyboard to "shoot" when zombie focused
  dom.zombie.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      // shoot at zombie center
      const zb = dom.zombie.getBoundingClientRect();
      const fake = { clientX: zb.left + zb.width / 2, clientY: zb.top + zb.height / 2, target: dom.zombie, preventDefault() {} };
      handleShot(fake);
    }
  });

  function startFromMenu() {
    tryFullscreen();
    dom.rules.style.display = 'none';
    dom.startBtn.style.display = 'none';
    requestAdBreak({ type: 'start', name: 'start-game' });
    startCountdown(() => startLevel(level));
  }

  function showMenu() {
    stopTimers();
    running = false;
    dom.rules.style.display = 'block';
    dom.startBtn.style.display = 'inline-block';
    dom.startBtn.textContent = 'Start';
    dom.startTimer.textContent = '';
    dom.crosshair.style.display = 'none';
    dom.zombie.classList.add('hidden');

    // Show correct starting HUD numbers for the current level/weapon.
    const weapon = getEquippedWeapon();
    const cfg = computeLevelConfig(level, weapon);
    killGoal = cfg.goal;
    bullets = cfg.bullets;
    timeLeft = cfg.time;
    kills = 0;
    earnedThisRun = 0;
    updateHUD();
  }

  function startCountdown(onDone) {
    clearInterval(countdownTimer);
    let t = 3;
    dom.startTimer.style.display = 'block';
    dom.startTimer.textContent = String(t);
    countdownTimer = setInterval(() => {
      t -= 1;
      if (t <= 0) {
        clearInterval(countdownTimer);
        dom.startTimer.textContent = 'GO!';
        dom.startTimer.style.color = '#7CFC00';
        setTimeout(() => {
          dom.startTimer.style.display = 'none';
          dom.startTimer.style.color = '';
          onDone();
        }, 600);
        return;
      }
      dom.startTimer.textContent = String(t);
    }, 900);
  }

  function computeLevelConfig(levelNum, weapon) {
    const goal = 8 + (levelNum - 1) * 3;
    const time = Math.max(10, 20 - Math.floor(levelNum / 2));
    const baseBullets = goal + 6;
    const totalBullets = baseBullets + weapon.bulletsBonus;
    const moveEveryMs = Math.max(420, 1200 - levelNum * 70);
    return { goal, time, bullets: totalBullets, moveEveryMs };
  }

  function startLevel(levelNum) {
    stopTimers();
    closeShop();

    level = clampInt(levelNum, 1, 9999);

    kills = 0;
    earnedThisRun = 0;
    const weapon = getEquippedWeapon();
    const cfg = computeLevelConfig(level, weapon);
    killGoal = cfg.goal;
    bullets = cfg.bullets;
    timeLeft = cfg.time;

    running = true;
    canShoot = true;
    lastShotAt = 0;

    dom.crosshair.style.display = 'block';
    dom.zombie.classList.remove('hidden');
    dom.zombie.style.left = '50%';
    dom.zombie.style.top = '50%';

    moveZombieRandom();
    updateHUD();

    secondTimer = setInterval(() => {
      if (!running) return;
      timeLeft -= 1;
      updateHUD();
      if (timeLeft <= 0) {
        gameOver('Out of time');
      }
    }, 1000);

    moveTimer = setInterval(() => {
      if (!running) return;
      moveZombieRandom();
    }, cfg.moveEveryMs);
  }

  function stopTimers() {
    clearInterval(moveTimer);
    clearInterval(secondTimer);
    clearInterval(countdownTimer);
    moveTimer = null;
    secondTimer = null;
    countdownTimer = null;
  }

  function handleShot(e) {
    if (!running) return;
    e.preventDefault?.();

    const weapon = getEquippedWeapon();
    const now = performance.now();
    if (!canShoot) return;
    if (now - lastShotAt < weapon.fireDelayMs) return;
    lastShotAt = now;
    canShoot = false;

    bullets -= 1;
    sfxShoot();

    const pos = toStagePos(e);
    showImpact(dom.bulletHole, pos.x, pos.y, 220);

    const hit = isZombieHit(e);
    if (hit) {
      kills += 1;
      sfxHit();
      showImpact(dom.bloodSpot, pos.x, pos.y, 260);

      const coinsEarned = weapon.coinsPerKill;
      save.coins += coinsEarned;
      earnedThisRun += coinsEarned;
      sfxCoin();
      showFloatingText(`+${coinsEarned}`, pos.x, pos.y);

      if (kills >= killGoal) {
        levelComplete();
        return;
      }
    }

    updateHUD();

    if (bullets <= 0) {
      gameOver('Out of bullets');
      return;
    }

    setTimeout(() => {
      canShoot = true;
    }, 30);
  }

  function levelComplete() {
    running = false;
    stopTimers();
    dom.crosshair.style.display = 'none';
    dom.zombie.classList.add('hidden');

    overlayContext = { level, kind: 'complete' };

    const nextLevel = level + 1;
    save.bestLevel = Math.max(save.bestLevel || 1, nextLevel);

    updateHUD();
    showOverlay({
      title: `Level ${level} Complete`,
      body: `Kills: ${kills}/${killGoal}<br>Coins earned: ${earnedThisRun}<br>Equipped: ${escapeHtml(getEquippedWeapon().name)}`,
      actions: [
        { label: 'Next Level', action: 'next' },
        { label: 'Replay', action: 'retry' },
        { label: 'Shop', action: 'shop' },
        { label: 'Menu', action: 'menu' }
      ]
    });
    renderShop();
  }

  function gameOver(reason) {
    running = false;
    stopTimers();
    dom.crosshair.style.display = 'none';
    dom.zombie.classList.add('hidden');
    updateHUD();

    overlayContext = { level, kind: 'gameover' };

    // Natural break for ads (per H5 Games Ads guidance).
    requestAdBreak({ type: 'start', name: 'game-over' });

    showOverlay({
      title: 'Game Over',
      body: `${escapeHtml(reason)}<br>Kills: ${kills}/${killGoal}<br>Coins earned: ${earnedThisRun}<br>Equipped: ${escapeHtml(getEquippedWeapon().name)}`,
      actions: [
        { label: 'Retry', action: 'retry' },
        { label: 'Shop', action: 'shop' },
        { label: 'Menu', action: 'menu' }
      ]
    });
    renderShop();
  }

  function showOverlay({ title, body, actions }) {
    dom.overlay.hidden = false;
    dom.overlayContent.innerHTML = `
      <h1>${escapeHtml(title)}</h1>
      <div style="color: rgba(255,255,255,0.9); font-size: 1.1rem; line-height: 1.6; text-align:center;">
        ${body}
      </div>
      <div class="overlay-actions">
        ${actions
          .map((a) => `<button type="button" data-overlay-action="${a.action}">${escapeHtml(a.label)}</button>`)
          .join('')}
      </div>
    `;
  }

  function hideOverlay() {
    dom.overlay.hidden = true;
    dom.overlayContent.innerHTML = '';
  }

  function updateHUD() {
    const weapon = getEquippedWeapon();
    dom.bulletsNum.textContent = String(Math.max(0, bullets));
    dom.timerNum.textContent = String(Math.max(0, timeLeft));
    dom.scoreNum.textContent = `${kills} / ${killGoal || 0}`;
    dom.coinsNum.textContent = String(save.coins);
    dom.levelNum.textContent = String(level);
    dom.weaponNum.textContent = weapon.name;
    dom.shopCoins.textContent = String(save.coins);
  }

  function moveZombieRandom() {
    stageRect = dom.stage.getBoundingClientRect();
    const zombieSize = 108;
    const pad = 14;
    const maxX = Math.max(pad, stageRect.width - zombieSize - pad);
    const maxY = Math.max(pad, stageRect.height - zombieSize - pad);
    const x = pad + Math.random() * maxX;
    const y = pad + Math.random() * maxY;
    dom.zombie.style.left = `${x}px`;
    dom.zombie.style.top = `${y}px`;
  }

  function isZombieHit(e) {
    if (dom.zombie.classList.contains('hidden')) return false;
    const rect = dom.zombie.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function placeCrosshair(x, y) {
    dom.crosshair.style.left = `${x}px`;
    dom.crosshair.style.top = `${y}px`;
  }

  function toStagePos(e) {
    stageRect = dom.stage.getBoundingClientRect();
    const x = clamp(e.clientX - stageRect.left, 0, stageRect.width);
    const y = clamp(e.clientY - stageRect.top, 0, stageRect.height);
    return { x, y };
  }

  function showImpact(el, x, y, hideAfterMs) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.display = 'block';
    setTimeout(() => {
      el.style.display = 'none';
    }, hideAfterMs);
  }

  function showFloatingText(text, x, y) {
    const el = document.createElement('div');
    el.className = 'floating-text';
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    dom.stage.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 900);
  }

  function openShop() {
    renderShop();
    dom.shopModal.classList.add('open');
  }

  function closeShop() {
    dom.shopModal.classList.remove('open');
  }

  function renderShop() {
    dom.shopCoins.textContent = String(save.coins);
    const equippedId = save.equippedWeaponId;

    dom.weaponsGrid.innerHTML = weapons
      .map((w) => {
        const owned = save.ownedWeapons.includes(w.id);
        const equipped = equippedId === w.id;
        const canBuy = save.coins >= w.price;
        const priceLabel = w.price === 0 ? 'Free' : `${w.price} coins`;
        const fireLabel = `${w.fireDelayMs}ms`;
        const bulletsLabel = w.bulletsBonus >= 0 ? `+${w.bulletsBonus}` : `${w.bulletsBonus}`;

        let buttonHtml = '';
        if (!owned) {
          buttonHtml = `<button class="buy-btn" data-action="buy" data-weapon="${w.id}" ${canBuy ? '' : 'disabled'}>
            Buy
          </button>`;
        } else if (equipped) {
          buttonHtml = `<button class="buy-btn" disabled>Equipped</button>`;
        } else {
          buttonHtml = `<button class="buy-btn" data-action="equip" data-weapon="${w.id}">Equip</button>`;
        }

        return `
          <div class="weapon-card ${equipped ? 'equipped' : ''}">
            <h3>${escapeHtml(w.name)}</h3>
            <p>${escapeHtml(w.description)}</p>
            <p><strong>Fire:</strong> ${fireLabel}</p>
            <p><strong>Bullets:</strong> ${bulletsLabel}</p>
            <p><strong>Coins / kill:</strong> ${w.coinsPerKill}</p>
            <div class="weapon-price">${priceLabel}</div>
            ${buttonHtml}
          </div>
        `;
      })
      .join('');

    updateHUD();
  }

  function buyWeapon(weaponId) {
    const w = weaponById.get(weaponId);
    if (!w) return;
    if (save.ownedWeapons.includes(weaponId)) return;
    if (save.coins < w.price) return;

    save.coins -= w.price;
    save.ownedWeapons.push(weaponId);
    save.equippedWeaponId = weaponId;
    renderShop();
    updateHUD();
  }

  function equipWeapon(weaponId) {
    if (!save.ownedWeapons.includes(weaponId)) return;
    save.equippedWeaponId = weaponId;
    renderShop();
    updateHUD();
  }

  function getEquippedWeapon() {
    const w = weaponById.get(save.equippedWeaponId);
    return w || weaponById.get('pistol');
  }

  function defaultSave() {
    return { coins: 0, ownedWeapons: ['pistol'], equippedWeaponId: 'pistol', level: 1, bestLevel: 1 };
  }

  function tryFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement) return;
    el.requestFullscreen?.().catch?.(() => {});
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function clampInt(v, min, max) {
    const n = Number.isFinite(v) ? Math.trunc(v) : min;
    return clamp(n, min, max);
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // Start at menu
  showMenu();
})();