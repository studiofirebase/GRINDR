import { $ } from "bun";
import { dirname } from "node:path";

import { repo } from "./config";

async function releaseKey(): Promise<string> {
	const keysDocument = `${repo}/KEYS.md`;
	const keys = new Set(
		(await Bun.file(keysDocument).text())
			.split(/[\s;`]/)
			.filter((token) => token.startsWith("RW") && token.length === 56),
	);
	const [key] = keys;
	if (!key || keys.size > 1) {
		throw new Error(
			`${keysDocument} has to publish exactly one minisign key, found ${keys.size}`,
		);
	}
	return key;
}

async function verifies({
	file,
	signature,
	key,
}: {
	file: string;
	signature: string;
	key: string;
}): Promise<boolean> {
	const { exitCode } = await $`minisign -Vm ${file} -x ${signature} -P ${key}`
		.quiet()
		.nothrow();
	return exitCode === 0;
}

async function fetchInto({
	url,
	file,
}: {
	url: string;
	file: string;
}): Promise<void> {
	const { exitCode } = await $`curl -fL --output ${file} ${url}`.nothrow();
	if (exitCode !== 0) throw new Error(`could not download ${url}`);
}

export async function verifiedDownload({
	url,
	file,
}: {
	url: string;
	file: string;
}): Promise<string> {
	const key = await releaseKey();
	const signature = `${file}.minisig`;
	if (await verifies({ file, signature, key })) return file;

	const part = `${file}.part`;
	await $`rm -f ${file} ${signature} ${part}`;
	await $`mkdir -p ${dirname(file)}`;
	console.log(`downloading ${url}…`);
	await fetchInto({ url: `${url}.minisig`, file: signature });
	await fetchInto({ url, file: part });
	if (!(await verifies({ file: part, signature, key }))) {
		await $`rm -f ${part} ${signature}`;
		throw new Error(`${url} does not verify against the key in KEYS.md`);
	}
	await $`mv ${part} ${file}`;
	return file;
}
