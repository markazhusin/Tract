import { execSync } from 'node:child_process';

/**
 * Завершает процесс(ы), слушающие TCP-порт (например, старый signaling после прошлого share).
 */
export function releasePort(port) {
  if (process.platform === 'win32') {
    try {
      const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        } catch {}
      }
    } catch {
      /* никто не слушает */
    }
    return;
  }

  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    if (!out) return;
    const pids = [...new Set(out.split(/\n/).filter(Boolean))];
    if (pids.length) {
      console.log(
        `\x1b[90m[tract] Порт ${port} занят — завершаю старый процесс: ${pids.join(', ')}\x1b[0m`
      );
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch {}
    }
  } catch {
    /* lsof: no matching processes */
  }
}

if (process.argv[1]?.includes('free-port.mjs')) {
  releasePort(Number(process.argv[2]) || 8877);
}
