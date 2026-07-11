// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "./error-format.js";

// The Tangled appview renders pulls as server HTML only; there is no XRPC that
// maps a pull AT-URI to its numeric web id. The list page exposes only
// /pulls/<id> links, while each pull page carries the record AT-URI as a
// data-aturi attribute. Resolution therefore lists candidates newest-first and
// confirms each candidate's AT-URI, never trusting title or list position.
export const DEFAULT_APPVIEW_ORIGIN = "https://tangled.org";

function extractPullIds(html) {
	const ids = new Set();
	const pattern = /\/pulls\/(\d+)/g;
	let match = pattern.exec(html);
	while (match !== null) {
		ids.add(Number(match[1]));
		match = pattern.exec(html);
	}
	return [...ids].sort((a, b) => b - a);
}

function pageMatchesAtUri(html, pullUri) {
	return html.includes(`data-aturi="${pullUri}"`) || html.includes(`data-aturi='${pullUri}'`);
}

export async function resolveRenderedPullUrl(
	pullUri,
	{ appviewOrigin = DEFAULT_APPVIEW_ORIGIN, owner, repoSlug },
	dependencies = {},
) {
	if (
		typeof pullUri !== "string" ||
		pullUri.length === 0 ||
		typeof owner !== "string" ||
		owner.length === 0 ||
		typeof repoSlug !== "string" ||
		repoSlug.length === 0
	) {
		throw new RookError("rendered pull URL request is invalid", {
			code: "rendered-url-unresolved",
		});
	}
	const fetchImpl = dependencies.fetch ?? globalThis.fetch;
	const clock = dependencies.clock ?? (() => Date.now());
	const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const deadline = clock() + (dependencies.renderedUrlDeadlineMs ?? 30_000);
	const maxRounds = dependencies.renderedUrlMaxRounds ?? 12;
	const maxCandidates = dependencies.renderedUrlMaxCandidates ?? 25;
	const requestTimeoutMs = dependencies.renderedUrlRequestTimeoutMs ?? 10_000;
	const maxDelay = dependencies.renderedUrlMaxDelayMs ?? 5_000;
	let delay = dependencies.renderedUrlInitialDelayMs ?? 1_000;
	const base = `${appviewOrigin.replace(/\/+$/, "")}/${owner}/${repoSlug}/pulls`;

	const get = async (url) => {
		const remaining = deadline - clock();
		if (remaining <= 0) return undefined;
		let response;
		try {
			const signal = AbortSignal.timeout(Math.min(requestTimeoutMs, remaining));
			response = await fetchImpl(url, { signal, redirect: "follow" });
		} catch {
			return undefined;
		}
		if (!response.ok) return undefined;
		try {
			return await response.text();
		} catch {
			return undefined;
		}
	};

	for (let round = 0; round < maxRounds && clock() <= deadline; round += 1) {
		const listHtml = await get(base);
		if (listHtml !== undefined) {
			const ids = extractPullIds(listHtml).slice(0, maxCandidates);
			for (const id of ids) {
				if (clock() > deadline) break;
				const pageUrl = `${base}/${id}`;
				const pageHtml = await get(pageUrl);
				if (pageHtml !== undefined && pageMatchesAtUri(pageHtml, pullUri)) {
					return pageUrl;
				}
			}
		}
		if (clock() > deadline) break;
		await sleep(Math.min(delay, Math.max(0, deadline - clock())));
		delay = Math.min(delay * 2, maxDelay);
	}
	throw new RookError("rendered pull URL did not converge", {
		code: "rendered-url-unresolved",
		remediation: "run rook pr again once the pull is indexed",
	});
}
