/**
 * qrcode.js —— 极简 QR 码生成（字节模式，纠错 L/M，版本 1–40），只用于设置页显示 B站扫码登录二维码。
 * 零依赖；算法与常量表参照 Project Nayuki 的 QR Code generator（MIT）。
 */

const ECC_CODEWORDS_PER_BLOCK = {
	L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
};
const NUM_ERROR_CORRECTION_BLOCKS = {
	L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
};
const FORMAT_BITS = { L: 1, M: 0 };

function rawDataModules(ver) {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const numAlign = Math.floor(ver / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (ver >= 7) result -= 36;
	}
	return result;
}

function dataCodewords(ver, ecl) {
	return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
}

function gfMul(x, y) {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function rsDivisor(degree) {
	const result = new Array(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMul(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = gfMul(root, 0x02);
	}
	return result;
}

function rsRemainder(data, divisor) {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ result.shift();
		result.push(0);
		divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
	}
	return result;
}

function alignmentPositions(ver) {
	if (ver === 1) return [];
	const size = ver * 4 + 17;
	const numAlign = Math.floor(ver / 7) + 2;
	const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
	const result = [6];
	for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
	return result;
}

const MASKS = [
	(x, y) => (x + y) % 2 === 0,
	(x, y) => y % 2 === 0,
	(x) => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

/**
 * 生成 QR 矩阵。
 * @param {string} text
 * @param {'L'|'M'} [ecl]
 * @returns {boolean[][]} modules[y][x]，true = 深色
 */
export function encodeQr(text, ecl = 'M') {
	const bytes = [...Buffer.from(String(text), 'utf8')];
	let ver = 1;
	for (; ver <= 40; ver++) {
		const countBits = ver < 10 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= dataCodewords(ver, ecl) * 8) break;
	}
	if (ver > 40) throw new Error('二维码内容太长');
	const size = ver * 4 + 17;

	// ── 数据位流 ──
	const bits = [];
	const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
	push(0b0100, 4);
	push(bytes.length, ver < 10 ? 8 : 16);
	for (const b of bytes) push(b, 8);
	const capacity = dataCodewords(ver, ecl) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	const data = [];
	for (let i = 0; i < bits.length; i += 8) {
		let b = 0;
		for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
		data.push(b);
	}

	// ── 纠错码与交织 ──
	const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
	const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
	const rawCodewords = Math.floor(rawDataModules(ver) / 8);
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);
	const divisor = rsDivisor(blockEccLen);
	const blocks = [];
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < numShortBlocks) dat.push(0);
		blocks.push(dat.concat(ecc));
	}
	const codewords = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(block[i]);
		});
	}

	// ── 功能图形 ──
	const modules = Array.from({ length: size }, () => new Array(size).fill(false));
	const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
	const setF = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };
	for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
	const finder = (cx, cy) => {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, dist !== 2 && dist !== 4);
			}
		}
	};
	finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
	const align = alignmentPositions(ver);
	const last = align.length - 1;
	for (let i = 0; i < align.length; i++) {
		for (let j = 0; j < align.length; j++) {
			if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) setF(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}
	const drawFormat = (mask) => {
		const d = (FORMAT_BITS[ecl] << 3) | mask;
		let rem = d;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const fb = ((d << 10) | rem) ^ 0x5412;
		const bit = (i) => ((fb >>> i) & 1) !== 0;
		for (let i = 0; i <= 5; i++) setF(8, i, bit(i));
		setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
		for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
		setF(8, size - 8, true);
	};
	drawFormat(0);
	if (ver >= 7) {
		let rem = ver;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const vb = (ver << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const dark = ((vb >>> i) & 1) !== 0;
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			setF(a, b, dark); setF(b, a, dark);
		}
	}

	// ── 数据填充（之字形）──
	let idx = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if (!isFunction[y][x] && idx < codewords.length * 8) {
					modules[y][x] = ((codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
					idx++;
				}
			}
		}
	}

	// ── 选掩码（简化罚分：连续同色 + 2×2 色块 + 明暗比例）──
	const applyMask = (m) => {
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x];
	};
	const penalty = () => {
		let score = 0;
		for (let pass = 0; pass < 2; pass++) {
			for (let a = 0; a < size; a++) {
				let run = 1;
				for (let b = 1; b < size; b++) {
					const cur = pass === 0 ? modules[a][b] : modules[b][a];
					const prev = pass === 0 ? modules[a][b - 1] : modules[b - 1][a];
					if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
				}
			}
		}
		let dark = 0;
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (modules[y][x]) dark++;
				if (x < size - 1 && y < size - 1) {
					const c = modules[y][x];
					if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
				}
			}
		}
		const total = size * size;
		score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
		return score;
	};
	let best = 0;
	let bestScore = Infinity;
	for (let m = 0; m < 8; m++) {
		applyMask(m); drawFormat(m);
		const s = penalty();
		if (s < bestScore) { bestScore = s; best = m; }
		applyMask(m);
	}
	applyMask(best); drawFormat(best);
	return modules;
}

/** 矩阵 → SVG 字符串（带 4 格静区）。 */
export function qrSvg(text, { ecl = 'M', scale = 6, dark = '#000', light = '#fff' } = {}) {
	const modules = encodeQr(text, ecl);
	const size = modules.length;
	const border = 4;
	const dim = size + border * 2;
	let path = '';
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) path += `M${x + border},${y + border}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * scale}" height="${dim * scale}" shape-rendering="crispEdges">` +
		`<rect width="100%" height="100%" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
