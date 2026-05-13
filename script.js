// 동전 쌓기 게임 - 메인 스크립트

// ========================
// CONFIG
// ========================
const API_BASE    = 'https://wootopia.kr/reward-game/api';
const GAME_ID     = 'coinstack';

const COIN_RADIUS          = 30;   // 수평 반지름 (충돌 판정 기준, 변경 금지)
const COIN_HALF_H          = 14;   // 이미지 수직 반지름 (coin.png 기준)
const COIN_DIAMETER        = 17;   // < COIN_HALF_H*2, 위 동전이 아래 동전을 ~39% 덮음
const METERS_PER_COIN      = 5;
const BASE_SWING_SPEED     = 3;       // px/frame
const SPEED_STEP           = 0.4;     // 10개마다 추가 속도
const MAX_INSTABILITY      = 100;
const INSTAB_START_RATIO   = 0.15;
const INSTAB_WEIGHT        = 90;
const RECENT_N             = 3;    // 최근 3개: 보정 반응 빠르게
const RECOVERY_WEIGHT      = 45;   // 중심 보정 시 회복 가중치 (25→45)
const RECOVERY_AMOUNT      = 12;   // 중심 근접 시 추가 회복 (6→12)
const COLLAPSE_MARGIN      = 1.10; // 즉시 붕괴 여유폭 (×COIN_RADIUS = 33px)
const MOVING_COIN_Y        = 110;    // 이동 동전 고정 y (px)

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
let stack        = [];   // { x: px, color: string }[]
let movingCoin   = { x: 0, dir: 1, speed: BASE_SWING_SPEED };
let instability  = 0;
let cameraOffset = 0;
let gamePhase    = 'intro';  // 'intro' | 'playing' | 'collapsing' | 'result'
let animFrameId  = null;
let collapseTimeoutId = null;
let stars        = [];

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
  gamePhase    = 'playing';

  updateHUD();
  showScreen('game');
  animFrameId = requestAnimationFrame(gameLoop);
}

function dropCoin() {
  if (gamePhase !== 'playing') return;

  const prev       = stack[stack.length - 1];
  const prevOffset = Math.abs(movingCoin.x - prev.x);

  // 단계 1: 즉시 붕괴 — 직전 동전에서 너무 벗어남
  if (prevOffset >= COIN_RADIUS * COLLAPSE_MARGIN) {
    checkCollapse();
    return;
  }

  // 단계 2: instability 계산 — 최근 타워 중심축 기반
  const N            = Math.min(stack.length, RECENT_N);
  const recentCenter = stack.slice(-N).reduce((s, c) => s + c.x, 0) / N;

  const prevToCenter = Math.abs(prev.x - recentCenter);
  const newToCenter  = Math.abs(movingCoin.x - recentCenter);
  const improvement  = prevToCenter - newToCenter;  // 양수: 중심에 가까워짐

  const prevRatio   = prevOffset / COIN_RADIUS;
  const centerRatio = newToCenter / COIN_RADIUS;
  const prevPenalty = Math.max(0, prevRatio - INSTAB_START_RATIO) * INSTAB_WEIGHT * 0.10;

  let delta;
  if (improvement > 0) {
    // 중심 방향 보정 → 회복
    delta = prevPenalty - (improvement / COIN_RADIUS) * RECOVERY_WEIGHT;
  } else {
    // 중심 이탈 → 불안정 증가
    delta = (-improvement / COIN_RADIUS) * INSTAB_WEIGHT * 0.50 + prevPenalty;
  }
  // 중심 근접 시 추가 소량 회복 (정교한 플레이 보상)
  if (centerRatio < INSTAB_START_RATIO) delta -= RECOVERY_AMOUNT;

  instability = Math.min(MAX_INSTABILITY, Math.max(0, instability + delta));

  stack.push({ x: movingCoin.x, color: getCoinColor(instability) });

  // 쌓을수록 이동 속도 증가 (10개마다 +0.4)
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

  // 흔들기 애니메이션 재시작
  canvas.style.animation = 'none';
  void canvas.offsetHeight; // reflow 강제
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
  updateCamera();
  render();

  animFrameId = requestAnimationFrame(gameLoop);
}

function updateCamera() {
  const topWorldY    = getFloorY() - COIN_HALF_H - (stack.length - 1) * COIN_DIAMETER;
  const targetScreenY = canvas.height * 0.38;
  const targetOffset  = Math.max(0, targetScreenY - topWorldY);
  cameraOffset += (targetOffset - cameraOffset) * 0.1;
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();

  // 쌓인 동전 렌더 (화면 범위 안에 있는 것만)
  for (let i = 0; i < stack.length; i++) {
    const sy = getStackCoinScreenY(i);
    if (sy > canvas.height + COIN_HALF_H) continue;
    if (sy < -COIN_HALF_H) break;
    drawCoin(stack[i].x, sy, stack[i].color, false);
  }

  // 이동 동전 + 가이드 라인
  if (gamePhase === 'playing') {
    drawDropIndicator();
    drawCoin(movingCoin.x, MOVING_COIN_Y, getCoinColor(instability), true);
  }
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
  let topColor, btmColor;

  if (score < 100) {
    topColor = '#4A90D9';
    btmColor = '#C9E8F7';
  } else if (score < 300) {
    topColor = '#7BA7C4';
    btmColor = '#DFF0FA';
    drawClouds();
  } else {
    topColor = '#0D1B2A';
    btmColor = '#1E3A5F';
    drawStars();
  }

  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, topColor);
  grad.addColorStop(1, btmColor);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 바닥
  const floorScreenY = getFloorY() + COIN_HALF_H + cameraOffset;
  if (floorScreenY < canvas.height) {
    ctx.fillStyle = '#7B5A1A';
    ctx.fillRect(0, floorScreenY, canvas.width, canvas.height - floorScreenY);
    // 바닥 상단 하이라이트
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
    // coin.png 로드 전 타원 폴백
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

function drawClouds() {
  const clouds = [
    { x: canvas.width * 0.18, y: canvas.height * 0.22, s: 1.0 },
    { x: canvas.width * 0.72, y: canvas.height * 0.42, s: 0.8 },
    { x: canvas.width * 0.42, y: canvas.height * 0.62, s: 1.1 },
  ];
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  clouds.forEach(c => {
    const r = 26 * c.s;
    ctx.beginPath();
    ctx.arc(c.x,        c.y,       r,       0, Math.PI * 2);
    ctx.arc(c.x + r,    c.y - r * 0.4, r * 0.8, 0, Math.PI * 2);
    ctx.arc(c.x + r * 2, c.y,       r * 0.9, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawStars() {
  if (stars.length === 0) generateStars();
  ctx.save();
  stars.forEach(s => {
    ctx.globalAlpha = s.a;
    ctx.fillStyle   = '#fff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.restore();
}

function generateStars() {
  for (let i = 0; i < 70; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.5 + 0.4,
      a: Math.random() * 0.6 + 0.4,
    });
  }
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
