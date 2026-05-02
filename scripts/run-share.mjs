import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePort } from './free-port.mjs';

const SIGNAL_PORT = 8877;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tunnelUrlFile = path.join(root, '.tunnel-url');
const trycloudflareRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

let announced = false;

function announce(url) {
  if (announced) return;
  announced = true;
  const line = `\n\x1b[1;32m═══════════════════════════════════════════════════════════\n  Публичная ссылка Tract (откройте в браузере):\n  ${url}\n═══════════════════════════════════════════════════════════\x1b[0m\n`;
  console.log(line);
  fs.writeFileSync(tunnelUrlFile, `${url}\n`, 'utf8');
  console.log(`\x1b[90mТот же URL записан в файл: ${tunnelUrlFile}\x1b[0m\n`);
  console.log(
    '\x1b[90mНе закрывайте этот терминал. Ошибка 1033 в браузере = процесс cloudflared не запущен или сеть оборвалась — снова: npm run share\x1b[0m\n'
  );
}

function markTunnelStopped() {
  try {
    fs.writeFileSync(
      tunnelUrlFile,
      '# Туннель сейчас не активен (запустите: npm run share)\n',
      'utf8'
    );
  } catch {}
}

function scanChunk(chunk) {
  const s = chunk.toString();
  const matches = s.match(trycloudflareRe);
  if (matches?.length) {
    announce(matches[0]);
  }
}

function waitForHealth(port, healthPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}${healthPath}`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    }

    function retry() {
      if (Date.now() >= deadline) {
        reject(new Error(`signaling не ответил на /health за ${timeoutMs} мс`));
        return;
      }
      setTimeout(attempt, 250);
    }

    attempt();
  });
}

async function main() {
  releasePort(SIGNAL_PORT);
  const until = Date.now() + 300;
  while (Date.now() < until) {
    /* дать ОС закрыть сокет */
  }

  const tract = spawn(process.execPath, ['signaling-server.js'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });

  try {
    await waitForHealth(SIGNAL_PORT, '/health', 20000);
  } catch (e) {
    console.error(`\x1b[31m${e.message}\x1b[0m`);
    try {
      tract.kill('SIGTERM');
    } catch {}
    process.exit(1);
  }

  const tunnel = spawn(
    'cloudflared',
    [
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      'quic',
      '--url',
      `http://127.0.0.1:${SIGNAL_PORT}`
    ],
    {
      cwd: root,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env
    }
  );

  tunnel.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    scanChunk(chunk);
  });

  tunnel.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    scanChunk(chunk);
  });

  function shutdown(code = 0) {
    markTunnelStopped();
    try {
      tunnel.kill('SIGTERM');
    } catch {}
    try {
      tract.kill('SIGTERM');
    } catch {}
    process.exit(code);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  tract.on('exit', (code) => {
    console.error(
      '\x1b[31mСервер Tract (порт 8877) остановился — туннель перестанет работать (ошибка 1033).\x1b[0m'
    );
    markTunnelStopped();
    try {
      tunnel.kill('SIGTERM');
    } catch {}
    process.exit(code ?? 0);
  });

  tunnel.on('exit', (code) => {
    if (code !== 0 && code != null) {
      console.error(
        '\n\x1b[1;31mcloudflared завершился с ошибкой. В браузере будет «Ошибка 1033» — проверьте сеть/VPN и снова: npm run share\x1b[0m\n'
      );
    } else {
      console.error(
        '\n\x1b[33mТуннель остановлен. Ссылка trycloudflare больше не действует (1033).\x1b[0m\n'
      );
    }
    markTunnelStopped();
    try {
      tract.kill('SIGTERM');
    } catch {}
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
