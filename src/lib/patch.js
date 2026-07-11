// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from "node:child_process";
import { gzipSync } from "node:zlib";
import { RookError } from "./error-format.js";
import { redactText } from "./redact.js";

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

// The outgoing range is the same two-dot range push proves provenance over:
// commits reachable from the pushed tip but not from the stored upstream base.
// `--no-signature` drops git's version-dependent trailer so the same tips
// produce byte-identical patches regardless of the local git version. Merge
// commits are omitted by format-patch's default behaviour; the range stays
// deterministic. The raw patch is data destined for a blob, never a log, so it
// is captured unredacted; only diagnostic stderr is redacted on failure.
function runFormatPatch(cwd, base, tip, dependencies) {
	const maxBuffer = dependencies.maxGitOutputBytes ?? DEFAULT_MAX_BUFFER;
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["format-patch", "--stdout", "--no-signature", `${base}..${tip}`],
			{
				cwd,
				env: dependencies.env ?? process.env,
				encoding: "buffer",
				shell: false,
				maxBuffer,
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolve(stdout);
					return;
				}
				if (
					error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
					/maxBuffer length exceeded/i.test(error.message)
				) {
					reject(
						new RookError("outgoing patch exceeded the configured limit", {
							code: "outgoing-range-too-large",
							remediation: "open the pull from a smaller commit range",
						}),
					);
					return;
				}
				const detail = redactText(
					Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
				);
				reject(
					new RookError("could not build the outgoing patch", {
						code: "format-patch-failed",
						remediation: "git fetch origin; rerun rook fork if the default branch moved",
						...(detail.trim() ? { cause: new Error(detail.trim()) } : {}),
					}),
				);
			},
		);
	});
}

export async function formatPatch(cwd, base, tip, dependencies = {}) {
	const raw = await runFormatPatch(cwd, base, tip, dependencies);
	if (!raw || raw.length === 0) {
		throw new RookError("outgoing range has no commits to open a pull", {
			code: "outgoing-range-empty",
			remediation: "push commits on this branch before opening a pull",
		});
	}
	return gzipSync(raw, { level: 9, mtime: 0 });
}
