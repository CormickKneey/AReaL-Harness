import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function applicationFixture(gui, directory, bootstrap = '') {
  await mkdir(directory, { recursive: true });
  const sockets = new Set();
  const ownerPath = join(directory, 'owner.sock');
  const owner = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => owner.listen(ownerPath, resolve));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'areal-application-fixture', main: 'bootstrap.cjs' }));
  await writeFile(join(directory, 'bootstrap.cjs'), `
if (!process.argv.includes('--areal-core-service')) {
  const owner = require('node:net').connect(${JSON.stringify(ownerPath)});
  owner.on('error', () => require('electron').app.exit(1));
  owner.on('close', () => require('electron').app.exit(1));
}
${bootstrap}
require(${JSON.stringify(join(gui, 'app/src/main.cjs'))});
`);
  let closing;
  const close = () => closing ??= new Promise(resolve => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, onSignal);
    for (const socket of sockets) socket.destroy();
    owner.close(resolve);
  });
  const onSignal = () => { void close().finally(() => process.exit(1)); };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, onSignal);
  return { path: directory, close };
}
