import { useState, useEffect, useMemo } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  useAccount,
  useChainId,
  useSignMessage,
  useReadContract,
  useWriteContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
  useBalance,
} from 'wagmi';
import { parseUnits, formatUnits, erc20Abi } from 'viem';
import { useAuth } from '../context/AuthContext';
import { FULA_TOKEN_ADDRESSES, SWAP_URLS, FULA_DECIMALS } from '../constants/tokens';
import { CHAIN_NAMES, DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS, skaleEuropa } from '../config/wagmi';

// Gas token names per chain
const GAS_TOKEN_NAMES: Record<number, string> = {
  8453: 'ETH',      // Base
  1: 'ETH',         // Ethereum
  [skaleEuropa.id]: 'sFUEL',  // Skale Europa
};

// Minimum gas balance required (in native units)
const MIN_GAS_BALANCE: Record<number, number> = {
  8453: 0.0001,     // Base - ~$0.25 worth of ETH
  1: 0.001,         // Ethereum - more expensive gas
  [skaleEuropa.id]: 0.00001,  // Skale - sFUEL is free/cheap
};

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
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();

  // State
  const [selectedChainId, setSelectedChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [depositAmount, setDepositAmount] = useState<string>('');
  const [isLinking, setIsLinking] = useState(false);
  const [isWalletLinked, setIsWalletLinked] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSuccess, setTransferSuccess] = useState<string | null>(null);
  const [isClaimingTx, setIsClaimingTx] = useState(false);
  const [hasPromptedLink, setHasPromptedLink] = useState(false);

  // Get token and vault addresses for selected chain
  const tokenAddress = FULA_TOKEN_ADDRESSES[selectedChainId];
  const vaultAddress = supportedChains.find(c => c.chainId === selectedChainId)?.vaultAddress as `0x${string}` | undefined;
  const swapUrl = SWAP_URLS[selectedChainId];
  const isWrongChain = chainId !== selectedChainId;

  // Parse deposit amount
  const parsedAmount = useMemo(() => {
    if (!depositAmount || parseFloat(depositAmount) <= 0) return BigInt(0);
    try {
      return parseUnits(depositAmount, FULA_DECIMALS);
    } catch {
      return BigInt(0);
    }
  }, [depositAmount]);

  // Read FULA balance
  const { data: balanceData, refetch: refetchBalance } = useReadContract({
    chainId: selectedChainId,
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!tokenAddress },
  });

  const balance = balanceData ? formatUnits(balanceData as bigint, FULA_DECIMALS) : '0';
  const balanceNumber = parseFloat(balance);

  // Read native gas token balance (ETH or sFUEL)
  const { data: gasBalanceData } = useBalance({
    address,
    chainId: selectedChainId,
    query: { enabled: !!address },
  });

  const gasBalance = gasBalanceData ? parseFloat(formatUnits(gasBalanceData.value, gasBalanceData.decimals)) : 0;
  const gasTokenName = GAS_TOKEN_NAMES[selectedChainId] || 'ETH';
  const minGasRequired = MIN_GAS_BALANCE[selectedChainId] || 0.0001;
  const hasInsufficientGas = gasBalance < minGasRequired;

  // Prepare the transfer transaction (wagmi v2 pattern with explicit chainId)
  const { data: simulateData, error: simulateError } = useSimulateContract({
    chainId: selectedChainId,
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [vaultAddress!, parsedAmount],
    query: {
      enabled: !!address && !!vaultAddress && parsedAmount > BigInt(0) && !isWrongChain,
    },
  });

  // Write contract - use the prepared request
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

  // Sync selected chain with connected wallet chain
  useEffect(() => {
    if (chainId && SUPPORTED_CHAIN_IDS.includes(chainId as typeof SUPPORTED_CHAIN_IDS[number])) {
      setSelectedChainId(chainId);
    }
  }, [chainId]);

  // Check if wallet is already linked when address changes
  useEffect(() => {
    if (address) {
      checkWalletLinked();
    } else {
      setIsWalletLinked(false);
      setHasPromptedLink(false);
    }
  }, [address]);

  // Auto-prompt for wallet linking after connection (if not already linked)
  useEffect(() => {
    if (isConnected && address && !isWalletLinked && !hasPromptedLink && !isLinking && user?.email) {
      // Small delay to let the connection UI settle
      const timer = setTimeout(() => {
        setHasPromptedLink(true);
        linkWalletToBackend();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isConnected, address, isWalletLinked, hasPromptedLink, isLinking, user?.email]);

  // Check if wallet is already linked to this account
  const checkWalletLinked = async () => {
    if (!address) return;

    try {
      const response = await fetch('/api/wallets', {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        const linked = data.wallets?.some(
          (w: { address: string }) => w.address.toLowerCase() === address.toLowerCase()
        );
        setIsWalletLinked(linked);
      }
    } catch (err) {
      console.error('Failed to check wallet status:', err);
    }
  };

  // Auto-claim transaction when confirmed
  useEffect(() => {
    if (isConfirmed && txHash && !isClaimingTx) {
      claimTransaction(txHash);
    }
  }, [isConfirmed, txHash]);

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

  // Link wallet to backend with signature verification
  const linkWalletToBackend = async () => {
    if (!address || !user?.email) return;

    setIsLinking(true);
    setLinkError(null);

    try {
      const timestamp = Date.now();
      const message = `Link wallet ${address} to ${user.email}\nTimestamp: ${timestamp}\nThis signature proves you own this wallet.`;
      const signature = await signMessageAsync({ message });

      const response = await fetch('/api/wallets/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ address, chainId: selectedChainId, signature, message }),
      });

      const data = await response.json();
      if (!response.ok) {
        // Handle specific error cases
        if (data.error?.includes('already linked to another')) {
          throw new Error('This wallet is already linked to a different account. Please use a different wallet.');
        }
        throw new Error(data.error || 'Failed to link wallet');
      }

      // Successfully linked
      setIsWalletLinked(true);
      setLinkError(null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to link wallet';
      if (errorMessage.includes('User rejected') || errorMessage.includes('rejected')) {
        setLinkError('Signature required to link wallet. Click "Verify & Link Wallet" to try again.');
      } else {
        setLinkError(errorMessage);
      }
    } finally {
      setIsLinking(false);
    }
  };

  // Handle chain switch
  const handleChainSwitch = async (newChainId: number) => {
    setSelectedChainId(newChainId);
    if (isConnected && chainId !== newChainId) {
      try {
        await switchChain({ chainId: newChainId });
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

  // Handle transfer - only use the prepared request
  const handleTransfer = async () => {
    // Switch chain first if needed
    if (isWrongChain) {
      await switchChain({ chainId: selectedChainId });
      return;
    }

    if (!simulateData?.request) {
      setTransferError('Transaction not ready. Please wait or try again.');
      return;
    }

    setTransferError(null);
    setTransferSuccess(null);
    resetWrite();

    // Use the prepared request from simulation
    writeContract(simulateData.request);
  };

  // Claim transaction to backend
  const claimTransaction = async (hash: string, retryCount = 0) => {
    setIsClaimingTx(true);

    try {
      // Wait before first attempt to allow blockchain explorer to index the transaction
      if (retryCount === 0) {
        console.log(`[Claim] Waiting 5s for transaction to be indexed...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      const response = await fetch('/api/credits/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ txHash: hash, chainId: selectedChainId }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Retry on indexing delays (transaction not found OR logs not indexed yet)
        const shouldRetry =
          data.error?.includes('not found') ||
          data.error?.includes('No FULA transfer to vault found');

        if (shouldRetry && retryCount < 5) {
          console.log(`[Claim] Transaction not indexed yet, retrying in 5s (attempt ${retryCount + 1}/5)`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          return claimTransaction(hash, retryCount + 1);
        }
        throw new Error(data.error || data.message || 'Failed to claim credits');
      }

      setTransferSuccess(`Successfully credited ${data.amountFula?.toFixed(4) || depositAmount} FULA! Your balance has been updated.`);
      setDepositAmount('');
      refetchBalance();
      onTransferSuccess?.();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error('[Claim] Error:', errorMessage);

      // Show specific error or fallback message
      if (errorMessage.includes('not linked')) {
        setTransferError(`Transfer successful but wallet not linked. Please link your wallet first.`);
        setTransferSuccess(null);
      } else if (errorMessage.includes('already been credited')) {
        setTransferSuccess(`Transaction already credited!`);
      } else {
        // Show tx hash for manual verification
        setTransferSuccess(
          `Transfer complete! TX: ${hash}\n` +
          `Auto-claim failed: ${errorMessage}\n` +
          `Credits will be applied within 10 minutes via background scan.`
        );
      }
    } finally {
      setIsClaimingTx(false);
    }
  };

  const isTransferring = isTransferPending || isConfirming || isClaimingTx;
  const isReady = !!simulateData?.request && !simulateError;
  const canTransfer = isConnected && isWalletLinked && parsedAmount > BigInt(0) && balanceNumber >= parseFloat(depositAmount || '0') && vaultAddress && !hasInsufficientGas;

  return (
    <div className="space-y-6">
      {/* Connect Wallet Section - Using RainbowKit */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Wallet Connection</h3>
        <ConnectButton
          chainStatus="icon"
          showBalance={false}
          accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
        />
      </div>

      {/* Wallet Link Status */}
      {isConnected && (
        <div className="space-y-2">
          {isWalletLinked ? (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Wallet verified and linked to your account
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-amber-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <div className="flex-1">
                  <p className="text-sm font-medium text-amber-800">
                    Wallet verification required
                  </p>
                  <p className="text-sm text-amber-700 mt-1">
                    Sign a message to prove you own this wallet. This links it to your account for transaction tracking.
                  </p>
                  {linkError && (
                    <p className="text-sm text-red-600 mt-2">{linkError}</p>
                  )}
                  <button
                    onClick={linkWalletToBackend}
                    disabled={isLinking}
                    className="mt-3 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50"
                  >
                    {isLinking ? 'Waiting for signature...' : 'Verify & Link Wallet'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Chain Selector + Get Token Button - Show when linked */}
      {isConnected && isWalletLinked && (
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

      {/* Balance and Transfer Section - Only show when wallet is linked */}
      {isConnected && isWalletLinked && (
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

          {/* Gas Balance Display */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">Gas Balance:</span>
            <span className={hasInsufficientGas ? 'text-red-600 font-medium' : 'text-gray-900'}>
              {gasBalance.toFixed(6)} {gasTokenName}
            </span>
          </div>

          {/* Insufficient Gas Warning */}
          {hasInsufficientGas && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <div>
                  <p className="font-medium">Insufficient {gasTokenName} for gas fees</p>
                  <p className="mt-1">
                    You need at least {minGasRequired} {gasTokenName} to pay for transaction fees on {CHAIN_NAMES[selectedChainId]}.
                    {selectedChainId === skaleEuropa.id
                      ? ' You can get free sFUEL from the SKALE faucet.'
                      : ` Please add ${gasTokenName} to your wallet.`}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Simulation Error */}
          {simulateError && parsedAmount > BigInt(0) && !isWrongChain && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-700 text-sm">
              {simulateError.message?.includes('insufficient') || simulateError.message?.includes('balance')
                ? 'Insufficient FULA balance for this transfer'
                : 'Unable to prepare transaction. Check your balance.'}
            </div>
          )}

          {/* Wrong Chain Warning */}
          {isWrongChain && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-700 text-sm">
              Your wallet is on {CHAIN_NAMES[chainId] || `Chain ${chainId}`}.
              Click Transfer to switch to {CHAIN_NAMES[selectedChainId]}.
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
            disabled={!canTransfer || isTransferring || (!isReady && !isWrongChain)}
            className="w-full btn-primary py-3"
          >
            {isWrongChain
              ? `Switch to ${CHAIN_NAMES[selectedChainId]}`
              : isTransferPending
              ? 'Confirm in Wallet...'
              : isConfirming
              ? 'Confirming Transaction...'
              : isClaimingTx
              ? 'Claiming Credits...'
              : !isReady && parsedAmount > BigInt(0)
              ? 'Preparing...'
              : 'Transfer to Vault'}
          </button>
        </div>
      )}
    </div>
  );
}
