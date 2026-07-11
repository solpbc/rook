// SPDX-License-Identifier: AGPL-3.0-only

import { redact } from "./redact.js";

export class RookError extends Error {
	constructor(message, options = {}) {
		super(message, options);
		this.name = "RookError";
		this.hint = options.hint;
	}
}

export function formatError(error) {
	const message = error instanceof Error ? error.message : String(error);
	const causes = [];
	let cause = error instanceof Error ? error.cause : undefined;
	const seen = new Set();
	while (cause !== undefined && cause !== null && causes.length < 8 && !seen.has(cause)) {
		seen.add(cause);
		causes.push(cause instanceof Error ? cause.message : String(cause));
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return redact({
		error: message,
		...(causes.length > 0 ? { causes } : {}),
		...(error?.hint ? { hint: error.hint } : {}),
	});
}
