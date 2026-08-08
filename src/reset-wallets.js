// Reset ALL wallet data — deletes every wallet, wallet group, and group membership
// so each user can re-import their own wallets fresh with correct ownership.
// Usage: node src/reset-wallets.js  (run on the server that owns the DB, e.g. Render)
import { initDatabase, resetAllWallets } from './database.js';

await initDatabase();
const { wallets, groups, members } = await resetAllWallets();
console.log(`[Reset] wallets=${wallets} groups=${groups} members=${members} — all wallet data cleared. Run on Render too (node src/reset-wallets.js).`);
process.exit(0);
