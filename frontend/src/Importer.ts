import { UnlockingScript, Signature, TransactionSignature, Hash, Utils, P2PKH, PublicKey, type Transaction, type WalletInterface } from '@bsv/sdk'
import { canonicalKeyID } from '../../shared/brc234.ts'

function verifyTruthy<T>(v: T | undefined): T {
    if (v == null) throw new Error('must have value')
    return v
}

export default class Importer {
    unlock(
        client: WalletInterface,
        keyID = '1'
    ): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
        estimateLength: () => Promise<108>
    } {
        canonicalKeyID(keyID)
        return {
            sign: async (tx: Transaction, inputIndex: number) => {
                let signatureScope = TransactionSignature.SIGHASH_FORKID
                signatureScope |= TransactionSignature.SIGHASH_ALL
                const input = tx.inputs[inputIndex]
                const otherInputs = tx.inputs.filter(
                    (_, index) => index !== inputIndex
                )
                const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
                if (sourceTXID == null || sourceTXID === undefined) {
                    throw new Error(
                        'The input sourceTXID or sourceTransaction is required for transaction signing.'
                    )
                }
                if (sourceTXID === '') {
                    throw new Error(
                        'The input sourceTXID or sourceTransaction is required for transaction signing.'
                    )
                }
                const sourceSatoshis =
                    input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis
                if (sourceSatoshis == null || sourceSatoshis === undefined) {
                    throw new Error(
                        'The sourceSatoshis or input sourceTransaction is required for transaction signing.'
                    )
                }
                const lockingScript =
                    input.sourceTransaction?.outputs[input.sourceOutputIndex]
                        .lockingScript
                if (lockingScript == null) {
                    throw new Error(
                        'The lockingScript or input sourceTransaction is required for transaction signing.'
                    )
                }

                const { publicKey } = await client.getPublicKey({
                    protocolID: [1, 'mountaintops'], keyID,
                    counterparty: 'anyone', forSelf: true
                })
                const expectedScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
                if (lockingScript.toHex() !== expectedScript) {
                    throw new Error('The input script does not match its Mountaintops key ID')
                }

                const preimage = TransactionSignature.format({
                    sourceTXID,
                    sourceOutputIndex: verifyTruthy(input.sourceOutputIndex),
                    sourceSatoshis,
                    transactionVersion: tx.version,
                    otherInputs,
                    inputIndex,
                    outputs: tx.outputs,
                    inputSequence: verifyTruthy(input.sequence),
                    subscript: lockingScript,
                    lockTime: tx.lockTime,
                    scope: signatureScope
                })

                const hashToSign = Hash.sha256(Hash.sha256(preimage))
                const { signature } = await client.createSignature({
                    hashToDirectlySign: hashToSign,
                    protocolID: [1, 'mountaintops'],
                    keyID,
                    counterparty: 'anyone'
                })
                const rawSignature = Signature.fromDER(signature)
                const sig = new TransactionSignature(
                    rawSignature.r,
                    rawSignature.s,
                    signatureScope
                )
                const sigForScript = sig.toChecksigFormat()
                const pubkeyForScript = Utils.toArray(publicKey, 'hex')
                return new UnlockingScript([
                    { op: sigForScript.length, data: sigForScript },
                    { op: pubkeyForScript.length, data: pubkeyForScript }
                ])
            },
            estimateLength: async () => {
                return 108
            }
        }
    }
}
