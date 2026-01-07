// FULA Token addresses per chain
export const FULA_TOKEN_ADDRESSES: Record<number, `0x${string}`> = {
  8453: '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB',      // Base
  1: '0x92217cCaEDBdbc54C76c15feA18823db1558fDc9',          // Ethereum
  2046399126: '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB', // Skale Europa
};

// Swap URLs for getting FULA tokens (null = hidden/not available)
export const SWAP_URLS: Record<number, string | null> = {
  8453: 'https://app.uniswap.org/swap?chain=base&inputCurrency=NATIVE&outputCurrency=0x9e12735d77c72c5c3670636d428f2f3815d8a4cb',
  2046399126: 'https://www.sushi.com/skale-europa/swap?token0=0xe0595a049d02b7674572b0d59cd4880db60edc50&token1=0x9e12735d77c72c5c3670636d428f2f3815d8a4cb',
  1: null,  // No swap available for Ethereum
};

// FULA token decimals
export const FULA_DECIMALS = 18;

// Minimal ERC20 ABI for balance and transfer
export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;
