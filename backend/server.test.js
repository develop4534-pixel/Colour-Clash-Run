"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { WebSocket } = require("ws");
const { createRoomServer } = require("./server");

const ORIGIN = "http://127.0.0.1:8787";
let service;
let baseUrl;
const sockets = [];

function connect() {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`, {
    origin: ORIGIN,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForMessage(socket, predicate, label = "WebSocket message") {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${label}`));
    }, 2000);
    function onMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    }
    socket.on("message", onMessage);
  });
}

before(async () => {
  service = createRoomServer({ allowedOrigins: [ORIGIN] });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${service.server.address().port}`;
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  await service.close();
});

test("serves the game and reports backend health", async () => {
  const [pageResponse, healthResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/healthz`),
  ]);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Colour Clash Run/);
  assert.deepEqual(await healthResponse.json(), { ok: true, rooms: 0, clients: 0 });
});

test("joins players and relays presence and game events", async () => {
  const roomKey = "cc-ab12cd34-0-l1";
  const host = await connect();
  const hostJoined = waitForMessage(
    host,
    (message) => message.type === "joined",
    "host room join",
  );
  host.send(JSON.stringify({ type: "join", roomKey }));
  const hostInfo = await hostJoined;

  const guest = await connect();
  const newPeers = waitForMessage(
    host,
    (message) => message.type === "peers" && message.peers.length === 1,
    "host peer list",
  );
  const guestJoined = waitForMessage(
    guest,
    (message) => message.type === "joined",
    "guest room join",
  );
  guest.send(JSON.stringify({ type: "join", roomKey }));
  const guestInfo = await guestJoined;
  assert.equal(guestInfo.peers.length, 1);
  assert.equal(guestInfo.peers[0].kind, "viewer");
  await newPeers;

  const presenceUpdate = waitForMessage(
    guest,
    (message) =>
      message.type === "presence" && message.peer === hostInfo.peer,
    "presence update",
  );
  host.send(
    JSON.stringify({
      type: "presence",
      data: {
        st: "lobby",
        name: "  Sunny   Fox ",
        av: 0,
        level: 1,
        ignored: "not forwarded",
      },
    }),
  );
  const presence = await presenceUpdate;
  assert.deepEqual(presence.data, {
    st: "lobby",
    name: "Sunny Fox",
    av: 0,
    level: 1,
  });

  const invalidPresence = waitForMessage(
    guest,
    (message) => message.type === "error",
    "invalid player name error",
  );
  guest.send(
    JSON.stringify({
      type: "presence",
      data: { name: "a".repeat(21) },
    }),
  );
  assert.equal((await invalidPresence).message, "Presence data is invalid.");

  const hostStart = waitForMessage(
    host,
    (message) => message.type === "event" && message.eventType === "start",
    "host start event",
  );
  const guestStart = waitForMessage(
    guest,
    (message) => message.type === "event" && message.eventType === "start",
    "guest start event",
  );
  guest.send(
    JSON.stringify({
      type: "event",
      eventType: "start",
      data: { ar: 0, code: "AB12CD34", level: 1 },
    }),
  );
  assert.equal((await hostStart).sameTab, false);
  assert.equal((await guestStart).sameTab, true);
});
