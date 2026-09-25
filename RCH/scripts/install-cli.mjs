import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('./credits.mjs',import.meta.url));
const directory=join(homedir(),'.local','bin');
const target=join(directory,process.platform==='win32'?'rch.cmd':'rch');
const marker='REACH Credits Projects CLI';
const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
try {
  await mkdir(directory,{recursive:true});
  let previous;try{previous=await readFile(target,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous&&!previous.includes(marker))throw new Error(`Refusing to replace another command at ${target}.`);
  const content=process.platform==='win32'
    ? `@echo off\r\nrem ${marker}\r\n"${process.execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\n# ${marker}\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`;
  await writeFile(target,content,{mode:0o755});await chmod(target,0o755);
  console.log(`Installed ${target}\nIn REACH Studio Projects, choose Project command and run: rch help\nHome's mini Projects terminal supports the same commands.\nKeep this checkout and its RCH dependencies installed.${process.platform==='win32'?'\nAdd '+directory+' to your user PATH for other terminals.':''}`);
}catch(error){console.error(error.message);process.exitCode=1;}
