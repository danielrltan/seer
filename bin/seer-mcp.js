#!/usr/bin/env node
// seer-mcp: the Seer tools for any MCP client (Claude Code, Codex, Cursor, Gemini CLI), over stdio.
// stdout carries the protocol, so nothing in here may print to it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as core from '../src/core.js';

const server = new McpServer({ name: 'seer', version: '0.1.0' });

const reply = fn => async args => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(args), null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

server.registerTool('seer_up', {
  title: 'Preview a build on the phone',
  description: 'Runs the project\'s dev server (or publishes one already running, via port) and returns a private link that '
    + 'opens it, running, on the user\'s phone behind their sign-in. Call it after a change the user can see, then put the '
    + 'returned url in your reply as a plain link. The same name always keeps the same link, so call it again after a '
    + 'rebuild and the user\'s open tab just reloads. If status is "failed", read the log and fix the start command.',
  inputSchema: {
    path: z.string().optional().describe('Project folder (or worktree). Default: the current directory.'),
    name: z.string().optional().describe('Preview name, part of the link. Default: the folder name. Use one name per worktree.'),
    cmd: z.string().optional().describe('How to start it when there is no dev script, e.g. "node server/game.js". PORT is set; {port} is replaced.'),
    port: z.number().int().optional().describe('Publish a server that is already listening on this port instead of starting one.'),
    restart: z.boolean().optional().describe('Start it again even if it is already running.'),
  },
}, reply(args => core.up(args)));

server.registerTool('seer_status', {
  title: 'Check a preview',
  description: 'Whether a preview is running, stopped or failed, with the last lines of its log when it is not running.',
  inputSchema: { name: z.string() },
}, reply(({ name }) => core.status(name)));

server.registerTool('seer_restart', {
  title: 'Restart a preview',
  description: 'Starts a preview\'s dev server again from the same folder and command. The link stays the same.',
  inputSchema: { name: z.string() },
}, reply(({ name }) => core.restart(name)));

server.registerTool('seer_down', {
  title: 'Stop a preview',
  description: 'Stops a preview and removes its link.',
  inputSchema: { name: z.string() },
}, reply(({ name }) => core.down(name)));

server.registerTool('seer_list', {
  title: 'List previews',
  description: 'Every preview with its link and state.',
  inputSchema: {},
}, reply(() => core.list()));

await server.connect(new StdioServerTransport());
