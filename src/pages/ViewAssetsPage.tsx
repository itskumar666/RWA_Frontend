import { useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useWalletClient, useWriteContract, useWaitForTransactionReceipt, useReadContract, useWatchContractEvent } from 'wagmi';
import { BACKEND_URL } from '../config';
import { addresses } from '../addresses';
import { rwaManagerAbi } from '../abi/rwaManager';

type Asset = {
  assetType: number;
  assetName: string;
  assetId: string;
  isLocked: boolean;
  isVerified: boolean;
  valueInUSD: string;
  owner: string;
  tradable: boolean;
};

type AssetMetadata = {
  ipfsUrls: string[];
  localFiles: string[];
  timestamp: string;
};

type AssetWithStatus = Asset & { 
  minted?: boolean; 
  metadata?: AssetMetadata; 
  tokenId?: string;
  nftUri?: string;
};

export default function ViewAssetsPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [assets, setAssets] = useState<AssetWithStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState<Record<string, boolean>>({});
  const [currentMintingRequestId, setCurrentMintingRequestId] = useState<string>('');

  // Direct contract interaction
  const { writeContract, data: hash, isPending, error: contractError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Watch for NFT Transfer events to capture Token IDs
  useWatchContractEvent({
    address: addresses.rwaNft as `0x${string}`,
    abi: [
      {
        "anonymous": false,
        "inputs": [
          {"indexed": true, "internalType": "address", "name": "from", "type": "address"},
          {"indexed": true, "internalType": "address", "name": "to", "type": "address"},
          {"indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256"}
        ],
        "name": "Transfer",
        "type": "event"
      }
    ] as const,
    eventName: 'Transfer',
    onLogs(logs) {
      console.log('NFT Transfer events received:', logs);
      logs.forEach((log) => {
        console.log('Processing Transfer event:', log);
        const { args } = log as any;
        console.log('Event args:', args);
        
        // Check if this is a mint (from zero address) to current user
        if (args?.from === '0x0000000000000000000000000000000000000000' && 
            args?.to?.toLowerCase() === address?.toLowerCase()) {
          
          const tokenId = args.tokenId?.toString();
          console.log(`🎉 NFT Transfer detected - TokenID: ${tokenId}, To: ${args.to}, From: ${args.from}`);
          
          if (tokenId) {
            // Store immediately with a timestamp for debugging
            const stored = localStorage.getItem('requestIdToTokenId') || '{}';
            const mapping = JSON.parse(stored);
            
            // If we have a current minting request, map it
            if (currentMintingRequestId) {
              mapping[currentMintingRequestId] = tokenId;
              mapping[`${currentMintingRequestId}_timestamp`] = new Date().toISOString();
              localStorage.setItem('requestIdToTokenId', JSON.stringify(mapping));
              console.log(`✅ Mapped RequestID ${currentMintingRequestId} → TokenID ${tokenId}`);
              
              // Clear the current minting request ID
              setCurrentMintingRequestId('');
              
              // Refresh assets immediately
              setTimeout(() => {
                console.log('Refreshing assets after Token ID capture...');
                loadMyAssets();
              }, 500);
            } else {
              // Store with a generic key for manual recovery
              const fallbackKey = `tokenId_${tokenId}_${Date.now()}`;
              mapping[fallbackKey] = {
                tokenId,
                timestamp: new Date().toISOString(),
                userAddress: address
              };
              localStorage.setItem('requestIdToTokenId', JSON.stringify(mapping));
              console.log(`⚠️ No current minting request, stored as: ${fallbackKey}`);
            }
          }
        }
      });
    },
  });

  async function loadMyAssets() {
    if (!address) return;
    setError(null);
    setLoading(true);
    try {
      // Get registry (mapping key) internally – we don't show this to the user.
      const regResp = await fetch(`${BACKEND_URL}/assets/registry`);
      const regJson = await regResp.json();
      if (!regResp.ok || !regJson?.address) throw new Error(regJson?.error || 'registry unavailable');

      // Load all assets under the registry and filter to my wallet as struct owner.
      const listResp = await fetch(`${BACKEND_URL}/assets/list?owner=${regJson.address}`);
      const listJson = await listResp.json();
      if (!listResp.ok) throw new Error(listJson?.error || 'load failed');
      const list: Asset[] = listJson.assets || [];
      const mine = list.filter(a => a.owner?.toLowerCase() === address.toLowerCase());

      // Fetch minted status, metadata, and NFT info per asset
      const withStatus: AssetWithStatus[] = [];
      for (const a of mine) {
        let assetWithStatus: AssetWithStatus = { ...a, minted: undefined };
        
        try {
          // Get minted status
          const s = await fetch(`${BACKEND_URL}/manager/status?user=${address}&requestId=${a.assetId}`);
          const sj = await s.json();
          assetWithStatus.minted = !!sj?.minted;
        } catch {
          // Keep minted as undefined if status check fails
        }

        try {
          // Get metadata (IPFS URLs)
          const metaResp = await fetch(`${BACKEND_URL}/assets/metadata/${a.assetId}`);
          if (metaResp.ok) {
            const metaJson = await metaResp.json();
            if (metaJson.metadata) {
              assetWithStatus.metadata = metaJson.metadata;
            }
          }
        } catch {
          // Keep metadata as undefined if fetch fails
        }

        try {
          // Get Token ID from localStorage mapping
          const stored = localStorage.getItem('requestIdToTokenId') || '{}';
          const mapping = JSON.parse(stored);
          console.log(`Checking Token ID for asset ${a.assetId}:`, mapping[a.assetId]);
          if (mapping[a.assetId]) {
            assetWithStatus.tokenId = mapping[a.assetId];
            console.log(`Found Token ID ${mapping[a.assetId]} for asset ${a.assetId}`);
          }
        } catch {
          // Keep tokenId as undefined if localStorage fails
        }

        withStatus.push(assetWithStatus);
      }
      setAssets(withStatus);
    } catch (e: any) {
      setError(e?.message || 'load error');
    } finally {
      setLoading(false);
    }
  }

  async function mintAsset(a: AssetWithStatus) {
    if (!address) return;
    setError(null);
    setMinting((m) => ({ ...m, [a.assetId]: true }));
    
    // Set the current minting request ID to track which asset is being minted
    setCurrentMintingRequestId(a.assetId);
    console.log(`Starting mint for Request ID: ${a.assetId}`);
    
    try {
      const tokenURI = `asset-${a.assetId}`;
      
      // Call contract directly instead of backend
      writeContract({
        address: addresses.rwaManager as `0x${string}`,
        abi: rwaManagerAbi,
        functionName: 'depositRWAAndMintNFT',
        args: [BigInt(a.assetId), BigInt(a.valueInUSD), address, tokenURI],
      });
      
    } catch (e: any) {
      setError(e?.message || 'mint failed');
      setMinting((m) => ({ ...m, [a.assetId]: false }));
    }
  }

  // Handle transaction success
  useEffect(() => {
    if (isSuccess) {
      // Refresh assets after successful mint
      loadMyAssets();
      // Reset minting state for all assets
      setMinting({});
    }
  }, [isSuccess]);

  // Handle contract errors
  useEffect(() => {
    if (contractError) {
      setError((contractError as any)?.shortMessage || contractError.message || 'Transaction failed');
      setMinting({});
    }
  }, [contractError]);

  // Enhanced debug function
  const handleDebugTokenIds = () => {
    const stored = localStorage.getItem('requestIdToTokenId') || '{}';
    const mapping = JSON.parse(stored);
    console.log('=== TOKEN ID DEBUG ===');
    console.log('Current Token ID mapping:', mapping);
    console.log('Current minting request ID:', currentMintingRequestId);
    console.log('Connected address:', address);
    console.log('NFT contract address:', addresses.rwaNft);
    console.log('Assets count:', assets.length);
    
    // Check each asset for Token ID mapping
    assets.forEach((asset, index) => {
      console.log(`Asset ${index + 1}:`, {
        assetId: asset.assetId,
        hasTokenId: !!mapping[asset.assetId],
        tokenId: mapping[asset.assetId],
        metadata: asset
      });
    });
    
    alert(`Found ${Object.keys(mapping).length} Token ID mappings. Check console for details.`);
  };

  // Function to manually try to fetch Token IDs from recent transactions
  const tryFetchTokenIds = async () => {
    if (!address) {
      alert('Please connect your wallet first');
      return;
    }
    
    try {
      console.log('🔍 Attempting to fetch recent NFT transfers...');
      
      // Force refresh the mapping and assets
      loadMyAssets();
      
      // Show current state
      const stored = localStorage.getItem('requestIdToTokenId') || '{}';
      const mapping = JSON.parse(stored);
      
      console.log('After refresh - Token ID mappings:', mapping);
      alert('Refreshed asset data. Check console for Token ID status.');
      
    } catch (error) {
      console.error('Error fetching Token IDs:', error);
      alert('Error fetching Token IDs. Check console for details.');
    }
  };

  // Component to display individual asset with enhanced info
  function AssetCard({ asset }: { asset: AssetWithStatus }) {
    const [nftUri, setNftUri] = useState<string>('');
    
    // Get NFT URI if we have tokenId
    const { data: tokenUri } = useReadContract({
      address: addresses.rwaNft as `0x${string}`,
      abi: [
        {
          "inputs": [{"internalType": "uint256", "name": "tokenId", "type": "uint256"}],
          "name": "tokenURI",
          "outputs": [{"internalType": "string", "name": "", "type": "string"}],
          "stateMutability": "view",
          "type": "function"
        }
      ] as const,
      functionName: 'tokenURI',
      args: [asset.tokenId ? BigInt(asset.tokenId) : 0n],
      query: { enabled: !!asset.tokenId },
    });

    useEffect(() => {
      if (tokenUri) {
        setNftUri(tokenUri as string);
      }
    }, [tokenUri]);

    return (
      <div key={`${asset.owner}-${asset.assetId}`} className="card" style={{ padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          <div><strong>Asset ID:</strong> {asset.assetId}</div>
          <div><strong>Type:</strong> {asset.assetType}</div>
          <div><strong>Name:</strong> {asset.assetName}</div>
          <div><strong>Value USD:</strong> {asset.valueInUSD}</div>
          <div><strong>Locked:</strong> {String(asset.isLocked)}</div>
          <div><strong>Verified:</strong> {String(asset.isVerified)}</div>
          <div><strong>Tradable:</strong> {String(asset.tradable)}</div>
          <div><strong>Minted:</strong> {asset.minted === undefined ? '—' : String(asset.minted)}</div>
        </div>

        {/* NFT Information */}
        {asset.tokenId ? (
          <div style={{ marginBottom: 12, padding: 8, background: '#f0f8ff', border: '1px solid #cce7ff', borderRadius: 4 }}>
            <strong>🎨 NFT Details:</strong>
            <div style={{ marginTop: 4 }}>
              <div><strong>Token ID:</strong> {asset.tokenId}</div>
              {nftUri && (
                <div style={{ marginTop: 4 }}>
                  <strong>NFT URI:</strong> 
                  <div style={{ wordBreak: 'break-all', fontSize: '0.9em' }}>
                    <a 
                      href={nftUri} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{ color: '#0066cc', textDecoration: 'underline' }}
                    >
                      {nftUri}
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : asset.minted ? (
          <div style={{ marginBottom: 12, padding: 8, background: '#fff8dc', border: '1px solid #ffd700', borderRadius: 4 }}>
            <strong>⚠️ NFT Minted but Token ID not captured</strong>
            <div style={{ fontSize: '0.9em', marginTop: 4 }}>
              The NFT was minted but the Token ID wasn't automatically captured. 
              Try refreshing or check the browser console for errors.
            </div>
          </div>
        ) : null}

        {/* IPFS Files */}
        {asset.metadata && asset.metadata.ipfsUrls && asset.metadata.ipfsUrls.length > 0 && (
          <div style={{ marginBottom: 12, padding: 8, background: '#f0fff0', border: '1px solid #ccffcc', borderRadius: 4 }}>
            <strong>📁 Asset Files (IPFS):</strong>
            <div style={{ marginTop: 4 }}>
              {asset.metadata.ipfsUrls.map((url: string, i: number) => (
                <div key={i} style={{ marginBottom: 4 }}>
                  <a 
                    href={url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    style={{ color: '#0066cc', textDecoration: 'underline', fontSize: '0.9em' }}
                  >
                    🔗 View File {i + 1}
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Local Files (fallback) */}
        {asset.metadata && asset.metadata.localFiles && asset.metadata.localFiles.length > 0 && (
          <div style={{ marginBottom: 12, padding: 8, background: '#fff8f0', border: '1px solid #ffeecc', borderRadius: 4 }}>
            <strong>📂 Local Files:</strong>
            <div style={{ marginTop: 4 }}>
              {asset.metadata.localFiles.map((file: string, i: number) => (
                <div key={i} style={{ marginBottom: 4 }}>
                  <a 
                    href={`${BACKEND_URL}${file}`} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    style={{ color: '#0066cc', textDecoration: 'underline', fontSize: '0.9em' }}
                  >
                    📄 {file.split('/').pop()}
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {!asset.minted && (
          <div style={{ marginTop: 12 }}>
            <button 
              onClick={() => mintAsset(asset)} 
              disabled={minting[asset.assetId] || !isConnected || isPending || isConfirming}
              style={{ 
                padding: '8px 16px', 
                backgroundColor: '#0066cc', 
                color: 'white', 
                border: 'none', 
                borderRadius: 4,
                cursor: 'pointer'
              }}
            >
              {isPending ? 'Confirming Transaction...' : 
               isConfirming ? 'Waiting for Confirmation...' : 
               minting[asset.assetId] ? 'Minting…' : 'Mint NFT & Coins'}
            </button>
          </div>
        )}
      </div>
    );
  }

  useEffect(() => {
    if (isConnected) {
      // Auto-load when wallet connects/changes
      loadMyAssets();
    } else {
      setAssets([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnected]);

  return (
    <div>
      <h4>My Verified Assets</h4>
      {!isConnected && <p>Connect your wallet to see your assets.</p>}
      <div style={{ marginTop: 8 }}>
        <button onClick={loadMyAssets} disabled={!isConnected || loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button 
          onClick={handleDebugTokenIds}
          style={{ marginLeft: 8 }}
        >
          Debug Token IDs
        </button>
        <button 
          onClick={tryFetchTokenIds}
          style={{ marginLeft: 8 }}
          disabled={!isConnected}
        >
          Force Refresh NFTs
        </button>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <div className="mt-3" style={{ display: 'grid', gap: 16 }}>
        {assets.map((asset) => (
          <AssetCard key={`${asset.owner}-${asset.assetId}`} asset={asset} />
        ))}
        {!loading && isConnected && assets.length === 0 && <p>No assets found for your wallet.</p>}
      </div>
      
      {/* Transaction Status */}
      {hash && (
        <div style={{ marginTop: 12, padding: 8, background: '#f0f8ff', border: '1px solid #cce7ff', borderRadius: 6 }}>
          <p><strong>Transaction:</strong> {hash}</p>
          {isConfirming && <p>⏳ Waiting for confirmation...</p>}
          {isSuccess && <p style={{ color: 'green' }}>✅ Transaction successful!</p>}
        </div>
      )}
    </div>
  );
}
