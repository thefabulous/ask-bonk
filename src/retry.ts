import { RequestError } from '@octokit/request-error';

// Retry helper for transient failures (network, rate limits).
// 3 attempts total, exponential backoff starting at 5s (5s, 10s).
export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	const maxAttempts = 3;
	const baseDelayMs = 5000;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			// Don't retry client errors (4xx) - they won't succeed on retry
			if (err instanceof RequestError && err.status >= 400 && err.status < 500) {
				throw err;
			}

			if (attempt === maxAttempts) {
				throw err;
			}

			const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
			console.warn(`[${label}] Attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms:`, err);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	// TypeScript: unreachable, but needed for type inference
	throw new Error('Retry exhausted');
}
