#!/usr/bin/env node
// seer-hook busy|waiting|idle: Claude Code's UserPromptSubmit / Notification / Stop hooks. Loads only what it needs so a prompt is
// never held up, and never fails.
import { recordHook } from '../src/activity.js';
let input = '';
if (!process.stdin.isTTY) for await (const c of process.stdin) input += c;
recordHook(['busy', 'waiting'].includes(process.argv[2]) ? process.argv[2] : 'idle', input);
