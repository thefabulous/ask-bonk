import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { Env } from './types';

// GitHub's OIDC token issuer for Actions
const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
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

// Extracts owner/repo from OIDC claims
export function extractRepoFromClaims(claims: GitHubActionsJWTClaims): { owner: string; repo: string } {
	const [owner, repo] = claims.repository.split('/');
	return { owner, repo };
}

// Gets or looks up the installation ID for a repository
async function getInstallationId(env: Env, owner: string, repo: string): Promise<number | null> {
	const repoKey = `${owner}/${repo}`;

	// Check cache first
	const cached = await env.APP_INSTALLATIONS.get(repoKey);
	if (cached) {
		return parseInt(cached, 10);
	}

	// Look up via GitHub API using the app's JWT
	const auth = createAppAuth({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_APP_PRIVATE_KEY,
	});

	const { token } = await auth({ type: 'app' });
	const octokit = new Octokit({ auth: token });

	try {
		const response = await octokit.apps.getRepoInstallation({ owner, repo });
		const installationId = response.data.id;

		// Cache for future use
		await env.APP_INSTALLATIONS.put(repoKey, String(installationId));
		return installationId;
	} catch {
		return null;
	}
}

// Generates an installation token for the GitHub App
async function generateInstallationToken(env: Env, installationId: number): Promise<string> {
	const auth = createAppAuth({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_APP_PRIVATE_KEY,
		installationId,
	});

	const { token } = await auth({ type: 'installation' });
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

	// Get installation ID
	const installationId = await getInstallationId(env, owner, repo);
	if (!installationId) {
		return { error: `GitHub App not installed for ${owner}/${repo}` };
	}

	// Generate installation token
	const token = await generateInstallationToken(env, installationId);

	return { token };
}

// Handler for POST /exchange_github_app_token_with_pat
// Exchanges a GitHub PAT for a GitHub App installation token (for testing/local development)
export async function handleExchangeTokenWithPAT(
	env: Env,
	authHeader: string | null,
	body: { owner?: string; repo?: string }
): Promise<ExchangeTokenResponse | ErrorResponse> {
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

	// Verify the PAT has write access to the repository
	const octokit = new Octokit({ auth: pat });
	try {
		const { data: repoData } = await octokit.repos.get({ owner: body.owner, repo: body.repo });
		const permissions = repoData.permissions;
		if (!permissions?.admin && !permissions?.push && !permissions?.maintain) {
			return { error: `PAT does not have write permissions for ${body.owner}/${body.repo}` };
		}
	} catch {
		return { error: `PAT does not have access to ${body.owner}/${body.repo}` };
	}

	// Get installation ID
	const installationId = await getInstallationId(env, body.owner, body.repo);
	if (!installationId) {
		return { error: `GitHub App not installed for ${body.owner}/${body.repo}` };
	}

	// Generate installation token
	const token = await generateInstallationToken(env, installationId);

	return { token };
}
