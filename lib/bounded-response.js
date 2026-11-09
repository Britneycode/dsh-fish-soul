/** Limit actual bytes as they arrive; Content-Length alone can be missing or wrong. */
export async function readResponseBounded(response, maxBytes) {
	const size = Number(response.headers?.get('content-length'));
	if (Number.isFinite(size) && size > maxBytes) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks, total);
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(Buffer.from(value));
		}
	} finally { reader.releaseLock(); }
}
