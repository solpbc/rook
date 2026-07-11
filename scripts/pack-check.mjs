// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
	"src/lib/network.js",
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
const probe = fileURLToPath(new URL("vit-cap-probe.mjs", import.meta.url));

// The frozen vit tarball is supplied out of band (no /tmp path is committed).
// When present, install it alongside rook so the vit@0.6.0 dependency resolves
// before it is published, and prove vit/cap.js imports and runs from the install.
const vitTarball = process.env.ROOK_VIT_TARBALL;
const mounts = ["-v", `${tarball}:/tmp/rook.tgz:ro`, "-v", `${probe}:/probe.mjs:ro`];
let installArgs = "/tmp/rook.tgz";
if (vitTarball) {
	mounts.push("-v", `${path.resolve(vitTarball)}:/tmp/vit.tgz:ro`);
	installArgs = "/tmp/vit.tgz /tmp/rook.tgz";
}
const script = [
	"npm config set engine-strict true",
	`npm install --prefix /tmp/rook-install ${installArgs}`,
	"cp /probe.mjs /tmp/rook-install/probe.mjs",
	"node /tmp/rook-install/probe.mjs",
	"printf '\\n__ROOK_HELP__\\n'",
	"/tmp/rook-install/node_modules/.bin/rook --help",
].join(" && ");

try {
	const container = await run("docker", [
		"run",
		"--rm",
		...mounts,
		"node:20.10.0",
		"sh",
		"-lc",
		script,
	]);
	const combined = `${container.stdout}${container.stderr}`;
	if (container.code !== 0) throw new Error(`Node 20.10 packaging acceptance failed:\n${combined}`);
	if (/EBADENGINE/i.test(combined))
		throw new Error(`Node 20.10 install emitted EBADENGINE:\n${combined}`);
	if (!/__VIT_CAP_OK__/.test(combined))
		throw new Error(`installed vit/cap.js did not resolve or invoke:\n${combined}`);
	const helpOutput = container.stdout.split("__ROOK_HELP__\n")[1];
	const firstHelpLine = helpOutput?.split(/\r?\n/)[0];
	if (firstHelpLine !== "rook ✦ on the job")
		throw new Error(`installed rook help did not print the required banner:\n${combined}`);
	process.stdout.write(
		"pack allowlist passed\nNode 20.10.0 clean install passed with no EBADENGINE\nvit/cap.js resolved and invoked\nrook ✦ on the job\n",
	);
} finally {
	await fs.unlink(tarball).catch(() => {});
}
