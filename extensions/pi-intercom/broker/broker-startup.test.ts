import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { getBrokerSocketPath } from "./paths.js";
import { checkSocketConnectable } from "./socket-check.js";

const isWindows = process.platform === "win32";
const brokerDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(brokerDir, "..");
const brokerPath = path.join(brokerDir, "broker.ts");

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

test("broker yields to an existing listener instead of stealing its socket", { skip: isWindows }, async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-startup-"));
  const intercomDir = path.join(homeDir, ".pi/agent/intercom");
  mkdirSync(intercomDir, { recursive: true });
  const socketPath = getBrokerSocketPath(process.platform, homeDir);

  const occupant = net.createServer();
  await new Promise<void>((resolve, reject) => {
    occupant.once("error", reject);
    occupant.listen(socketPath, resolve);
  });

  try {
    const broker = spawnBroker(homeDir);
    const streams = collectStream(broker);
    const exitCode = await waitForExit(broker);

    assert.equal(exitCode, 0, `expected clean yield, stderr: ${streams.stderr()}`);
    assert.match(streams.stdout(), /already listening/);
    assert.doesNotMatch(streams.stdout(), /Intercom broker started/);

    // The occupant's socket must survive: still connectable after the yield.
    assert.equal(await checkSocketConnectable(socketPath), true);

    // The yield must also be observable in the broker log.
    const logPath = path.join(intercomDir, "broker.log");
    assert.equal(existsSync(logPath), true);
    assert.match(readFileSync(logPath, "utf-8"), /already listening/);
  } finally {
    await new Promise<void>((resolve) => occupant.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("broker removes a stale socket file and starts normally", { skip: isWindows }, async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-startup-"));
  const intercomDir = path.join(homeDir, ".pi/agent/intercom");
  mkdirSync(intercomDir, { recursive: true });
  const socketPath = getBrokerSocketPath(process.platform, homeDir);

  // A leftover socket path that nothing is listening on.
  writeFileSync(socketPath, "");

  const broker = spawnBroker(homeDir);
  const streams = collectStream(broker);

  try {
    await waitForStdoutLine(streams, broker, "Intercom broker started");
    assert.equal(await checkSocketConnectable(socketPath), true);
  } finally {
    broker.kill("SIGTERM");
    await waitForExit(broker).catch(() => null);
    rmSync(homeDir, { recursive: true, force: true });
  }
});
