// 동전 쌓기 게임 - 메인 스크립트

// ========================
// CONFIG
// ========================
const API_BASE    = 'https://wootopia.kr/reward-game/api';
const GAME_ID     = 'coinstack';

const COIN_RADIUS          = 30;
const COIN_HALF_H          = 14;
const COIN_DIAMETER        = 17;
const METERS_PER_COIN      = 5;
const BASE_SWING_SPEED     = 3;
const SPEED_STEP           = 0.4;
const MAX_INSTABILITY      = 100;
const INSTAB_START_RATIO   = 0.15;
const INSTAB_WEIGHT        = 90;
const RECENT_N             = 3;
const RECOVERY_WEIGHT      = 45;
const RECOVERY_AMOUNT      = 12;
const COLLAPSE_MARGIN      = 1.10;
const MOVING_COIN_Y        = 110;

// 배경 구간 임계값 — 테스트 시 여기만 수정 (원래값: 40 / 100 / 180 / 260)
const BG_ZONE1_M = 10;   // 구름 언덕 시작 (m)
const BG_ZONE2_M = 20;   // 노을 하늘 시작 (m)
const BG_ZONE3_M = 30;   // 밤하늘 시작 (m)
const BG_ZONE4_M = 40;   // 우주 시작 (m)

// ========================
// MOCK USER & AUTH
// ========================
const MOCK_USER = {
  platformCode:    'dev',
  platformUserKey: 'local-test',
  displayName:     '테스터',
};

const AUTH = {
  bootstrap() {
    return this._fromUrl() || window.APP_USER || MOCK_USER;
  },
  _fromUrl() {
    const p = new URLSearchParams(location.search);
    const code = p.get('platform_code');
    const key  = p.get('platform_user_key');
    const name = p.get('display_name');
    return (code && key && name)
      ? { platformCode: code, platformUserKey: key, displayName: name }
      : null;
  },
};

const session = { platformCode: '', platformUserKey: '', displayName: '' };

// ========================
// GAME STATE
// ========================
let canvas, ctx;
let coinImg      = null;
let stack        = [];
let movingCoin   = { x: 0, dir: 1, speed: BASE_SWING_SPEED };
let instability  = 0;
let cameraOffset = 0;
let gamePhase    = 'intro';
let animFrameId  = null;
let collapseTimeoutId = null;
let stars        = [];
let landingAnim  = { active: false, progress: 0, coinIndex: -1 };
const hitText    = { label: '', x: 0, y: 0, timer: 0, isPerfect: false };
let zoneText     = { label: '', timer: 0, total: 0, color: '#FFFFFF' };
let prevZone     = -1;

// ========================
// API CALLS
// ========================
async function apiAuth(user) {
  const res = await fetch(API_BASE + '/auth.php', {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      platform_code:     user.platformCode,
      platform_user_key: user.platformUserKey,
      display_name:      user.displayName,
    }),
  });
  if (!res.ok) throw new Error('auth ' + res.status);
  const json = await res.json();
  if (json.result !== 'success') throw new Error(json.message || 'auth failed');
  return json.data;
}

async function apiSubmitScore(score) {
  const res = await fetch(API_BASE + '/submit_score.php', {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ game_id: GAME_ID, score }),
  });
  if (!res.ok) throw new Error('submit_score ' + res.status);
  return res.json();
}

async function apiGetRanking() {
  const params = new URLSearchParams({ game_id: GAME_ID, period_type: 'daily', limit: 5 });
  const res = await fetch(API_BASE + '/get_ranking.php?' + params, {
    method:      'GET',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('get_ranking ' + res.status);
  return res.json();
}

// ========================
// GAME FUNCTIONS
// ========================
function startGame() {
  if (collapseTimeoutId) {
    clearTimeout(collapseTimeoutId);
    collapseTimeoutId = null;
  }
  cancelAnimationFrame(animFrameId);
  canvas.style.animation = 'none';

  stack        = [{ x: canvas.width / 2, color: '#FFD700' }];
  movingCoin   = { x: canvas.width * 0.25, dir: 1, speed: BASE_SWING_SPEED };
  instability  = 0;
  cameraOffset = 0;
  stars        = [];
  landingAnim  = { active: false, progress: 0, coinIndex: -1 };
  hitText.timer  = 0;
  zoneText.timer = 0;
  prevZone       = 0;
  gamePhase    = 'playing';

  updateHUD();
  showScreen('game');
  animFrameId = requestAnimationFrame(gameLoop);
}

function dropCoin() {
  if (gamePhase !== 'playing') return;

  const prev       = stack[stack.length - 1];
  const prevOffset = Math.abs(movingCoin.x - prev.x);

  if (prevOffset >= COIN_RADIUS * COLLAPSE_MARGIN) {
    checkCollapse();
    return;
  }

  const N            = Math.min(stack.length, RECENT_N);
  const recentCenter = stack.slice(-N).reduce((s, c) => s + c.x, 0) / N;

  const prevToCenter = Math.abs(prev.x - recentCenter);
  const newToCenter  = Math.abs(movingCoin.x - recentCenter);
  const improvement  = prevToCenter - newToCenter;

  const prevRatio   = prevOffset / COIN_RADIUS;
  const centerRatio = newToCenter / COIN_RADIUS;
  const prevPenalty = Math.max(0, prevRatio - INSTAB_START_RATIO) * INSTAB_WEIGHT * 0.10;

  let delta;
  if (improvement > 0) {
    delta = prevPenalty - (improvement / COIN_RADIUS) * RECOVERY_WEIGHT;
  } else {
    delta = (-improvement / COIN_RADIUS) * INSTAB_WEIGHT * 0.50 + prevPenalty;
  }
  if (centerRatio < INSTAB_START_RATIO) delta -= RECOVERY_AMOUNT;

  instability = Math.min(MAX_INSTABILITY, Math.max(0, instability + delta));

  checkZoneChange();

  stack.push({ x: movingCoin.x, color: getCoinColor(instability) });

  landingAnim = { active: true, progress: 0, coinIndex: stack.length - 1 };

  const normOff  = prevOffset / COIN_RADIUS;
  const textY    = getStackCoinScreenY(stack.length - 1) - COIN_HALF_H - 16;
  if (normOff < 0.08) {
    Object.assign(hitText, { label: 'PERFECT!', isPerfect: true,  timer: 55, x: movingCoin.x, y: textY });
  } else if (normOff < 0.30) {
    Object.assign(hitText, { label: 'GOOD',     isPerfect: false, timer: 42, x: movingCoin.x, y: textY });
  }

  movingCoin.speed = BASE_SWING_SPEED + Math.floor(stack.length / 10) * SPEED_STEP;

  updateHUD();

  if (instability >= MAX_INSTABILITY) {
    checkCollapse();
  }
}

function updateMovingCoin() {
  movingCoin.x += movingCoin.speed * movingCoin.dir;

  if (movingCoin.x >= canvas.width - COIN_RADIUS) {
    movingCoin.x = canvas.width - COIN_RADIUS;
    movingCoin.dir = -1;
  } else if (movingCoin.x <= COIN_RADIUS) {
    movingCoin.x = COIN_RADIUS;
    movingCoin.dir = 1;
  }
}

function checkCollapse() {
  gamePhase = 'collapsing';

  canvas.style.animation = 'none';
  void canvas.offsetHeight;
  canvas.style.animation = 'shake 0.65s ease';

  collapseTimeoutId = setTimeout(endGame, 750);
}

async function endGame() {
  gamePhase = 'result';
  cancelAnimationFrame(animFrameId);
  canvas.style.animation = 'none';

  const score = (stack.length - 1) * METERS_PER_COIN;

  const best = parseInt(localStorage.getItem('coinstack_best') || '0');
  if (score > best) localStorage.setItem('coinstack_best', String(score));

  document.getElementById('result-score').textContent = score + 'm';
  document.getElementById('result-coins').textContent = (stack.length - 1) + '개 쌓음';
  document.getElementById('result-rank').textContent = '';
  document.getElementById('ranking-loading').classList.remove('hidden');
  document.getElementById('ranking-content').classList.add('hidden');

  showScreen('result');

  try {
    await apiSubmitScore(score);
    const json = await apiGetRanking();
    if (json.result === 'success') renderRanking(json.data);
  } catch (e) {
    console.warn('[coinstack] endGame API error:', e);
    document.getElementById('ranking-loading').textContent = '랭킹 불러오기 실패';
  }
}

// ========================
// GAME LOOP & RENDER
// ========================
function gameLoop() {
  if (gamePhase !== 'playing' && gamePhase !== 'collapsing') return;

  if (gamePhase === 'playing') updateMovingCoin();
  if (landingAnim.active) {
    landingAnim.progress += 0.07;
    if (landingAnim.progress >= 1) landingAnim.active = false;
  }
  updateCamera();
  render();

  animFrameId = requestAnimationFrame(gameLoop);
}

function updateCamera() {
  const topWorldY     = getFloorY() - COIN_HALF_H - (stack.length - 1) * COIN_DIAMETER;
  const targetScreenY = canvas.height * 0.38;
  const targetOffset  = Math.max(0, targetScreenY - topWorldY);
  cameraOffset += (targetOffset - cameraOffset) * 0.1;
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();

  const wobble = getWobble();
  ctx.save();
  ctx.translate(wobble, 0);

  for (let i = 0; i < stack.length; i++) {
    const sy = getStackCoinScreenY(i);
    if (sy > canvas.height + COIN_HALF_H) continue;
    if (sy < -COIN_HALF_H) break;

    if (landingAnim.active && i === landingAnim.coinIndex) {
      const scl = getLandingScale(landingAnim.progress);
      ctx.save();
      ctx.translate(stack[i].x, sy);
      ctx.scale(scl.scx, scl.scy);
      ctx.translate(-stack[i].x, -sy);
      drawCoin(stack[i].x, sy, stack[i].color, false);
      ctx.restore();
    } else {
      drawCoin(stack[i].x, sy, stack[i].color, false);
    }
  }

  ctx.restore();

  if (gamePhase === 'playing') {
    drawDropIndicator();
    drawCoin(movingCoin.x, MOVING_COIN_Y, getCoinColor(instability), true);
  }

  drawHitText();
  drawZoneText();
}

// ========================
// DRAW HELPERS
// ========================
function getFloorY() {
  return canvas.height - 50;
}

function getStackCoinScreenY(index) {
  return getFloorY() - COIN_HALF_H - index * COIN_DIAMETER + cameraOffset;
}

function drawBackground() {
  const score = (stack.length - 1) * METERS_PER_COIN;

  let bands;
  if      (score < BG_ZONE1_M) bands = ['#1870CE','#2882DC','#3C96E8','#54AEF2','#72C4FC','#96D8FF'];
  else if (score < BG_ZONE2_M) bands = ['#1060C0','#1C78CC','#2E90D8','#46ACE4','#68C8F4','#A0E0FF'];
  else if (score < BG_ZONE3_M) bands = ['#2C0E5E','#5C2468','#904050','#C06838','#DC9830','#F0C050'];
  else if (score < BG_ZONE4_M) bands = ['#02060E','#030A1A','#040E26','#061232','#08163E','#0C1C50'];
  else                          bands = ['#000004','#000108','#01010E','#020214','#04031A','#070522'];

  const bh = Math.ceil(canvas.height / bands.length);
  bands.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, i * bh, canvas.width, bh + 1);
  });

  if      (score >= BG_ZONE4_M) drawStars(4);
  else if (score >= BG_ZONE3_M) drawStars(3);
  else if (score >= BG_ZONE2_M) drawSunset();
  else if (score >= BG_ZONE1_M) drawClouds(1);
  else                           drawClouds(0);

  // 바닥
  const floorScreenY = getFloorY() + COIN_HALF_H + cameraOffset;
  if (floorScreenY < canvas.height) {
    ctx.fillStyle = '#7B5A1A';
    ctx.fillRect(0, floorScreenY, canvas.width, canvas.height - floorScreenY);
    ctx.fillStyle = '#A07828';
    ctx.fillRect(0, floorScreenY, canvas.width, 4);
  }
}

function drawCoin(x, y, _color, isMoving) {
  ctx.save();

  const imgReady = coinImg && coinImg.complete && coinImg.naturalWidth > 0;

  if (imgReady) {
    ctx.filter = isMoving
      ? 'drop-shadow(0 0 6px rgba(255,255,255,0.65)) drop-shadow(0 2px 5px rgba(0,0,0,0.28))'
      : 'drop-shadow(0 2px 5px rgba(0,0,0,0.32))';

    ctx.drawImage(
      coinImg,
      Math.round(x - COIN_RADIUS),
      Math.round(y - COIN_HALF_H),
      COIN_RADIUS * 2,
      COIN_HALF_H * 2
    );
  } else {
    ctx.beginPath();
    ctx.ellipse(x, y, COIN_RADIUS, COIN_HALF_H, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#FFD700';
    ctx.fill();
    if (isMoving) {
      ctx.strokeStyle = 'rgba(255,255,255,0.78)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawDropIndicator() {
  const topCoinY = getStackCoinScreenY(stack.length - 1) - COIN_HALF_H;
  const startY   = MOVING_COIN_Y + COIN_HALF_H + 4;
  if (topCoinY <= startY) return;

  ctx.save();
  ctx.setLineDash([6, 7]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(movingCoin.x, startY);
  ctx.lineTo(movingCoin.x, topCoinY);
  ctx.stroke();
  ctx.restore();
}

// 도트풍 픽셀 구름 블록
function drawPixelCloud(cx, cy, bs) {
  const g = [
    [0,0,1,1,1,0,0],
    [0,1,1,1,1,1,0],
    [1,1,1,1,1,1,1],
    [1,2,2,2,2,2,1],
  ];
  const cols = 7;
  const ox = Math.round(cx - (cols * bs) / 2);
  const oy = Math.round(cy - g.length * bs);
  g.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      if (cell === 0) return;
      ctx.fillStyle = cell === 1 ? '#FFFFFF' : '#C8DCE8';
      ctx.fillRect(ox + ci * bs, oy + ri * bs, bs, bs);
    });
  });
}

// zone 0: 아침 하늘 (작은 구름 3개 + 점새)
// zone 1: 구름 언덕 (큰+중간+하단 구름섬)
function drawClouds(zone) {
  ctx.save();
  if (zone === 0) {
    ctx.globalAlpha = 0.80;
    drawPixelCloud(canvas.width * 0.18, canvas.height * 0.22, 7);
    drawPixelCloud(canvas.width * 0.64, canvas.height * 0.40, 6);
    drawPixelCloud(canvas.width * 0.38, canvas.height * 0.62, 5);
  } else {
    ctx.globalAlpha = 0.90;
    drawPixelCloud(canvas.width * 0.14, canvas.height * 0.16, 12);
    drawPixelCloud(canvas.width * 0.68, canvas.height * 0.28, 11);
    ctx.globalAlpha = 0.68;
    drawPixelCloud(canvas.width * 0.38, canvas.height * 0.44, 9);
    drawPixelCloud(canvas.width * 0.80, canvas.height * 0.55, 8);
    // 하단 구름섬 — 투명도 낮춰 플레이 방해 최소화
    ctx.globalAlpha = 0.52;
    drawPixelCloud(canvas.width * 0.20, canvas.height * 0.74, 12);
    drawPixelCloud(canvas.width * 0.50, canvas.height * 0.79, 11);
    drawPixelCloud(canvas.width * 0.76, canvas.height * 0.72, 10);
  }
  ctx.restore();
  if (zone === 0) drawDistantBirds();
}

// 아주 작은 픽셀 점새 (V자 2px+2px)
function drawDistantBirds() {
  const birds = [[0.60, 0.27], [0.63, 0.25], [0.67, 0.27], [0.28, 0.18], [0.82, 0.43]];
  ctx.save();
  ctx.fillStyle = 'rgba(20, 50, 140, 0.28)';
  birds.forEach(([fx, fy]) => {
    const x = Math.round(canvas.width * fx);
    const y = Math.round(canvas.height * fy);
    ctx.fillRect(x, y, 2, 1);
    ctx.fillRect(x + 3, y, 2, 1);
  });
  ctx.restore();
}

// 노을 하늘: 수평선 빛 + 픽셀 스파클
function drawSunset() {
  // 수평선 노을 빛 — 화면 하단 35%만 커버, 낮은 불투명도
  const glow = ctx.createLinearGradient(0, canvas.height * 0.65, 0, canvas.height);
  glow.addColorStop(0, 'rgba(0,0,0,0)');
  glow.addColorStop(1, 'rgba(255, 140, 30, 0.16)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, canvas.height * 0.65, canvas.width, canvas.height * 0.35);

  // 픽셀 스파클 (맥동)
  const positions = [
    [0.14, 0.19], [0.68, 0.13], [0.38, 0.34],
    [0.82, 0.42], [0.22, 0.58], [0.54, 0.70],
  ];
  const pulse = Math.sin(Date.now() / 600) * 0.25 + 0.75;
  ctx.save();
  ctx.fillStyle = `rgba(255, 230, 100, ${0.52 * pulse})`;
  positions.forEach(([fx, fy]) => {
    const x = Math.round(canvas.width * fx);
    const y = Math.round(canvas.height * fy);
    ctx.fillRect(x + 1, y, 2, 4);
    ctx.fillRect(x, y + 1, 4, 2);
  });
  ctx.restore();
}

// 도트풍 픽셀 별
function generateStars(zone) {
  stars = [];
  const count = zone === 3 ? 60 : 90;
  for (let i = 0; i < count; i++) {
    const r = Math.random();
    const type = zone === 3
      ? (r < 0.74 ? 0 : 1)               // 밤: 도트+작은십자만
      : (r < 0.52 ? 0 : r < 0.82 ? 1 : 2); // 우주: 전체
    stars.push({
      x:    Math.random() * canvas.width,
      y:    Math.random() * canvas.height,
      type, a: Math.random() * 0.55 + 0.45,
    });
  }
}

function drawStars(zone) {
  if (stars.length === 0) generateStars(zone);
  ctx.save();
  stars.forEach(s => {
    ctx.globalAlpha = s.a;
    ctx.fillStyle   = '#FFFFFF';
    const x = Math.round(s.x), y = Math.round(s.y);
    if      (s.type === 0) { ctx.fillRect(x, y, 2, 2); }
    else if (s.type === 1) { ctx.fillRect(x+2, y, 2, 6); ctx.fillRect(x, y+2, 6, 2); }
    else                   { ctx.fillRect(x+3, y, 3, 9); ctx.fillRect(x, y+3, 9, 3); }
  });
  ctx.globalAlpha = 1;
  ctx.restore();
  if (zone === 3) drawPixelMoon();
  else            { drawNebula(); drawPixelPlanet(); }
}

// 밤하늘 초승달 (5×7 픽셀, bs=4)
function drawPixelMoon() {
  const g = [
    [0,0,1,1,0],
    [0,1,1,1,1],
    [1,1,1,1,0],
    [1,1,1,0,0],
    [1,1,1,1,0],
    [0,1,1,1,1],
    [0,0,1,1,0],
  ];
  const bs = 4, cols = 5;
  const ox = Math.round(canvas.width * 0.74) - Math.floor(cols * bs / 2);
  const oy = Math.round(canvas.height * 0.17) - Math.floor(g.length * bs / 2);
  ctx.save();
  ctx.globalAlpha = 0.85;
  g.forEach((row, ri) => row.forEach((cell, ci) => {
    if (!cell) return;
    ctx.fillStyle = '#FFFDE0';
    ctx.fillRect(ox + ci * bs, oy + ri * bs, bs, bs);
  }));
  ctx.restore();
}

// 우주 성운 (은은한 보라 radial)
function drawNebula() {
  const nb = ctx.createRadialGradient(
    canvas.width * 0.65, canvas.height * 0.30, 0,
    canvas.width * 0.65, canvas.height * 0.30, canvas.width * 0.40
  );
  nb.addColorStop(0, 'rgba(80, 30, 120, 0.18)');
  nb.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = nb;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// 우주 픽셀 행성 (7×7, bs=5) + 고리
function drawPixelPlanet() {
  const g = [
    [0,0,1,1,1,0,0],
    [0,1,1,1,1,1,0],
    [1,1,2,2,2,1,1],
    [1,2,2,2,2,2,1],
    [1,1,2,2,2,1,1],
    [0,1,1,1,1,1,0],
    [0,0,1,1,1,0,0],
  ];
  const bs = 5, cols = 7;
  const ox = Math.round(canvas.width * 0.78) - Math.floor(cols * bs / 2);
  const oy = Math.round(canvas.height * 0.18) - Math.floor(g.length * bs / 2);
  g.forEach((row, ri) => row.forEach((cell, ci) => {
    if (!cell) return;
    ctx.fillStyle = cell === 1 ? '#6644AA' : '#9977CC';
    ctx.fillRect(ox + ci * bs, oy + ri * bs, bs, bs);
  }));
  // 행성 고리 (픽셀 가로선)
  ctx.fillStyle = 'rgba(180, 150, 220, 0.45)';
  ctx.fillRect(ox - bs, oy + bs * 3, (cols + 2) * bs, bs);
}

function getLandingScale(t) {
  if (t < 0.40) {
    const p = t / 0.40;
    return { scx: 1 + 0.16 * p, scy: 1 - 0.44 * p };
  } else if (t < 0.70) {
    const p = (t - 0.40) / 0.30;
    return { scx: 1.16 - 0.21 * p, scy: 0.56 + 0.50 * p };
  } else {
    const p = (t - 0.70) / 0.30;
    return { scx: 0.95 + 0.05 * p, scy: 1.06 - 0.06 * p };
  }
}

function getWobble() {
  if (instability < 35) return 0;
  const strength = (instability - 35) / 65;
  return Math.sin(Date.now() / 85) * strength * 4;
}

function drawHitText() {
  if (hitText.timer <= 0) return;
  const alpha = Math.min(1, hitText.timer / 16);
  hitText.timer--;
  hitText.y -= 0.65;
  ctx.save();
  ctx.globalAlpha    = alpha;
  ctx.font           = `bold ${hitText.isPerfect ? '23' : '17'}px -apple-system, sans-serif`;
  ctx.fillStyle      = hitText.isPerfect ? '#FFE033' : '#FFFFFF';
  ctx.shadowColor    = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur     = 5;
  ctx.textAlign      = 'center';
  ctx.fillText(hitText.label, hitText.x, hitText.y);
  ctx.restore();
}

// 구간 진입 감지
function checkZoneChange() {
  const score = (stack.length - 1) * METERS_PER_COIN;
  const zone = score >= BG_ZONE4_M ? 4
             : score >= BG_ZONE3_M ? 3
             : score >= BG_ZONE2_M ? 2
             : score >= BG_ZONE1_M ? 1 : 0;
  if (zone !== prevZone && prevZone >= 0) {
    const labels = ['', '구름 언덕', '노을 하늘', '별빛 층', '우주 진입'];
    const colors = ['', '#A8DCFF',  '#FFD070',  '#D8C0FF', '#8AB4FF'];
    zoneText.label = labels[zone];
    zoneText.color = colors[zone];
    zoneText.timer = 75;
    zoneText.total = 75;
    if (zone === 3 || zone === 4) generateStars(zone);
  }
  prevZone = zone;
}

// 구간 진입 텍스트: 팝인 → 유지 → 위로 float 페이드아웃
function drawZoneText() {
  if (zoneText.timer <= 0) return;

  const elapsed = zoneText.total - zoneText.timer;
  zoneText.timer--;

  let alpha, scale, yOffset;
  if (elapsed < 12) {
    // 팝인: easeOutCubic 스케일 + 페이드인
    const p = elapsed / 12;
    const e = 1 - Math.pow(1 - p, 3);
    alpha   = p;
    scale   = 0.60 + 0.40 * e;
    yOffset = 0;
  } else if (zoneText.timer > 20) {
    // 유지
    alpha   = 1;
    scale   = 1;
    yOffset = 0;
  } else {
    // 퇴장: 위로 float + 페이드아웃
    const p = 1 - (zoneText.timer / 20);
    alpha   = 1 - p;
    scale   = 1;
    yOffset = -22 * p;
  }

  const cx = canvas.width / 2;
  const cy = canvas.height * 0.34 + yOffset;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.font         = 'bold 24px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // 1패스: 컬러 글로우 (구간별 아케이드 아우라)
  ctx.globalAlpha   = alpha * 0.55;
  ctx.shadowColor   = zoneText.color;
  ctx.shadowBlur    = 14;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle     = zoneText.color;
  ctx.fillText(zoneText.label, 0, 0);

  // 2패스: 흰 텍스트 + 도트풍 픽셀 그림자
  ctx.globalAlpha   = alpha;
  ctx.shadowColor   = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur    = 0;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle     = '#FFFFFF';
  ctx.fillText(zoneText.label, 0, 0);

  ctx.restore();
}

// ========================
// COLOR HELPERS
// ========================
function getCoinColor(inst) {
  if (inst < 25) return '#FFD700';
  if (inst < 50) return '#FFA500';
  if (inst < 75) return '#FF6347';
  return '#E53935';
}

function lightenHex(hex, ratio) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + Math.round(255 * ratio));
  const g = Math.min(255, ((n >>  8) & 0xff) + Math.round(255 * ratio));
  const b = Math.min(255, ( n        & 0xff) + Math.round(255 * ratio));
  return `rgb(${r},${g},${b})`;
}

function darkenHex(hex, ratio) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((n >> 16) & 0xff) - Math.round(255 * ratio));
  const g = Math.max(0, ((n >>  8) & 0xff) - Math.round(255 * ratio));
  const b = Math.max(0, ( n        & 0xff) - Math.round(255 * ratio));
  return `rgb(${r},${g},${b})`;
}

// ========================
// HUD & RANKING
// ========================
function updateHUD() {
  const score = (stack.length - 1) * METERS_PER_COIN;
  document.getElementById('hud-height').textContent = score + 'm';

  const bar = document.getElementById('instability-bar');
  bar.style.width = instability + '%';
  bar.style.backgroundColor =
    instability < 50 ? '#4CAF50' :
    instability < 75 ? '#FF9800' : '#F44336';
}

function renderRanking(data) {
  const myRank = data.my_rank;
  const top5   = (data.ranking || []).map(item => ({
    rank:        item.rank,
    displayName: item.display_name,
    score:       item.best_score,
    isMe:        item.display_name === session.displayName &&
                 item.platform_code === session.platformCode,
  }));

  const rankEl = document.getElementById('result-rank');
  rankEl.textContent = myRank ? '오늘 내 순위: ' + myRank + '위' : '오늘 첫 도전!';

  const listEl = document.getElementById('ranking-list');
  listEl.innerHTML = top5.map(item =>
    '<li class="rank-item' + (item.isMe ? ' rank-item--me' : '') + '">' +
      '<span class="rank-pos">' + item.rank + '위</span>' +
      '<span class="rank-name">' + item.displayName + (item.isMe ? ' <em>나</em>' : '') + '</span>' +
      '<span class="rank-score">' + item.score + 'm</span>' +
    '</li>'
  ).join('');

  document.getElementById('ranking-loading').classList.add('hidden');
  document.getElementById('ranking-content').classList.remove('hidden');
}

// ========================
// SCREEN MANAGEMENT
// ========================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

// ========================
// INIT
// ========================
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  stars = [];
}

function init() {
  canvas = document.getElementById('game-canvas');
  ctx    = canvas.getContext('2d');

  coinImg = new Image();
  coinImg.src = 'coin.png';

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const user = AUTH.bootstrap();
  Object.assign(session, user);
  apiAuth(user).catch(e => console.warn('[coinstack] auth failed (dev mode):', e));

  const best = localStorage.getItem('coinstack_best');
  if (best && best !== '0') {
    document.getElementById('best-score').textContent = '최고 기록: ' + best + 'm';
  }

  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-retry').addEventListener('click', startGame);

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    dropCoin();
  });
}

window.addEventListener('DOMContentLoaded', init);
