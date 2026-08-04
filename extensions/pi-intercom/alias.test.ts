import test from "node:test";
import assert from "node:assert/strict";
import {
  referencedSessionAliases,
  sessionAlias,
} from "./alias.ts";
import type { SessionInfo } from "./types.ts";

function session(id: string, name?: string): SessionInfo {
  return {
    id,
    ...(name ? { name } : {}),
    cwd: "/tmp",
    model: "test-model",
    pid: 1,
    startedAt: 0,
    lastActivity: 0,
  };
}

test("session aliases use the /name session name", () => {
  assert.equal(sessionAlias(session("abc", "worker")), "worker");
  assert.equal(sessionAlias(session("12345678")), "12345678");
});

test("referencedSessionAliases finds exact #alias markers", () => {
  const aliases = new Set(["worker", "Refactor auth module"]);
  assert.deepEqual(referencedSessionAliases("给 #worker 发消息：检查一下", aliases), ["worker"]);
  assert.deepEqual(referencedSessionAliases("问下 #Refactor auth module 一个问题", aliases), ["Refactor auth module"]);
  assert.deepEqual(referencedSessionAliases("修复 issue #42", aliases), []);
  assert.deepEqual(referencedSessionAliases("##worker", aliases), []);
});
