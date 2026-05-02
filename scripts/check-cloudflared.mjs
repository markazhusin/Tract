import { spawnSync } from 'node:child_process';

const r = spawnSync('cloudflared', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });

if (r.error || r.status !== 0) {
  console.error('\nНе найден cloudflared в PATH.\n');
  console.error('Установка (macOS):  brew install cloudflare/cloudflare/cloudflared');
  console.error('Скачать:           https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n');
  process.exit(1);
}
