import { copyFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const distDir = resolve('dist');
const shellPath = resolve(distDir, '_shell.html');
const indexPath = resolve(distDir, 'index.html');
const notFoundPath = resolve(distDir, '404.html');
const serverDir = resolve(distDir, 'server');

await stat(shellPath);
await copyFile(shellPath, indexPath);
await copyFile(shellPath, notFoundPath);
await rm(serverDir, { recursive: true, force: true });
