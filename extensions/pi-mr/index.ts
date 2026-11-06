// pi-mr: show the current branch's merge request (GitLab) or pull request
// (GitHub) in the bottom status line — the line pi appends below the footer.
//
//   ⬤ !1234 ✓CI 登录改造
//
// Data comes from `glab` on GitLab remotes and `gh` on GitHub remotes, so the
// CLIs' own auth is reused and no tokens live here. The branch is re-read every
// few seconds (one cheap `git rev-parse`) and the forge is queried when the
// branch changes or every 60s, which is what makes merged / CI state follow
// along. Anything unknown — no repo, no remote, no request, CLI failure —
// clears the line instead of showing stale data.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ciFromGitlabCommit,
	detectForge,
	GITHUB_PR_FIELDS,
	GITHUB_REPO_FIELDS,
	githubLogin,
	githubRemoteRepos,
	githubRepoInfo,
	gitlabApiPath,
	gitlabCommitPath,
	GITLAB_PROJECT_PATH,
	gitlabRepoInfo,
	normalizeGithub,
	normalizeGitlab,
	parseRemoteUrls,
	type CheckoutInfo,
	type Forge,
	type MrInfo,
	type RepoInfo,
} from "./forge.ts";
import { renderMrLine, type ColorRole } from "./format.ts";

/**
 * Footer status key. pi draws one status line with every `setStatus` entry, sorted
 * by key alphabetically, so the key doubles as a layout slot: `zzz-` keeps the MR
 * to the right of pi-execution-time's `zz-execution-time-total` (Σ runtime).
 */
const STATUS_KEY = "zzz-mr";
/** How often the branch is re-read, so a `git switch` shows up promptly. */
const BRANCH_POLL_MS = 5_000;
/** How long a fetched request stays fresh before being re-queried. */
const REFRESH_MS = 60_000;
/** Backoff after a failure (missing CLI, auth loss, network) or an unresolvable forge. */
const RETRY_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 5_000;
const CLI_TIMEOUT_MS = 20_000;

/** Facts about the checkout that a by-branch request lookup cannot carry. */
interface RepositoryFacts extends RepoInfo {
	/** `owner/name` of every GitHub remote, lowercased. */
	repos?: string[];
}

interface SessionState {
	ctx: ExtensionContext;
	cwd: string;
	forge?: Forge;
	forgeResolved: boolean;
	/** Branch the displayed request belongs to; undefined before the first lookup. */
	branch?: string;
	shown?: MrInfo;
	/** Repository-level facts for the request filters; empty when the probe failed. */
	repoInfo: RepositoryFacts;
	lastAttempt: number;
	nextAttempt: number;
	renderKey?: string;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export default function piMrExtension(pi: ExtensionAPI): void {
	let state: SessionState | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inflight = false;

	function stopTimer(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	async function readBranch(s: SessionState): Promise<string | undefined> {
		const res = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: s.cwd, timeout: GIT_TIMEOUT_MS });
		if (res.code !== 0) return undefined;
		const branch = res.stdout.trim();
		// Detached HEAD resolves to "HEAD"; there is no branch to look up.
		return branch === "" || branch === "HEAD" ? undefined : branch;
	}

	/**
	 * Probe the repository-level facts a by-branch lookup cannot express: the
	 * default branch, and on GitHub which repositories this checkout may push to.
	 * Best effort — an unanswered probe only costs the suppression rules, so the
	 * request itself is still shown.
	 */
	async function describeRepository(s: SessionState, forge: Forge, urls: string[]): Promise<RepositoryFacts> {
		try {
			if (forge === "gitlab") {
				const res = await pi.exec("glab", ["api", GITLAB_PROJECT_PATH], { cwd: s.cwd, timeout: CLI_TIMEOUT_MS });
				return res.code === 0 ? gitlabRepoInfo(parseJson(res.stdout)) : {};
			}
			const [repoRes, loginRes] = await Promise.all([
				pi.exec("gh", ["repo", "view", "--json", GITHUB_REPO_FIELDS], { cwd: s.cwd, timeout: CLI_TIMEOUT_MS }),
				// A local config read, so it costs a fork of the process rather than a
				// network round trip. The login is how an own-fork pull request is told
				// apart from a stranger's fork of the same branch name.
				pi.exec("gh", ["config", "get", "-h", "github.com", "user"], { cwd: s.cwd, timeout: GIT_TIMEOUT_MS }),
			]);
			return {
				repos: githubRemoteRepos(urls),
				...(repoRes.code === 0 ? githubRepoInfo(parseJson(repoRes.stdout)) : {}),
				...(loginRes.code === 0 ? { login: githubLogin(loginRes.stdout) } : {}),
			};
		} catch {
			// Missing CLI, logged-out host or no repository: keep the old behaviour.
			return { repos: githubRemoteRepos(urls) };
		}
	}

	async function resolveForge(s: SessionState): Promise<Forge | undefined> {
		if (s.forgeResolved) return s.forge;
		s.forgeResolved = true;
		let urls: string[] = [];
		try {
			const res = await pi.exec("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], {
				cwd: s.cwd,
				timeout: GIT_TIMEOUT_MS,
			});
			if (res.code === 0) {
				urls = parseRemoteUrls(res.stdout);
				s.forge = detectForge(urls);
			}
		} catch {
			// Not a git repo (or no git binary): nothing to show.
		}
		if (s.forge) s.repoInfo = await describeRepository(s, s.forge, urls);
		return s.forge;
	}

	async function queryForge(s: SessionState, forge: Forge, checkout: CheckoutInfo): Promise<MrInfo | undefined> {
		if (forge === "gitlab") {
			const res = await pi.exec("glab", ["api", gitlabApiPath(checkout.branch)], { cwd: s.cwd, timeout: CLI_TIMEOUT_MS });
			if (res.code !== 0) throw new Error(res.stderr.trim() || `glab exited ${res.code}`);
			const info = normalizeGitlab(parseJson(res.stdout), checkout);
			if (info && info.ci === "none" && info.sha) await fillGitlabCi(s, info);
			return info;
		}
		const res = await pi.exec(
			"gh",
			["pr", "list", "--head", checkout.branch, "--state", "all", "--limit", "5", "--json", GITHUB_PR_FIELDS],
			{ cwd: s.cwd, timeout: CLI_TIMEOUT_MS },
		);
		if (res.code !== 0) throw new Error(res.stderr.trim() || `gh exited ${res.code}`);
		return normalizeGithub(parseJson(res.stdout), checkout);
	}

	/**
	 * Fill in CI from the head commit when the request itself carries no pipeline
	 * (self-hosted GitLab leaves `head_pipeline` null). A failure here only costs
	 * the CI token, so the request is still shown.
	 */
	async function fillGitlabCi(s: SessionState, info: MrInfo): Promise<void> {
		try {
			const res = await pi.exec("glab", ["api", gitlabCommitPath(info.sha!)], { cwd: s.cwd, timeout: CLI_TIMEOUT_MS });
			if (res.code === 0) info.ci = ciFromGitlabCommit(parseJson(res.stdout));
		} catch {
			// Keep ci: "none"
		}
	}

	function render(s: SessionState): void {
		if (state !== s) return; // A newer session took over while this lookup ran.
		const ui = s.ctx.ui;
		const colorize = (role: ColorRole, text: string) => ui.theme.fg(role, text);
		const line = s.shown ? renderMrLine(s.shown, colorize) : undefined;
		// Theme colors are baked into the string, so a theme switch must re-render.
		const key = `${ui.theme.name ?? ""}\u0000${line ?? ""}`;
		if (key === s.renderKey) return;
		s.renderKey = key;
		try {
			ui.setStatus(STATUS_KEY, line);
		} catch {
			// UI torn down mid-flight; the next session_start resets everything.
		}
	}

	async function tick(s: SessionState): Promise<void> {
		if (inflight || state !== s) return;
		inflight = true;
		try {
			const branch = await readBranch(s);
			const now = Date.now();
			if (branch === undefined) {
				s.branch = undefined;
				s.shown = undefined;
				render(s);
				return;
			}
			const branchChanged = branch !== s.branch;
			if (!branchChanged && now < s.nextAttempt) return; // backing off
			if (!branchChanged && now - s.lastAttempt < REFRESH_MS) return;

			const forge = await resolveForge(s);
			s.lastAttempt = Date.now();
			if (!forge) {
				s.branch = branch;
				s.shown = undefined;
				s.nextAttempt = s.lastAttempt + RETRY_MS;
				render(s);
				return;
			}
			try {
				const checkout: CheckoutInfo = {
					branch,
					defaultBranch: s.repoInfo.defaultBranch,
					repos: s.repoInfo.repos,
					login: s.repoInfo.login,
				};
				const info = await queryForge(s, forge, checkout);
				s.branch = branch;
				s.shown = info;
				s.nextAttempt = 0;
			} catch {
				// Hide rather than show something stale or wrong.
				s.branch = branch;
				s.shown = undefined;
				s.nextAttempt = Date.now() + RETRY_MS;
			}
			render(s);
		} catch {
			// Never let a status line break the session.
		} finally {
			inflight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		stopTimer();
		inflight = false;
		if (!ctx.hasUI) {
			state = undefined;
			return;
		}
		const s: SessionState = { ctx, cwd: ctx.cwd, forgeResolved: false, repoInfo: {}, lastAttempt: 0, nextAttempt: 0 };
		state = s;
		timer = setInterval(() => void tick(s), BRANCH_POLL_MS);
		void tick(s);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		state = undefined;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// UI already disposed.
		}
	});
}
