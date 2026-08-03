import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { getBrokerSocketPath } from "./paths.js";
import { writeMessage, createMessageReader } from "./framing.js";

const isWindows = process.platform === "win32";
const brokerDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(brokerDir, "..");
const brokerPath = path.join(brokerDir, "broker.ts");
const cliPath = path.join(repoDir, "cli", "cli.ts");

type AnyRecord = Record<string, any>;

function spawnBroker(homeDir: string): ChildProcess {
  return spawn("npx", ["--no-install", "tsx", brokerPath], {
    cwd: repoDir,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectStream(child: ChildProcess): { stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { stdout: () => stdout, stderr: () => stderr };
}

function waitForExit(child: ChildProcess, timeoutMs = 15000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Broker process did not exit within timeout"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function waitForStdoutLine(streams: { stdout: () => string }, child: ChildProcess, needle: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${needle}"; stdout so far: ${streams.stdout()}`));
    }, timeoutMs);
    const check = () => {
      if (streams.stdout().includes(needle)) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      // Give the final data event a tick to land before deciding.
      setImmediate(() => {
        if (streams.stdout().includes(needle)) {
          cleanup();
          resolve();
        } else {
          cleanup();
          reject(new Error(`Broker exited before printing "${needle}"; stdout: ${streams.stdout()}`));
        }
      });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", check);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", check);
    child.once("exit", onExit);
    check();
  });
}

interface TestConnection {
  socket: net.Socket;
  next: (timeoutMs?: number) => Promise<AnyRecord>;
}

function connectClient(socketPath: string): Promise<TestConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const queue: AnyRecord[] = [];
    const waiters: Array<{ resolve: (msg: AnyRecord) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
    let failed = false;

    const reader = createMessageReader((msg) => {
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(msg as AnyRecord);
      } else {
        queue.push(msg as AnyRecord);
      }
    }, (error) => {
      failed = true;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });

    const next = (timeoutMs = 5000): Promise<AnyRecord> => {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (failed) {
        return Promise.reject(new Error("connection failed"));
      }
      return new Promise((resolveMsg, rejectMsg) => {
        const timer = setTimeout(() => {
          rejectMsg(new Error("timed out waiting for broker message"));
        }, timeoutMs);
        waiters.push({ resolve: resolveMsg as (msg: AnyRecord) => void, reject: rejectMsg, timer });
      });
    };

    socket.on("data", reader);
    socket.once("error", reject);
    socket.once("connect", () => resolve({ socket, next }));
  });
}

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-session",
    cwd: "/tmp",
    model: "test-model",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    ...overrides,
  };
}

function runCli(homeDir: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "tsx", cliPath, ...args], {
      cwd: repoDir,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      stdio: input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within timeout; stdout: ${stdout}; stderr: ${stderr}`));
    }, 20000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

test("guest clients are invisible to sessions and can send/receive replies", { skip: isWindows }, async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-guest-"));
  mkdirSync(path.join(homeDir, ".pi/agent/intercom"), { recursive: true });
  const socketPath = getBrokerSocketPath(process.platform, homeDir);

  const broker = spawnBroker(homeDir);
  const streams = collectStream(broker);
  const sockets: net.Socket[] = [];
  try {
    await waitForStdoutLine(streams, broker, "Intercom broker started");

    const session = await connectClient(socketPath);
    sockets.push(session.socket);
    writeMessage(session.socket, { type: "register", session: registration() });
    const sessionRegistered = await session.next();
    assert.equal(sessionRegistered.type, "registered");

    const guest = await connectClient(socketPath);
    sockets.push(guest.socket);
    writeMessage(guest.socket, { type: "register", session: registration({ name: "cli" }), guest: true });
    const guestRegistered = await guest.next();
    assert.equal(guestRegistered.type, "registered");
    const guestId = guestRegistered.sessionId as string;

    // The real session must not hear about the guest joining: the first message
    // it receives after guest registration is its own list response, not a
    // session_joined broadcast.
    writeMessage(session.socket, { type: "list", requestId: "session-list" });
    const sessionList = await session.next();
    assert.equal(sessionList.type, "sessions");
    const sessionIds = (sessionList.sessions as AnyRecord[]).map(s => s.id);
    assert.ok(sessionIds.includes(sessionRegistered.sessionId));
    assert.ok(!sessionIds.includes(guestId), "guest must not appear in a session's list");

    // The guest's own list view also excludes itself.
    writeMessage(guest.socket, { type: "list", requestId: "guest-list" });
    const guestList = await guest.next();
    assert.equal(guestList.type, "sessions");
    const guestIds = (guestList.sessions as AnyRecord[]).map(s => s.id);
    assert.ok(!guestIds.includes(guestId), "guest must not appear in its own list");

    // Guest sends a message to the real session; the from identity is the guest.
    writeMessage(guest.socket, {
      type: "send",
      to: sessionRegistered.sessionId,
      message: { id: "q-1", timestamp: Date.now(), content: { text: "hello" }, expectsReply: true },
    });
    const delivered = await guest.next();
    assert.equal(delivered.type, "delivered");
    const incoming = await session.next();
    assert.equal(incoming.type, "message");
    assert.equal(incoming.message.id, "q-1");
    assert.equal(incoming.message.expectsReply, true);
    assert.equal(incoming.from.id, guestId);
    assert.equal(incoming.from.name, "cli");

    // The real session replies to the guest by id; the guest receives it.
    writeMessage(session.socket, {
      type: "send",
      to: guestId,
      message: { id: "r-1", timestamp: Date.now(), replyTo: "q-1", content: { text: "hi back" } },
    });
    const replyDelivered = await session.next();
    assert.equal(replyDelivered.type, "delivered");
    const replyIncoming = await guest.next();
    assert.equal(replyIncoming.type, "message");
    assert.equal(replyIncoming.message.replyTo, "q-1");
    assert.equal(replyIncoming.message.content.text, "hi back");
    assert.equal(replyIncoming.from.id, sessionRegistered.sessionId);

    // Guests cannot be addressed by name, only by their exact id.
    writeMessage(session.socket, {
      type: "send",
      to: "cli",
      message: { id: "r-2", timestamp: Date.now(), content: { text: "wrong address" } },
    });
    const failed = await session.next();
    assert.equal(failed.type, "delivery_failed");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    broker.kill("SIGTERM");
    await waitForExit(broker).catch(() => null);
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli list, send, and ask work end-to-end against a live broker", { skip: isWindows }, async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-cli-"));
  mkdirSync(path.join(homeDir, ".pi/agent/intercom"), { recursive: true });
  const socketPath = getBrokerSocketPath(process.platform, homeDir);

  const broker = spawnBroker(homeDir);
  const streams = collectStream(broker);
  const sockets: net.Socket[] = [];
  try {
    await waitForStdoutLine(streams, broker, "Intercom broker started");

    const session = await connectClient(socketPath);
    sockets.push(session.socket);
    writeMessage(session.socket, { type: "register", session: registration({ name: "worker" }) });
    const sessionRegistered = await session.next();
    assert.equal(sessionRegistered.type, "registered");

    // list
    const listResult = await runCli(homeDir, ["list"]);
    assert.equal(listResult.code, 0, listResult.stderr);
    assert.match(listResult.stdout, /worker/);
    assert.doesNotMatch(listResult.stdout, /pi-intercom-cli/);

    // send (fire-and-forget)
    const sendResult = await runCli(homeDir, ["send", "worker", "fire and forget"]);
    assert.equal(sendResult.code, 0, sendResult.stderr);
    const sentIncoming = await session.next();
    assert.equal(sentIncoming.type, "message");
    assert.equal(sentIncoming.message.content.text, "fire and forget");

    // ask (blocks until the target replies)
    const askPromise = runCli(homeDir, ["ask", "worker", "hello from cli", "--timeout", "15"]);
    const askIncoming = await session.next(10000);
    assert.equal(askIncoming.type, "message");
    assert.equal(askIncoming.message.content.text, "hello from cli");
    assert.equal(askIncoming.message.expectsReply, true);
    assert.equal(askIncoming.from.name, "cli");
    writeMessage(session.socket, {
      type: "send",
      to: askIncoming.from.id,
      message: { id: "r-cli-1", timestamp: Date.now(), replyTo: askIncoming.message.id, content: { text: "reply from worker" } },
    });
    const replyAck = await session.next();
    assert.equal(replyAck.type, "delivered");
    const askResult = await askPromise;
    assert.equal(askResult.code, 0, askResult.stderr);
    assert.match(askResult.stdout, /reply from worker/);

    // ask reads the message from stdin when the message argument is empty
    const stdinAsk = runCli(homeDir, ["ask", "worker", "--timeout", "15"], "hello via stdin\n");
    const stdinIncoming = await session.next(10000);
    assert.equal(stdinIncoming.type, "message");
    assert.equal(stdinIncoming.message.content.text, "hello via stdin");
    assert.equal(stdinIncoming.message.expectsReply, true);
    writeMessage(session.socket, {
      type: "send",
      to: stdinIncoming.from.id,
      message: { id: "r-cli-2", timestamp: Date.now(), replyTo: stdinIncoming.message.id, content: { text: "got it" } },
    });
    const stdinResult = await stdinAsk;
    assert.equal(stdinResult.code, 0, stdinResult.stderr);
    assert.match(stdinResult.stdout, /got it/);

    // unknown target fails fast with a helpful message
    const missingResult = await runCli(homeDir, ["ask", "nobody", "hi", "--timeout", "5"]);
    assert.notEqual(missingResult.code, 0);
    assert.match(missingResult.stderr, /not found/);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    broker.kill("SIGTERM");
    await waitForExit(broker).catch(() => null);
    rmSync(homeDir, { recursive: true, force: true });
  }
});
