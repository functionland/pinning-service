import { http, createConfig } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';
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

// Wagmi configuration
export const config = createConfig({
  chains: [base, mainnet, skaleEuropa],
  connectors: [
    injected(),
    ...(walletConnectProjectId
      ? [walletConnect({ projectId: walletConnectProjectId })]
      : []),
    coinbaseWallet({ appName: 'Fula Pinning Service' }),
  ],
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
    [skaleEuropa.id]: http(),
  },
});

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
