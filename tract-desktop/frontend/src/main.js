import './style.css';
import { NodeStatus, NodeURL } from '../wailsjs/go/main/App';

document.querySelector('#app').innerHTML = `
  <div class="brand">
    <div class="mark">t</div>
    <h1>Tract</h1>
  </div>
  <div class="subtitle">Этот компьютер — узел сети</div>

  <div class="card">
    <div class="status-row">
      <div class="dot" id="dot"></div>
      <div>
        <div class="status-text" id="statusText">Запуск узла…</div>
        <div class="status-sub" id="statusSub">поднимаем встроенный сервер</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="num" id="peers">—</div><div class="label">пиры</div></div>
      <div class="stat"><div class="num" id="identities">—</div><div class="label">личности</div></div>
      <div class="stat"><div class="num" id="rooms">—</div><div class="label">комнаты</div></div>
    </div>
  </div>

  <p class="note">
    Это приложение — <b>и клиент, и сервер</b>: оно само держит узел сети.
    Адрес узла для устройств рядом: <span class="url" id="url">…</span>
  </p>
`;

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const statusSub = document.getElementById('statusSub');
const peersEl = document.getElementById('peers');
const idsEl = document.getElementById('identities');
const roomsEl = document.getElementById('rooms');

NodeURL().then((u) => { document.getElementById('url').innerText = u; });

async function refresh() {
  try {
    const raw = await NodeStatus();
    const h = JSON.parse(raw);
    if (h.status === 'ok') {
      dot.classList.add('online');
      statusText.innerText = 'Узел в сети';
      statusSub.innerText = 'принимает подключения';
      peersEl.innerText = h.peers ?? 0;
      idsEl.innerText = h.identities ?? 0;
      roomsEl.innerText = h.rooms ?? 0;
    } else {
      dot.classList.remove('online');
      statusText.innerText = 'Запуск узла…';
      statusSub.innerText = 'поднимаем встроенный сервер';
    }
  } catch (e) {
    dot.classList.remove('online');
    statusText.innerText = 'Узел недоступен';
    statusSub.innerText = String(e);
  }
}

refresh();
setInterval(refresh, 1500);
