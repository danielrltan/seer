#!/usr/bin/env node
// seer-hook busy|waiting|idle: Claude Code's UserPromptSubmit / Notification / Stop hooks. Loads only what it needs so a prompt is
// never held up, and never fails. The fast path and the fallback: Claude's own sessions file decides when it has one
// (activity.js), since Stop fires at the end of a turn even while background subagents or shells still work.
import { recordHook } from '../src/activity.js';
let input = '';
if (!process.stdin.isTTY) for await (const c of process.stdin) input += c;
recordHook(['busy', 'waiting'].includes(process.argv[2]) ? process.argv[2] : 'idle', input);
// Tell Seer now (not at its next tick), so frozen apps thaw the moment an agent starts. Never waits long.
try { await fetch('http://127.0.0.1:7399/kick', { method: 'POST', signal: AbortSignal.timeout(300) }); } catch {}
