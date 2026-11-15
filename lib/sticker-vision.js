/** 表情看图：每次单独保存失败类型，不能读取其他并发调用共用的 lastError。 */
export function createStickerVision(llmRouter, { timeoutMs = 20_000 } = {}) {
	if (!llmRouter) return null;
	return async (prompt, images, { onFailure } = {}) => {
		const failureInfo = {};
		const controller = new AbortController();
		let timedOut = false;
		let timer;
		try {
			const result = await Promise.race([
				llmRouter.call(prompt, { feature: 'other', maxTokens: 60, images, needImages: true, signal: controller.signal, failureInfo }),
				new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(null); }, timeoutMs); timer.unref?.(); })
			]);
			if (result === null || result === undefined || String(result).trim() === '') onFailure?.(timedOut ? 'timeout' : (failureInfo.code || 'no_response'));
			return result;
		} catch {
			onFailure?.(timedOut ? 'timeout' : 'model_error');
			return null;
		} finally { clearTimeout(timer); }
	};
}
