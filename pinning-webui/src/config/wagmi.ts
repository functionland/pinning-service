import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { http } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';
import type { Chain } from 'viem';

// Custom chain definition for Skale Europa
export const skaleEuropa: Chain = {
  id: 2046399126,
  name: 'SKALE Europa',
  nativeCurrency: { name: 'sFUEL', symbol: 'sFUEL', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://mainnet.skalenodes.com/v1/elated-tan-skat'] },
  },
  blockExplorers: {
    default: { name: 'SKALE Explorer', url: 'https://elated-tan-skat.explorer.mainnet.skalenodes.com' },
  },
};

// WalletConnect project ID from environment
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

// RainbowKit + Wagmi configuration
// Base is first in the chains array to make it the default connection chain
export const config = getDefaultConfig({
  appName: 'Fula Pinning Service',
  projectId: walletConnectProjectId,
  chains: [base, mainnet, skaleEuropa],
  transports: {
    [base.id]: http('https://mainnet.base.org'),
    [mainnet.id]: http('https://eth.llamarpc.com'),
    [skaleEuropa.id]: http('https://mainnet.skalenodes.com/v1/elated-tan-skat'),
  },
});

// Initial chain for RainbowKit modal
export const INITIAL_CHAIN = base;

// Supported chain IDs
export const SUPPORTED_CHAIN_IDS = [base.id, mainnet.id, skaleEuropa.id] as const;

// Chain names for display
export const CHAIN_NAMES: Record<number, string> = {
  [base.id]: 'Base',
  [mainnet.id]: 'Ethereum',
  [skaleEuropa.id]: 'SKALE Europa',
};

// Default chain
export const DEFAULT_CHAIN_ID = base.id;
