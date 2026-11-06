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
	githubLogin,
	githubRemoteRepos,
	githubRepoInfo,
	gitlabRepoInfo,
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

test("gitlabRepoInfo: the project's default branch, or nothing", () => {
	assert.deepEqual(gitlabRepoInfo({ default_branch: "master" }), { defaultBranch: "master" });
	assert.deepEqual(gitlabRepoInfo({ default_branch: "" }), {});
	assert.deepEqual(gitlabRepoInfo({ default_branch: null }), {});
	assert.deepEqual(gitlabRepoInfo(undefined), {});
});

test("githubRemoteRepos: owner/name of every GitHub remote, lowercased and deduplicated", () => {
	assert.deepEqual(
		githubRemoteRepos([
			"git@github.com:HDT3213/rdb.git",
			"https://github.com/sjet47/rdb.git",
			"ssh://git@github.com/sjet47/rdb",
			"git@git.maxjia.com:sunlinhao/rcman.git",
			"git@github.com:HDT3213/RDB.git",
		]),
		["hdt3213/rdb", "sjet47/rdb"],
	);
	assert.deepEqual(githubRemoteRepos([]), []);
	assert.deepEqual(githubRemoteRepos(["not a url"]), []);
	// A trailing slash and an uppercase owner are still the same repository.
	assert.deepEqual(githubRemoteRepos(["https://github.com/Sjet47/Pi-Setup/"]), ["sjet47/pi-setup"]);
});

test("githubLogin: the recorded login, trimmed and lowercased", () => {
	assert.equal(githubLogin("sjet47\n"), "sjet47");
	assert.equal(githubLogin("  Sjet47  "), "sjet47");
	assert.equal(githubLogin(""), undefined);
	assert.equal(githubLogin("  \n"), undefined);
});

test("githubRepoInfo: the default branch of the repository gh resolved", () => {
	assert.deepEqual(githubRepoInfo({ nameWithOwner: "V4bel/dirtyfrag", defaultBranchRef: { name: "master" } }), {
		defaultBranch: "master",
	});
	assert.deepEqual(githubRepoInfo({ nameWithOwner: "V4bel/dirtyfrag", defaultBranchRef: null }), {});
	assert.deepEqual(githubRepoInfo({ defaultBranchRef: "" }), {});
	assert.deepEqual(githubRepoInfo(null), {});
});

test("normalizeGitlab: a merged request on the default branch is history, not the branch's work", () => {
	const onDefault = { branch: "master", defaultBranch: "master" };
	assert.equal(normalizeGitlab([gitlabMr({ state: "merged" })], onDefault), undefined);
	assert.equal(normalizeGitlab([gitlabMr({ state: "closed" })], onDefault), undefined);
	// An open request on the default branch still belongs to it.
	assert.equal(normalizeGitlab([gitlabMr()], onDefault)?.ref, "!1234");
	// Off the default branch a merged request is where the branch tip landed.
	const feature = { branch: "slh/feat/upgrade-skillhub-v0.2.22", defaultBranch: "master" };
	assert.equal(normalizeGitlab([gitlabMr({ state: "merged" })], feature)?.state, "merged");
	// Unknown default branch, or no checkout at all: old behaviour.
	assert.equal(normalizeGitlab([gitlabMr({ state: "merged" })], { branch: "master" })?.state, "merged");
	assert.equal(normalizeGitlab([gitlabMr({ state: "merged" })])?.state, "merged");
});

test("normalizeGitlab: drops merge requests whose source is another project", () => {
	const own = (overrides: Record<string, unknown> = {}) => gitlabMr({ source_project_id: 1, target_project_id: 1, ...overrides });
	// A fork's open request is newer, but it says nothing about this checkout.
	const fork = own({ iid: 1695, source_project_id: 2, title: "fork" });
	assert.equal(normalizeGitlab([fork, own({ iid: 1694, state: "merged" })], { branch: "master" })?.ref, "!1694");
	assert.equal(normalizeGitlab([fork], { branch: "master" }), undefined);
	// Missing ids prove nothing (old payloads, deleted forks): keep the request.
	assert.equal(normalizeGitlab([gitlabMr({ state: "merged" })], { branch: "master" })?.ref, "!1234");
	assert.equal(normalizeGitlab([gitlabMr({ source_project_id: "1", target_project_id: 1 })])?.ref, "!1234");
});

test("normalizeGithub: keeps this checkout's own remotes and own forks, drops strangers", () => {
	const pr = (number: number, nameWithOwner: unknown) => githubPr({ number, headRepository: { nameWithOwner } });
	// A stranger's fork of a popular project merely shares the branch name.
	assert.equal(normalizeGithub([pr(80, "Bode512/dirtyfrag")], { branch: "master", repos: ["v4bel/dirtyfrag"] }), undefined);
	// One of the checkout's remotes: pushes go there, so the branch is this one.
	assert.equal(normalizeGithub([pr(80, "V4bel/dirtyfrag")], { branch: "master", repos: ["v4bel/dirtyfrag"] })?.ref, "#80");
	assert.equal(normalizeGithub([pr(80, "v4bel/DIRTYFRAG")], { branch: "master", repos: ["v4bel/dirtyfrag"] })?.ref, "#80");
	// The signed-in user's own fork, even when the checkout has no remote for it:
	// contributing from a fork is the normal way to open a pull request upstream.
	assert.equal(normalizeGithub([pr(61, "sjet47/rdb")], { branch: "feat/x", repos: ["hdt3213/rdb"], login: "sjet47" })?.ref, "#61");
	// rdb's real shape: upstream `origin` plus the user's fork as `pr`, #61 merged.
	assert.equal(
		normalizeGithub([pr(61, "sjet47/rdb")], { branch: "feat/support-opcode-slot-info", repos: ["hdt3213/rdb", "sjet47/rdb"], login: "sjet47" })?.ref,
		"#61",
	);
	// Unknown proves nothing: an unanswered probe keeps every request.
	assert.equal(normalizeGithub([pr(80, "Bode512/dirtyfrag")], { branch: "master" })?.ref, "#80");
	assert.equal(normalizeGithub([pr(80, "Bode512/dirtyfrag")], { branch: "master", repos: [] })?.ref, "#80");
	assert.equal(normalizeGithub([pr(80, "Bode512/dirtyfrag")])?.ref, "#80");
	// A deleted fork leaves no head repository: keep the request.
	assert.equal(normalizeGithub([githubPr({ number: 80, headRepository: null })], { branch: "master", login: "sjet47" })?.ref, "#80");
	assert.equal(normalizeGithub([githubPr({ number: 80 })], { branch: "master", repos: ["v4bel/dirtyfrag"] })?.ref, "#80");
});

test("normalizeGithub: hides merged/closed only on the default branch", () => {
	const onDefault = { branch: "main", defaultBranch: "main" };
	assert.equal(normalizeGithub([githubPr({ state: "MERGED" })], onDefault), undefined);
	assert.equal(normalizeGithub([githubPr({ state: "CLOSED" })], onDefault), undefined);
	assert.equal(normalizeGithub([githubPr()], onDefault)?.state, "opened");
	assert.equal(normalizeGithub([githubPr({ state: "MERGED" })], { branch: "feat/x", defaultBranch: "main" })?.state, "merged");
	assert.equal(normalizeGithub([githubPr({ state: "MERGED" })], { branch: "main" })?.state, "merged");
});
