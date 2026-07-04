import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(join(__dirname, '..'));

const { createWebServer } = await import('../src/web-server.js');
const app = createWebServer();

export default app;
