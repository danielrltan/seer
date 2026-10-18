// The Claude Code sessions running on this Mac, for Seer home: Claude Code keeps one small file per session in
// ~/.claude/sessions (pid, name, folder, status, and with Remote Control on, the claude.ai session it is bridged
// to). A file whose process has ended is skipped. This is Claude Code's own bookkeeping, not a published format,
// so anything missing or unreadable just leaves the list shorter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.claude', 'sessions');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function runningAgents() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => /^\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!Number.isInteger(s.pid) || !alive(s.pid)) continue;
      const bridge = typeof s.bridgeSessionId === 'string' && /^session_[A-Za-z0-9]{8,64}$/.test(s.bridgeSessionId) ? s.bridgeSessionId : null;
      const dir = typeof s.cwd === 'string' && s.cwd !== os.homedir() ? s.cwd.replace(os.homedir(), '~') : '';
      out.push({
        name: String(s.name || 'session').slice(0, 60), dir: dir.slice(0, 80),
        busy: s.status === 'busy', since: Number(s.statusUpdatedAt || s.updatedAt) || 0,
        url: bridge ? `https://claude.ai/code/${bridge}` : null,
      });
    } catch {}
  }
  return out.sort((a, b) => (b.busy - a.busy) || (b.since - a.since));
}
