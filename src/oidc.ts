import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { RequestError } from '@octokit/request-error';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { Env } from './types';
import { hasWriteAccess, getRepository } from './github';
import { withRetry } from './retry';
import { createLogger } from './log';

// GitHub's OIDC token issuer for Actions
const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

// TTL for cached installation IDs (30 minutes)
export const APP_INSTALLATION_CACHE_TTL_SECS = 1800;
const JWKS = createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`));

// JWT claims from GitHub Actions OIDC token
interface GitHubActionsJWTClaims {
	iss: string;
	sub: string;
	aud: string | string[];
	exp: number;
	iat: number;
	nbf?: number;
	jti?: string;
	// GitHub-specific claims
	repository: string;
	repository_owner: string;
	repository_id: string;
	repository_owner_id: string;
	run_id: string;
	run_number: string;
	run_attempt: string;
	actor: string;
	actor_id: string;
	workflow: string;
	head_ref?: string;
	base_ref?: string;
	event_name: string;
	ref: string;
	ref_type: string;
	job_workflow_ref: string;
	runner_environment: string;
}

interface OIDCValidationResult {
	valid: boolean;
	claims?: GitHubActionsJWTClaims;
	error?: string;
}

// Validates a GitHub Actions OIDC token using jose library
export async function validateGitHubOIDCToken(
	token: string,
	expectedAudience: string = 'opencode-github-action'
): Promise<OIDCValidationResult> {
	try {
		const { payload } = await jwtVerify(token, JWKS, {
			issuer: GITHUB_ACTIONS_ISSUER,
			audience: expectedAudience,
		});

		return { valid: true, claims: payload as unknown as GitHubActionsJWTClaims };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return { valid: false, error: message };
	}
}

// Extracts owner/repo from OIDC claims.
// Throws if the repository claim is malformed.
export function extractRepoFromClaims(claims: GitHubActionsJWTClaims): { owner: string; repo: string } {
	const parts = claims.repository.split('/');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`Invalid repository claim: ${claims.repository}`);
	}
	return { owner: parts[0], repo: parts[1] };
}

// Gets or looks up the installation ID for a repository.
// Returns null if the app is not installed. Throws on transient errors (network, rate limit).
export async function getInstallationId(env: Env, owner: string, repo: string): Promise<number | null> {
	const installLog = createLogger({ owner, repo });

	// Check cache first, with validation
	const cached = await env.APP_INSTALLATIONS.get(`${owner}/${repo}`);
	if (cached) {
		const id = parseInt(cached, 10);
		if (!Number.isNaN(id)) {
			return id;
		}
		installLog.warn('installation_cache_invalid', { cached_value: cached });
	}

	// Look up via GitHub API using the app's JWT
	const auth = createAppAuth({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_APP_PRIVATE_KEY,
	});

	const { token } = await auth({ type: 'app' });
	const octokit = new Octokit({ auth: token });

	try {
		const response = await withRetry(
			() => octokit.apps.getRepoInstallation({ owner, repo }),
			`getInstallationId(${owner}/${repo})`
		);
		const installationId = response.data.id;

		// Cache for future use
		await env.APP_INSTALLATIONS.put(`${owner}/${repo}`, String(installationId), { expirationTtl: APP_INSTALLATION_CACHE_TTL_SECS });
		return installationId;
	} catch (err) {
		// 404 = app not installed on this repo (expected case)
		if (err instanceof RequestError && err.status === 404) {
			return null;
		}
		// Other errors (network, rate limit, 5xx) should propagate
		throw err;
	}
}

// Options for scoped installation token generation
interface ScopedTokenOptions {
	// Limit token to specific repository names
	repositoryNames?: string[];
	// Limit token permissions (defaults to full installation permissions)
	permissions?: {
		contents?: 'read' | 'write';
		issues?: 'read' | 'write';
		pull_requests?: 'read' | 'write';
		metadata?: 'read';
	};
}

// Generates an installation token for the GitHub App.
// Optionally scopes the token to specific repositories and/or permissions.
async function generateInstallationToken(
	env: Env,
	installationId: number,
	options?: ScopedTokenOptions
): Promise<string> {
	const auth = createAppAuth({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_APP_PRIVATE_KEY,
		installationId,
	});

	const authOptions: {
		type: 'installation';
		repositoryNames?: string[];
		permissions?: ScopedTokenOptions['permissions'];
	} = { type: 'installation' };

	if (options?.repositoryNames) {
		authOptions.repositoryNames = options.repositoryNames;
	}
	if (options?.permissions) {
		authOptions.permissions = options.permissions;
	}

	const { token } = await withRetry(() => auth(authOptions), 'generateInstallationToken.auth');
	return token;
}

// Response types for API endpoints
export interface GetInstallationResponse {
	installation: {
		id: number;
	} | null;
}

export interface ExchangeTokenResponse {
	token: string;
}

export interface ErrorResponse {
	error: string;
}

// Handler for GET /get_github_app_installation
export async function handleGetInstallation(
	env: Env,
	owner: string,
	repo: string
): Promise<GetInstallationResponse | ErrorResponse> {
	if (!owner || !repo) {
		return { error: 'Missing owner or repo parameter' };
	}

	const installationId = await getInstallationId(env, owner, repo);
	if (!installationId) {
		return { installation: null };
	}

	return { installation: { id: installationId } };
}

// Handler for POST /exchange_github_app_token
// Exchanges a GitHub Actions OIDC token for a GitHub App installation token
export async function handleExchangeToken(
	env: Env,
	authHeader: string | null
): Promise<ExchangeTokenResponse | ErrorResponse> {
	if (!authHeader?.startsWith('Bearer ')) {
		return { error: 'Missing or invalid Authorization header' };
	}

	const oidcToken = authHeader.slice(7);

	// Validate the OIDC token
	const validation = await validateGitHubOIDCToken(oidcToken);
	if (!validation.valid || !validation.claims) {
		return { error: validation.error || 'Invalid OIDC token' };
	}

	// Extract repository info from claims
	const { owner, repo } = extractRepoFromClaims(validation.claims);

	try {
		// Get installation ID (throws on transient errors like network/rate limit)
		const installationId = await getInstallationId(env, owner, repo);
		if (!installationId) {
			return { error: `GitHub App not installed for ${owner}/${repo}` };
		}

		// Scope the token to the source repo with minimal permissions. Even though the OIDC
		// token proves the workflow runs in this repo, we limit scope to prevent lateral
		// movement if the app is installed org-wide, and restrict permissions to only what's
		// needed for typical operations (push, PRs, comments).
		const token = await generateInstallationToken(env, installationId, {
			repositoryNames: [repo],
			permissions: {
				contents: 'write',
				pull_requests: 'write',
				issues: 'write',
				metadata: 'read',
			},
		});

		return { token };
	} catch (err) {
		createLogger({ owner, repo }).errorWithException('token_generation_failed', err);
		return { error: `Failed to generate token for ${owner}/${repo}` };
	}
}

// Handler for POST /exchange_github_app_token_for_repo
// Exchanges a GitHub Actions OIDC token for a GitHub App installation token on a DIFFERENT repository.
// This enables cross-repo operations from GitHub Actions - the caller authenticates with their
// workflow's OIDC token, but can request a token for any repo where the Bonk app is installed.
//
// Security controls:
// 1. Same-org restriction: The target repo must be in the same org/user as the source repo
// 2. Visibility restriction: Public repos cannot access private repos (prevents data exfiltration)
// 3. Actor write access: The actor (user who triggered the workflow) must have write access to the target repo
export async function handleExchangeTokenForRepo(
	env: Env,
	authHeader: string | null,
	body: { owner?: string; repo?: string }
): Promise<ExchangeTokenResponse | ErrorResponse> {
	if (!authHeader?.startsWith('Bearer ')) {
		return { error: 'Missing or invalid Authorization header' };
	}

	const oidcToken = authHeader.slice(7);

	// Validate the OIDC token - this proves the caller is a legitimate GitHub Actions workflow
	const validation = await validateGitHubOIDCToken(oidcToken);
	if (!validation.valid || !validation.claims) {
		return { error: validation.error || 'Invalid OIDC token' };
	}

	// Target repo must be specified in body
	if (!body.owner || !body.repo) {
		return { error: 'Missing owner or repo in request body' };
	}

	// Extract source repo info using validated helper (avoids fragile split pattern)
	const { owner: sourceOwner, repo: sourceRepoName } = extractRepoFromClaims(validation.claims);
	const sourceRepo = validation.claims.repository;
	const targetRepo = `${body.owner}/${body.repo}`;
	const actor = validation.claims.actor;
	const crossRepoLog = createLogger({ actor, source_repo: sourceRepo, target_repo: targetRepo });

	// Security check 1: Same-org restriction
	// Only allow cross-repo access within the same org/user to prevent abuse
	if (sourceOwner !== body.owner) {
		crossRepoLog.warn('cross_repo_denied_cross_org', {
			source_owner: sourceOwner,
			target_owner: body.owner,
		});
		return {
			error: `Cross-org access denied: workflow in ${sourceOwner} cannot access repos in ${body.owner}`,
		};
	}

	try {
		// Get installation IDs for both repos
		const sourceInstallationId = await getInstallationId(env, sourceOwner, sourceRepoName);
		if (!sourceInstallationId) {
			return { error: `GitHub App not installed for ${sourceRepo}` };
		}

		const targetInstallationId = await getInstallationId(env, body.owner, body.repo);
		if (!targetInstallationId) {
			return { error: `GitHub App not installed for ${targetRepo}` };
		}

		// Generate tokens once and reuse for all checks
		// Source token: unscoped (just need to read repo metadata)
		// Target token: scoped to target repo with required permissions
		const sourceToken = await generateInstallationToken(env, sourceInstallationId);
		const targetToken = await generateInstallationToken(env, targetInstallationId, {
			repositoryNames: [body.repo],
			permissions: {
				contents: 'write',
				pull_requests: 'write',
				issues: 'write',
				metadata: 'read',
			},
		});

		const sourceOctokit = new Octokit({ auth: sourceToken });
		const targetOctokit = new Octokit({ auth: targetToken });

		// Security check 2: Visibility restriction (check before write access - cheaper and fails fast)
		// IMPORTANT: Public repos cannot access private repos. This prevents a malicious workflow
		// in a public repo from exfiltrating code from private repos in the same org, even if the
		// actor has write access to both. The threat model is: an attacker forks a public repo,
		// triggers a workflow, and uses the cross-repo tool to clone a private repo and leak its contents.
		const sourceData = await getRepository(sourceOctokit, sourceOwner, sourceRepoName);
		const targetData = await getRepository(targetOctokit, body.owner, body.repo);
		const sourceVisibility = sourceData.visibility as 'public' | 'private' | 'internal';
		const targetVisibility = targetData.visibility as 'public' | 'private' | 'internal';

		if (sourceVisibility === 'public' && targetVisibility !== 'public') {
			crossRepoLog.warn('cross_repo_denied_visibility', {
				source_visibility: sourceVisibility,
				target_visibility: targetVisibility,
			});
			return {
				error: `Cross-repo access denied: public repos cannot access private/internal repos`,
			};
		}

		// Security check 3: Actor write access
		// The actor who triggered the workflow must have write access to the target repo
		const hasAccess = await hasWriteAccess(targetOctokit, body.owner, body.repo, actor);
		if (!hasAccess) {
			crossRepoLog.warn('cross_repo_denied_no_write_access');
			return {
				error: `Access denied: ${actor} does not have write access to ${targetRepo}`,
			};
		}

		// Audit log: successful cross-repo token issuance
		crossRepoLog.info('cross_repo_token_issued', {
			source_visibility: sourceVisibility,
			target_visibility: targetVisibility,
			run_id: validation.claims.run_id,
			workflow: validation.claims.job_workflow_ref,
		});

		// Return the already-scoped target token
		return { token: targetToken };
	} catch (err) {
		crossRepoLog.errorWithException('cross_repo_token_generation_failed', err);
		return { error: `Failed to generate token for ${targetRepo}` };
	}
}

// Handler for POST /exchange_github_app_token_with_pat
// Exchanges a GitHub PAT for a GitHub App installation token (for testing/local development).
// DISABLED BY DEFAULT - set ENABLE_PAT_EXCHANGE=true to enable.
export async function handleExchangeTokenWithPAT(
	env: Env,
	authHeader: string | null,
	body: { owner?: string; repo?: string }
): Promise<ExchangeTokenResponse | ErrorResponse> {
	// Security: PAT exchange is disabled by default. Only enable for local development/testing.
	if (env.ENABLE_PAT_EXCHANGE !== 'true') {
		return { error: 'PAT exchange is disabled' };
	}

	if (!authHeader?.startsWith('Bearer ')) {
		return { error: 'Missing or invalid Authorization header' };
	}

	const pat = authHeader.slice(7);

	// Only allow tokens that look like PATs
	if (!pat.startsWith('github_pat_') && !pat.startsWith('ghp_')) {
		return { error: 'Invalid token format - expected a GitHub PAT' };
	}

	if (!body.owner || !body.repo) {
		return { error: 'Missing owner or repo in request body' };
	}

	const patLog = createLogger({ owner: body.owner, repo: body.repo });

	// Verify the PAT has write access to the repository
	const octokit = new Octokit({ auth: pat });
	try {
		const { data: repoData } = await octokit.repos.get({ owner: body.owner, repo: body.repo });
		const permissions = repoData.permissions;
		if (!permissions?.admin && !permissions?.push && !permissions?.maintain) {
			patLog.warn('pat_exchange_denied_no_write_access');
			return { error: `PAT does not have write permissions for ${body.owner}/${body.repo}` };
		}
	} catch {
		patLog.warn('pat_exchange_denied_no_access');
		return { error: `PAT does not have access to ${body.owner}/${body.repo}` };
	}

	try {
		// Get installation ID (throws on transient errors)
		const installationId = await getInstallationId(env, body.owner, body.repo);
		if (!installationId) {
			return { error: `GitHub App not installed for ${body.owner}/${body.repo}` };
		}

		// Scope the token to the requested repo only. The PAT proves the user has write access,
		// but we still limit the installation token to prevent privilege escalation if the app
		// is installed org-wide. A PAT with access to repo-a shouldn't yield a token for repo-b.
		const token = await generateInstallationToken(env, installationId, {
			repositoryNames: [body.repo],
			permissions: {
				contents: 'write',
				pull_requests: 'write',
				issues: 'write',
				metadata: 'read',
			},
		});

		// Audit log: PAT exchange (useful for tracking local dev usage)
		patLog.info('pat_token_exchanged');

		return { token };
	} catch (err) {
		patLog.errorWithException('pat_token_exchange_failed', err);
		return { error: `Failed to generate token for ${body.owner}/${body.repo}` };
	}
}
