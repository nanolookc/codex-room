# Codex Room

![Codex Room screenshot](./screen.png)

This is an early experimental idea.

A friend and I were building a game, and I thought it would be useful to see Codex output in real time while also being able to edit prompts collaboratively, similar to Google Docs.

That is exactly how Codex Room works today.

In the future, I plan to add:
- A simple proxy backend so Codex Room can create a public tunnel automatically with token-based access.
- Better sandboxing so access is limited to the directory where the app was started.

## How to run

```bash
codex-room start
```

Example output:

```text
Codex Room started for: /home/dima/dev/bones
Room: 46acb1f2-004c-423a-8ab6-e40c8a83d906
Local URL: http://localhost:3001?room=46acb1f2-004c-423a-8ab6-e40c8a83d906
Share URL: http://192.168.1.230:3001?room=46acb1f2-004c-423a-8ab6-e40c8a83d906
Press Ctrl+C to stop.
```

For now, you need to create a tunnel manually with tools like ngrok or Cloudflare Tunnel.
