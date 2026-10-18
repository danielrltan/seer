# Seer

Check on your Mac and what it's building from your phone.

A coding agent starts a dev server, Seer gives it a private link, and you open it on your phone. Seer also keeps the Mac awake for as long as something needs it, with the lid closed if you want, and lets you watch the screen when a preview isn't enough.

- **Private links** for local dev servers, through a Cloudflare Tunnel behind Cloudflare Access (one-time PIN to your email).
- **Cloud copies** on Fly.io for when the Mac is off. They sleep when idle and stop after an hour.
- **Mac view**: a project rendered in a real desktop browser on the Mac and streamed to the phone (H.264), with touch, scroll and keyboard input.
- **Awake only when needed**: while an agent works (Claude Code hooks), while you stream, or for a while after, then normal sleep. With the lid closed it turns the screen off, mutes, freezes heavy apps and uses Low Power Mode on battery.
- **Hotspot backup** when the Wi-Fi drops.
- **Status page**: battery, ping, network, lid, running agents (opens a session's Remote Control page) and projects. Settings on the phone and the Mac.
- **Menu-bar app** that runs it all.

## Requirements

- macOS 14+ on Apple silicon, Node 20+, `cloudflared`
- A domain on Cloudflare with Zero Trust enabled
- `fly` and a Fly.io account, for cloud copies only

## Setup

```sh
npm install
# A Cloudflare API token with Account > Cloudflare Tunnel: Edit, Account > Access: Apps and Policies: Edit,
# Zone > DNS: Edit (plus Workers Scripts and Routes: Edit for cloud copies)
mkdir -p ~/.seer && install -m 600 /dev/stdin ~/.seer/cf-token <<< "<token>"
node bin/seer.js setup --zone example.com --email you@example.com
scripts/build-app.sh --install        # builds Seer.app and puts it in /Applications
open /Applications/Seer.app
```

Grant Seer **Screen Recording** and **Accessibility** in System Settings for the Mac view. Seer's own code runs from `~/.seer/code`, so `scripts/deploy-code.sh` ships a change without touching the app or its permissions.

Optional:

```sh
node bin/seer.js away install          # lid-closed awake: one sudoers rule for four pmset commands
node bin/seer.js away hooks            # Claude Code hooks, so Seer knows when an agent is working
node bin/seer.js away hotspot "My iPhone"
```

## Use

```sh
seer up [path]          # start the dev server in path and print its link
seer list
seer down <name>
seer cloud up [path] --name N --cmd "npm start"
```

`bin/seer-mcp.js` exposes the same as MCP tools, so an agent can hand you a link itself.

## License

MIT
