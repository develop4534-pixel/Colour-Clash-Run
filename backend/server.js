"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const MAX_CLIENTS = 3000;
const MAX_PEERS_PER_ROOM = 16;
const MAX_ROOMS = 1000;
const MAX_MESSAGES_PER_SECOND = 80;
const MAX_MESSAGE_BYTES = 8192;
const ROOM_KEY_PATTERN = /^cc-([a-z0-9]{1,8})-(\d{1,3})-l(\d{1,2})$/i;
const ROOM_KEY_REASONS = {
  1008: "Room or message is invalid",
  1013: "Room is full; try again later",
};

function getAllowedOrigins(configuredOrigins) {
  if (configuredOrigins) return new Set(configuredOrigins);
  const values = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!values.length && process.env.NODE_ENV === "production") {
    throw new Error("Set ALLOWED_ORIGINS to the exact website origins allowed to connect.");
  }

  return new Set(
    values.length
      ? values
      : ["http://localhost:8787", "http://127.0.0.1:8787"],
  );
}

function sanitizePresence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  const allowedFields = new Set([
    "st",
    "name",
    "av",
    "pc",
    "level",
    "x",
    "y",
    "sc",
    "fin",
    "pr",
    "f",
    "em",
  ]);

  for (const [key, item] of Object.entries(value)) {
    if (!allowedFields.has(key)) continue;
    if (key === "st") {
      if (!["lobby", "play", "end"].includes(item)) return null;
      result.st = item;
    } else if (key === "name") {
      if (typeof item !== "string") return null;
      const name = item
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!name || name.length > 20) return null;
      result.name = name;
    } else if (typeof item === "number" && Number.isFinite(item)) {
      if (Math.abs(item) > 10_000_000) return null;
      result[key] = item;
    } else {
      return null;
    }
  }

  return result;
}

function sanitizeEvent(eventType, value, roomKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  if (eventType === "start") {
    const match = ROOM_KEY_PATTERN.exec(roomKey);
    if (
      !match ||
      typeof value.code !== "string" ||
      !/^[A-Z0-9]{1,8}$/.test(value.code) ||
      value.code.toLowerCase() !== match[1].toLowerCase() ||
      !Number.isInteger(value.ar) ||
      value.ar !== Number(match[2]) ||
      !Number.isInteger(value.level) ||
      value.level !== Number(match[3]) ||
      value.level < 1 ||
      value.level > 10
    )
      return null;
    return { ar: value.ar, code: value.code, level: value.level };
  }

  if (eventType !== "ev" || typeof value.t !== "string") return null;
  switch (value.t) {
    case "say":
      return Number.isInteger(value.i) && value.i >= 0 && value.i < 4
        ? { t: "say", i: value.i }
        : null;
    case "ping":
      return Number.isFinite(value.x) &&
        Number.isFinite(value.y) &&
        Math.abs(value.x) <= 10_000_000 &&
        Math.abs(value.y) <= 10_000_000
        ? { t: "ping", x: value.x, y: value.y }
        : null;
    case "paint":
      return Number.isInteger(value.i) &&
        value.i >= 0 &&
        value.i <= 10_000 &&
        Number.isInteger(value.c) &&
        value.c >= 0 &&
        value.c < 16
        ? { t: "paint", i: value.i, c: value.c }
        : null;
    case "heart":
    case "star":
      return Number.isInteger(value.i) && value.i >= 0 && value.i <= 10_000
        ? { t: value.t, i: value.i }
        : null;
    case "speed":
    case "key":
    case "gate":
      return { t: value.t };
    default:
      return null;
  }
}

function createRoomServer(options = {}) {
  const allowedOrigins = getAllowedOrigins(options.allowedOrigins);
  const staticRoot = path.resolve(
    options.staticRoot || path.join(__dirname, "..", "index.html"),
  );
  const rooms = new Map();
  const clients = new Set();

  function send(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendError(client, message) {
    send(client.socket, { type: "error", message });
  }

  function peersFor(room, excludedId) {
    return [...room.clients.values()]
      .filter((client) => client.id !== excludedId)
      .map((client) => ({
        peer: client.id,
        kind: "viewer",
        sameTab: false,
        presence: client.presence,
      }));
  }

  function publishPeers(room) {
    for (const client of room.clients.values()) {
      send(client.socket, {
        type: "peers",
        peers: peersFor(room, client.id),
      });
    }
  }

  function removeClient(client) {
    clearTimeout(client.joinTimer);
    clients.delete(client);
    const room = client.room;
    if (!room) return;
    room.clients.delete(client.id);
    client.room = null;
    if (room.clients.size === 0) {
      rooms.delete(room.key);
    } else {
      publishPeers(room);
    }
  }

  function closeWithError(client, code, message) {
    sendError(client, message);
    client.socket.close(code, ROOM_KEY_REASONS[code] || "Invalid message");
  }

  function handleJoin(client, message) {
    if (client.room || typeof message.roomKey !== "string") {
      closeWithError(client, 1008, "Invalid room request.");
      return;
    }
    const roomKey = message.roomKey.toLowerCase();
    const match = ROOM_KEY_PATTERN.exec(roomKey);
    if (!match || Number(match[3]) < 1 || Number(match[3]) > 10) {
      closeWithError(client, 1008, "Room code, arena, or level is invalid.");
      return;
    }

    let room = rooms.get(roomKey);
    if (!room && rooms.size >= MAX_ROOMS) {
      closeWithError(client, 1013, "The room service is busy. Try again shortly.");
      return;
    }
    if (room && room.clients.size >= MAX_PEERS_PER_ROOM) {
      closeWithError(client, 1013, "This room is full (maximum 16 players).");
      return;
    }
    if (!room) {
      room = { key: roomKey, clients: new Map() };
      rooms.set(roomKey, room);
    }

    clearTimeout(client.joinTimer);
    client.id = crypto.randomUUID();
    client.room = room;
    room.clients.set(client.id, client);
    send(client.socket, {
      type: "joined",
      peer: client.id,
      peers: peersFor(room, client.id),
    });
    publishPeers(room);
  }

  function handleMessage(client, raw) {
    const now = Date.now();
    if (now - client.rateWindow >= 1000) {
      client.rateWindow = now;
      client.messageCount = 0;
    }
    client.messageCount++;
    if (client.messageCount > MAX_MESSAGES_PER_SECOND) {
      closeWithError(client, 1008, "Too many messages. Slow down.");
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      closeWithError(client, 1008, "Message must be valid JSON.");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      closeWithError(client, 1008, "Message format is invalid.");
      return;
    }

    if (!client.room) {
      if (message.type !== "join") {
        closeWithError(client, 1008, "Join a room before sending messages.");
        return;
      }
      handleJoin(client, message);
      return;
    }

    if (message.type === "presence") {
      const presence = sanitizePresence(message.data);
      if (!presence) {
        sendError(client, "Presence data is invalid.");
        return;
      }
      client.presence = presence;
      for (const peer of client.room.clients.values()) {
        if (peer.id !== client.id)
          send(peer.socket, {
            type: "presence",
            peer: client.id,
            data: presence,
          });
      }
      return;
    }

    if (message.type === "event") {
      const data = sanitizeEvent(
        message.eventType,
        message.data,
        client.room.key,
      );
      if (!data) {
        sendError(client, "Room event is invalid.");
        return;
      }
      for (const peer of client.room.clients.values()) {
        send(peer.socket, {
          type: "event",
          eventType: message.eventType,
          peer: client.id,
          sameTab: peer.id === client.id,
          data,
        });
      }
      return;
    }

    if (message.type === "leave") {
      removeClient(client);
      client.socket.close(1000, "Left room");
      return;
    }

    closeWithError(client, 1008, "Message type is not supported.");
  }

  function serveStatic(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }
    if (pathname === "/healthz") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size }));
      return;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.resolve(staticRoot, relativePath);
    const relativeToRoot = path.relative(staticRoot, filePath);
    if (
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot)
    ) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    let file;
    try {
      file = fs.statSync(filePath).isFile() ? filePath : null;
    } catch {
      file = null;
    }
    if (!file) {
      response.writeHead(404).end("Not found");
      return;
    }

    const mimeTypes = {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".js": "text/javascript; charset=utf-8",
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "Content-Type":
        mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(file).pipe(response);
  }

  const server = http.createServer(serveStatic);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!request.headers.origin || !allowedOrigins.has(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (clients.size >= MAX_CLIENTS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  webSocketServer.on("connection", (socket) => {
    const client = {
      socket,
      id: null,
      room: null,
      presence: null,
      alive: true,
      messageCount: 0,
      rateWindow: Date.now(),
      joinTimer: setTimeout(() => {
        closeWithError(client, 1008, "Join a room to keep the connection open.");
      }, 10_000),
    };
    clients.add(client);
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("message", (raw) => handleMessage(client, raw));
    socket.on("close", () => removeClient(client));
    socket.on("error", () => removeClient(client));
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        removeClient(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    server,
    rooms,
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.socket.terminate();
      return new Promise((resolve, reject) => {
        webSocketServer.close();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

if (require.main === module) {
  const service = createRoomServer();
  const port = Number(process.env.PORT) || 8787;
  service.server.listen(port, "0.0.0.0", () => {
    console.log(`Colour Clash Run multiplayer server listening on port ${port}`);
  });
}

module.exports = { createRoomServer };
