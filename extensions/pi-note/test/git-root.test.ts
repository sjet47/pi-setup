// Git-root resolution tests (SPEC §10 "路径解析").
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { memoryRootFor } from "../git-root.ts";
import { slugForCwd } from "../paths.ts";

// Hermetic git: ignore the machine's own global/system config, and set the
// identity inline so a missing user.email cannot fail the fixture commit.
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=test",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] },
	);
}

/** A real repo with one commit and one linked worktree beside it. */
function makeRepo(): { tmp: string; root: string; worktree: string } {
	const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-note-git-")));
	const root = join(tmp, "main");
	mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	git(root, "commit", "-q", "--allow-empty", "-m", "init");
	const worktree = join(tmp, "wt-canary");
	git(root, "worktree", "add", "-q", "-b", "canary", worktree);
	return { tmp, root, worktree };
}

test("main checkout and its linked worktree resolve to the same root", () => {
	const { tmp, root, worktree } = makeRepo();
	try {
		assert.equal(memoryRootFor(root), resolve(root));
		assert.equal(memoryRootFor(worktree), resolve(root));
		// The point of the whole exercise: one memory dir per repository.
		assert.equal(slugForCwd(memoryRootFor(worktree)), slugForCwd(root));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("a subdirectory of a worktree resolves to the main checkout", () => {
	const { tmp, root, worktree } = makeRepo();
	try {
		const nested = join(worktree, "internal", "deep");
		mkdirSync(nested, { recursive: true });
		// git prints a bare ".git" from a subdirectory; only --path-format=absolute
		// keeps this from resolving to a bogus path.
		assert.equal(memoryRootFor(nested), resolve(root));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("a cwd outside any repository keys on itself", () => {
	const plain = realpathSync(mkdtempSync(join(tmpdir(), "pi-note-norepo-")));
	try {
		assert.equal(memoryRootFor(plain), resolve(plain));
		assert.equal(memoryRootFor(join(plain, "missing")), resolve(join(plain, "missing")));
	} finally {
		rmSync(plain, { recursive: true, force: true });
	}
});

test("relative cwd is normalized before the git lookup", () => {
	const { tmp, root, worktree } = makeRepo();
	try {
		const rel = join(worktree, "sub", "..");
		mkdirSync(join(worktree, "sub"), { recursive: true });
		assert.equal(memoryRootFor(rel), resolve(root));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
