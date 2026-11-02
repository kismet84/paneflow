import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=resolve(import.meta.dirname,'..');
const quote=value=>value.replaceAll('$','$$').replaceAll('"','$\\"');
export async function prepareInstaller(appDirectory) {
  const output=resolve(root,'release-resources/nsis');await mkdir(output,{recursive:true});
  const files=[],directories=[];
  async function walk(path,relative='') {for(const entry of await readdir(path,{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name;if(entry.isSymbolicLink())throw new Error('Installer payload must not contain links');if(entry.isDirectory()){directories.push(name);await walk(join(path,entry.name),name);}else if(entry.isFile())files.push(name);}}
  await walk(appDirectory);
  if(!files.includes('PaneFlow Desktop.exe'))throw new Error('Missing packaged application');
  const removal=['ClearErrors',...files.map(file=>'Delete "$INSTDIR\\'+quote(file.replaceAll('/','\\'))+'"'),'${If} ${Errors}','  SetErrorLevel 2','  Abort "Some program files could not be removed. Close users of this installation and retry; the uninstaller has been retained."','${EndIf}',...directories.sort((a,b)=>b.length-a.length).map(dir=>'RMDir "$INSTDIR\\'+quote(dir.replaceAll('/','\\'))+'"')].join('\n');
  await writeFile(join(output,'owned-files.nsh'),removal+'\n');
  const template=await readFile(resolve(root,'build/standalone-installer.nsi'),'utf8');
  const prefix='!define PANEFLOW_APP_DIR "'+quote(resolve(appDirectory))+'"\n!define PANEFLOW_OWNED_FILES "'+quote(join(output,'owned-files.nsh'))+'"\n';
  await writeFile(join(output,'installer.nsi'),prefix+template);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await prepareInstaller(resolve(root,'release/win-unpacked'));
