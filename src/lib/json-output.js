// SPDX-License-Identifier: AGPL-3.0-only

import { formatError } from "./error-format.js";
import { redact } from "./redact.js";

function write(stream, value) {
	stream.write(`${typeof value === "string" ? value : JSON.stringify(redact(value))}\n`);
}

export function createOutput(options = {}) {
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const json = Boolean(options.json);
	return {
		json,
		vlog(message) {
			write(json ? stderr : stdout, redact(message));
		},
		success(fields, human) {
			if (json) write(stdout, { ok: true, ...redact(fields) });
			else if (human) write(stdout, redact(human));
		},
		failure(error) {
			const formatted = formatError(error);
			if (json) write(stdout, { ok: false, ...formatted });
			else write(stderr, formatted.error);
		},
	};
}
