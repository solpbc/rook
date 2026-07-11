// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "../lib/error-format.js";
import { readIdentity } from "../lib/identity.js";
import { resolveIdentityPath } from "../lib/paths.js";
import { redactText } from "../lib/redact.js";
import { assertContextIdentity, restoreContext } from "../lib/session-context.js";
import { forkCore } from "./fork.js";
import { prCore } from "./pr.js";
import { pushCore } from "./push.js";
import { shipCore } from "./ship.js";

const STAGE_NAMES = ["fork", "push", "pr", "ship"];

// Every value here is rook-internal (stage names, codes, URIs, outcomes) except
// error text, which is scrubbed. Codes are stable constants, so the summary is
// emitted without the object redaction walk that would blank a `code` field.
function stageError(error) {
	return {
		code: error?.code ? redactText(String(error.code)) : "unknown",
		error: redactText(error instanceof Error ? error.message : String(error)),
		...(error?.remediation ? { remediation: redactText(String(error.remediation)) } : {}),
	};
}

function summarizeResult(name, result) {
	if (name === "fork") {
		return {
			knotRepoDid: result.knotRepoDid,
			record: result.record.outcome,
			remote: result.remote.outcome,
		};
	}
	if (name === "push") {
		return { branch: result.branch, tip: result.tip };
	}
	if (name === "pr") {
		return {
			pull: result.outcome,
			pullUri: result.pullUri,
			renderedPullUrl: result.renderedPullUrl,
		};
	}
	return { cap: result.outcome, capUri: result.capUri, capRef: result.capRef };
}

function buildSummary(stages, failure) {
	const ok = !failure && STAGE_NAMES.every((name) => stages[name].status === "completed");
	return {
		ok,
		stages,
		...(failure ? { stage: failure.stage, code: failure.code, recovery: failure.recovery } : {}),
	};
}

async function promoteOnce(context) {
	let promoted = false;
	try {
		await context.transaction.promote();
		promoted = true;
	} catch (error) {
		if (error instanceof RookError) throw error;
		throw new RookError("OAuth session could not be promoted", {
			stage: "session",
			code: "session-invalid",
			remediation: "run rook login",
		});
	} finally {
		if (!promoted) await context.transaction.rollback().catch(() => {});
	}
}

// fork -> push -> pr -> ship under one restored, promoted session. Stops at the
// first failure, naming the stage and its recovery command; later stages stay
// skipped and are never reported completed.
export async function submit(options, dependencies = {}) {
	const cwd = dependencies.cwd ?? process.cwd();
	const upstream = options.upstream;
	const stages = Object.fromEntries(STAGE_NAMES.map((name) => [name, { status: "skipped" }]));

	let context;
	try {
		let identityPath;
		try {
			identityPath = resolveIdentityPath(options, dependencies.env, cwd);
		} catch {
			throw new RookError("selected identity path is invalid", {
				stage: "gate",
				code: "identity-invalid",
				remediation: "run rook enroll --invite <url> --handle <name>",
			});
		}
		const identity = await (dependencies.readIdentity ?? readIdentity)(identityPath);
		if (!identity) {
			throw new RookError("no enrolled identity is available", {
				stage: "gate",
				code: "identity-invalid",
				remediation: "run rook enroll --invite <url> --handle <name>",
			});
		}
		context = await (dependencies.restoreContext ?? restoreContext)(
			identity,
			identityPath,
			dependencies,
		);
		assertContextIdentity(context, identity);
		await promoteOnce(context);
	} catch (error) {
		const detail = stageError(error);
		const recovery = `run rook fork ${upstream}`;
		stages.fork = { status: "failed", ...detail, recovery };
		return buildSummary(stages, { stage: "fork", code: detail.code, recovery });
	}

	const runners = [
		{
			name: "fork",
			core: dependencies.forkCore ?? forkCore,
			opts: { ...options, upstreamRepoUrl: upstream },
			recovery: `run rook fork ${upstream}`,
		},
		{
			name: "push",
			core: dependencies.pushCore ?? pushCore,
			opts: { ...options, branch: options.branch, json: true },
			recovery: "run rook push",
		},
		{
			name: "pr",
			core: dependencies.prCore ?? prCore,
			opts: { ...options, appendWhenExists: true },
			recovery: "run rook pr",
		},
		{
			name: "ship",
			core: dependencies.shipCore ?? shipCore,
			opts: { ...options, request: options.request },
			recovery: "run rook ship",
		},
	];

	for (const runner of runners) {
		try {
			const result = await runner.core(runner.opts, context, dependencies);
			stages[runner.name] = { status: "completed", ...summarizeResult(runner.name, result) };
		} catch (error) {
			const detail = stageError(error);
			stages[runner.name] = { status: "failed", ...detail, recovery: runner.recovery };
			return buildSummary(stages, {
				stage: runner.name,
				code: detail.code,
				recovery: runner.recovery,
			});
		}
	}
	return buildSummary(stages);
}

function humanSummary(summary) {
	const lines = [];
	for (const name of STAGE_NAMES) {
		const stage = summary.stages[name];
		if (stage.status === "completed") {
			lines.push(`${name} completed`);
		} else if (stage.status === "failed") {
			lines.push(`${name} failed: ${stage.code}`);
			lines.push(`error: ${stage.error}`);
			lines.push(`recovery: ${stage.recovery}`);
		} else {
			lines.push(`${name} skipped`);
		}
	}
	return lines.join("\n");
}

export function register(program, dependencies = {}) {
	const stdout = dependencies.stdout ?? process.stdout;
	program
		.command("submit")
		.description("run fork, push, pr, and ship in order under one session")
		.argument("<upstream>")
		.option("--request <cap-uri>", "reply to a request cap at this org.v-it.cap URI")
		.option("--branch <name>", "push this branch instead of the current one")
		.option("--json", "emit one structured JSON stage summary")
		.action(async (upstream, localOptions, command) => {
			const json = Boolean(localOptions.json);
			try {
				const summary = await submit(
					{ ...command.optsWithGlobals(), ...localOptions, upstream },
					dependencies,
				);
				if (json) {
					stdout.write(`${JSON.stringify(summary)}\n`);
				} else {
					stdout.write(`${redactText(humanSummary(summary))}\n`);
				}
				if (!summary.ok) process.exitCode = 1;
			} catch (error) {
				// submit() is expected to fold failures into the summary; this guards
				// against an unexpected throw without leaking secrets.
				const detail = stageError(error);
				stdout.write(`${JSON.stringify({ ok: false, stage: "submit", ...detail })}\n`);
				process.exitCode = 1;
			}
		});
}
