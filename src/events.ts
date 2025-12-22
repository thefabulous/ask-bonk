import type {
	IssueCommentEvent,
	IssuesEvent,
	PullRequestReviewCommentEvent,
	PullRequestReviewEvent,
} from "@octokit/webhooks-types";
import { DEFAULT_MODEL, type Env, type EventContext, type ReviewCommentContext, type ScheduledEventContext, type WorkflowDispatchContext, type ScheduleEventPayload, type WorkflowDispatchPayload } from "./types";

const BOT_MENTION = "@ask-bonk";
const BOT_COMMAND = "/bonk";
const MENTION_PATTERN = new RegExp(`(?:^|\\s)(?:${BOT_MENTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${BOT_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|\\s)`);

export function hasMention(body: string): boolean {
	return MENTION_PATTERN.test(body.trim());
}

export function extractPrompt(body: string, reviewContext?: ReviewCommentContext): string {
	const trimmed = body.trim();

	if (trimmed === BOT_MENTION || trimmed === BOT_COMMAND) {
		if (reviewContext) {
			return `Review this code change and suggest improvements for the commented lines:\n\nFile: ${reviewContext.file}\nLines: ${reviewContext.line}\n\n${reviewContext.diffHunk}`;
		}
		return "Summarize this thread";
	}

	if (reviewContext) {
		return `${trimmed}\n\nContext: You are reviewing a comment on file "${reviewContext.file}" at line ${reviewContext.line}.\n\nDiff context:\n${reviewContext.diffHunk}`;
	}

	return trimmed;
}

export function getReviewCommentContext(
	payload: PullRequestReviewCommentEvent
): ReviewCommentContext {
	return {
		file: payload.comment.path,
		diffHunk: payload.comment.diff_hunk,
		line: payload.comment.line ?? null,
		originalLine: payload.comment.original_line ?? null,
		position: payload.comment.position ?? null,
		commitId: payload.comment.commit_id,
		originalCommitId: payload.comment.original_commit_id,
	};
}

export function isForkPR(payload: IssueCommentEvent | PullRequestReviewCommentEvent | PullRequestReviewEvent): boolean {
	if ("pull_request" in payload && payload.pull_request) {
		const pr = payload.pull_request;
		if ("head" in pr && "base" in pr) {
			const head = pr.head as { repo?: { full_name?: string } };
			const base = pr.base as { repo?: { full_name?: string } };
			return head.repo?.full_name !== base.repo?.full_name;
		}
	}
	return false;
}

export function parseIssueCommentEvent(payload: IssueCommentEvent): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
} | null {
	if (payload.action !== "created") {
		return null;
	}

	if (!hasMention(payload.comment.body)) {
		return null;
	}

	const isPullRequest = Boolean(payload.issue.pull_request);

	return {
		context: {
			owner: payload.repository.owner.login,
			repo: payload.repository.name,
			issueNumber: payload.issue.number,
			commentId: 0, // Will be set after creating response comment
			actor: payload.comment.user.login,
			isPullRequest,
			isPrivate: payload.repository.private,
			defaultBranch: payload.repository.default_branch,
		},
		prompt: extractPrompt(payload.comment.body),
		triggerCommentId: payload.comment.id,
	};
}

export function parsePRReviewCommentEvent(payload: PullRequestReviewCommentEvent): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
	reviewContext: ReviewCommentContext;
} | null {
	if (payload.action !== "created") {
		return null;
	}

	if (!hasMention(payload.comment.body)) {
		return null;
	}

	if (isForkPR(payload)) {
		return null;
	}

	const reviewContext = getReviewCommentContext(payload);

	return {
		context: {
			owner: payload.repository.owner.login,
			repo: payload.repository.name,
			issueNumber: payload.pull_request.number,
			commentId: 0,
			actor: payload.comment.user.login,
			isPullRequest: true,
			isPrivate: payload.repository.private,
			defaultBranch: payload.repository.default_branch,
			headBranch: payload.pull_request.head.ref,
			headSha: payload.pull_request.head.sha,
			isFork: false,
		},
		prompt: extractPrompt(payload.comment.body, reviewContext),
		triggerCommentId: payload.comment.id,
		reviewContext,
	};
}

export function parsePRReviewEvent(payload: PullRequestReviewEvent): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
} | null {
	if (payload.action !== "submitted") {
		return null;
	}

	if (!payload.review.body || !hasMention(payload.review.body)) {
		return null;
	}

	if (isForkPR(payload)) {
		return null;
	}

	return {
		context: {
			owner: payload.repository.owner.login,
			repo: payload.repository.name,
			issueNumber: payload.pull_request.number,
			commentId: 0,
			actor: payload.review.user.login,
			isPullRequest: true,
			isPrivate: payload.repository.private,
			defaultBranch: payload.repository.default_branch,
			headBranch: payload.pull_request.head.ref,
			headSha: payload.pull_request.head.sha,
			isFork: false,
		},
		prompt: extractPrompt(payload.review.body),
		triggerCommentId: payload.review.id,
	};
}

// Parse issues events - supports 'opened' and 'edited' actions.
// - opened: Always processed
// - edited: Only processed if the body changed significantly (threshold %+) OR contains a mention
// Other actions (deleted, labeled, etc.) are explicitly rejected.
export function parseIssuesEvent(
	payload: IssuesEvent,
	editedThresholdPc = 20
): {
	context: Omit<EventContext, "env">;
	issueTitle: string;
	issueBody: string;
	issueAuthor: string;
} | null {
	if (payload.action === "opened") {
		return {
			context: {
				owner: payload.repository.owner.login,
				repo: payload.repository.name,
				issueNumber: payload.issue.number,
				commentId: 0,
				actor: payload.issue.user.login,
				isPullRequest: false,
				isPrivate: payload.repository.private,
				defaultBranch: payload.repository.default_branch,
			},
			issueTitle: payload.issue.title,
			issueBody: payload.issue.body ?? "",
			issueAuthor: payload.issue.user.login,
		};
	}

	if (payload.action === "edited") {
		const newBody = payload.issue.body ?? "";
		
		// Note: hasMention check removed - workflows already filter for /bonk mentions
		// Check if body changed significantly (threshold %+)
		// payload.changes.body.from contains the previous body
		const changes = payload.changes as { body?: { from: string } } | undefined;
		const oldBody = changes?.body?.from;
		
		if (!hasSignificantChange(oldBody, newBody, editedThresholdPc)) {
			console.log(`issues:edited body change below ${editedThresholdPc}% threshold - ignoring`);
			return null;
		}

		return {
			context: {
				owner: payload.repository.owner.login,
				repo: payload.repository.name,
				issueNumber: payload.issue.number,
				commentId: 0,
				actor: payload.sender.login,
				isPullRequest: false,
				isPrivate: payload.repository.private,
				defaultBranch: payload.repository.default_branch,
			},
			issueTitle: payload.issue.title,
			issueBody: newBody,
			issueAuthor: payload.issue.user.login,
		};
	}

	console.log(`Unsupported issues event action: ${payload.action}`);
	return null;
}

export function getModel(env: Env): { providerID: string; modelID: string } {
	const model = env.DEFAULT_MODEL ?? DEFAULT_MODEL;
	const [providerID, ...rest] = model.split("/");
	const modelID = rest.join("/");

	if (!providerID?.length || !modelID.length) {
		throw new Error(
			`Invalid model ${model}. Model must be in the format "provider/model".`
		);
	}

	return { providerID, modelID };
}

export function formatResponse(
	response: string,
	changedFiles: string[] | null,
	sessionLink: string | null,
	model: string
): string {
	const parts: string[] = [response];

	if (changedFiles && changedFiles.length > 0) {
		parts.push("");
		parts.push("<details>");
		parts.push("<summary>Files changed</summary>");
		parts.push("");
		for (const file of changedFiles) {
			parts.push(`- \`${file}\``);
		}
		parts.push("");
		parts.push("</details>");
	}

	parts.push("");
	parts.push("---");

	const footerParts: string[] = [];
	if (sessionLink) {
		footerParts.push(`[View session](${sessionLink})`);
	}
	footerParts.push(`\`${model}\``);

	parts.push(footerParts.join(" | "));

	return parts.join("\n");
}

export function generateBranchName(type: "issue" | "pr", issueNumber: number): string {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:-]/g, "")
		.replace(/\.\d{3}Z/, "")
		.split("T")
		.join("");
	return `bonk/${type}${issueNumber}-${timestamp}`;
}

/**
 * Calculate word-based change percentage between two strings.
 * Returns 0-100 representing how much the content changed.
 */
export function calculateChangePercent(oldText: string, newText: string): number {
	const tokenize = (text: string): string[] =>
		text.toLowerCase().split(/\s+/).filter(Boolean);

	const oldWords = tokenize(oldText);
	const newWords = tokenize(newText);

	if (oldWords.length === 0 && newWords.length === 0) return 0;
	if (oldWords.length === 0 || newWords.length === 0) return 100;

	// Count word frequencies
	const oldFreq = new Map<string, number>();
	for (const word of oldWords) {
		oldFreq.set(word, (oldFreq.get(word) ?? 0) + 1);
	}

	const newFreq = new Map<string, number>();
	for (const word of newWords) {
		newFreq.set(word, (newFreq.get(word) ?? 0) + 1);
	}

	// Calculate words in common (using minimum of frequencies)
	let commonWords = 0;
	for (const [word, count] of oldFreq) {
		commonWords += Math.min(count, newFreq.get(word) ?? 0);
	}

	// Change percentage based on average of both texts
	const avgLength = (oldWords.length + newWords.length) / 2;
	const changePercent = ((avgLength - commonWords) / avgLength) * 100;

	return Math.round(Math.min(100, Math.max(0, changePercent)));
}

/**
 * Check if issue edit exceeds a word-change threshold.
 * For issues:edited payloads, compares changes.body.from with issue.body.
 */
export function hasSignificantChange(
	oldBody: string | undefined,
	newBody: string | undefined,
	thresholdPercent = 20
): boolean {
	if (!oldBody || !newBody) return true; // Treat missing as significant
	return calculateChangePercent(oldBody, newBody) >= thresholdPercent;
}

export function parseScheduleEvent(payload: ScheduleEventPayload): ScheduledEventContext | null {
	if (!payload.schedule || !payload.repository) {
		return null;
	}

	return {
		owner: payload.repository.owner.login,
		repo: payload.repository.name,
		isPrivate: payload.repository.private,
		defaultBranch: payload.repository.default_branch,
		schedule: payload.schedule,
		workflow: payload.workflow ?? null,
	};
}

export function parseWorkflowDispatchEvent(payload: WorkflowDispatchPayload): WorkflowDispatchContext | null {
	if (!payload.repository || !payload.ref) {
		return null;
	}

	return {
		owner: payload.repository.owner.login,
		repo: payload.repository.name,
		isPrivate: payload.repository.private,
		defaultBranch: payload.repository.default_branch,
		ref: payload.ref,
		sender: payload.sender.login,
		inputs: payload.inputs ?? {},
		workflow: payload.workflow ?? null,
	};
}
