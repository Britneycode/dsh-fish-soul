// 发版 workflow 的 shell 在隔离 git 仓库和假 registry / gh / npm 下执行；绝不访问或发布到线上。
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
const yaml = readFileSync('.github/workflows/release.yml', 'utf8');
function step(name) {
 const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const m = yaml.match(new RegExp(`      - name: ${escaped}\\n([\\s\\S]*?)(?=\\n      - name: |$)`));
 assert(m, `缺少 workflow 步骤：${name}`);
 const run = m[1].match(/\n        run: \|\n((?:          .*\n?)*)/);
 assert(run, `${name} 缺少 run`);
 return run[1].split('\n').map(line => line.replace(/^          /, '')).join('\n').replaceAll('${{ steps.v.outputs.ver }}', '1.2.3');
}
const classify = step('版本号'), wait = step('等待已有标签的 Release'), publish = step('npm publish');
assert.match(yaml, /- name: 打 tag \+ 建 Release[\s\S]*?if: steps\.v\.outputs\.skip != '1' && steps\.v\.outputs\.existing_tag != '1'/);
assert.match(yaml, /- name: 等待已有标签的 Release[\s\S]*?if: steps\.v\.outputs\.skip != '1' && steps\.v\.outputs\.existing_tag == '1'/);
const dir=mkdtempSync(join(tmpdir(),'fish-release-workflow-'));
try {
 const bin=join(dir,'bin'), repo=join(dir,'repo'), log=join(dir,'calls'), output=join(dir,'output');mkdirSync(bin);mkdirSync(repo);
 const add=(name,body)=>writeFileSync(join(bin,name),`#!/usr/bin/env bash\nset -e\n${body}\n`,{mode:0o755});
 add('curl', 'printf "%s" "$MOCK_CODE"');
 add('npm', 'printf "npm %s\\n" "$*" >> "$MOCK_LOG"');
 add('sleep', ':');
 add('gh', 'printf "gh %s\\n" "$*" >> "$MOCK_LOG"\nif [ "$MOCK_RELEASE" = available ]; then echo false; exit 0; fi\nif [ "$MOCK_RELEASE" = draft ]; then echo true; exit 0; fi\nexit 1');
 execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'config','user.name','Test']);execFileSync('git',['-C',repo,'config','user.email','test@example.invalid']);
 writeFileSync(join(repo,'package.json'),'{"version":"1.2.3"}\n');writeFileSync(join(repo,'README.md'),'版本 **1.2.3**\n');
 execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'commit','-qm','fixture']);
 const sha=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const run=(script,overrides={})=>{writeFileSync(output,'');writeFileSync(log,''); const env={...process.env,PATH:`${bin}:${process.env.PATH}`,GITHUB_OUTPUT:output,GITHUB_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',MOCK_CODE:'404',MOCK_RELEASE:'available',MOCK_LOG:log,NPM_TOKEN:'fake-test-token',...overrides}; const r=spawnSync('bash',['-e','-o','pipefail','-c',script],{cwd:repo,env,encoding:'utf8'}); return {...r,out:readFileSync(output,'utf8'),calls:readFileSync(log,'utf8')};};
 let r=run(classify);assert.equal(r.status,0,'无 tag、无 npm：允许创建 Release');assert(!r.out.includes('skip=1'));assert(!r.out.includes('existing_tag=1'));
 r=run(classify,{MOCK_CODE:'200'});assert.notEqual(r.status,0,'无 tag 但 npm 版本已存在，禁止重新建指向不同提交的 tag');
 r=run(classify,{MOCK_CODE:'503'});assert.notEqual(r.status,0,'registry 异常不能当作 404');
 execFileSync('git',['-C',repo,'tag','-a','v1.2.3','-m','v1.2.3']);
 r=run(classify);assert.equal(r.status,0,'手动先打 tag，但 npm 404：应进入补发');assert.match(r.out,/existing_tag=1/);assert(!r.out.includes('skip=1'));
 r=run(classify,{MOCK_CODE:'200'});assert.equal(r.status,0);assert.match(r.out,/skip=1/,'已发布的 tag 和 npm 应跳过');
 r=run(classify,{GITHUB_SHA:'0000000000000000000000000000000000000000'});assert.notEqual(r.status,0,'旧 tag 指向其他提交：禁止发布');
 r=run(wait);assert.equal(r.status,0);assert.match(r.calls,/gh release view v1\.2\.3/);
 for(const state of ['missing','draft']) {r=run(wait,{MOCK_RELEASE:state});assert.notEqual(r.status,0,`Release ${state}：不能发布`);}
 r=run(publish);assert.equal(r.status,0);assert.match(r.calls,/npm publish/);
 r=run(publish,{MOCK_CODE:'200'});assert.equal(r.status,0);assert.doesNotMatch(r.calls,/npm publish/);
 r=run(publish,{MOCK_CODE:'503'});assert.notEqual(r.status,0);assert.doesNotMatch(r.calls,/npm publish/);
 r=run(publish,{NPM_TOKEN:''});assert.notEqual(r.status,0);assert.doesNotMatch(r.calls,/npm publish/);
 // 真正运行手动脚本，git push 只指向本地 bare 仓库；Python 的 Release API 用假实现。
 const manual=join(dir,'manual'), remote=join(dir,'origin.git'), notes=join(dir,'notes.md');mkdirSync(manual);mkdirSync(join(manual,'scripts'));
 execFileSync('git',['init','--bare','-q',remote]);execFileSync('git',['init','-q','-b','main',manual]);
 const git=(...args)=>execFileSync('git',['-C',manual,...args],{stdio:'pipe',encoding:'utf8'});
 git('config','user.name','Test');git('config','user.email','test@example.invalid');git('remote','add','origin',remote);
 copyFileSync('scripts/release.sh',join(manual,'scripts','release.sh'));writeFileSync(join(manual,'package.json'),'{"version": "1.2.3"}\n');writeFileSync(join(manual,'README.md'),'版本 **1.2.3**\n');writeFileSync(notes,'测试说明\n');
 git('add','.');git('commit','-qm','initial');git('push','-q','origin','main');
 add('python', 'if [ "$#" -ge 2 ]; then exec python3 "$@"; fi\ncat >/dev/null\nprintf "mock GitHub Release\\n"');
 const runManual=()=>spawnSync('bash',['scripts/release.sh','1.2.3',notes],{cwd:manual,encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,GITHUB_TOKEN_BRITNEYCODE:'fake-test-token'}});
 r=runManual();assert.notEqual(r.status,0,'main 未变化时拒绝手动发版，避免错过触发');assert.match(r.stderr,/main 已推送/);
 assert.equal(git('tag','--list','v1.2.3').trim(),'');
 writeFileSync(join(manual,'change.txt'),'release');git('add','change.txt');git('commit','-qm','release');
 r=runManual();assert.notEqual(r.status,0,'只有无关文件变化时不会触发 workflow');assert.match(r.stderr,/不能触发自动 npm 发布/);
 writeFileSync(join(manual,'package.json'),'{"version": "1.2.3", "description": "release"}\n');git('add','package.json');git('commit','-qm','version');
 execFileSync('git',['--git-dir',remote,'tag','v1.2.3','main']);
 r=runManual();assert.notEqual(r.status,0,'远端 tag 已存在时拒绝抢跑');assert.match(r.stderr,/远端 v1\.2\.3 已存在/);
 assert.equal(git('tag','--list','v1.2.3').trim(),'');execFileSync('git',['--git-dir',remote,'tag','-d','v1.2.3']);
 r=runManual();assert.equal(r.status,0,`本地手动发版应成功：${r.stderr}`);assert.match(r.stdout,/mock GitHub Release/);
 const localHead=git('rev-parse','HEAD').trim();
 assert.equal(execFileSync('git',['--git-dir',remote,'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim(),localHead);
 assert.equal(execFileSync('git',['--git-dir',remote,'rev-parse','refs/tags/v1.2.3^{commit}'],{encoding:'utf8'}).trim(),localHead);
 console.log('✓ 发版 workflow：两种入口、冲突、重试、网络错误和草稿均安全处理');
} finally { rmSync(dir,{recursive:true,force:true}); }
