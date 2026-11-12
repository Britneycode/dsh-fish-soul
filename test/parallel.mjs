// CI 并行测试 runner：把 package.json 里串行 `node test/x && node test/y` 的全部套件
// 拆成 N 个并行进程跑。所有测试都用 listen(0) 随机端口 + mkdtemp 临时目录，互不干扰（已核实）。
// 用法：node test/parallel.mjs [并发数]   默认 4（GitHub ubuntu-latest 是 4 vCPU）
// 失败任何一个立刻退出非 0，并打出失败套件名。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 从 package.json 的 test 脚本解析出测试文件列表，保证「不减少必要测试项」
const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts.test;
const files = [...script.matchAll(/node\s+(test\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
if (files.length === 0) { console.error('没从 package.json 解析出测试文件'); process.exit(1); }

const CONC = Math.max(1, Number(process.argv[2]) || 4);
console.log(`并行跑 ${files.length} 个套件，并发 ${CONC}`);

let failed = null;
let idx = 0;
async function worker(id) {
	while (idx < files.length && !failed) {
		const f = files[idx++];
		const t = Date.now();
		const code = await new Promise((res) => {
			const p = spawn('node', [f], { stdio: ['ignore', 'pipe', 'pipe'] });
			let out = '';
			p.stdout.on('data', (d) => (out += d));
			p.stderr.on('data', (d) => (out += d));
			p.on('close', (c) => { if (c !== 0) process.stdout.write(out); res(c); });
		});
		const s = ((Date.now() - t) / 1000).toFixed(1);
		if (code !== 0) { failed = f; console.error(`✗ ${f} (${s}s) exit=${code}`); break; }
		console.log(`✓ ${f} (${s}s)`);
	}
}
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
if (failed) { console.error(`\n失败：${failed}`); process.exit(1); }
console.log(`\n全部 ${files.length} 个套件通过`);
