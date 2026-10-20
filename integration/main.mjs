import { createGateway } from './server.mjs';
import { readNodeCtlCredentials } from './nodectl.mjs';

try {
  const port = Number(process.env.PORT || 12900);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
  const server = createGateway({
    mmwxUrl: process.env.MMWX_URL || 'http://127.0.0.1:12890',
    nodectlUrl: process.env.NODECTL_URL || 'http://127.0.0.1:7878',
    publicOrigin: process.env.PUBLIC_ORIGIN,
    credentials: () => readNodeCtlCredentials(process.env.NODECTL_DB || '/data/nodectl/nodectl.db'),
  });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(JSON.stringify({ event: 'unified_gateway_ready', port })));
  server.on('error', () => { console.error('Unified gateway failed to listen'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
} catch {
  console.error('Invalid unified gateway configuration; check PUBLIC_ORIGIN and upstream URLs');
  process.exitCode = 1;
}
