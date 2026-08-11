import { useState, useRef } from 'react';
import WalletClient from '@bsv/sdk/wallet/WalletClient';
import PublicKey from '@bsv/sdk/primitives/PublicKey';
import P2PKH from '@bsv/sdk/script/templates/P2PKH';
import { CreateActionInput, SignActionArgs } from '@bsv/sdk/wallet/Wallet.interfaces';
import Importer from './Importer';
import Transaction from '@bsv/sdk/transaction/Transaction';
import { Beef } from '@bsv/sdk/transaction/Beef';
import { useMNCErrorHandler } from 'metanet-react-prompt';
import getBeefForTxid from './getBeefForTxid';
import { whatsOnChainFetch } from './whatsOnChainClient';

// Instantiate a new BSV WalletClient (auto-detects wallet environment).
const client = new WalletClient('auto');

// Background music (public domain piece for demonstration):
const backgroundMusicUrl =
    'https://upload.wikimedia.org/wikipedia/commons/8/8f/Fur_Elise.ogg';

// Sound effect (Wilhelm Scream or similar for "shouting" BSV):
const shoutSoundUrl = '/shout.mp3';

// Main Component
const Mountaintops: React.FC = () => {
    const handleMNCError = useMNCErrorHandler()
    const [mountaintopsAddress, setMountaintopsAddress] = useState<string | null>(null);
    const [balance, setBalance] = useState<number>(-1);
    const [recipientAddress, setRecipientAddress] = useState<string>('');
    const [amount, setAmount] = useState<string>('');
    const [transactions, setTransactions] = useState<
        Array<{ txid: string; to: string; amount: string }>
    >([]);

    // Refs for audio elements
    const shoutAudioRef = useRef<HTMLAudioElement>(null);
    const bgAudioRef = useRef<HTMLAudioElement>(null);

    // Track whether background music is playing
    const [isMusicPlaying, setIsMusicPlaying] = useState(false);

    // Fetch the real wallet network
    const getRealWalletNetwork = async (): Promise<'mainnet' | 'testnet'> => {
        try {
            const { network } = await client.getNetwork({});
            return network;
        } catch (e) {
            handleMNCError(e as Error)
            throw e
        }
    };

    // Derive a public "Mountaintops" address (publicly exposed in this app)
    const getMountaintopsAddress = async (): Promise<string> => {
        const network = await getRealWalletNetwork();
        const { publicKey } = await client.getPublicKey({
            protocolID: [1, 'mountaintops'],
            keyID: '1',
            counterparty: 'anyone',
            forSelf: true,
        });
        return PublicKey.fromString(publicKey).toAddress(network);
    };

    interface Utxo {
        txid: string;
        vout: number;
        satoshis: number;
    }

    interface WoCAddressUnspentAll {
        error: string,
        address: string,
        script: string,
        result: {
            height?: number,
            tx_pos: number,
            tx_hash: string,
            value: number,
            isSpentInMempoolTx: boolean,
            status: string
        }[]
    }

    const getUtxosForAddress = async (address: string): Promise<Utxo[]> => {
        const network = await getRealWalletNetwork();
        const response = await whatsOnChainFetch(
            `https://api.whatsonchain.com/v1/bsv/${network === 'mainnet' ? 'main' : 'test'
            }/address/${encodeURIComponent(address)}/unspent/all`
        );
        if (!response.ok) {
            throw new Error(`WhatsOnChain UTXO request failed (${response.status} ${response.statusText})`);
        }
        const rp: WoCAddressUnspentAll = await response.json();
        if (!Array.isArray(rp.result)) {
            throw new Error(rp.error || 'WhatsOnChain returned an invalid UTXO response');
        }
        const utxos: Utxo[] = rp.result.filter(r => r.isSpentInMempoolTx === false).map(r => ({ txid: r.tx_hash, vout: r.tx_pos, satoshis: r.value }));
        return utxos
    }

    // Fetch BSV balance for a given address
    const fetchBSVBalance = async (address: string): Promise<number> => {
        const utxos = await getUtxosForAddress(address);
        const balance = utxos.reduce((acc, r) => acc + r.satoshis, 0);
        return balance / 100000000;
    };

    // Send BSV to a recipient address
    const sendBSV = async (to: string, amount: number): Promise<string | undefined> => {
        const network = await getRealWalletNetwork();
        // Very naive network vs. address check for demo:
        if (network === 'mainnet' && !to.startsWith('1')) {
            alert('You are on mainnet but the recipient address does not look like a mainnet address (starting with 1)!');
            return;
        }

        const lockingScript = new P2PKH().lock(to).toHex();
        const { txid } = await client.createAction({
            description: 'Shout BSV at an address',
            outputs: [
                {
                    lockingScript,
                    satoshis: Math.round(amount * 100000000),
                    outputDescription: 'BSV for recipient address',
                },
            ],
        });
        return txid;
    };

    // Show your address
    const handleViewAddress = async () => {
        setMountaintopsAddress(await getMountaintopsAddress());
    };

    // Get your balance
    const handleGetBalance = async () => {
        if (mountaintopsAddress) {
            try {
                const fetchedBalance = await fetchBSVBalance(mountaintopsAddress);
                setBalance(fetchedBalance);
            } catch (e) {
                console.error(e);
                const message = e instanceof Error ? e.message : 'unknown error';
                alert(`Could not fetch the public address balance: ${message}`);
            }
        } else {
            alert('Get your address first!');
        }
    };

    // Import funds from the "Mountaintops" address
    const handleImportFunds = async () => {
        if (!mountaintopsAddress || balance < 0) {
            alert('Get your address and balance first!');
            return;
        }
        if (balance === 0) {
            alert('No money to import!');
            return;
        }

        let reference: string | undefined = undefined;
        try {
            const network = await getRealWalletNetwork();
            const utxos = await getUtxosForAddress(mountaintopsAddress);

            const outpoints: string[] = utxos.map(x => `${x.txid}.${x.vout}`)
            const inputs: CreateActionInput[] = outpoints.map(outpoint => ({
                outpoint,
                inputDescription: 'Redeem from the Mountaintops',
                unlockingScriptLength: 108,
            }));

            // Merge BEEF for the inputs (placeholder)
            const inputBEEF = new Beef();
            for (let i = 0; i < inputs.length; i++) {
                const txid = inputs[i].outpoint.split('.')[0];
                if (!inputBEEF.findTxid(txid)) {
                    const beef = await getBeefForTxid(txid, network === 'mainnet' ? 'main' : 'test')
                    inputBEEF.mergeBeef(beef);
                }
            }

            // Create the action for spending from these inputs
            const { signableTransaction } = await client.createAction({
                inputBEEF: inputBEEF.toBinary(),
                inputs,
                description: 'Import from the Mountaintops',
            });

            reference = signableTransaction!.reference;

            // Convert BEEF to a Transaction object
            const tx = Transaction.fromAtomicBEEF(signableTransaction!.tx);
            const importer = new Importer();
            const unlocker = importer.unlock(client);

            const signActionArgs: SignActionArgs = {
                reference,
                spends: {},
            };

            // Sign each input
            for (let i = 0; i < inputs.length; i++) {
                const script = await unlocker.sign(tx, i);
                signActionArgs.spends[i] = {
                    unlockingScript: script.toHex(),
                };
            }

            // Broadcast signatures back to the wallet
            await client.signAction(signActionArgs);

            // Reset the local balance after successful import
            setBalance(0);
            alert('Funds successfully imported to your real wallet!');
        } catch (e) {
            console.error(e)
            // Abort in case something goes wrong
            if (reference) {
                await client.abortAction({ reference });
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const message = `Import failed: ${(e as any).message || 'unknown error'}`;
            alert(message);
        }
    };

    // SHOUT BSV to someone
    const handleShoutBSV = async () => {
        if (!recipientAddress || !amount) {
            alert('Please enter a recipient address AND an amount first!');
            return;
        }

        const amt = Number(amount);
        if (isNaN(amt) || amt <= 0) {
            alert('Please enter a valid amount > 0.');
            return;
        }

        const txid = await sendBSV(recipientAddress, amt);
        if (txid) {
            // Play the "shout" sound effect
            if (shoutAudioRef.current) {
                shoutAudioRef.current.currentTime = 0;
                shoutAudioRef.current.play().catch(() => {
                    // Browser may block autoplay if no user interaction
                });
            }
            alert(
                `Successfully SHOUTED ${amt} BSV from your real wallet to ${recipientAddress} with absolutely no privacy! TXID: ${txid}`
            );

            // Record the transaction locally
            setTransactions((prev) => [
                ...prev,
                {
                    txid,
                    to: recipientAddress,
                    amount: amt.toString(),
                },
            ]);
            setRecipientAddress('');
            setAmount('');
        }
    };

    // Toggle background music on/off
    const toggleBackgroundMusic = () => {
        if (!bgAudioRef.current) return;

        if (isMusicPlaying) {
            // Pause music
            bgAudioRef.current.pause();
            setIsMusicPlaying(false);
        } else {
            // Play music
            bgAudioRef.current.currentTime = 0;
            bgAudioRef.current
                .play()
                .then(() => {
                    setIsMusicPlaying(true);
                })
                .catch(() => {
                    alert('Failed to play background music (autoplay restrictions).');
                });
        }
    };

    return (
        <div style={styles.container}>
            {/* "Panoramic" background container */}
            <div style={styles.background}></div>

            {/* Audio elements */}
            <audio ref={shoutAudioRef} src={shoutSoundUrl} preload="auto" />
            <audio ref={bgAudioRef} src={backgroundMusicUrl} loop preload="auto" />

            {/* Main content panel */}
            <div style={styles.content}>
                <h1 style={styles.title}>Mountaintops</h1>
                <p style={styles.subtitle}>
                    Shout all your transactions from the mountaintops, with <br />
                    <span style={{ color: '#ff5757', fontWeight: 'bold' }}>
                        ABSOLUTELY NO PRIVACY!
                    </span>
                </p>

                {/* Toggle background music button */}
                <div style={styles.musicToggleArea}>
                    <button style={styles.musicButton} onClick={toggleBackgroundMusic}>
                        {isMusicPlaying ? 'Pause Background Music' : 'Play Background Music'}
                    </button>
                </div>

                {/* Address and balance section */}
                <div style={styles.section}>
                    {!mountaintopsAddress ? (
                        <button style={styles.actionButton} onClick={handleViewAddress}>
                            Show My BSV Address
                        </button>
                    ) : (
                        <>
                            <p style={styles.label}>Your Mountaintops Address (exposed):</p>
                            <div style={styles.addressBox}>{mountaintopsAddress}</div>

                            <div style={styles.buttonsRow}>
                                <button style={styles.actionButton} onClick={handleGetBalance}>
                                    Get Balance
                                </button>
                                <button style={styles.actionButton} onClick={handleImportFunds}>
                                    Import Money
                                </button>
                            </div>

                            <p style={styles.balanceText}>
                                Current BSV at this super-public address:{' '}
                                {balance === -1
                                    ? 'Not checked yet!'
                                    : `${balance} BSV (everyone can see it!)`}
                            </p>
                        </>
                    )}
                </div>

                {/* Shout BSV form */}
                <div style={styles.section}>
                    <h3 style={styles.sectionTitle}>
                        SHOUT BSV Across To Someone:
                    </h3>
                    <input
                        style={styles.input}
                        placeholder="Recipient Address"
                        value={recipientAddress}
                        onChange={(e) => setRecipientAddress(e.target.value)}
                    />
                    <input
                        style={styles.input}
                        placeholder="Amount (BSV)"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                    />
                    <button style={{ ...styles.actionButton, ...styles.shoutButton }} onClick={handleShoutBSV}>
                        SHOUT BSV
                    </button>
                </div>

                {/* List of previous shouted transactions */}
                <div style={styles.section}>
                    <h3 style={styles.sectionTitle}>Shouted Transactions</h3>
                    {transactions.length === 0 ? (
                        <p style={styles.emptyState}>
                            No transactions shouted yet... (but the world is waiting!)
                        </p>
                    ) : (
                        <ul style={styles.txList}>
                            {transactions.map((tx, index) => (
                                <li key={index} style={styles.txListItem}>
                                    <strong>TXID:</strong> {tx.txid}
                                    <br />
                                    <strong>To:</strong> {tx.to}
                                    <br />
                                    <strong>Amount:</strong> {tx.amount} BSV
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <p style={styles.attribution}>
                    Powered by{' '}
                    <a href="https://whatsonchain.com" target="_blank" rel="noreferrer" style={styles.attributionLink}>
                        WhatsOnChain
                    </a>
                </p>
            </div>
        </div>
    );
};

/** ========== STYLING & ANIMATIONS ========== */

const styles: { [key: string]: React.CSSProperties } = {
    container: {
        position: 'relative',
        height: '100vh',
        width: '100vw',
        overflow: 'auto',
        margin: 0,
        padding: 0,
        fontFamily: `'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`,
        color: '#fff',
        textAlign: 'center',
    },

    // Key background with slow panning effect
    background: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: -1,
        backgroundImage:
            'url("/mountains.jpg")',
        backgroundRepeat: 'no-repeat',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        // Sloooow pan from left to right (30s)
        animation: 'pan 30s infinite alternate linear',
    },

    content: {
        position: 'relative',
        marginTop: 50,
        marginBottom: 50,
        padding: 20,
        width: '90%',
        maxWidth: 700,
        marginLeft: 'auto',
        marginRight: 'auto',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        borderRadius: 12,
        boxShadow: '0 0 20px rgba(0,0,0,0.5)',
    },

    title: {
        fontSize: '3rem',
        margin: 0,
        fontWeight: 700,
        textShadow: '2px 2px 4px #000',
    },
    subtitle: {
        marginTop: 10,
        marginBottom: 20,
        fontSize: '1.2rem',
        lineHeight: 1.4,
        textShadow: '1px 1px 2px #000',
    },

    musicToggleArea: {
        marginBottom: 20,
    },
    musicButton: {
        backgroundColor: '#4caf50',
        border: 'none',
        padding: '10px 25px',
        fontSize: '1rem',
        borderRadius: 8,
        cursor: 'pointer',
        transition: 'transform 0.2s ease, background-color 0.2s ease',
        color: '#fff',
        fontWeight: 600,
    },

    section: {
        marginTop: 30,
        marginBottom: 30,
    },
    sectionTitle: {
        fontSize: '1.5rem',
        marginBottom: 10,
        textShadow: '1px 1px 3px #000',
    },

    label: {
        fontWeight: 'bold',
        fontSize: '1rem',
        marginBottom: 5,
    },
    addressBox: {
        backgroundColor: '#222',
        padding: '10px',
        borderRadius: 6,
        marginBottom: 10,
        overflowWrap: 'break-word',
        fontSize: '0.9rem',
        letterSpacing: '0.5px',
    },
    buttonsRow: {
        display: 'flex',
        justifyContent: 'center',
        marginBottom: 20,
        gap: 10,
    },
    actionButton: {
        backgroundColor: '#ff004c',
        color: '#fff',
        padding: '10px 20px',
        borderRadius: 8,
        border: 'none',
        fontSize: '1rem',
        cursor: 'pointer',
        fontWeight: 600,
        transition: 'transform 0.2s ease, background-color 0.2s ease',
        boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
    },
    shoutButton: {
        animation: 'pulse 2s infinite',
    },
    balanceText: {
        marginTop: 15,
        fontSize: '1.1rem',
        fontStyle: 'italic',
    },

    input: {
        display: 'block',
        width: '80%',
        maxWidth: 400,
        margin: '10px auto',
        padding: '10px',
        borderRadius: 6,
        border: '2px solid #ff004c',
        outline: 'none',
        fontSize: '1rem',
        textAlign: 'center',
        backgroundColor: '#fff',
        color: '#000',
    },
    emptyState: {
        marginTop: 15,
        fontStyle: 'italic',
        fontSize: '0.95rem',
    },
    txList: {
        listStyle: 'none',
        margin: 0,
        padding: 0,
        textAlign: 'left',
    },
    txListItem: {
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        marginBottom: 10,
        padding: 10,
        borderRadius: 6,
        fontSize: '0.9rem',
        overflowWrap: 'break-word',
    },
    attribution: {
        marginTop: 20,
        marginBottom: 0,
        fontSize: '0.8rem',
        opacity: 0.85,
    },
    attributionLink: {
        color: '#fff',
    },
};

/**
 * We define our keyframe animations here:
 *  - A slow horizontal pan for the background
 *  - A pulse for the SHOUT button
 */
const styleSheet = document.createElement('style');
styleSheet.type = 'text/css';
styleSheet.innerHTML = `
@keyframes pan {
  0% {
    background-position: left center;
  }
  100% {
    background-position: right center;
  }
}

@keyframes pulse {
  0% { transform: scale(1); box-shadow: 0 0 5px rgba(255,0,76,0.5); }
  50% { transform: scale(1.05); box-shadow: 0 0 20px rgba(255,0,76,0.7); }
  100% { transform: scale(1); box-shadow: 0 0 5px rgba(255,0,76,0.5); }
}

/* Hover effect on buttons */
button:hover {
  transform: scale(1.05);
}

/* Active (clicked) effect on buttons */
button:active {
  transform: scale(0.95);
}

body {
  margin: 0;
}
`;
document.head.appendChild(styleSheet);

export default Mountaintops;
