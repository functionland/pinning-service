import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface CreditStatus {
  email: string;
  balanceFula: number;
  totalDeposited: number;
  totalDeducted: number;
  isSuspended: boolean;
  lastDeductionAt: string | null;
  currentStorageBytes: number;
  freeTierBytes: number;
  canUpload: boolean;
  message: string;
}

interface Wallet {
  address: string;
  chainId: number;
  isVerified: boolean;
  connectedAt: string;
}

interface ChainInfo {
  chainId: number;
  chainName: string;
  tokenAddress: string;
  vaultAddress: string;
  isEnabled: boolean;
}

interface CreditHistoryItem {
  txType: string;
  amountFula: number;
  balanceAfter: number;
  referenceId: string | null;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getChainName(chainId: number): string {
  switch (chainId) {
    case 1: return 'Ethereum';
    case 8453: return 'Base';
    case 2046399126: return 'Skale Europa';
    default: return `Chain ${chainId}`;
  }
}

export default function Billing() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [creditStatus, setCreditStatus] = useState<CreditStatus | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [supportedChains, setSupportedChains] = useState<ChainInfo[]>([]);
  const [history, setHistory] = useState<CreditHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Claim form state
  const [showClaimForm, setShowClaimForm] = useState(false);
  const [claimTxHash, setClaimTxHash] = useState('');
  const [claimChainId, setClaimChainId] = useState<number>(8453);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [creditsRes, walletsRes, historyRes] = await Promise.all([
        fetch('/api/credits', { credentials: 'include' }),
        fetch('/api/wallets', { credentials: 'include' }),
        fetch('/api/credits/history?limit=20', { credentials: 'include' }),
      ]);

      if (!creditsRes.ok || !walletsRes.ok) {
        throw new Error('Failed to fetch billing data');
      }

      const creditsData = await creditsRes.json();
      const walletsData = await walletsRes.json();
      const historyData = await historyRes.json();

      setCreditStatus(creditsData);
      setWallets(walletsData.wallets || []);
      setSupportedChains(walletsData.supportedChains || []);
      setHistory(historyData.history || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    setClaiming(true);
    setClaimError(null);
    setClaimSuccess(null);

    try {
      const res = await fetch('/api/credits/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ txHash: claimTxHash, chainId: claimChainId }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || data.message || 'Failed to claim transaction');
      }

      setClaimSuccess(`Successfully credited ${data.amountFula.toFixed(4)} FULA!`);
      setClaimTxHash('');
      fetchData(); // Refresh data
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Failed to claim transaction');
    } finally {
      setClaiming(false);
    }
  };

  const handleDisconnectWallet = async (address: string) => {
    try {
      const res = await fetch(`/api/wallets/${address}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) {
        throw new Error('Failed to disconnect wallet');
      }

      setWallets(prev => prev.filter(w => w.address !== address));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to disconnect wallet');
    }
  };

  // Calculate usage percentage
  const usagePercent = creditStatus
    ? Math.min(100, (creditStatus.currentStorageBytes / creditStatus.freeTierBytes) * 100)
    : 0;
  const isOverFreeTier = creditStatus && creditStatus.currentStorageBytes >= creditStatus.freeTierBytes;

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="h-8 bg-gray-200 rounded w-48 animate-pulse"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="card animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-24 mb-3"></div>
              <div className="h-8 bg-gray-200 rounded w-32"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.billing?.title || 'Billing & Credits'}</h1>
        <p className="text-gray-600 mt-1">{t.billing?.subtitle || 'Manage your FULA credits and wallet connections'}</p>
      </div>

      {/* Suspension warning */}
      {creditStatus?.isSuspended && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6">
          <div className="flex items-start space-x-4">
            <div className="text-3xl">⚠️</div>
            <div>
              <h2 className="text-lg font-semibold text-red-800">Account Suspended</h2>
              <p className="text-red-700 mt-1">
                Your storage has exceeded the free tier and your credit balance is depleted.
                Please add FULA credits to continue uploading.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Usage and Balance cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Storage Usage */}
        <div className="card col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-medium text-gray-500">{t.billing?.storageUsage || 'Storage Usage'}</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">
                {formatBytes(creditStatus?.currentStorageBytes || 0)}
              </p>
            </div>
            <div className="text-4xl opacity-20">💾</div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Free tier: {formatBytes(creditStatus?.freeTierBytes || 0)}</span>
              <span className={isOverFreeTier ? 'text-amber-600 font-medium' : 'text-green-600'}>
                {usagePercent.toFixed(1)}%
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className={`h-3 rounded-full transition-all ${
                  usagePercent >= 100 ? 'bg-red-500' : usagePercent >= 80 ? 'bg-amber-500' : 'bg-green-500'
                }`}
                style={{ width: `${Math.min(100, usagePercent)}%` }}
              ></div>
            </div>
            {isOverFreeTier && (
              <p className="text-sm text-amber-600">
                Using {formatBytes((creditStatus?.currentStorageBytes || 0) - (creditStatus?.freeTierBytes || 0))} paid storage
              </p>
            )}
          </div>
        </div>

        {/* FULA Balance */}
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">{t.billing?.balance || 'FULA Balance'}</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">
                {(creditStatus?.balanceFula || 0).toFixed(2)}
              </p>
            </div>
            <div className="text-4xl opacity-20">💰</div>
          </div>
        </div>

        {/* Status */}
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">{t.billing?.status || 'Status'}</p>
              <p className={`text-lg font-semibold mt-1 ${creditStatus?.canUpload ? 'text-green-600' : 'text-red-600'}`}>
                {creditStatus?.canUpload ? 'Active' : 'Limited'}
              </p>
              <p className="text-xs text-gray-500 mt-1">{creditStatus?.message}</p>
            </div>
            <div className="text-4xl opacity-20">{creditStatus?.canUpload ? '✅' : '🚫'}</div>
          </div>
        </div>
      </div>

      {/* Deposit instructions */}
      <div className="card bg-primary-50 border-primary-200">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t.billing?.depositTitle || 'How to Add Credits'}</h2>
        <div className="space-y-4">
          <div className="flex items-start space-x-4">
            <span className="flex-shrink-0 w-8 h-8 bg-primary-600 text-white rounded-full flex items-center justify-center font-semibold">1</span>
            <div>
              <p className="font-medium text-gray-900">Connect your wallet below</p>
              <p className="text-sm text-gray-600">Link your Ethereum/Base/Skale wallet to your account</p>
            </div>
          </div>
          <div className="flex items-start space-x-4">
            <span className="flex-shrink-0 w-8 h-8 bg-primary-600 text-white rounded-full flex items-center justify-center font-semibold">2</span>
            <div>
              <p className="font-medium text-gray-900">Send FULA tokens to the vault</p>
              <p className="text-sm text-gray-600">
                Vault address: <code className="bg-white px-2 py-1 rounded text-xs break-all">
                  {supportedChains[0]?.vaultAddress || '0x...'}
                </code>
              </p>
            </div>
          </div>
          <div className="flex items-start space-x-4">
            <span className="flex-shrink-0 w-8 h-8 bg-primary-600 text-white rounded-full flex items-center justify-center font-semibold">3</span>
            <div>
              <p className="font-medium text-gray-900">Credits are auto-applied (or claim manually)</p>
              <p className="text-sm text-gray-600">Payments from linked wallets are automatically credited every 10 minutes</p>
            </div>
          </div>
        </div>

        <div className="mt-4 p-4 bg-white rounded-lg">
          <p className="text-sm font-medium text-gray-700">Pricing: <span className="text-primary-600">3 FULA per GB per month</span></p>
          <p className="text-xs text-gray-500 mt-1">Free tier: 500 MB | 1 FULA = ~333 MB for 1 month</p>
        </div>
      </div>

      {/* Manual claim section */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">{t.billing?.claimTitle || 'Claim Transaction'}</h2>
          <button
            onClick={() => setShowClaimForm(!showClaimForm)}
            className="text-primary-600 hover:text-primary-700 text-sm font-medium"
          >
            {showClaimForm ? 'Hide' : 'Show Form'}
          </button>
        </div>

        {showClaimForm && (
          <form onSubmit={handleClaim} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Chain</label>
              <select
                value={claimChainId}
                onChange={(e) => setClaimChainId(Number(e.target.value))}
                className="w-full border rounded-lg px-3 py-2"
              >
                {supportedChains.filter(c => c.isEnabled).map(chain => (
                  <option key={chain.chainId} value={chain.chainId}>{chain.chainName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Transaction Hash</label>
              <input
                type="text"
                value={claimTxHash}
                onChange={(e) => setClaimTxHash(e.target.value)}
                placeholder="0x..."
                className="w-full border rounded-lg px-3 py-2 font-mono text-sm"
                pattern="^0x[a-fA-F0-9]{64}$"
                required
              />
            </div>

            {claimError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
                {claimError}
              </div>
            )}

            {claimSuccess && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">
                {claimSuccess}
              </div>
            )}

            <button
              type="submit"
              disabled={claiming || !claimTxHash}
              className="btn-primary w-full"
            >
              {claiming ? 'Claiming...' : 'Claim Credits'}
            </button>
          </form>
        )}

        {!showClaimForm && (
          <p className="text-sm text-gray-500">
            If your payment wasn't automatically credited, you can manually claim it by providing the transaction hash.
          </p>
        )}
      </div>

      {/* Connected wallets */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">{t.billing?.walletsTitle || 'Connected Wallets'}</h2>
          <button
            onClick={() => alert('Wallet connection coming soon! For now, contact support to link your wallet.')}
            className="btn-primary text-sm"
          >
            Connect Wallet
          </button>
        </div>

        {wallets.length === 0 ? (
          <p className="text-gray-500 text-sm">No wallets connected yet. Connect a wallet to receive automatic credits.</p>
        ) : (
          <div className="space-y-3">
            {wallets.map((wallet) => (
              <div key={`${wallet.address}-${wallet.chainId}`} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
                    <span className="text-sm">💳</span>
                  </div>
                  <div>
                    <p className="font-mono text-sm">{shortenAddress(wallet.address)}</p>
                    <p className="text-xs text-gray-500">{getChainName(wallet.chainId)}</p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {wallet.isVerified && (
                    <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">Verified</span>
                  )}
                  <button
                    onClick={() => handleDisconnectWallet(wallet.address)}
                    className="text-red-600 hover:text-red-700 text-sm"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Credit history */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t.billing?.historyTitle || 'Credit History'}</h2>

        {history.length === 0 ? (
          <p className="text-gray-500 text-sm">No transactions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2">Type</th>
                  <th className="pb-2">Amount</th>
                  <th className="pb-2">Balance After</th>
                  <th className="pb-2">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {history.map((item, idx) => (
                  <tr key={idx} className="text-gray-700">
                    <td className="py-2">
                      <span className={`px-2 py-1 rounded text-xs ${
                        item.txType === 'deposit' ? 'bg-green-100 text-green-700' :
                        item.txType === 'adjustment' ? 'bg-blue-100 text-blue-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {item.txType}
                      </span>
                    </td>
                    <td className={`py-2 font-mono ${item.amountFula >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {item.amountFula >= 0 ? '+' : ''}{item.amountFula.toFixed(4)}
                    </td>
                    <td className="py-2 font-mono">{item.balanceAfter.toFixed(4)}</td>
                    <td className="py-2 text-gray-500">{new Date(item.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Supported chains info */}
      <div className="card bg-gray-50">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t.billing?.chainsTitle || 'Supported Chains'}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {supportedChains.filter(c => c.isEnabled).map(chain => (
            <div key={chain.chainId} className="bg-white rounded-lg p-4">
              <p className="font-medium text-gray-900">{chain.chainName}</p>
              <p className="text-xs text-gray-500 mt-1">Chain ID: {chain.chainId}</p>
              <p className="text-xs font-mono text-gray-500 mt-1 truncate" title={chain.tokenAddress}>
                Token: {shortenAddress(chain.tokenAddress)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
