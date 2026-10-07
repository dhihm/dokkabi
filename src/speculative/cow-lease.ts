import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { trustedSessionRoot } from "./promotion-journal.ts";

export interface CowWorkerLease {
	readonly sessionRoot: string;
	readonly candidateId: string;
	readonly token: string;
}

export function createCowWorkerLease(
	sessionRoot: string,
	candidateId: string,
): CowWorkerLease {
	if (!/^[0-9a-f]{64}$/u.test(candidateId))
		throw new TypeError("invalid Tier2 worker candidate id");
	const root = leaseRoot(sessionRoot, true);
	const lease = {
		sessionRoot: trustedSessionRoot(sessionRoot),
		candidateId,
		token: randomBytes(32).toString("hex"),
	} satisfies CowWorkerLease;
	const fd = openSync(
		leasePath(lease),
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, lease.token);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncDirectory(root);
	fsyncDirectory(lease.sessionRoot);
	return Object.freeze(lease);
}

export function releaseCowWorkerLease(lease: CowWorkerLease): void {
	const path = leasePath(lease);
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.size !== 64 ||
		readFileSync(path, "utf8") !== lease.token
	)
		return;
	rmSync(path);
	fsyncDirectory(leaseRoot(lease.sessionRoot, false));
}

export function cowWorkerLeaseActive(
	sessionRoot: string,
	candidateId: string,
): boolean {
	if (!/^[0-9a-f]{64}$/u.test(candidateId)) return true;
	try {
		const root = leaseRoot(sessionRoot, false);
		if (!existsSync(root)) return false;
		const path = join(root, `${candidateId}.lease`);
		if (!existsSync(path)) return false;
		lstatSync(path);
		return true;
	} catch (error) {
		if (error instanceof Error) return true;
		return true;
	}
}

function leaseRoot(sessionRoot: string, create: boolean): string {
	const root = join(trustedSessionRoot(sessionRoot), "tier2-workers");
	if (create && !existsSync(root)) mkdirSync(root, { mode: 0o700 });
	if (existsSync(root)) {
		const stat = lstatSync(root);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o777) !== 0o700
		)
			throw new TypeError("unsafe Tier2 worker lease root");
	}
	return root;
}

function leasePath(lease: CowWorkerLease): string {
	if (
		!/^[0-9a-f]{64}$/u.test(lease.candidateId) ||
		!/^[0-9a-f]{64}$/u.test(lease.token)
	) {
		throw new TypeError("invalid Tier2 worker lease");
	}
	return join(
		leaseRoot(lease.sessionRoot, false),
		`${lease.candidateId}.lease`,
	);
}

function fsyncDirectory(path: string): void {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
