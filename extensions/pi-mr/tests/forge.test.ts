// Pure-logic tests for pi-mr's forge layer (no I/O, no pi runtime).
// Run: npm run test:mr
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ciFromGithub,
	ciFromGitlab,
	detectForge,
	gitlabApiPath,
	gitlabCommitPath,
	ciFromGitlabCommit,
	normalizeGithub,
	normalizeGitlab,
	parseRemoteUrls,
	remoteHost,
} from "../forge.ts";

test("parseRemoteUrls: reads every remote url, ignores other config lines", () => {
	const config = [
		"remote.origin.url git@github.com:sjet47/pi-setup.git",
		"remote.glab.url\thttps://git.maxjia.com/sunlinhao/rcman.git",
		"",
	].join("\n");
	assert.deepEqual(parseRemoteUrls(config), [
		"git@github.com:sjet47/pi-setup.git",
		"https://git.maxjia.com/sunlinhao/rcman.git",
	]);
	assert.deepEqual(parseRemoteUrls(""), []);
});

test("remoteHost: handles scp-like, https and ssh URLs", () => {
	assert.equal(remoteHost("git@github.com:sjet47/pi-setup.git"), "github.com");
	assert.equal(remoteHost("https://github.com/sjet47/pi-setup.git"), "github.com");
	assert.equal(remoteHost("ssh://git@git.maxjia.com:2222/sunlinhao/rcman.git"), "git.maxjia.com");
	assert.equal(remoteHost("git://git.example.com/x.git"), "git.example.com");
	assert.equal(remoteHost("not a url"), undefined);
});

test("detectForge: self-hosted GitLab wins over a GitHub mirror", () => {
	assert.equal(detectForge(["git@github.com:sjet47/rcman.git", "git@git.maxjia.com:sunlinhao/rcman.git"]), "gitlab");
	assert.equal(detectForge(["git@github.com:sjet47/pi-setup.git"]), "github");
	assert.equal(detectForge(["https://github.com/sjet47/pi-setup.git"]), "github");
	assert.equal(detectForge(["git@ghe.corp.ghe.com:team/app.git"]), "github");
	assert.equal(detectForge([]), undefined);
	assert.equal(detectForge(["https://gitlab.com/group/app.git"]), "gitlab");
});

test("gitlabApiPath: encodes branch and asks for every state", () => {
	const path = gitlabApiPath("feat/auth login");
	assert.ok(path.startsWith("projects/:fullpath/merge_requests?"));
	const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
	assert.equal(query.get("source_branch"), "feat/auth login");
	assert.equal(query.get("state"), "all");
	assert.equal(query.get("sort"), "desc");
});

function gitlabMr(overrides: Record<string, unknown> = {}) {
	return {
		iid: 1234,
		title: "登录改造",
		state: "opened",
		draft: false,
		web_url: "https://git.maxjia.com/sunlinhao/rcman/-/merge_requests/1234",
		has_conflicts: false,
		head_pipeline: { status: "success" },
		...overrides,
	};
}

test("normalizeGitlab: open request with pipeline becomes the line's data", () => {
	const info = normalizeGitlab([gitlabMr()]);
	assert.deepEqual(info, {
		forge: "gitlab",
		ref: "!1234",
		title: "登录改造",
		state: "opened",
		ci: "success",
		conflicts: false,
		url: "https://git.maxjia.com/sunlinhao/rcman/-/merge_requests/1234",
		sha: undefined,
	});
});

test("normalizeGitlab: draft, merged, closed and conflicts", () => {
	assert.equal(normalizeGitlab([gitlabMr({ draft: true })])?.state, "draft");
	assert.equal(normalizeGitlab([gitlabMr({ state: "merged" })])?.state, "merged");
	assert.equal(normalizeGitlab([gitlabMr({ state: "closed" })])?.state, "closed");
	assert.equal(normalizeGitlab([gitlabMr({ state: "locked" })])?.state, "closed");
	assert.equal(normalizeGitlab([gitlabMr({ has_conflicts: true })])?.conflicts, true);
	// A merged request's conflict flag is stale noise.
	assert.equal(normalizeGitlab([gitlabMr({ state: "merged", has_conflicts: true })])?.conflicts, false);
});

test("normalizeGitlab: prefers the newest open request over newer merged ones", () => {
	const info = normalizeGitlab([
		gitlabMr({ iid: 9, state: "merged" }),
		gitlabMr({ iid: 8, state: "opened", title: "open one" }),
		gitlabMr({ iid: 7, state: "closed" }),
	]);
	assert.equal(info?.ref, "!8");
	assert.equal(info?.title, "open one");
});

test("normalizeGitlab: tolerates junk", () => {
	assert.equal(normalizeGitlab(undefined), undefined);
	assert.equal(normalizeGitlab({ error: "nope" }), undefined);
	assert.equal(normalizeGitlab([]), undefined);
	assert.equal(normalizeGitlab([{ iid: "not a number" }]), undefined);
	const bare = normalizeGitlab([{ iid: 5 }]);
	assert.equal(bare?.ci, "none");
	assert.equal(bare?.state, "closed");
	assert.equal(bare?.url, "");
});

test("ciFromGitlab: maps pipeline statuses", () => {
	const cases: Array<[unknown, string]> = [
		["success", "success"],
		["failed", "failed"],
		["canceled", "failed"],
		["running", "running"],
		["pending", "running"],
		["manual", "running"],
		["skipped", "none"],
		[null, "none"],
		[undefined, "none"],
	];
	for (const [status, expected] of cases) {
		assert.equal(ciFromGitlab(status), expected, `status=${String(status)}`);
	}
});

function githubPr(overrides: Record<string, unknown> = {}) {
	return {
		number: 42,
		title: "Add login flow",
		state: "OPEN",
		isDraft: false,
		url: "https://github.com/sjet47/pi-setup/pull/42",
		statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
		...overrides,
	};
}

test("normalizeGithub: open pull request with green checks", () => {
	const info = normalizeGithub([githubPr()]);
	assert.deepEqual(info, {
		forge: "github",
		ref: "#42",
		title: "Add login flow",
		state: "opened",
		ci: "success",
		conflicts: false,
		url: "https://github.com/sjet47/pi-setup/pull/42",
	});
});

test("normalizeGithub: draft/merged/closed and open-first selection", () => {
	assert.equal(normalizeGithub([githubPr({ isDraft: true })])?.state, "draft");
	assert.equal(normalizeGithub([githubPr({ state: "MERGED" })])?.state, "merged");
	assert.equal(normalizeGithub([githubPr({ state: "CLOSED" })])?.state, "closed");
	assert.equal(
		normalizeGithub([githubPr({ number: 41, state: "MERGED" }), githubPr({ number: 40, state: "OPEN" })])?.ref,
		"#40",
	);
	assert.equal(normalizeGithub([{ number: "nope" }]), undefined);
});

test("ciFromGithub: rollup verdicts", () => {
	assert.equal(ciFromGithub([]), "none");
	assert.equal(ciFromGithub(undefined), "none");
	assert.equal(ciFromGithub([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]), "success");
	assert.equal(ciFromGithub([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), "failed");
	assert.equal(ciFromGithub([{ state: "ERROR" }]), "failed");
	assert.equal(ciFromGithub([{ status: "IN_PROGRESS", conclusion: null }]), "running");
	assert.equal(ciFromGithub([{ __typename: "StatusContext", state: "PENDING" }]), "running");
	assert.equal(ciFromGithub([{ conclusion: "SUCCESS" }, { status: "QUEUED" }]), "running");
});

test("gitlabCommitPath: encodes the head sha", () => {
	assert.equal(
		gitlabCommitPath("28f3ad89831d43d03c852a98b7db633dea4e9138"),
		"projects/:fullpath/repository/commits/28f3ad89831d43d03c852a98b7db633dea4e9138",
	);
});

test("ciFromGitlabCommit: prefers last_pipeline, falls back to commit status", () => {
	assert.equal(ciFromGitlabCommit({ last_pipeline: { status: "running" } }), "running");
	assert.equal(ciFromGitlabCommit({ last_pipeline: { status: "failed" }, status: "failed" }), "failed");
	// Self-hosted GitLab reports pipelines on the commit, not on the request.
	assert.equal(ciFromGitlabCommit({ last_pipeline: null, status: "success" }), "success");
	assert.equal(ciFromGitlabCommit({ last_pipeline: null, status: null }), "none");
	assert.equal(ciFromGitlabCommit(undefined), "none");
});

test("normalizeGitlab: carries the head sha for the CI fallback", () => {
	assert.equal(normalizeGitlab([gitlabMr({ sha: "abc123" })])?.sha, "abc123");
	assert.equal(normalizeGitlab([gitlabMr({ sha: "" })])?.sha, undefined);
});
