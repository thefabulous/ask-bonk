import type {
	IssueCommentEvent,
	PullRequestReviewCommentEvent,
	PullRequestReviewEvent,
} from "@octokit/webhooks-types";
import type { Env, EventContext, ReviewCommentContext } from "./types";

// Configurable mention patterns
function getMentionPattern(env: Env): RegExp {
	const mention = env.BOT_MENTION ?? "@ask-bonk";
	const command = env.BOT_COMMAND ?? "/bonk";
	// Escape special regex characters in the mention/command
	const escapedMention = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|\\s)(?:${escapedMention}|${escapedCommand})(?=$|\\s)`);
}

// Check if a comment body contains a mention
export function hasMention(body: string, env: Env): boolean {
	return getMentionPattern(env).test(body.trim());
}

// Extract the prompt from comment body (everything after the mention)
export function extractPrompt(
	body: string,
	env: Env,
	reviewContext?: ReviewCommentContext
): string {
	const mention = env.BOT_MENTION ?? "@ask-bonk";
	const command = env.BOT_COMMAND ?? "/bonk";
	const trimmed = body.trim();

	// If body is just the mention/command, provide default behavior
	if (trimmed === mention || trimmed === command) {
		if (reviewContext) {
			return `Review this code change and suggest improvements for the commented lines:\n\nFile: ${reviewContext.file}\nLines: ${reviewContext.line}\n\n${reviewContext.diffHunk}`;
		}
		return "Summarize this thread";
	}

	// Include review context if available
	if (reviewContext) {
		return `${trimmed}\n\nContext: You are reviewing a comment on file "${reviewContext.file}" at line ${reviewContext.line}.\n\nDiff context:\n${reviewContext.diffHunk}`;
	}

	return trimmed;
}

// Extract review comment context from PR review comment event
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

// Check if PR is from a fork
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

// Parse issue_comment event
export function parseIssueCommentEvent(
	payload: IssueCommentEvent,
	env: Env
): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
} | null {
	// Only handle created comments
	if (payload.action !== "created") {
		return null;
	}

	// Check for mention
	if (!hasMention(payload.comment.body, env)) {
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
		prompt: extractPrompt(payload.comment.body, env),
		triggerCommentId: payload.comment.id,
	};
}

// Parse pull_request_review_comment event
export function parsePRReviewCommentEvent(
	payload: PullRequestReviewCommentEvent,
	env: Env
): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
	reviewContext: ReviewCommentContext;
} | null {
	// Only handle created comments
	if (payload.action !== "created") {
		return null;
	}

	// Check for mention
	if (!hasMention(payload.comment.body, env)) {
		return null;
	}

	// Check for fork PR
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
		prompt: extractPrompt(payload.comment.body, env, reviewContext),
		triggerCommentId: payload.comment.id,
		reviewContext,
	};
}

// Parse pull_request_review event
export function parsePRReviewEvent(
	payload: PullRequestReviewEvent,
	env: Env
): {
	context: Omit<EventContext, "env">;
	prompt: string;
	triggerCommentId: number;
} | null {
	// Only handle submitted reviews
	if (payload.action !== "submitted") {
		return null;
	}

	// Check for mention in review body
	if (!payload.review.body || !hasMention(payload.review.body, env)) {
		return null;
	}

	// Check for fork PR
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
		prompt: extractPrompt(payload.review.body, env),
		triggerCommentId: payload.review.id,
	};
}

// Get model configuration
export function getModel(env: Env, configModel?: string): { providerID: string; modelID: string } {
	const model = configModel ?? env.DEFAULT_MODEL ?? "anthropic/claude-opus-4-5";
	const [providerID, ...rest] = model.split("/");
	const modelID = rest.join("/");

	if (!providerID?.length || !modelID.length) {
		throw new Error(
			`Invalid model ${model}. Model must be in the format "provider/model".`
		);
	}

	return { providerID, modelID };
}

// Format response with optional session link
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

// Generate branch name for new branches
export function generateBranchName(type: "issue" | "pr", issueNumber: number): string {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:-]/g, "")
		.replace(/\.\d{3}Z/, "")
		.split("T")
		.join("");
	return `bonk/${type}${issueNumber}-${timestamp}`;
}
