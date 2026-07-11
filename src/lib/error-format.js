// SPDX-License-Identifier: AGPL-3.0-only

import { redact, redactText } from "./redact.js";

export class RookError extends Error {
	constructor(message, options = {}) {
		super(message, options);
		this.name = "RookError";
		this.hint = options.hint;
		this.stage = options.stage;
		this.code = options.code;
		this.remediation = options.remediation;
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
	const safe = redact({
		error: message,
		...(error?.stage ? { stage: error.stage } : {}),
		...(error?.remediation ? { remediation: error.remediation } : {}),
		...(causes.length > 0 ? { causes } : {}),
		...(error?.hint ? { hint: error.hint } : {}),
	});
	return {
		error: safe.error,
		...(safe.stage ? { stage: safe.stage } : {}),
		...(error?.code ? { code: redactText(error.code) } : {}),
		...(safe.remediation ? { remediation: safe.remediation } : {}),
		...(safe.causes ? { causes: safe.causes } : {}),
		...(safe.hint ? { hint: safe.hint } : {}),
	};
}
