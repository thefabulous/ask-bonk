import { getSandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Config, OpencodeClient } from "@opencode-ai/sdk";
import type {
	IssueCommentEvent,
	PullRequestReviewCommentEvent,
	PullRequestReviewEvent,
} from "@octokit/webhooks-types";
import type { Env } from "./types";
import {
	createOctokit,
	createGraphQL,
	createWebhooks,
	verifyWebhook,
	hasWriteAccess,
	createComment,
	updateComment,
	createPullRequest,
	getRepository,
	getBonkConfig,
	fetchIssue,
	fetchPullRequest,
	buildIssueContext,
	buildPRContext,
	getInstallationToken,
} from "./github";
import {
	parseIssueCommentEvent,
	parsePRReviewCommentEvent,
	parsePRReviewEvent,
	getModel,
	formatResponse,
	generateBranchName,
} from "./events";
import { extractImages, imagesToPromptParts } from "./images";

export { Sandbox } from "@cloudflare/sandbox";

const SHARE_URL = "https://opencode.ai";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health check endpoint
		if (url.pathname === "/" || url.pathname === "/health") {
			return new Response("OK", { status: 200 });
		}

		// Webhook endpoint
		if (url.pathname === "/webhooks" && request.method === "POST") {
			return handleWebhook(request, env);
		}

		return new Response("Not Found", { status: 404 });
	},
};

async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const webhooks = createWebhooks(env);

	// Verify webhook signature
	const event = await verifyWebhook(webhooks, request);
	if (!event) {
		return new Response("Invalid signature", { status: 401 });
	}

	// Handle supported events
	try {
		switch (event.name) {
			case "issue_comment":
				await handleIssueComment(
					event.payload as IssueCommentEvent,
					env
				);
				break;

			case "pull_request_review_comment":
				await handlePRReviewComment(
					event.payload as PullRequestReviewCommentEvent,
					env
				);
				break;

			case "pull_request_review":
				await handlePRReview(
					event.payload as PullRequestReviewEvent,
					env
				);
				break;

			default:
				// Ignore unsupported events
				return new Response("Event not handled", { status: 200 });
		}

		return new Response("OK", { status: 200 });
	} catch (error) {
		console.error("Webhook handling error:", error);
		return new Response("Internal error", { status: 500 });
	}
}

async function handleIssueComment(
	payload: IssueCommentEvent,
	env: Env
): Promise<void> {
	const parsed = parseIssueCommentEvent(payload, env);
	if (!parsed) return;

	const { context, prompt, triggerCommentId } = parsed;
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error("No installation ID in payload");
		return;
	}

	await processRequest({
		env,
		installationId,
		context,
		prompt,
		triggerCommentId,
	});
}

async function handlePRReviewComment(
	payload: PullRequestReviewCommentEvent,
	env: Env
): Promise<void> {
	const parsed = parsePRReviewCommentEvent(payload, env);
	if (!parsed) return;

	const { context, prompt, triggerCommentId } = parsed;
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error("No installation ID in payload");
		return;
	}

	await processRequest({
		env,
		installationId,
		context,
		prompt,
		triggerCommentId,
	});
}

async function handlePRReview(
	payload: PullRequestReviewEvent,
	env: Env
): Promise<void> {
	const parsed = parsePRReviewEvent(payload, env);
	if (!parsed) return;

	const { context, prompt, triggerCommentId } = parsed;
	const installationId = payload.installation?.id;
	if (!installationId) {
		console.error("No installation ID in payload");
		return;
	}

	await processRequest({
		env,
		installationId,
		context,
		prompt,
		triggerCommentId,
	});
}

interface ProcessRequestParams {
	env: Env;
	installationId: number;
	context: {
		owner: string;
		repo: string;
		issueNumber: number;
		commentId: number;
		actor: string;
		isPullRequest: boolean;
		isPrivate: boolean;
		defaultBranch: string;
		headBranch?: string;
		headSha?: string;
		isFork?: boolean;
	};
	prompt: string;
	triggerCommentId: number;
}

async function processRequest({
	env,
	installationId,
	context,
	prompt,
	triggerCommentId,
}: ProcessRequestParams): Promise<void> {
	const octokit = await createOctokit(env, installationId);
	const gql = await createGraphQL(env, installationId);

	// Check permissions
	const canWrite = await hasWriteAccess(
		octokit,
		context.owner,
		context.repo,
		context.actor
	);
	if (!canWrite) {
		console.log(`User ${context.actor} does not have write access`);
		return;
	}

	// Create initial "working" comment
	const responseCommentId = await createComment(
		octokit,
		context.owner,
		context.repo,
		context.issueNumber,
		"Bonk is working on it..."
	);

	try {
		// Get repository info
		const repoData = await getRepository(
			octokit,
			context.owner,
			context.repo
		);

		// Get repo config
		const bonkConfig = await getBonkConfig(
			octokit,
			context.owner,
			context.repo,
			context.headBranch ?? context.defaultBranch
		);

		// Get model configuration
		const modelConfig = getModel(env, bonkConfig.model);
		const modelString = `${modelConfig.providerID}/${modelConfig.modelID}`;

		// Get installation token for git operations
		const token = await getInstallationToken(env, installationId);

		// Process images in prompt
		const { processedBody: processedPrompt, images } = await extractImages(
			prompt,
			token
		);

		// Build context from issue/PR data
		let dataContext: string;
		if (context.isPullRequest) {
			const prData = await fetchPullRequest(
				gql,
				context.owner,
				context.repo,
				context.issueNumber
			);

			// Check if fork PR
			if (
				prData.headRepository.nameWithOwner !==
				prData.baseRepository.nameWithOwner
			) {
				await updateComment(
					octokit,
					context.owner,
					context.repo,
					responseCommentId,
					"Fork PRs are not supported."
				);
				return;
			}

			context.headBranch = prData.headRefName;
			context.headSha = prData.headRefOid;
			dataContext = buildPRContext(prData, [
				triggerCommentId,
				responseCommentId,
			]);
		} else {
			const issueData = await fetchIssue(
				gql,
				context.owner,
				context.repo,
				context.issueNumber
			);
			dataContext = buildIssueContext(issueData, [
				triggerCommentId,
				responseCommentId,
			]);
		}

		// Run OpenCode in sandbox
		const result = await runOpencodeSandbox({
			env,
			owner: context.owner,
			repo: context.repo,
			branch: context.headBranch ?? context.defaultBranch,
			prompt: `${processedPrompt}\n\n${dataContext}`,
			images,
			modelConfig,
			token,
			isPrivate: repoData.private,
			actor: context.actor,
		isPullRequest: context.isPullRequest,
		issueNumber: context.issueNumber,
	});

		// Update comment with result
		const response = formatResponse(
			result.response,
			result.changedFiles,
			result.sessionLink,
			modelString
		);
		await updateComment(
			octokit,
			context.owner,
			context.repo,
			responseCommentId,
			response
		);

		// Create PR if on issue and changes were made
		if (
			!context.isPullRequest &&
			result.changedFiles &&
			result.changedFiles.length > 0 &&
			result.newBranch
		) {
			const prNumber = await createPullRequest(
				octokit,
				context.owner,
				context.repo,
				result.newBranch,
				context.defaultBranch,
				result.summary || `Fix issue #${context.issueNumber}`,
				`${result.response}\n\nCloses #${context.issueNumber}`
			);

			// Update comment to mention PR
			await updateComment(
				octokit,
				context.owner,
				context.repo,
				responseCommentId,
				`${response}\n\nCreated PR #${prNumber}`
			);
		}
	} catch (error) {
		console.error("Error processing request:", error);
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		await updateComment(
			octokit,
			context.owner,
			context.repo,
			responseCommentId,
			`Error: ${errorMessage}`
		);
	}
}

interface OpencodeSandboxParams {
	env: Env;
	owner: string;
	repo: string;
	branch: string;
	prompt: string;
	images: Array<{
		filename: string;
		mime: string;
		content: string;
		start: number;
		end: number;
		replacement: string;
	}>;
	modelConfig: { providerID: string; modelID: string };
	token: string;
	isPrivate: boolean;
	actor: string;
	isPullRequest: boolean;
	issueNumber: number;
}

interface OpencodeSandboxResult {
	response: string;
	changedFiles: string[] | null;
	sessionLink: string | null;
	newBranch: string | null;
	summary: string | null;
}

async function runOpencodeSandbox(
	params: OpencodeSandboxParams
): Promise<OpencodeSandboxResult> {
	const {
		env,
		owner,
		repo,
		branch,
		prompt,
		images,
		modelConfig,
		token,
		isPrivate,
		actor,
		isPullRequest,
		issueNumber,
	} = params;

	// Create sandbox
	const sandboxId = `${owner}-${repo}-${Date.now()}`;
	const sandbox = getSandbox(env.Sandbox, sandboxId);

	// Clone repository
	const repoUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
	await sandbox.gitCheckout(repoUrl, {
		targetDir: "/home/user/workspace",
		branch: branch,
	});

	// Configure git user
	await sandbox.exec(
		`git config user.name "bonk[bot]" && git config user.email "bonk[bot]@users.noreply.github.com"`,
		{ cwd: "/home/user/workspace" }
	);

	// Set up git credentials for push
	await sandbox.exec(
		`git config credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
		{ cwd: "/home/user/workspace" }
	);

	// OpenCode config
	const config: Config = {
		provider: {
			anthropic: {
				options: {
					apiKey: env.ANTHROPIC_API_KEY,
				},
			},
		},
	};

	// Start OpenCode
	const { client } = await createOpencode<OpencodeClient>(sandbox, {
		directory: "/home/user/workspace",
		config,
	});

	// Create session
	const session = await client.session.create({
		body: { title: `Bonk: ${owner}/${repo}#${issueNumber}` },
		query: { directory: "/home/user/workspace" },
	});

	if (!session.data) {
		throw new Error("Failed to create OpenCode session");
	}

	// Share session for public repos
	let sessionLink: string | null = null;
	if (!isPrivate) {
		try {
			await client.session.share({
				path: { id: session.data.id },
			});
			const shareId = session.data.id.slice(-8);
			sessionLink = `${SHARE_URL}/s/${shareId}`;
		} catch (error) {
			console.error("Failed to share session:", error);
		}
	}

	// Send prompt
	const promptResult = await client.session.prompt({
		path: { id: session.data.id },
		query: { directory: "/home/user/workspace" },
		body: {
			model: {
				providerID: modelConfig.providerID,
				modelID: modelConfig.modelID,
			},
			parts: [
				{ type: "text", text: prompt },
				...imagesToPromptParts(images),
			],
		},
	});

	// Extract response
	const parts = promptResult.data?.parts ?? [];
	const textPart = parts.find((p: { type: string }) => p.type === "text") as
		| { text?: string }
		| undefined;
	const response = textPart?.text ?? "No response";

	// Check for changes
	const statusResult = await sandbox.exec("git status --porcelain", {
		cwd: "/home/user/workspace",
	});
	const hasChanges = statusResult.stdout.trim().length > 0;

	let changedFiles: string[] | null = null;
	let newBranch: string | null = null;
	let summary: string | null = null;

	if (hasChanges) {
		// Get list of changed files
		const files = statusResult.stdout
			.trim()
			.split("\n")
			.map((line: string) => line.slice(3).trim())
			.filter((f: string) => f.length > 0);
		changedFiles = files;

		// Generate summary
		summary = await generateSummary(client, session.data.id, response);

		if (!isPullRequest) {
			// Create new branch and push for issues
			newBranch = generateBranchName("issue", issueNumber);
			await sandbox.exec(`git checkout -b ${newBranch}`, {
				cwd: "/home/user/workspace",
			});
			await sandbox.exec("git add .", { cwd: "/home/user/workspace" });
			await sandbox.exec(
				`git commit -m "${summary}\n\nCo-authored-by: ${actor} <${actor}@users.noreply.github.com>"`,
				{ cwd: "/home/user/workspace" }
			);
			await sandbox.exec(`git push -u origin ${newBranch}`, {
				cwd: "/home/user/workspace",
			});
		} else {
			// Push to existing branch for PRs
			await sandbox.exec("git add .", { cwd: "/home/user/workspace" });
			await sandbox.exec(
				`git commit -m "${summary}\n\nCo-authored-by: ${actor} <${actor}@users.noreply.github.com>"`,
				{ cwd: "/home/user/workspace" }
			);
			await sandbox.exec("git push", { cwd: "/home/user/workspace" });
		}
	}

	return {
		response,
		changedFiles,
		sessionLink,
		newBranch,
		summary,
	};
}

async function generateSummary(
	client: OpencodeClient,
	sessionId: string,
	response: string
): Promise<string> {
	try {
		const summaryResult = await client.session.prompt({
			path: { id: sessionId },
			body: {
				model: {
					providerID: "anthropic",
					modelID: "claude-haiku-4-5",
				},
				parts: [
					{
						type: "text",
						text: `Summarize the following in less than 40 characters:\n\n${response}`,
					},
				],
			},
		});

		const parts = summaryResult.data?.parts ?? [];
		const textPart = parts.find(
			(p: { type: string }) => p.type === "text"
		) as { text?: string } | undefined;
		return textPart?.text?.slice(0, 40) ?? "Fix issue";
	} catch {
		return "Fix issue";
	}
}
