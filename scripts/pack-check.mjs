// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

const packed = await run("npm", ["pack", "--json"]);
if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`);
let report;
try {
	report = JSON.parse(packed.stdout)[0];
} catch (cause) {
	throw new Error("npm pack did not return valid JSON", { cause });
}
const paths = report.files.map(({ path: filePath }) => filePath.replace(/^package\//, ""));
const requiredFiles = [
	"bin/rook.js",
	"README.md",
	"LICENSE",
	"package.json",
	"src/cli.js",
	"src/cmd/enroll.js",
	"src/cmd/login.js",
	"src/cmd/whoami.js",
	"src/cmd/doctor.js",
	"src/lib/paths.js",
	"src/lib/storage.js",
	"src/lib/identity.js",
	"src/lib/welcome-mat.js",
	"src/lib/oauth.js",
	"src/lib/discovery.js",
	"src/lib/knot.js",
	"src/lib/redact.js",
	"src/lib/json-output.js",
	"src/lib/error-format.js",
];
for (const required of requiredFiles) {
	if (!paths.includes(required)) throw new Error(`packed tarball is missing ${required}`);
}
const forbidden = ["test/", "docs/", "coverage/", "node_modules/", "biome.json"];
for (const filePath of paths) {
	if (forbidden.some((entry) => filePath === entry || filePath.startsWith(entry))) {
		throw new Error(`packed tarball contains forbidden path ${filePath}`);
	}
}

const tarball = path.resolve(report.filename);
try {
	const container = await run("docker", [
		"run",
		"--rm",
		"-v",
		`${tarball}:/tmp/rook.tgz:ro`,
		"node:20.10.0",
		"sh",
		"-lc",
		"npm config set engine-strict true && npm install --prefix /tmp/rook-install /tmp/rook.tgz && printf '\\n__ROOK_HELP__\\n' && /tmp/rook-install/node_modules/.bin/rook --help",
	]);
	const combined = `${container.stdout}${container.stderr}`;
	if (container.code !== 0) throw new Error(`Node 20.10 packaging acceptance failed:\n${combined}`);
	if (/EBADENGINE/i.test(combined))
		throw new Error(`Node 20.10 install emitted EBADENGINE:\n${combined}`);
	const helpOutput = container.stdout.split("__ROOK_HELP__\n")[1];
	const firstHelpLine = helpOutput?.split(/\r?\n/)[0];
	if (firstHelpLine !== "rook ✦ on the job")
		throw new Error(`installed rook help did not print the required banner:\n${combined}`);
	process.stdout.write(
		"pack allowlist passed\nNode 20.10.0 clean install passed with no EBADENGINE\nrook ✦ on the job\n",
	);
} finally {
	await fs.unlink(tarball).catch(() => {});
}
