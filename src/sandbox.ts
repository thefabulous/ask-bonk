import { getSandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Config, OpencodeClient } from "@opencode-ai/sdk";
import { DEFAULT_MODEL, type Env, type AskRequest } from "./types";
import { getInstallationToken } from "./github";
import { withRetry } from "./retry";

// Runs OpenCode in the sandbox for the /ask endpoint.
// Returns an SSE stream of events from the OpenCode session.
//
// Flow:
// 1. Clone repo using installation token
// 2. Configure git identity
// 3. Start OpenCode with provided config (SDK handles merging with opencode.json)
// 4. Send prompt to OpenCode
// 5. Stream SSE events back to caller
//
// In future, responses may be routed to other destinations (email, Discord, etc)
// but for now, SSE is the only response type.
export async function runAsk(
	env: Env,
	installationId: number,
	request: AskRequest,
): Promise<ReadableStream> {
	const { id: askId, owner, repo, prompt, agent, model, config } = request;
	const logPrefix = `[${owner}/${repo}][ask:${askId}]`;

	const token = await getInstallationToken(env, installationId);
	const sandboxId = `${owner}-${repo}-${Date.now()}`;
	const sandbox = getSandbox(env.Sandbox, sandboxId);
	const repoUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
	const workDir = "/home/user/workspace";

	// Clone repository
	try {
		await withRetry(
			() => sandbox.gitCheckout(repoUrl, { targetDir: workDir, branch: undefined }),
			'sandbox.gitCheckout'
		);
	} catch (error) {
		console.error(`${logPrefix} Failed to clone repository:`, error);
		throw error;
	}

	// Configure git identity for any commits OpenCode might make
	const gitConfigResult = await sandbox.exec(
		`git config user.name "bonk[bot]" && git config user.email "bonk[bot]@users.noreply.github.com"`,
		{ cwd: workDir },
	);
	if (!gitConfigResult.success) {
		console.error(`${logPrefix} Git config failed:`, gitConfigResult.stderr);
	}

	// Configure credential helper for git push
	await sandbox.exec(
		`git config credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
		{ cwd: workDir },
	);

	// Build OpenCode config - SDK merges with project's opencode.json automatically.
	// We only need to set the API key for the opencode provider.
	const opencodeConfig: Config = {
		...config,
		provider: {
			...config?.provider,
			opencode: {
				...config?.provider?.opencode,
				options: {
					...config?.provider?.opencode?.options,
					apiKey: env.OPENCODE_API_KEY,
				},
			},
		},
	};

	// Start OpenCode in sandbox
	let client: OpencodeClient;
	try {
		const opencode = await withRetry(
			() => createOpencode<OpencodeClient>(sandbox, { directory: workDir, config: opencodeConfig }),
			'sandbox.createOpencode'
		);
		client = opencode.client;
	} catch (error) {
		console.error(`${logPrefix} Failed to start OpenCode:`, error);
		throw error;
	}

	// Create session
	const session = await withRetry(
		() => client.session.create({ body: { title: `Ask: ${owner}/${repo}` }, query: { directory: workDir } }),
		'opencode.session.create'
	);

	if (!session.data) {
		throw new Error("Failed to create OpenCode session");
	}

	// Build model config from request or use default
	const modelString = model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL;
	const [providerID, ...rest] = modelString.split("/");
	const modelID = rest.join("/");

	if (!providerID?.length || !modelID.length) {
		throw new Error(`Invalid model ${modelString}. Model must be in the format "provider/model".`);
	}

	// Stream SSE events from the prompt
	// The SDK's prompt method returns the final result, but for SSE streaming
	// we need to use a different approach - subscribe to session events
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	// Helper to write SSE events safely. Returns false if the write failed (e.g., stream closed).
	const sendEvent = async (event: string, data: unknown): Promise<boolean> => {
		try {
			await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			return true;
		} catch (error) {
			console.error(`${logPrefix} Failed to write SSE event '${event}':`, error);
			return false;
		}
	};

	// Run the prompt in the background and stream events
	const sessionId = session.data!.id;
	const sessionLogPrefix = `${logPrefix}[session:${sessionId}]`;

	(async () => {
		try {
			await sendEvent("session", { id: sessionId, askId });

			const promptResult = await withRetry(
				() => client.session.prompt({
					path: { id: sessionId },
					query: { directory: workDir },
					body: {
						model: { providerID, modelID },
						agent: agent ?? undefined,
						parts: [{ type: "text", text: prompt }],
					},
				}),
				'opencode.session.prompt'
			);

			const parts = promptResult.data?.parts ?? [];
			const textPart = parts.find((p: { type: string }) => p.type === "text") as
				| { text?: string }
				| undefined;
			const response = textPart?.text ?? "No response";

			// Check for changes
			const statusResult = await sandbox.exec("git status --porcelain", { cwd: workDir });
			const hasChanges = statusResult.success && statusResult.stdout.trim().length > 0;

			let changedFiles: string[] = [];
			if (hasChanges) {
				changedFiles = statusResult.stdout
					.trim()
					.split("\n")
					.map((line: string) => line.slice(3).trim())
					.filter((f: string) => f.length > 0);
			}

			await sendEvent("response", {
				text: response,
				changedFiles: changedFiles.length > 0 ? changedFiles : null,
			});

			await sendEvent("done", { success: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error(`${sessionLogPrefix} Prompt failed:`, message);
			// Try to send error event, but don't fail if stream is already closed
			await sendEvent("error", { message, askId, sessionId });
		} finally {
			// Safely close the writer, ignoring errors if already closed
			try {
				await writer.close();
			} catch (closeError) {
				console.error(`${sessionLogPrefix} Failed to close SSE writer:`, closeError);
			}
		}
	})();

	return readable;
}
