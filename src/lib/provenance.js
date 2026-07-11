// SPDX-License-Identifier: AGPL-3.0-only

export function findProvenanceOffenders(rows, did) {
	return rows.filter(
		({ authorEmail, committerEmail }) => authorEmail !== did || committerEmail !== did,
	);
}

export function provenanceRepairSteps(did, base) {
	return [
		`git config user.email '${did}'`,
		`git rebase -i ${base}`,
		"mark each offending commit for edit",
		"git commit --amend --reset-author",
		"git rebase --continue",
		"review the rewritten history before rerunning rook push",
	].join("; ");
}
