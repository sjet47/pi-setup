#!/usr/bin/env node

import { randomUUID } from "crypto";
import { IntercomClient } from "../broker/client.js";
import { spawnBrokerIfNeeded } from "../broker/spawn.js";
import { loadConfig } from "../config.js";
import type { Message, SessionInfo } from "../types.js";

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CLI_NAME = "cli";

const USAGE = `pi-intercom — message running pi sessions from the command line.

Usage:
  pi-intercom list                        List connected pi sessions
  pi-intercom status                      Show broker/session status
  pi-intercom send <target> <message...>  Fire-and-forget message
  pi-intercom ask <target> <message...>   Ask a session and wait for its reply

Options:
  --name <name>    Sender name shown to the recipient (default: "cli")
  --timeout <sec>  Reply timeout for ask (default: 600)
  -h, --help       Show this help

The message can also be piped through stdin, or typed interactively when the
message argument is empty (finish with Ctrl+D):
  echo "Should I use A or B?" | pi-intercom ask worker
  pi-intercom ask worker     # then type the message, press Ctrl+D

Data goes to stdout (session list, replies); status messages go to stderr.
`;

type Action = "list" | "status" | "send" | "ask";

interface CliArgs {
  action: Action;
  target?: string;
  message?: string;
  name: string;
  timeoutMs: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { action: "list", name: DEFAULT_CLI_NAME, timeoutMs: DEFAULT_ASK_TIMEOUT_MS, help: false };
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (positionalOnly) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--name") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--name requires a value");
      }
      args.name = value;
      continue;
    }
    if (arg === "--timeout") {
      const value = argv[++index];
      const seconds = Number(value);
      if (!value || !Number.isFinite(seconds) || seconds <= 0) {
        throw new Error("--timeout requires a positive number of seconds");
      }
      args.timeoutMs = Math.round(seconds * 1000);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  const [action, target, ...messageParts] = positionals;
  if (action !== undefined) {
    if (action !== "list" && action !== "status" && action !== "send" && action !== "ask") {
      throw new Error(`Unknown action: ${action}`);
    }
    args.action = action;
  }
  if ((args.action === "list" || args.action === "status") && (target !== undefined || messageParts.length > 0)) {
    throw new Error(`'${args.action}' takes no arguments`);
  }
  if (target !== undefined) {
    args.target = target;
  }
  const message = messageParts.join(" ");
  if (message) {
    args.message = message;
  }
  return args;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function buildGuestSession(name: string): Omit<SessionInfo, "id"> {
  const now = Date.now();
  return {
    name,
    cwd: process.cwd(),
    model: "pi-intercom-cli",
    pid: process.pid,
    startedAt: now,
    lastActivity: now,
    status: "cli",
  };
}

async function resolveTarget(client: IntercomClient, nameOrId: string): Promise<string> {
  const sessions = await client.listSessions();
  const byId = sessions.find(s => s.id === nameOrId);
  if (byId) {
    return byId.id;
  }

  const lowerName = nameOrId.toLowerCase();
  const byName = sessions.filter(s => s.name?.toLowerCase() === lowerName);
  if (byName.length > 1) {
    throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
  }
  if (byName.length === 1) {
    return byName[0].id;
  }

  throw new Error(`Session "${nameOrId}" not found. Use 'pi-intercom list' to see connected sessions.`);
}

interface ReplyWait {
  promise: Promise<Message>;
  cancel: (error: Error) => void;
}

function waitForReply(client: IntercomClient, from: string, replyTo: string, timeoutMs: number): ReplyWait {
  let rejectPromise: (error: Error) => void = () => undefined;
  let cleanup: () => void = () => undefined;

  const promise = new Promise<Message>((resolve, reject) => {
    rejectPromise = reject;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const onMessage = (sender: SessionInfo, message: Message) => {
      if (message.replyTo === replyTo && sender.id === from) {
        cleanup();
        resolve(message);
      }
    };
    cleanup = () => {
      clearTimeout(timeout);
      client.off("message", onMessage);
    };
    client.on("message", onMessage);
  });

  return {
    promise,
    cancel: (error) => {
      cleanup();
      rejectPromise(error);
    },
  };
}

function formatReply(message: Message): string {
  let text = message.content.text;
  for (const attachment of message.content.attachments ?? []) {
    text += `\n\n---\n📎 ${attachment.name}\n${attachment.language ? `~~~${attachment.language}\n${attachment.content}\n~~~` : attachment.content}`;
  }
  return text;
}

function formatSessionRow(session: SessionInfo): string {
  const status = session.status && session.status !== "idle" ? ` [${session.status}]` : "";
  return `${session.name ?? session.id}${status} (${session.id.slice(0, 8)}) (${session.model}) ${session.cwd}`;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`pi-intercom: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.action === "send" || args.action === "ask") {
    if (!args.message) {
      args.message = (await readStdin()).trim();
    }
    if (!args.target) {
      console.error(`pi-intercom: missing target for '${args.action}'`);
      console.error(USAGE);
      return 2;
    }
    if (!args.message || !args.message.trim()) {
      console.error(`pi-intercom: missing message for '${args.action}'`);
      console.error(USAGE);
      return 2;
    }
  }

  let client: IntercomClient | null = null;
  let interrupted = false;
  let activeWait: ReplyWait | null = null;
  const onInterrupt = () => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    activeWait?.cancel(new Error("Interrupted (Ctrl+C)"));
    client?.disconnect().catch(() => undefined);
  };
  process.on("SIGINT", onInterrupt);

  try {
    const config = loadConfig();
    if (!config.enabled) {
      throw new Error("Intercom is disabled in ~/.pi/agent/intercom/config.json");
    }
    await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);

    client = new IntercomClient();
    await client.connect(buildGuestSession(args.name), { guest: true });

    switch (args.action) {
      case "list": {
        const sessions = await client.listSessions();
        if (sessions.length === 0) {
          process.stdout.write("No intercom-connected pi sessions.\n");
          return 0;
        }
        process.stdout.write(`${sessions.map(formatSessionRow).join("\n")}\n`);
        return 0;
      }

      case "status": {
        const sessions = await client.listSessions();
        process.stdout.write(`Broker: connected\nSession ID: ${client.sessionId}\nActive sessions: ${sessions.length}\n`);
        return 0;
      }

      case "send": {
        const sendTo = await resolveTarget(client, args.target!);
        const result = await client.send(sendTo, { text: args.message! });
        if (!result.delivered) {
          throw new Error(`Message to "${args.target}" was not delivered: ${result.reason ?? "unknown reason"}`);
        }
        console.error(`Sent to ${args.target} (${sendTo.slice(0, 8)})`);
        return 0;
      }

      case "ask": {
        const sendTo = await resolveTarget(client, args.target!);
        const questionId = randomUUID();
        const wait = waitForReply(client, sendTo, questionId, args.timeoutMs);
        activeWait = wait;
        console.error(`Asking ${args.target} (${sendTo.slice(0, 8)})... waiting for reply (timeout ${Math.round(args.timeoutMs / 1000)}s)`);
        const result = await client.send(sendTo, { messageId: questionId, text: args.message!, expectsReply: true });
        if (!result.delivered) {
          wait.cancel(new Error(`Message to "${args.target}" was not delivered: ${result.reason ?? "unknown reason"}`));
        }
        const reply = await wait.promise;
        process.stdout.write(`${formatReply(reply)}\n`);
        return 0;
      }
    }
    // Unreachable: every action returns above. Kept for TS exhaustiveness.
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pi-intercom: ${message}`);
    return interrupted ? 130 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Best-effort: the process is exiting anyway.
      }
    }
  }
}

process.exitCode = await main();
