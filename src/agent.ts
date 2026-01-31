import { Agent } from 'agents';
import type { Env } from './types';
import { createOctokit, createComment, getWorkflowRunStatus } from './github';
import { createLogger, type Logger } from './log';

export interface CheckStatusPayload {
	runId: number;
	runUrl: string;
	issueNumber: number;
	createdAt: number;
}

interface RepoAgentState {
	installationId: number;
	// Active workflow runs being tracked, keyed by run ID
	activeRuns: Record<number, CheckStatusPayload>;
}

// Poll every 5 minutes as a safety net (action calls finalizeRun on completion)
const POLL_INTERVAL_SECONDS = 300;
const MAX_TRACKING_TIME_MS = 30 * 60 * 1000;

// Tracks workflow runs per repo. ID format: "{owner}/{repo}"
export class RepoAgent extends Agent<Env, RepoAgentState> {
	initialState: RepoAgentState = { installationId: 0, activeRuns: {} };

	private get owner(): string {
		return this.name.split('/')[0] ?? '';
	}

	private get repo(): string {
		return this.name.split('/')[1] ?? '';
	}

	private logger(runId?: number, issueNumber?: number): Logger {
		return createLogger({
			owner: this.owner,
			repo: this.repo,
			run_id: runId,
			issue_number: issueNumber,
			installation_id: this.state.installationId || undefined,
		});
	}

	async setInstallationId(id: number): Promise<void> {
		this.setState({ ...this.state, installationId: id });
	}

	async trackRun(runId: number, runUrl: string, issueNumber: number): Promise<void> {
		const log = this.logger(runId, issueNumber);
		log.info('run_tracking_started', { run_url: runUrl });

		const payload: CheckStatusPayload = {
			runId,
			runUrl,
			issueNumber,
			createdAt: Date.now(),
		};

		// Store in activeRuns state
		const activeRuns = { ...this.state.activeRuns, [runId]: payload };
		this.setState({ ...this.state, activeRuns });

		// Schedule polling as safety net
		await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
		log.info('run_poll_scheduled', { poll_interval_seconds: POLL_INTERVAL_SECONDS });
	}

	async finalizeRun(runId: number, status: string): Promise<void> {
		const run = this.state.activeRuns[runId];
		const log = this.logger(runId, run?.issueNumber);

		log.info('run_finalizing', { status });

		if (!run) {
			log.info('run_already_finalized');
			return;
		}

		// Remove from activeRuns (this effectively "cancels" the polling)
		const { [runId]: _, ...remainingRuns } = this.state.activeRuns;
		this.setState({ ...this.state, activeRuns: remainingRuns });

		// Post failure comment if needed
		if (status !== 'success' && status !== 'skipped') {
			await this.postFailureComment(runId, run.runUrl, run.issueNumber, status);
		} else {
			log.info('run_completed_no_comment', { status });
		}
	}

	async checkWorkflowStatus(payload: CheckStatusPayload): Promise<void> {
		const { runId, runUrl, issueNumber, createdAt } = payload;
		const log = this.logger(runId, issueNumber);

		// Check if run is still being tracked (may have been finalized by action)
		if (!this.state.activeRuns[runId]) {
			log.info('run_poll_skipped_already_finalized');
			return;
		}

		log.info('run_status_checking');

		const elapsed = Date.now() - createdAt;
		if (elapsed > MAX_TRACKING_TIME_MS) {
			log.warn('run_timed_out', { elapsed_ms: elapsed, max_tracking_ms: MAX_TRACKING_TIME_MS });
			// Remove from activeRuns
			const { [runId]: _, ...remainingRuns } = this.state.activeRuns;
			this.setState({ ...this.state, activeRuns: remainingRuns });
			await this.postFailureComment(runId, runUrl, issueNumber, 'timeout');
			return;
		}

		let octokit;
		try {
			octokit = await createOctokit(this.env, this.state.installationId);
		} catch (error) {
			log.errorWithException('run_octokit_failed', error);
			await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
			return;
		}

		try {
			const status = await getWorkflowRunStatus(octokit, this.owner, this.repo, runId);

			log.info('run_status_fetched', { status: status.status, conclusion: status.conclusion });

			if (status.status === 'completed') {
				// Remove from activeRuns
				const { [runId]: _, ...remainingRuns } = this.state.activeRuns;
				this.setState({ ...this.state, activeRuns: remainingRuns });

				// On success, OpenCode posts the response - we stay silent
				if (status.conclusion !== 'success') {
					await this.postFailureComment(runId, runUrl, issueNumber, status.conclusion);
				} else {
					log.info('run_succeeded');
				}
			} else {
				await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
			}
		} catch (error) {
			log.errorWithException('run_status_check_failed', error);
			await this.schedule<CheckStatusPayload>(POLL_INTERVAL_SECONDS, 'checkWorkflowStatus', payload);
		}
	}

	private async postFailureComment(runId: number, runUrl: string, issueNumber: number, conclusion: string | null): Promise<void> {
		const log = this.logger(runId, issueNumber);

		const statusMessage =
			conclusion === 'timeout'
				? 'Bonk workflow timed out.'
				: conclusion === 'failure'
					? 'Bonk workflow failed. Check the logs for details.'
					: conclusion === 'cancelled'
						? 'Bonk workflow was cancelled.'
						: `Bonk workflow finished with status: ${conclusion ?? 'unknown'}`;

		const body = `${statusMessage}\n\n[View workflow run](${runUrl})`;

		try {
			const octokit = await createOctokit(this.env, this.state.installationId);
			await createComment(octokit, this.owner, this.repo, issueNumber, body);
			log.info('failure_comment_posted', { conclusion });
		} catch (error) {
			log.errorWithException('failure_comment_failed', error, { conclusion });
		}
	}
}
