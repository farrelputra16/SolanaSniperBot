const DEXSCREENER_API = 'https://api.dexscreener.com';

const CHAIN_MAP = {
  solana: 'sol',
  bsc: 'bsc',
  ethereum: 'eth',
  base: 'base',
};

const REVERSE_CHAIN_MAP = {};
for (const [k, v] of Object.entries(CHAIN_MAP)) REVERSE_CHAIN_MAP[v] = k;

export async function getDexScreenerInfo(chain, address) {
  const url = `${DEXSCREENER_API}/latest/dex/search?q=${address}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[DexScreener] HTTP ${res.status} for ${address}`);
      return null;
    }

    const json = await res.json();
    if (!json || !json.pairs || json.pairs.length === 0) return null;

    const dexChain = REVERSE_CHAIN_MAP[chain] || chain;
    let pair = json.pairs.find(p => p.chainId === dexChain);
    if (!pair) pair = json.pairs[0];

    return {
      priceUsd: parseFloat(pair.priceUsd) || 0,
      priceNative: parseFloat(pair.priceNative) || 0,
      marketCap: pair.fdv ? parseFloat(pair.fdv) : 0,
      liquidity: pair.liquidity?.usd ? parseFloat(pair.liquidity.usd) : 0,
      volume24h: pair.volume?.h24 ? parseFloat(pair.volume.h24) : 0,
      tokenSymbol: pair.baseToken?.symbol || '',
      tokenName: pair.baseToken?.name || '',
      priceChange24h: pair.priceChange?.h24 || 0,
      txns24h: pair.txns?.h24 || { buys: 0, sells: 0 },
      pairCreatedAt: pair.pairCreatedAt || 0,
      dexId: pair.dexId || '',
      pairAddress: pair.pairAddress || '',
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.warn('[DexScreener] Request timed out');
      return null;
    }
    console.warn(`[DexScreener] Error fetching ${address}:`, err.message);
    return null;
  }
}
