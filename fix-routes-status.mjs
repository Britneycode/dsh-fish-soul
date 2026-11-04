// 修 routes.js：batchMs 归位 + 补 framedToday（装好的 lib 与补丁基线 work 各一份）
import fs from 'node:fs';

const files = [
	'C:/Users/xmlyyds/.dsh/profiles/desktop/node_modules/dsh-fish-soul/lib/routes.js',
	'C:/Users/xmlyyds/Documents/dsh-fish-138/work/lib/routes.js'
];

for (const p of files) {
	let t = fs.readFileSync(p, 'utf8');
	const before = t;

	// 1) 错误位置（browse 里）的 batchMs 去掉
	t = t.replace(/\n\t+batchMs: q\.batchMs \?\? 3000,(?=\n)/g, (m, off) => {
		// 只删出现在 browse 块里的那行（后面紧跟 comment / frames / search 字段）
		const rest = t.slice(off, off + 200);
		return /comment|frames|search|danmaku/.test(rest) ? '' : m;
	});

	// 2) 正确的 qq 块里补上（如果还没有）
	const qqAnchor = 'followUpSeconds: q.followUpSeconds ?? 120,';
	if (t.includes(qqAnchor) && !/followUpSeconds[\s\S]{0,80}batchMs/.test(t)) {
		const line = t.split('\n').find((l) => l.includes(qqAnchor));
		const indent = line.match(/^\s*/)[0];
		t = t.replace(line, line + '\n' + indent + 'batchMs: q.batchMs ?? 3000,');
	}

	// 3) browse 状态补 framedToday（UI 要显示"今天看了几条"）
	if (!t.includes('framedToday')) {
		const a = t.split('\n').find((l) => l.includes('framesPerDay: br.framesPerDay ?? 1,'));
		if (a) {
			const indent = a.match(/^\s*/)[0];
			t = t.replace(a, a + '\n' + indent + 'framedToday: browser?.framedToday?.() ?? 0,');
		}
	}

	fs.writeFileSync(p, t, 'utf8');
	const check = (s) => [
		/q\.batchMs \?\? 3000/.test(s) ? 'qq-batch ok' : 'qq-batch MISSING',
		/framedToday/.test(s) ? 'framedToday ok' : 'framedToday MISSING'
	].join(' / ');
	console.log(p.endsWith('work/lib/routes.js') ? 'work  ' : 'inst  ', check(t), before === t ? '(未变)' : '(已改)');
}
