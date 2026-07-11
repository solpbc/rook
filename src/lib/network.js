// SPDX-License-Identifier: AGPL-3.0-only

const DEFAULT_TIMEOUT_MS = 15_000;

export function timeoutSignal(options = {}) {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
}

export function withTimeout(init = {}, options = {}) {
	const deadline = timeoutSignal(options);
	return {
		...init,
		signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
	};
}

export function timeoutFetch(fetchImpl = globalThis.fetch, options = {}) {
	return (input, init) => fetchImpl(input, withTimeout(init, options));
}
