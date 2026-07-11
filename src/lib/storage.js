// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs/promises";
import path from "node:path";

let temporaryCounter = 0;

function isMissing(error) {
	return error?.code === "ENOENT";
}

async function ensureDirectory(filePath, fsOps) {
	await fsOps.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

async function createTemporaryFile(filePath, data, fsOps) {
	await ensureDirectory(filePath, fsOps);
	const counter = ++temporaryCounter;
	const temporaryPath = path.join(
		path.dirname(filePath),
		`${path.basename(filePath)}.tmp.${process.pid}.${counter}`,
	);
	let handle;
	try {
		handle = await fsOps.open(temporaryPath, "wx", 0o600);
		await handle.chmod(0o600);
		await handle.writeFile(data);
		if (typeof handle.sync === "function") await handle.sync();
		await handle.close();
		handle = undefined;
		return temporaryPath;
	} catch (error) {
		if (handle) await handle.close().catch(() => {});
		await fsOps.unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

export async function atomicWriteFile(filePath, data, fsOps = fs) {
	const temporaryPath = await createTemporaryFile(filePath, data, fsOps);
	try {
		await fsOps.rename(temporaryPath, filePath);
	} catch (error) {
		await fsOps.unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

export async function atomicCreateFile(filePath, data, fsOps = fs) {
	const temporaryPath = await createTemporaryFile(filePath, data, fsOps);
	try {
		await fsOps.link(temporaryPath, filePath);
	} catch (error) {
		await fsOps.unlink(temporaryPath).catch(() => {});
		throw error;
	}
	await fsOps.unlink(temporaryPath).catch(() => {});
}

export async function readJsonFile(filePath, fsOps = fs) {
	let bytes;
	try {
		bytes = await fsOps.readFile(filePath, "utf8");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
	return JSON.parse(bytes);
}

function own(map, key) {
	return Object.hasOwn(map, key);
}

export class AtomicMapStore {
	constructor(pathHolder, options = {}) {
		this.pathHolder = pathHolder;
		this.fs = options.fs ?? fs;
	}

	async readMap() {
		const value = await readJsonFile(this.pathHolder.path, this.fs);
		if (value === undefined) return Object.create(null);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new TypeError(`store at ${this.pathHolder.path} is not a JSON object`);
		}
		return Object.assign(Object.create(null), value);
	}

	async writeMap(map) {
		await atomicWriteFile(this.pathHolder.path, `${JSON.stringify(map, null, 2)}\n`, this.fs);
	}

	async get(key) {
		const map = await this.readMap();
		return own(map, key) ? map[key] : undefined;
	}

	async set(key, value) {
		const map = await this.readMap();
		map[key] = value;
		await this.writeMap(map);
	}

	async del(key) {
		const map = await this.readMap();
		if (!own(map, key)) return;
		delete map[key];
		if (Object.keys(map).length === 0) {
			await this.fs.unlink(this.pathHolder.path).catch((error) => {
				if (!isMissing(error)) throw error;
			});
			return;
		}
		await this.writeMap(map);
	}

	async clear() {
		await this.fs.unlink(this.pathHolder.path).catch((error) => {
			if (!isMissing(error)) throw error;
		});
	}
}

export class ExpiringStateStore extends AtomicMapStore {
	constructor(pathHolder, options = {}) {
		super(pathHolder, options);
		this.clock = options.clock ?? (() => Date.now());
		this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
	}

	async expire() {
		try {
			const stat = await this.fs.stat(this.pathHolder.path);
			if (this.clock() - stat.mtimeMs > this.ttlMs) await this.clear();
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}

	async get(key) {
		await this.expire();
		return super.get(key);
	}

	async set(key, value) {
		await this.expire();
		await this.writeMap({ [key]: value });
	}

	async del(key) {
		await this.expire();
		return super.del(key);
	}
}

export function createOAuthStores(sessionPath, statePath, options = {}) {
	const sessionPathHolder = { path: sessionPath };
	const statePathHolder = { path: statePath };
	return {
		sessionPathHolder,
		statePathHolder,
		sessionStore: new AtomicMapStore(sessionPathHolder, options),
		stateStore: new ExpiringStateStore(statePathHolder, options),
	};
}

export class LoginStorageTransaction {
	constructor(sessionPath, statePath, options = {}) {
		this.sessionPath = sessionPath;
		this.statePath = statePath;
		this.fs = options.fs ?? fs;
		this.clock = options.clock;
		const id = `${process.pid}.${++temporaryCounter}`;
		this.stageSessionPath = `${sessionPath}.stage.${id}`;
		this.stageStatePath = `${statePath}.stage.${id}`;
		this.promoted = false;
		this.started = false;
	}

	async start() {
		if (this.started) throw new Error("login storage transaction already started");
		this.started = true;
		let bytes;
		try {
			bytes = await this.fs.readFile(this.sessionPath);
		} catch (error) {
			if (!isMissing(error)) throw error;
			bytes = Buffer.from("{}\n");
		}
		try {
			await atomicWriteFile(this.stageSessionPath, bytes, this.fs);
			await atomicWriteFile(this.stageStatePath, "{}\n", this.fs);
		} catch (error) {
			for (const filePath of [this.stageSessionPath, this.stageStatePath]) {
				await this.fs.unlink(filePath).catch(() => {});
			}
			throw error;
		}
		this.stores = createOAuthStores(this.stageSessionPath, this.stageStatePath, {
			fs: this.fs,
			clock: this.clock,
		});
		return this;
	}

	async promote() {
		if (!this.started || this.promoted)
			throw new Error("login storage transaction cannot be promoted");
		await this.fs.chmod(this.stageSessionPath, 0o600);
		await ensureDirectory(this.sessionPath, this.fs);
		await this.fs.unlink(this.stageStatePath).catch((error) => {
			if (!isMissing(error)) throw error;
		});
		await this.fs.rename(this.stageSessionPath, this.sessionPath);
		this.stores.sessionPathHolder.path = this.sessionPath;
		this.promoted = true;
	}

	async rollback() {
		for (const filePath of [this.stageSessionPath, this.stageStatePath]) {
			await this.fs.unlink(filePath).catch((error) => {
				if (!isMissing(error)) throw error;
			});
		}
	}
}

export async function fileMode(filePath, fsOps = fs) {
	try {
		const stat = await fsOps.stat(filePath);
		return stat.mode & 0o777;
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

export async function fileExists(filePath, fsOps = fs) {
	try {
		await fsOps.access(filePath);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}
