# Colour Clash Run multiplayer server

This Node.js service hosts the game files and WebSocket room server. It relays
room presence, the start signal, quick-chat phrases, and gameplay pings/events.
Rooms are temporary and disappear when their last player disconnects.
Presence includes a display name of up to 20 characters; names are only relayed
to players currently connected to the same room.
Quick-chat and pings are delivered to connected players; this does not enable
push notifications when the game is closed.

## Run locally

Requires Node.js 20 or newer.

```powershell
cd backend
npm install
$env:ALLOWED_ORIGINS = "http://localhost:8787,http://127.0.0.1:8787"
npm start
```

Open `http://localhost:8787`. The service also provides `GET /healthz` for a
basic health check and `npm test` for the WebSocket integration tests.

## Deploy

The repository includes a Render Blueprint in `../render.yaml`. Create a
Blueprint from the repository root in Render and deploy the
`colour-clash-run-multiplayer` web service. It runs this Node.js service and
allows the published Netlify game origin to connect. The service must run on a
host that supports WebSocket upgrade connections.

- Build command: `npm install`
- Start command: `npm start`
- Node version: 20 or newer
- Set `NODE_ENV` to `production`.
- Set `ALLOWED_ORIGINS` to a comma-separated list of exact browser origins.
  Add every frontend origin that will connect; the supplied Blueprint includes
  `https://colour-clash-roun-test.netlify.app` and
  `https://develop4534-pixel.github.io`.

  After deploying, check `https://<your-service>.onrender.com/healthz`; it should
  return JSON with `"ok": true`. Static Netlify and GitHub Pages sites cannot host
  WebSockets, so point their clients at the deployed service. The frontend is
  configured for `wss://colour-clash-run-multiplayer.onrender.com/ws`, matching
  the supplied Render service name. If Render assigns a different public host,
  set the `room-server-url` meta tag in `index.html/index.html` to
  `wss://<your-service>.onrender.com/ws` and redeploy the frontend, or open/share
  the game with a `roomServer` query parameter, for example:
`https://colour-clash-roun-test.netlify.app/?roomServer=wss%3A%2F%2F<your-service>.onrender.com%2Fws`.
The URL parameter is useful when you cannot redeploy the static page; each
player must use that configured game URL. The meta tag takes precedence if it
is set.

The team-room lobby provides a pairing link that includes the room code, arena,
and level. Friends can open it or paste it into the team-room menu to join that
room; the host must stay connected while they join. Room codes remain public
join credentials: anyone who knows a code or pairing link can enter its room.
New rooms use eight-character codes. Keep the service to one instance unless
shared room storage is added; in-memory rooms are not shared across instances
or deployments.
