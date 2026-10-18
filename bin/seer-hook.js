#!/usr/bin/env node
// seer-hook busy|idle: Claude Code's UserPromptSubmit / Stop hooks. Loads only what it needs so a prompt is
// never held up, and never fails.
import { recordHook } from '../src/activity.js';
let input = '';
if (!process.stdin.isTTY) for await (const c of process.stdin) input += c;
recordHook(process.argv[2] === 'busy' ? 'busy' : 'idle', input);
