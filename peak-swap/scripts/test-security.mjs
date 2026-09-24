import ts from 'typescript';
import {readFileSync,readdirSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
for(const f of [...files('lib'),...files('tests')].filter(f=>f.endsWith('.ts'))){
 let source=readFileSync(f,'utf8').replace("from 'cloudflare:workers'",`from '${'../'.repeat(f.split('/').length-1)}tests/mock-env'`);
 let js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,esModuleInterop:true}}).outputText;
 js=js.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_,quote,path)=>`from ${quote}${path}.js${quote}`);
 const out='.sites-runtime/security/'+f.replace(/\.ts$/,'.js');mkdirSync(dirname(out),{recursive:true});writeFileSync(out,js);
}
const r=spawnSync(process.execPath,['--test','.sites-runtime/security/tests/security.js','.sites-runtime/security/tests/venues.js'],{stdio:'inherit'});process.exit(r.status??1);
