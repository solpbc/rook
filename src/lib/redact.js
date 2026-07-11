// SPDX-License-Identifier: AGPL-3.0-only

const REDACTED = "[REDACTED]";
const SECRET_KEYS = new Set([
	"rsaprivatekeypem",
	"d",
	"access_token",
	"refresh_token",
	"authorization",
	"dpop",
	"token",
	"code",
	"tos_signature",
	"invite",
	"ref",
]);

function redactString(value) {
	return value
		.replace(
			/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g,
			REDACTED,
		)
		.replace(
			/(["'](?:d|access_token|refresh_token|authorization|dpop|token|code|tos_signature|invite|ref)["']\s*:\s*["'])[^"']*/gi,
			`$1${REDACTED}`,
		)
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
		.replace(/\b(?:rkat|rkrt)_[A-Za-z0-9._~-]+\b/g, REDACTED)
		.replace(/\b(Bearer|DPoP)\s+[A-Za-z0-9._~-]{20,}/gi, `$1 ${REDACTED}`)
		.replace(/\b(Authorization|DPoP)\s*:\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi, `$1: ${REDACTED}`)
		.replace(/([?&]code=)[^&#\s]*/gi, `$1${REDACTED}`)
		.replace(/(https?:\/\/[^\s#]+)#[^\s]*/gi, `$1#${REDACTED}`);
}

export function redactText(value) {
	return redactString(String(value));
}

function walk(value, seen, depth) {
	if (typeof value === "string") return redactText(value);
	if (value === null || typeof value !== "object") return value;
	if (depth > 12 || seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => walk(item, seen, depth + 1));
	const output = {};
	for (const [key, item] of Object.entries(value)) {
		output[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : walk(item, seen, depth + 1);
	}
	return output;
}

export function redact(value) {
	return walk(value, new WeakSet(), 0);
}
