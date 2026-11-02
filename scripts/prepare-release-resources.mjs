import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'), source=resolve(root,'remote/relay'), target=resolve(root,'release-resources/relay');
await mkdir(target,{recursive:true});
await cp(resolve(source,'dist'),resolve(target,'dist'),{recursive:true});
await cp(resolve(source,'public'),resolve(target,'public'),{recursive:true});
await writeFile(resolve(target,'package.json'),JSON.stringify({name:'paneflow-packaged-relay',private:true,type:'module'}));
const lock=JSON.parse(await readFile(resolve(source,'package-lock.json'),'utf8'));
for(const [path,entry] of Object.entries(lock.packages)) {
  if(!path.startsWith('node_modules/')||entry.dev||entry.link)continue;
  await cp(resolve(source,path),resolve(target,path),{recursive:true,dereference:true});
}
console.log('Prepared relay runtime dependencies and public assets');
