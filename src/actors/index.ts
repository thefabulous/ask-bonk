import { Actor, Persist } from '@cloudflare/actors';
import type { Schedule } from '@cloudflare/actors/alarms';
import type { Env } from '../types';
import { createOctokit, getWorkflowRunStatus, updateComment } from '../github';

/**
 * Payload for the checkWorkflowStatus scheduled callback
 */
export interface CheckStatusPayload {
	runId: number;
	runUrl: string;
	commentId: number;
	issueNumber: number;
	createdAt: number;
}

const POLL_INTERVAL_SECONDS = 30;
const MAX_TRACKING_TIME_MS = 30 * 60 * 1000; // 30 minutes

/**
 * RepoActor - Durable Object for tracking workflow completion per repository
 *
 * ID format: "{owner}/{repo}" (e.g., "elithrar/ask-bonk")
 *
 * Uses the @cloudflare/actors schedule API for alarm management.
 * Each tracked workflow run gets its own scheduled callback.
 */
export class RepoActor extends Actor<Env> {
	private owner: string;
	private repo: string;

	// Persisted state
	@Persist installationId: number = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const [owner, repo] = ctx.id.name?.split('/') ?? ['', ''];
		this.owner = owner;
		this.repo = repo;
	}

	/**
	 * Store the GitHub App installation ID for API authentication
	 */
	async setInstallationId(id: number): Promise<void> {
		this.installationId = id;
	}

	/**
	 * Start tracking a workflow run for completion
	 */
	async trackRun(commentId: number, runId: number, runUrl: string, issueNumber: number): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		console.info(`${logPrefix} Tracking run ${runId} for comment ${commentId}`);

		const payload: CheckStatusPayload = {
			runId,
			runUrl,
			commentId,
			issueNumber,
			createdAt: Date.now(),
		};

		// Schedule the first status check
		await this.alarms.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);

		console.info(`${logPrefix} Scheduled status check in ${POLL_INTERVAL_SECONDS}s`);
	}

	/**
	 * Scheduled callback to check workflow run status
	 * Called by the alarms system with the payload and schedule info
	 */
	async checkWorkflowStatus(payload: CheckStatusPayload, _schedule: Schedule<CheckStatusPayload>): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		const { runId, runUrl, commentId, createdAt } = payload;

		console.info(`${logPrefix} Checking status for run ${runId}`);

		// Check if we've exceeded max tracking time
		const elapsed = Date.now() - createdAt;
		if (elapsed > MAX_TRACKING_TIME_MS) {
			console.warn(`${logPrefix} Run ${runId} timed out after ${elapsed}ms`);
			await this.updateCommentWithTimeout(runUrl, commentId);
			return; // Don't reschedule
		}

		let octokit;
		try {
			octokit = await createOctokit(this.env, this.installationId);
		} catch (error) {
			console.error(`${logPrefix} Failed to create Octokit:`, error);
			// Reschedule to retry
			await this.alarms.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
			return;
		}

		try {
			const status = await getWorkflowRunStatus(octokit, this.owner, this.repo, runId);

			console.info(`${logPrefix} Run ${runId} status: ${status.status}, conclusion: ${status.conclusion}`);

			if (status.status === 'completed') {
				await this.updateCommentWithResult(runUrl, commentId, status.conclusion);
				// Don't reschedule - we're done
			} else {
				// Still running, schedule next check
				await this.alarms.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
			}
		} catch (error) {
			console.error(`${logPrefix} Failed to check run ${runId}:`, error);
			// Reschedule to retry
			await this.alarms.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
		}
	}

	/**
	 * Update the GitHub comment with the workflow result
	 */
	private async updateCommentWithResult(runUrl: string, commentId: number, conclusion: string | null): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;

		const statusMessage =
			conclusion === 'success'
				? 'Bonk completed successfully!'
				: conclusion === 'failure'
					? 'Bonk failed. Check the workflow logs for details.'
					: conclusion === 'cancelled'
						? 'Bonk was cancelled.'
						: `Bonk finished with status: ${conclusion ?? 'unknown'}`;

		const body = `${statusMessage}\n\n[View workflow run](${runUrl})`;

		try {
			const octokit = await createOctokit(this.env, this.installationId);
			await updateComment(octokit, this.owner, this.repo, commentId, body);
			console.info(`${logPrefix} Updated comment ${commentId} with result: ${conclusion}`);
		} catch (error) {
			console.error(`${logPrefix} Failed to update comment ${commentId}:`, error);
		}
	}

	/**
	 * Update the GitHub comment when tracking times out
	 */
	private async updateCommentWithTimeout(runUrl: string, commentId: number): Promise<void> {
		const logPrefix = `[${this.owner}/${this.repo}]`;
		const body = `Timed out waiting for completion. [View run](${runUrl})`;

		try {
			const octokit = await createOctokit(this.env, this.installationId);
			await updateComment(octokit, this.owner, this.repo, commentId, body);
			console.info(`${logPrefix} Updated comment ${commentId} with timeout`);
		} catch (error) {
			console.error(`${logPrefix} Failed to update comment ${commentId} with timeout:`, error);
		}
	}
}
