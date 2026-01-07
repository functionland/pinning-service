import { useState, useEffect, useMemo } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  useAccount,
  useSignMessage,
  useReadContract,
  useWriteContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
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
  const { signMessageAsync } = useSignMessage();
  const { switchChain } = useSwitchChain();

  // State
  const [selectedChainId, setSelectedChainId] = useState<number>(DEFAULT_CHAIN_ID);
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

  // Check if wallet is on the correct chain
  const isWrongChain = isConnected && connectedChainId !== selectedChainId;

  // Parse deposit amount for simulation
  const parsedAmount = useMemo(() => {
    if (!depositAmount || parseFloat(depositAmount) <= 0) return undefined;
    try {
      return parseUnits(depositAmount, FULA_DECIMALS);
    } catch {
      return undefined;
    }
  }, [depositAmount]);

  // Simulate the contract call first (prepares gas estimation properly)
  const { data: simulateData, error: simulateError } = useSimulateContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: vaultAddress && parsedAmount ? [vaultAddress as `0x${string}`, parsedAmount] : undefined,
    query: {
      enabled: !!address && !!vaultAddress && !!parsedAmount && !isWrongChain && connectedChainId === selectedChainId,
    },
  });

  // Sync selected chain with connected wallet chain (only on initial connection)
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

    // Check if on correct chain
    if (isWrongChain) {
      setTransferError(`Please switch to ${CHAIN_NAMES[selectedChainId] || 'the correct network'} first`);
      return;
    }

    setTransferError(null);
    setTransferSuccess(null);
    resetWrite();

    try {
      // Use the simulated request if available (includes proper gas estimation)
      if (simulateData?.request) {
        writeContract(simulateData.request);
      } else if (simulateError) {
        // Simulation failed - show the error
        const errMsg = simulateError.message || 'Transaction simulation failed';
        if (errMsg.includes('insufficient') || errMsg.includes('balance')) {
          setTransferError('Insufficient FULA balance for this transfer');
        } else {
          setTransferError(`Simulation failed: ${errMsg.slice(0, 80)}`);
        }
      } else {
        // Fallback: build the request manually
        const amount = parseUnits(depositAmount, FULA_DECIMALS);
        writeContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [vaultAddress as `0x${string}`, amount],
        });
      }
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
  const isSimulating = !!parsedAmount && !!vaultAddress && !simulateData && !simulateError && !isWrongChain;
  const canTransfer = isConnected && depositAmount && parseFloat(depositAmount) > 0 && parseFloat(depositAmount) <= balanceNumber && vaultAddress && !isWrongChain;

  return (
    <div className="space-y-6">
      {/* Connect Wallet Section - Using RainbowKit */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Wallet Connection</h3>
        <ConnectButton
          chainStatus="icon"
          showBalance={false}
          accountStatus={{
            smallScreen: 'avatar',
            largeScreen: 'full',
          }}
        />
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
              className="border rounded-lg px-3 py-2 text-sm"
            >
              {supportedChains.filter(c => c.isEnabled).map((chain) => (
                <option key={chain.chainId} value={chain.chainId}>
                  {chain.chainName}
                </option>
              ))}
            </select>
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

          {/* Simulation Status */}
          {simulateError && parsedAmount && !isWrongChain && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-700 text-sm">
              {simulateError.message?.includes('insufficient') || simulateError.message?.includes('balance')
                ? 'Insufficient FULA balance for this transfer'
                : 'Unable to simulate transaction. Transfer may still work.'}
            </div>
          )}

          {/* Wrong Chain Warning */}
          {isWrongChain && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-700 text-sm">
              Your wallet is connected to {CHAIN_NAMES[connectedChainId!] || `Chain ${connectedChainId}`}.
              Please switch to {CHAIN_NAMES[selectedChainId]} to transfer.
              <button
                onClick={() => switchChain({ chainId: selectedChainId })}
                className="ml-2 underline font-medium"
              >
                Switch Network
              </button>
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
            disabled={!canTransfer || isTransferring || isSimulating}
            className="w-full btn-primary py-3"
          >
            {isSimulating
              ? 'Preparing Transaction...'
              : isTransferPending
              ? 'Confirm in Wallet...'
              : isConfirming
              ? 'Confirming Transaction...'
              : isClaimingTx
              ? 'Claiming Credits...'
              : 'Transfer to Vault'}
          </button>
        </div>
      )}
    </div>
  );
}
