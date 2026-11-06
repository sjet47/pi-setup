// Forge layer for pi-mr: everything here is pure (no I/O), so the branch/CLI
// plumbing in index.ts stays thin and the parsing is unit-testable.
//
// Two forges, one shape: `glab` for GitLab (any self-hosted instance the user
// logged into) and `gh` for GitHub. Both produce an `MrInfo`; the CLI JSON is
// never re-exported.

export type Forge = "gitlab" | "github";

/** Lifecycle of the request that belongs to the branch, as far as the UI cares. */
export type MrState = "opened" | "draft" | "merged" | "closed";

/** Normalized CI status of the request's head pipeline. */
export type CiState = "success" | "failed" | "running" | "none";

export interface MrInfo {
	forge: Forge;
	/** `!123` on GitLab, `#123` on GitHub. */
	ref: string;
	title: string;
	state: MrState;
	ci: CiState;
	/** Open request whose branch conflicts with the target branch. */
	conflicts: boolean;
	url: string;
	/** Head commit, used for a CI fallback when the request carries no pipeline. */
	sha?: string;
}

// ── remotes → forge ──────────────────────────────────────────────────────

/** Extract remote URLs from `git config --get-regexp '^remote\..*\.url$'`. */
export function parseRemoteUrls(configOutput: string): string[] {
	const urls: string[] = [];
	for (const line of configOutput.split("\n")) {
		const match = /^remote\.[^\s]+\.url[ \t]+(.+)$/.exec(line.trim());
		if (match) urls.push(match[1].trim());
	}
	return urls;
}

/** Host of a git remote URL, scp-like or URL form. */
export function remoteHost(url: string): string | undefined {
	const trimmed = url.trim();
	if (!trimmed.includes("://")) {
		// scp-like: git@git.example.com:group/repo.git
		const scp = /^(?:[^@/]+@)?([^:/]+):/.exec(trimmed);
		if (scp) return scp[1].toLowerCase();
		return undefined;
	}
	try {
		return new URL(trimmed).hostname.toLowerCase() || undefined;
	} catch {
		return undefined;
	}
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

function isGithubHost(host: string): boolean {
	return GITHUB_HOSTS.has(host) || host.endsWith(".ghe.com");
}

/**
 * Pick the forge for a repository from its remote URLs.
 *
 * Any non-GitHub host wins: `glab` supports arbitrary self-hosted instances, and
 * a repo that mirrors to GitHub (`origin`) while its merge requests live on a
 * corporate GitLab remote must resolve to `glab`. Only a repo whose remotes are
 * all GitHub resolves to `gh`.
 */
export function detectForge(urls: string[]): Forge | undefined {
	const hosts = urls.map(remoteHost).filter((host): host is string => !!host);
	if (hosts.some((host) => !isGithubHost(host))) return "gitlab";
	return hosts.some(isGithubHost) ? "github" : undefined;
}

// ── CLI invocations ──────────────────────────────────────────────────────

/**
 * `glab api` path for the project's merge requests on one source branch.
 *
 * The REST endpoint is used instead of `glab mr list` because the list output
 * omits `head_pipeline`, and `:fullpath` lets `glab` resolve the project from
 * whichever remote points at a GitLab instance it knows.
 */
export function gitlabApiPath(branch: string): string {
	const query = new URLSearchParams({
		state: "all",
		source_branch: branch,
		order_by: "updated_at",
		sort: "desc",
		per_page: "5",
	});
	return `projects/:fullpath/merge_requests?${query.toString()}`;
}

/** `gh pr list --json` fields. Keep in sync with `normalizeGithub`. */
export const GITHUB_PR_FIELDS = "number,title,state,isDraft,statusCheckRollup,url,headRepository";

/** `glab api` path for the project itself. Used for its default branch. */
export const GITLAB_PROJECT_PATH = "projects/:fullpath";

/** `gh repo view --json` fields. Keep in sync with `githubRepoInfo`. */
export const GITHUB_REPO_FIELDS = "nameWithOwner,defaultBranchRef";

/**
 * `glab api` path for one commit. Used as the CI fallback: self-hosted GitLab
 * instances (this one included) leave `head_pipeline` null on the request, while
 * the commit still reports its latest pipeline as `last_pipeline`.
 */
export function gitlabCommitPath(sha: string): string {
	return `projects/:fullpath/repository/commits/${encodeURIComponent(sha)}`;
}

// ── payloads → MrInfo ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * What the local checkout knows about itself. A by-branch lookup cannot express
 * the two repository-level facts needed to reject look-alike requests, so they
 * are probed once per working directory (see `gitlabRepoInfo`/`githubRepoInfo`).
 */
export interface CheckoutInfo {
	/** Branch HEAD is on. */
	branch: string;
	/** The repository's default branch, when the forge reports one. */
	defaultBranch?: string;
	/** `owner/name` of the GitHub repository the CLI resolves to. */
	repo?: string;
}

/** Repository-level facts; every field is absent when the probe failed. */
export interface RepoInfo {
	defaultBranch?: string;
	repo?: string;
}

/** `glab api projects/:fullpath` → the project's default branch. */
export function gitlabRepoInfo(payload: unknown): RepoInfo {
	if (!isRecord(payload)) return {};
	const branch = payload.default_branch;
	return typeof branch === "string" && branch !== "" ? { defaultBranch: branch } : {};
}

/** `gh repo view --json nameWithOwner,defaultBranchRef` → repo identity and default branch. */
export function githubRepoInfo(payload: unknown): RepoInfo {
	if (!isRecord(payload)) return {};
	const info: RepoInfo = {};
	if (typeof payload.nameWithOwner === "string" && payload.nameWithOwner !== "") {
		info.repo = payload.nameWithOwner;
	}
	const ref = isRecord(payload.defaultBranchRef) ? payload.defaultBranchRef : undefined;
	if (typeof ref?.name === "string" && ref.name !== "") info.defaultBranch = ref.name;
	return info;
}

/**
 * Choose the request to display: the newest open one, else the newest of any
 * state (the API returns `updated_at`-descending order). GitLab says `opened`,
 * GitHub says `OPEN`.
 */
function pickNewest(list: Record<string, unknown>[], stateKey: string): Record<string, unknown> | undefined {
	return list.find((item) => /^open(ed)?$/i.test(String(item[stateKey] ?? ""))) ?? list[0];
}

/**
 * Keep requests whose source is this repository. A fork that happens to use the
 * same branch name (`master` is a popular one) opens requests against this
 * project too, but its branch says nothing about this checkout.
 *
 * Unknown proves nothing: an old GitLab payload without the ids, or a PR whose
 * head repository was deleted with the fork, is kept.
 */
function fromThisGitlabProject(mr: Record<string, unknown>): boolean {
	const source = mr.source_project_id;
	const target = mr.target_project_id;
	if (typeof source !== "number" || typeof target !== "number") return true;
	return source === target;
}

function fromThisGithubRepo(pr: Record<string, unknown>, repo: string | undefined): boolean {
	if (repo === undefined) return true;
	const head = isRecord(pr.headRepository) ? pr.headRepository : undefined;
	const name = typeof head?.nameWithOwner === "string" ? head.nameWithOwner : undefined;
	if (name === undefined) return true;
	return name.toLowerCase() === repo.toLowerCase();
}

/**
 * Whether the picked request is history rather than the current work.
 *
 * On the default branch the branch *is* the release line: a `merged` request
 * whose source is `master` is an old sync (they happen), and a `closed` one is a
 * dead promotion — neither describes this checkout. Off the default branch a
 * merged request is exactly where the branch tip landed, so it stays visible.
 */
function hidesOnDefaultBranch(state: MrState, checkout: CheckoutInfo | undefined): boolean {
	if (checkout?.defaultBranch === undefined) return false;
	if (checkout.branch !== checkout.defaultBranch) return false;
	return state === "merged" || state === "closed";
}

export function normalizeGitlab(payload: unknown, checkout?: CheckoutInfo): MrInfo | undefined {
	if (!Array.isArray(payload)) return undefined;
	const list = payload.filter(isRecord).filter((item) => typeof item.iid === "number").filter(fromThisGitlabProject);
	if (list.length === 0) return undefined;
	const mr = pickNewest(list, "state");
	if (!mr) return undefined;

	const rawState = String(mr.state ?? "").toLowerCase();
	const state: MrState =
		rawState === "opened" ? (mr.draft === true ? "draft" : "opened") : rawState === "merged" ? "merged" : "closed";
	if (hidesOnDefaultBranch(state, checkout)) return undefined;
	const pipeline = isRecord(mr.head_pipeline) ? mr.head_pipeline : undefined;

	return {
		forge: "gitlab",
		ref: `!${mr.iid}`,
		title: typeof mr.title === "string" ? mr.title : "",
		state,
		ci: ciFromGitlab(pipeline?.status),
		conflicts: state === "opened" && mr.has_conflicts === true,
		url: typeof mr.web_url === "string" ? mr.web_url : "",
		sha: typeof mr.sha === "string" && mr.sha ? mr.sha : undefined,
	};
}

/** GitLab pipeline status → CI state. `manual` still waits on a human. */
export function ciFromGitlab(status: unknown): CiState {
	switch (typeof status === "string" ? status.toLowerCase() : "") {
		case "success":
			return "success";
		case "failed":
		case "canceled":
		case "cancelled":
			return "failed";
		case "created":
		case "preparing":
		case "waiting_for_resource":
		case "pending":
		case "running":
		case "scheduled":
		case "manual":
			return "running";
		default:
			return "none";
	}
}

/**
 * CI state from `GET /repository/commits/:sha`, the fallback when the request
 * has no head pipeline. `last_pipeline` is the newest pipeline for that commit;
 * `status` is the commit's combined status when only external statuses exist.
 */
export function ciFromGitlabCommit(payload: unknown): CiState {
	if (!isRecord(payload)) return "none";
	const pipeline = isRecord(payload.last_pipeline) ? payload.last_pipeline : undefined;
	return ciFromGitlab(pipeline ? pipeline.status : payload.status);
}

export function normalizeGithub(payload: unknown, checkout?: CheckoutInfo): MrInfo | undefined {
	if (!Array.isArray(payload)) return undefined;
	const list = payload
		.filter(isRecord)
		.filter((item) => typeof item.number === "number")
		.filter((item) => fromThisGithubRepo(item, checkout?.repo));
	if (list.length === 0) return undefined;
	const pr = pickNewest(list, "state");
	if (!pr) return undefined;

	const rawState = String(pr.state ?? "").toUpperCase();
	const state: MrState =
		rawState === "OPEN" ? (pr.isDraft === true ? "draft" : "opened") : rawState === "MERGED" ? "merged" : "closed";
	if (hidesOnDefaultBranch(state, checkout)) return undefined;

	return {
		forge: "github",
		ref: `#${pr.number}`,
		title: typeof pr.title === "string" ? pr.title : "",
		state,
		ci: ciFromGithub(pr.statusCheckRollup),
		conflicts: false,
		url: typeof pr.url === "string" ? pr.url : "",
	};
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

/** `statusCheckRollup` (CheckRun + StatusContext mix) → CI state. */
export function ciFromGithub(rollup: unknown): CiState {
	if (!Array.isArray(rollup) || rollup.length === 0) return "none";
	let pending = false;
	for (const check of rollup) {
		if (!isRecord(check)) continue;
		// CheckRun: `conclusion` once finished; StatusContext: `state`.
		const verdict = String(check.conclusion ?? check.state ?? "").toUpperCase();
		if (FAILED_CONCLUSIONS.has(verdict)) return "failed";
		if (verdict === "SUCCESS" || verdict === "NEUTRAL" || verdict === "SKIPPED" || verdict === "PASS") continue;
		// Queued / in progress / pending / no verdict yet.
		pending = true;
	}
	return pending ? "running" : "success";
}
