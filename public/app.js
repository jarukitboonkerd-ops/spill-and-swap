const $ = (id) => document.getElementById(id);
const code = location.pathname.match(/^\/room\/([0-9a-f]{16})$/)?.[1];
const storageKey = 'friends:' + code;
const roomPath = '/api/rooms/' + code;
const screens = ['home', 'join-screen', 'lobby', 'answering', 'revealed', 'modes'];
let token = code ? sessionStorage.getItem(storageKey) : null;
let state;
let pending = false;
let reading = false;
let revision = 0;
let checkingSubmission = false;
let pollTimer;
let endsAt = 0;
let opensAt = 0;
let suppressRevealAnimation = false;

function show(screen) {
  for (const id of screens) $(id).hidden = id !== screen;
}

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

async function request(path, { method = 'GET', data } = {}) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(path, {
    method,
    headers,
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(8000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}

function updateDraft() {
  const length = [...$('draft').value.trim()].length;
  $('length').textContent = length + ' / 500';
  $('send').disabled = pending || checkingSubmission || length === 0 || length > 500;
}

function updateClock() {
  if (state?.phase !== 'answering') return;
  const now = performance.now();
  const lead = Math.max(0, Math.ceil((opensAt - now) / 1000));
  const remaining = Math.max(0, Math.min(60, (endsAt - now) / 1000));
  const clock = lead ? String(lead) : Math.ceil(remaining) + ' วินาที';
  if ($('clock').textContent !== clock) $('clock').textContent = clock;
  $('clock').classList.toggle('countdown', lead > 0);
  $('time-bar').hidden = lead > 0;
  $('time-bar').value = remaining;
  $('question').hidden = lead > 0;
  $('answer-form').hidden = lead > 0 || state.hasSubmitted;
  $('progress').hidden = lead > 0;
}

function renderModes(next, id, canSelect) {
  const list = $(id);
  const key = [canSelect, ...next.unlockedModes].join(':');
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  const visibleModes = next.modes.filter(({id: mode}) => {
    if (id === 'lobby-modes') return true;
    return next.unlockedModes.includes(mode) === (id === 'mode-options');
  });
  list.replaceChildren(...visibleModes.map(({ id: mode, label, example }) => {
    const item = document.createElement('li');
    const unlocked = next.unlockedModes.includes(mode);
    if (unlocked && canSelect) {
      const button = document.createElement('button');
      button.textContent = label;
      button.onclick = () => mutate(button, async () => {
        render(await request(roomPath + '/mode', { method: 'POST', data: { mode } }));
      });
      item.append(button);
    } else {
      item.textContent = label + (unlocked ? ' · เล่นได้' : ' · ล็อก');
      if (!unlocked) item.className = 'locked';
    }
    if (unlocked && example && mode !== 'basic') {
      item.classList.add('mode-card');
      const sample = document.createElement('p');
      sample.textContent = example;
      item.append(sample);
    }
    return item;
  }));
}

async function drawInviteQr(url) {
  try {
    const { default: qrCode } = await import('/qr-encoder.mjs');
    const qr = qrCode(0, 'M');
    qr.addData(url);
    qr.make();
    $('invite-qr-image').src = qr.createDataURL(6, 24);
    $('invite-qr').hidden = false;
  } catch {
    $('invite-qr').hidden = true;
  }
}

function render(next) {
  const previous = state;
  state = next;
  if (previous?.roundId !== next.roundId || next.phase === 'lobby') $('draft').value = '';
  $('round').hidden = next.phase === 'lobby' || next.phase === 'modes';
  const modeLabel = next.modes.find((mode) => mode.id === next.mode).label;
  $('round').textContent = modeLabel + ' · ' + next.questionNumber + '/' + next.questionCount;
  show(next.phase);

  if (next.phase === 'lobby') {
    if (previous?.phase !== 'lobby') {
      const invite = location.origin + '/room/' + code;
      $('invite').value = invite;
      void drawInviteQr(invite);
    }
    if (previous?.phase !== 'lobby' || previous.playerCount !== next.playerCount) {
      $('players').textContent = 'เข้าห้องแล้ว ' + next.playerCount + ' คน';
      const icons = $('player-icons');
      if (previous?.phase !== 'lobby') icons.replaceChildren();
      const count = Math.min(next.playerCount, 24);
      while (icons.childElementCount < count) icons.append(document.createElement('span'));
    }
    $('start').hidden = !next.isHost;
    $('wait-for-host').hidden = next.isHost;
    renderModes(next, 'lobby-modes', false);
  } else if (next.phase === 'answering') {
    if (previous?.roundId !== next.roundId && !document.hidden) suppressRevealAnimation = false;
    endsAt = performance.now() + Math.max(0, next.deadline - next.serverNow);
    opensAt = performance.now() + ((next.answerStartsAt ?? next.deadline - 60_000) - next.serverNow);
    $('question').textContent = next.question;
    $('sent').hidden = !next.hasSubmitted;
    updateClock();
    $('progress').textContent = 'ส่งแล้ว ' + next.submittedCount + ' จาก ' + next.playerCount + ' คน';
    updateDraft();
  } else if (next.phase === 'revealed') {
    $('result-question').textContent = next.question;
    if (previous?.phase !== 'revealed' || previous.roundId !== next.roundId) {
      $('answers').replaceChildren(...next.answers.map((answer, index) => {
        const item = document.createElement('li');
        const number = document.createElement('span');
        number.className = 'card-number';
        number.textContent = 'ใบ ' + (index + 1);
        const content = document.createElement('div');
        content.textContent = answer;
        item.append(number, content);
        if (previous?.phase === 'answering' && !document.hidden &&
            !suppressRevealAnimation) {
          item.classList.add('reveal-card');
          item.style.animationDelay = Math.min(index * 65, 450) + 'ms';
        }
        return item;
      }));
    }
    $('empty').hidden = next.answers.length !== 0;
    $('ready').textContent = next.isReady ? 'ยกเลิกความพร้อม' : 'พร้อมไปต่อ';
    $('ready').setAttribute('aria-pressed', String(next.isReady));
    const count = 'พร้อมแล้ว ' + next.readyCount + ' จาก ' + next.playerCount + ' คน';
    if ($('ready-count').textContent !== count) $('ready-count').textContent = count;
    suppressRevealAnimation = false;
  } else {
    $('mode-instructions').textContent = next.isHost ? 'เลือกโหมดให้ทั้งวง' : 'รอคนสร้างห้องเลือกโหมด';
    renderModes(next, 'mode-options', next.isHost);
    renderModes(next, 'locked-modes', false);
  }
}

function pollDelay() {
  if (document.hidden) return 10_000;
  return state?.phase === 'answering' ? 500 : 2000;
}

async function poll() {
  clearTimeout(pollTimer);
  if (!token || reading) return;
  if (pending) {
    pollTimer = setTimeout(poll, pollDelay());
    return;
  }
  reading = true;
  const readRevision = revision;
  try {
    const next = await request(roomPath);
    if (revision !== readRevision || pending) return;
    checkingSubmission = false;
    render(next);
    notice();
  } catch (error) {
    if (revision !== readRevision || pending) return;
    if (error.status === 403 || error.status === 404) {
      token = null;
      state = undefined;
      sessionStorage.removeItem(storageKey);
      $('round').hidden = true;
      show('join-screen');
      notice(error.message);
    } else {
      notice('กำลังเชื่อมต่อใหม่…');
    }
  } finally {
    reading = false;
    if (token) pollTimer = setTimeout(poll, pollDelay());
  }
}

async function mutate(button, action, { reconcile = false } = {}) {
  if (pending) return;
  pending = true;
  revision += 1;
  button.disabled = true;
  notice();
  try {
    await action();
  } catch (error) {
    notice(error.status ? error.message : 'เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง');
    if (reconcile && token) {
      try {
        render(await request(roomPath));
        if (state.hasSubmitted || state.phase !== 'answering') notice();
      } catch {
        checkingSubmission = true;
        notice('กำลังตรวจสอบสถานะคำตอบ…');
      }
    }
  } finally {
    pending = false;
    button.disabled = false;
    updateDraft();
    if (token) void poll();
  }
}

$('create').onclick = () => mutate($('create'), async () => {
  const room = await request('/api/rooms', { method: 'POST' });
  sessionStorage.setItem('friends:' + room.code, room.token);
  location.assign('/room/' + room.code);
});

$('join').onclick = () => mutate($('join'), async () => {
  const keyName = storageKey + ':join';
  let joinKey = sessionStorage.getItem(keyName);
  if (!joinKey) {
    joinKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(keyName, joinKey);
  }
  const room = await request(roomPath + '/join', { method: 'POST', data: { joinKey } });
  token = room.token;
  sessionStorage.setItem(storageKey, token);
});

$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('invite').value);
    $('copy').textContent = 'คัดลอกแล้ว';
    setTimeout(() => { $('copy').textContent = 'คัดลอก'; }, 1800);
  } catch {
    $('invite').focus();
    $('invite').select();
  }
};

$('start').onclick = () => mutate($('start'), async () => {
  render(await request(roomPath + '/start', { method: 'POST' }));
});

$('ready').onclick = () => mutate($('ready'), async () => {
  const data = { roundId: state.roundId, isReady: !state.isReady };
  render(await request(roomPath + '/ready', { method: 'POST', data }));
});

$('draft').addEventListener('input', updateDraft);
$('answer-form').onsubmit = (event) => {
  event.preventDefault();
  if (!state || state.phase !== 'answering' || state.hasSubmitted || performance.now() < opensAt || $('send').disabled) return;
  const data = { roundId: state.roundId, text: $('draft').value };
  void mutate($('send'), async () => {
    render(await request(roomPath + '/answers', { method: 'POST', data }));
  }, { reconcile: true });
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) suppressRevealAnimation = true;
  else void poll();
});
setInterval(updateClock, 200);
if (token) void poll();
else show(code ? 'join-screen' : 'home');
