import { useState, useEffect } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useSignMessage,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { useAuth } from '../context/AuthContext';
import { FULA_TOKEN_ADDRESSES, SWAP_URLS, ERC20_ABI, FULA_DECIMALS } from '../constants/tokens';
import { CHAIN_NAMES, DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS } from '../config/wagmi';

interface ChainInfo {
  chainId: number;
  chainName: string;
  tokenAddress: string;
  vaultAddress: string;
  isEnabled: boolean;
}

interface WalletSectionProps {
  supportedChains: ChainInfo[];
  onTransferSuccess?: () => void;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function WalletSection({ supportedChains, onTransferSuccess }: WalletSectionProps) {
  const { user } = useAuth();
  const { address, isConnected, chainId: connectedChainId } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();

  // State
  const [selectedChainId, setSelectedChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [showConnectors, setShowConnectors] = useState(false);
  const [depositAmount, setDepositAmount] = useState<string>('');
  const [isLinking, setIsLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSuccess, setTransferSuccess] = useState<string | null>(null);
  const [isClaimingTx, setIsClaimingTx] = useState(false);

  // Get token address for current chain
  const tokenAddress = FULA_TOKEN_ADDRESSES[selectedChainId];

  // Read FULA balance
  const { data: balanceData, refetch: refetchBalance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!tokenAddress },
  });

  // Format balance for display
  const balance = balanceData ? formatUnits(balanceData as bigint, FULA_DECIMALS) : '0';
  const balanceNumber = parseFloat(balance);

  // Write contract for transfer
  const {
    writeContract,
    data: txHash,
    isPending: isTransferPending,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract();

  // Wait for transaction receipt
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Get vault address for selected chain
  const vaultAddress = supportedChains.find(c => c.chainId === selectedChainId)?.vaultAddress;

  // Get swap URL for selected chain
  const swapUrl = SWAP_URLS[selectedChainId];

  // Sync selected chain with connected wallet chain
  useEffect(() => {
    if (connectedChainId && SUPPORTED_CHAIN_IDS.includes(connectedChainId as typeof SUPPORTED_CHAIN_IDS[number])) {
      setSelectedChainId(connectedChainId);
    }
  }, [connectedChainId]);

  // Auto-claim transaction when confirmed
  useEffect(() => {
    if (isConfirmed && txHash && !isClaimingTx) {
      claimTransaction(txHash);
    }
  }, [isConfirmed, txHash]);

  // Handle wallet connection with signature verification
  const handleConnect = async (connector: typeof connectors[number]) => {
    try {
      setShowConnectors(false);
      connect({ connector });
    } catch (err) {
      console.error('Connection failed:', err);
    }
  };

  // Link wallet to backend after connection
  const linkWalletToBackend = async () => {
    if (!address || !user?.email) return;

    setIsLinking(true);
    setLinkError(null);

    try {
      const timestamp = Date.now();
      const message = `Link wallet to ${user.email}\nTimestamp: ${timestamp}`;

      const signature = await signMessageAsync({ message });

      const response = await fetch('/api/wallets/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          address,
          chainId: selectedChainId,
          signature,
          message,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to link wallet');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to link wallet';
      if (!errorMessage.includes('User rejected')) {
        setLinkError(errorMessage);
      }
    } finally {
      setIsLinking(false);
    }
  };

  // Handle chain switch
  const handleChainSwitch = async (newChainId: number) => {
    setSelectedChainId(newChainId);
    if (isConnected && connectedChainId !== newChainId) {
      try {
        switchChain({ chainId: newChainId });
      } catch (err) {
        console.error('Chain switch failed:', err);
      }
    }
  };

  // Handle preset amount selection
  const handlePreset = (percentage: number) => {
    const amount = (balanceNumber * percentage / 100).toFixed(4);
    setDepositAmount(amount);
  };

  // Handle transfer
  const handleTransfer = async () => {
    if (!address || !vaultAddress || !depositAmount) return;

    setTransferError(null);
    setTransferSuccess(null);
    resetWrite();

    try {
      const amount = parseUnits(depositAmount, FULA_DECIMALS);

      writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [vaultAddress as `0x${string}`, amount],
      });
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : 'Transfer failed');
    }
  };

  // Claim transaction to backend
  const claimTransaction = async (hash: string) => {
    setIsClaimingTx(true);

    try {
      const response = await fetch('/api/credits/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ txHash: hash, chainId: selectedChainId }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to claim credits');
      }

      setTransferSuccess(`Successfully credited ${data.amountFula?.toFixed(4) || depositAmount} FULA!`);
      setDepositAmount('');
      refetchBalance();
      onTransferSuccess?.();
    } catch (err) {
      // If auto-claim fails, show message but don't hide success (tx was successful)
      setTransferSuccess(`Transfer successful! TX: ${shortenAddress(hash)}. Credits will be applied within 10 minutes.`);
    } finally {
      setIsClaimingTx(false);
    }
  };

  // Handle write errors
  useEffect(() => {
    if (writeError) {
      const message = writeError.message || 'Transfer failed';
      if (message.includes('User rejected') || message.includes('rejected')) {
        setTransferError('Transaction was cancelled');
      } else if (message.includes('insufficient')) {
        setTransferError('Insufficient FULA balance');
      } else {
        setTransferError(message.slice(0, 100));
      }
    }
  }, [writeError]);

  const isTransferring = isTransferPending || isConfirming || isClaimingTx;
  const canTransfer = isConnected && depositAmount && parseFloat(depositAmount) > 0 && parseFloat(depositAmount) <= balanceNumber && vaultAddress;

  return (
    <div className="space-y-6">
      {/* Connect Wallet Section */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Wallet Connection</h3>
        {isConnected ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600 font-mono">{shortenAddress(address!)}</span>
            <button
              onClick={() => disconnect()}
              className="text-sm text-red-600 hover:text-red-700"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="relative">
            <button
              onClick={() => setShowConnectors(!showConnectors)}
              disabled={isConnecting}
              className="btn-primary text-sm"
            >
              {isConnecting ? 'Connecting...' : 'Connect Wallet'}
            </button>

            {showConnectors && (
              <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 z-10">
                {connectors.map((connector) => (
                  <button
                    key={connector.uid}
                    onClick={() => handleConnect(connector)}
                    className="w-full px-4 py-3 text-left text-sm hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg flex items-center gap-3"
                  >
                    <span className="font-medium">{connector.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Link Wallet Button (after connection) */}
      {isConnected && (
        <div className="flex items-center gap-3">
          <button
            onClick={linkWalletToBackend}
            disabled={isLinking}
            className="text-sm text-primary-600 hover:text-primary-700 font-medium"
          >
            {isLinking ? 'Signing...' : 'Link Wallet to Account'}
          </button>
          {linkError && <span className="text-sm text-red-600">{linkError}</span>}
        </div>
      )}

      {/* Chain Selector + Get Token Button */}
      {isConnected && (
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Chain:</label>
            <select
              value={selectedChainId}
              onChange={(e) => handleChainSwitch(Number(e.target.value))}
              disabled={isSwitching}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              {supportedChains.filter(c => c.isEnabled).map((chain) => (
                <option key={chain.chainId} value={chain.chainId}>
                  {chain.chainName}
                </option>
              ))}
            </select>
            {isSwitching && <span className="text-xs text-gray-500">Switching...</span>}
          </div>

          {swapUrl && (
            <a
              href={swapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary text-sm"
            >
              Get Fula Token on {CHAIN_NAMES[selectedChainId] || 'Chain'}
            </a>
          )}
        </div>
      )}

      {/* Balance and Transfer Section */}
      {isConnected && (
        <div className="bg-gray-50 rounded-xl p-6 space-y-4">
          {/* Balance Display */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Your FULA Balance:</span>
            <span className="text-lg font-bold text-gray-900">{parseFloat(balance).toFixed(4)} FULA</span>
          </div>

          {/* Amount Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Deposit Amount:</label>
            <div className="flex gap-2">
              <input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                max={balance}
                step="0.0001"
                className="flex-1 border rounded-lg px-3 py-2 text-sm"
              />
              <span className="flex items-center text-sm text-gray-500">FULA</span>
            </div>
          </div>

          {/* Preset Buttons */}
          <div className="grid grid-cols-4 gap-2">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => handlePreset(pct)}
                disabled={balanceNumber <= 0}
                className="px-3 py-2 text-sm font-medium border rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pct}%
              </button>
            ))}
          </div>

          {/* Vault Address Display */}
          {vaultAddress && (
            <div className="text-sm text-gray-500">
              To: <span className="font-mono">{shortenAddress(vaultAddress)}</span> ({CHAIN_NAMES[selectedChainId]})
            </div>
          )}

          {/* Error/Success Messages */}
          {transferError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
              {transferError}
            </div>
          )}

          {transferSuccess && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">
              {transferSuccess}
            </div>
          )}

          {/* Transfer Button */}
          <button
            onClick={handleTransfer}
            disabled={!canTransfer || isTransferring}
            className="w-full btn-primary py-3"
          >
            {isTransferPending
              ? 'Confirm in Wallet...'
              : isConfirming
              ? 'Confirming Transaction...'
              : isClaimingTx
              ? 'Claiming Credits...'
              : 'Transfer to Vault'}
          </button>
        </div>
      )}

      {/* Click outside to close connectors dropdown */}
      {showConnectors && (
        <div
          className="fixed inset-0 z-0"
          onClick={() => setShowConnectors(false)}
        />
      )}
    </div>
  );
}
