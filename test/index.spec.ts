import { describe, it, expect } from "vitest";
import {
	hasMention,
	extractPrompt,
	parseIssueCommentEvent,
	parsePRReviewCommentEvent,
	getModel,
	formatResponse,
	generateBranchName,
} from "../src/events";
import type { BonkConfig, Env } from "../src/types";
import type {
	IssueCommentEvent,
	PullRequestReviewCommentEvent,
} from "@octokit/webhooks-types";

// Read fixtures
import issueCommentFixture from "./fixtures/issue-comment.json";
import prReviewCommentFixture from "./fixtures/pr-review-comment.json";

// Mock config for testing
const mockConfig: BonkConfig = {
	botMention: "@ask-bonk",
	botCommand: "/bonk",
	model: "anthropic/claude-opus-4-5",
};

// Mock env for model tests
const mockEnv: Env = {
	Sandbox: {} as Env["Sandbox"],
	GITHUB_APP_ID: "123",
	GITHUB_APP_PRIVATE_KEY: "test-key",
	GITHUB_WEBHOOK_SECRET: "test-secret",
	ANTHROPIC_API_KEY: "test-api-key",
	DEFAULT_MODEL: "anthropic/claude-opus-4-5",
};

describe("Mention Detection", () => {
	it("detects @ask-bonk mention", () => {
		expect(hasMention("@ask-bonk fix this", mockConfig)).toBe(true);
	});

	it("detects /bonk command", () => {
		expect(hasMention("/bonk fix this", mockConfig)).toBe(true);
	});

	it("detects mention in middle of text", () => {
		expect(hasMention("hey @ask-bonk can you help", mockConfig)).toBe(true);
	});

	it("does not match partial mentions", () => {
		expect(hasMention("@ask-bonker", mockConfig)).toBe(false);
	});

	it("does not match without mention", () => {
		expect(hasMention("please fix this bug", mockConfig)).toBe(false);
	});

	it("works with custom bot mention", () => {
		const customConfig: BonkConfig = { botMention: "@custom-bot" };
		expect(hasMention("@custom-bot help", customConfig)).toBe(true);
		expect(hasMention("/bonk help", customConfig)).toBe(true); // default command still works
	});

	it("works with default config", () => {
		expect(hasMention("@ask-bonk help", {})).toBe(true);
		expect(hasMention("/bonk help", {})).toBe(true);
	});
});

describe("Prompt Extraction", () => {
	it("extracts full prompt with mention", () => {
		const prompt = extractPrompt("@ask-bonk fix the type error", mockConfig);
		expect(prompt).toBe("@ask-bonk fix the type error");
	});

	it("returns default for bare mention", () => {
		const prompt = extractPrompt("@ask-bonk", mockConfig);
		expect(prompt).toBe("Summarize this thread");
	});

	it("includes review context when provided", () => {
		const reviewContext = {
			file: "src/utils.ts",
			diffHunk: "@@ -1,3 +1,4 @@\n+const x = 1;",
			line: 5,
			originalLine: 4,
			position: 2,
			commitId: "abc123",
			originalCommitId: "def456",
		};
		const prompt = extractPrompt("@ask-bonk improve this", mockConfig, reviewContext);
		expect(prompt).toContain("src/utils.ts");
		expect(prompt).toContain("line 5");
	});
});

describe("Issue Comment Event Parsing", () => {
	it("parses valid issue comment event", () => {
		const result = parseIssueCommentEvent(
			issueCommentFixture as unknown as IssueCommentEvent,
			mockConfig
		);

		expect(result).not.toBeNull();
		expect(result?.context.owner).toBe("test-owner");
		expect(result?.context.repo).toBe("test-repo");
		expect(result?.context.issueNumber).toBe(42);
		expect(result?.context.actor).toBe("testuser");
		expect(result?.context.isPullRequest).toBe(false);
		expect(result?.triggerCommentId).toBe(123456);
	});

	it("returns null for non-created action", () => {
		const payload = { ...issueCommentFixture, action: "deleted" };
		const result = parseIssueCommentEvent(
			payload as unknown as IssueCommentEvent,
			mockConfig
		);
		expect(result).toBeNull();
	});

	it("returns null for comment without mention", () => {
		const payload = {
			...issueCommentFixture,
			comment: { ...issueCommentFixture.comment, body: "just a regular comment" },
		};
		const result = parseIssueCommentEvent(
			payload as unknown as IssueCommentEvent,
			mockConfig
		);
		expect(result).toBeNull();
	});
});

describe("PR Review Comment Event Parsing", () => {
	it("parses valid PR review comment event", () => {
		const result = parsePRReviewCommentEvent(
			prReviewCommentFixture as unknown as PullRequestReviewCommentEvent,
			mockConfig
		);

		expect(result).not.toBeNull();
		expect(result?.context.owner).toBe("test-owner");
		expect(result?.context.repo).toBe("test-repo");
		expect(result?.context.issueNumber).toBe(99);
		expect(result?.context.isPullRequest).toBe(true);
		expect(result?.context.headBranch).toBe("feature-branch");
		expect(result?.reviewContext.file).toBe("src/utils.ts");
		expect(result?.reviewContext.line).toBe(42);
	});

	it("returns null for fork PRs", () => {
		const forkPayload = {
			...prReviewCommentFixture,
			pull_request: {
				...prReviewCommentFixture.pull_request,
				head: {
					...prReviewCommentFixture.pull_request.head,
					repo: { full_name: "forked-owner/test-repo" },
				},
			},
		};
		const result = parsePRReviewCommentEvent(
			forkPayload as unknown as PullRequestReviewCommentEvent,
			mockConfig
		);
		expect(result).toBeNull();
	});
});

describe("Model Configuration", () => {
	it("returns default model when not configured", () => {
		const model = getModel(mockEnv);
		expect(model.providerID).toBe("anthropic");
		expect(model.modelID).toBe("claude-opus-4-5");
	});

	it("uses config model override", () => {
		const model = getModel(mockEnv, "anthropic/claude-sonnet-4-20250514");
		expect(model.providerID).toBe("anthropic");
		expect(model.modelID).toBe("claude-sonnet-4-20250514");
	});

	it("throws for invalid model format", () => {
		expect(() => getModel(mockEnv, "invalid")).toThrow();
	});
});

describe("Response Formatting", () => {
	it("formats basic response", () => {
		const response = formatResponse(
			"Here is the fix",
			null,
			null,
			"anthropic/claude-opus-4-5"
		);
		expect(response).toContain("Here is the fix");
		expect(response).toContain("`anthropic/claude-opus-4-5`");
	});

	it("includes changed files", () => {
		const response = formatResponse(
			"Fixed the issue",
			["src/utils.ts", "src/index.ts"],
			null,
			"anthropic/claude-opus-4-5"
		);
		expect(response).toContain("Files changed");
		expect(response).toContain("`src/utils.ts`");
		expect(response).toContain("`src/index.ts`");
	});

	it("includes session link for public repos", () => {
		const response = formatResponse(
			"Done",
			null,
			"https://opencode.ai/s/abc123",
			"anthropic/claude-opus-4-5"
		);
		expect(response).toContain("[View session](https://opencode.ai/s/abc123)");
	});
});

describe("Branch Name Generation", () => {
	it("generates issue branch name", () => {
		const branch = generateBranchName("issue", 42);
		expect(branch).toMatch(/^bonk\/issue42-\d{14}$/);
	});

	it("generates PR branch name", () => {
		const branch = generateBranchName("pr", 99);
		expect(branch).toMatch(/^bonk\/pr99-\d{14}$/);
	});
});
