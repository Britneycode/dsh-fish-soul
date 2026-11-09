/**
 * Limit actual bytes as they arrive; Content-Length alone can be missing or wrong.
 *
 * ⚠️ 入站媒体（图片 / 语音 / QQ 附件）已全部改走 safe-download.js，那条路还要做 DNS 固定
 * 和私网拒绝，所以生产代码里不再用这个函数。现在只剩 test/security-boundaries.mjs
 * 在测它本身的行为；哪天那个测试也改成测 safe-download，这个文件就可以删了。
 */
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
