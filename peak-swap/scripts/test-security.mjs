import ts from 'typescript';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
for(const f of ['lib/swap-shared.ts','lib/transaction.ts','lib/swap-server.ts','tests/mock-env.ts','tests/security.ts']){
 let source=readFileSync(f,'utf8').replace("from 'cloudflare:workers'","from '../tests/mock-env'");
 let js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,esModuleInterop:true}}).outputText;
 js=js.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_,quote,path)=>`from ${quote}${path}.js${quote}`);
 const out='.sites-runtime/security/'+f.replace(/\.ts$/,'.js');mkdirSync(dirname(out),{recursive:true});writeFileSync(out,js);
}
const r=spawnSync(process.execPath,['--test','.sites-runtime/security/tests/security.js'],{stdio:'inherit'});process.exit(r.status??1);
