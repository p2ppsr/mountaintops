# Mountaintops

A client-only BRC-100 wallet application at [mountaintops.net](https://mountaintops.net). Static files are served through the existing CARS frontend project. Mountaintops has no application API, registry server, database, or deposit-watching service.

## Receiving, expiration and recovery

The main Receive view shows one selected address, its expiration status and payment controls. Other addresses, advanced search targets, transaction eligibility and recovery explanations are collapsed until needed; Send has its own view. A saved address with longer coverage is offered directly before suggesting more mining. Expiration warnings and fees remain beside the affected action.

The original address keeps the exact `[1, 'mountaintops']`, decimal key ID `1`, counterparty `anyone`, `forSelf: true` derivation. Browser workers search canonical decimal key IDs from `1` upward, returning the first match for a fixed BRC-234 target. The suggested target uses a measured 30-second, 95th-percentile work estimate; each work slice is bounded to 30 seconds. Search is free. A match requires explicit **Save address** (wallet fees apply) before the address can be displayed/shared, then **Use for receiving** to switch receiving. Pausing is free; saving resumable progress to the wallet is an explicit fee-bearing step. Unsaved work can always be repeated deterministically from ID 1; no published address depends on that session's memory.

Address publications, primary selections, search progress, permanent receiving retirements, chain checkpoints, bounded-history completion are immutable encrypted on-chain PushDrop records using SDK `LocalKVStore` in wallet basket `mntops v1`. Each metadata record uses a 1-satoshi output plus applicable network and wallet service fees and the wallet's permission flow. There are no certificate APIs or certificate storage. Independent random record keys allow concurrent-device records to merge without overwriting another device's address history. A published address is never acknowledged until the wallet can read its record back.

Restore the same BRC-100 wallet account and its supported storage/recovery service on any device. Browser storage, the old device, an open tab, manually saved key IDs and exports are not recovery dependencies. The original address can be reconstructed without a storage transaction. As with other BRC-100 applications, the wallet account and its storage service must remain available.

At its first recorded exclusion, an address is permanently **Expired — do not send coins to this address**. Copy, receiving selection and payments to retired/expired destinations are blocked. Retirement does not remove ownership or disable imports of existing funds. There is no override. Pending contractions are checked before payment submission. External applications can still send on chain; Mountaintops cannot prevent that or promise discovery of new post-expiration deposits.

Explicit balance checks of eligible addresses use existing WhatsOnChain discovery. After expiration there are no live unspent-address queries or background address polls. A first-returning user can perform one bounded, ascending confirmed-history bootstrap, stopping at the last pre-expiration height. Its completion is saved only after coin evidence is acknowledged by the wallet. Subsequent checks use wallet-retained BEEF and exact known-outpoint status. Known pending TXIDs and orphaned proofs can be resolved without reopening address discovery. Errors and incomplete provider responses never become a zero balance.

Coin evidence and per-input derivation metadata are retained in the `mountaintops receipts v1` wallet basket. Imports validate scripts, satoshis, canonical proofs and actual unspentness; each custom input is signed with its own key ID. Wallet-added inputs stay under the wallet's signer. A filtered BRC-234 ledger total is never used as a spendable balance.

## BRC-234 rules and payment construction

`shared/schedule.json` pins the normative schedule at BRC document blob `85eaa6219cec77350170d52d243e65122e453d39` ([merged proposal](https://github.com/bsv-blockchain/BRCs/blob/068e4b5eac90ebbe726fb067682bf72aadafa4ff/opinions/0234.md)). Mainnet block 1,000,000 establishes the MTP anchor. Calendar gates alone are not expiration dates: all-version non-coinbase volume, frozen pending rounds, the 14-MTP-day notice and following-block activation also apply. Coverage is replayed from parent-linked WoC block evidence and wallet checkpoints; reorged checkpoints are discarded. Initial catch-up after the anchor can be lengthy. Testnet has no fabricated mainnet sunset.

Address, TXID and script-hash predicates are independent. The app displays funding coverage at confirmation without discarding coins outside those rules. Payments/imports prepare version-1 transactions with supported wallet APIs, bounded nonce variation, `noSend` signing, final-template and final-TXID inspection, fresh coverage checks, and one explicit `sendWith` submission. Candidate payment outputs are never changed to grind. Abandoned candidates are aborted. The wallet may ask for permissions; metadata records have their own fees. The payment work budget is 30 seconds; a match at broadcast remains provisional until confirmation.

Native durable wallet action history and unique labels support recovery after an interrupted submission, without requiring an extra fee-paying record before the first import. An empty wallet can import its first coins. Signed noSend preparations can be canceled by TXID from a fresh device; unsigned or uncertain actions require wallet review. An uncertain outcome blocks automatic retries and requires checking wallet history. Out-of-session signable-reference recovery is not assumed. Mountaintops does not promise that a BRC-234 merge proves provider adoption, indefinite WoC availability, complete retrieval of data a provider no longer serves, or external wallet transaction-grinding support. Such failures remain explicit, with retained funds and keys intact.

The **Activity this session** list is ephemeral React state and clears on reload. Mountaintops does not create extra history tokens or load past completed payments into that list. The wallet retains its own mandatory transaction records and coin proofs; native unfinished-action checks remain for duplicate-payment protection. For existing desktop wallets, the client prefers their standard JSON bridge over SDK 4's changed binary output format, only after verifying the same identity and network. CWI/mobile transports are unchanged.

## Development and validation

Use Node 24:

```sh
cd frontend
npm ci
npm test
npm run lint
npm run build
npm audit --omit=dev --audit-level=moderate
```

CI runs these checks. Tests use real SDK derivation, signing, encryption, PushDrop and BEEF with disposable synthetic funding. `frontend/test/ui.html` is a development-only isolated wallet/network fixture; `?expired` exercises retirement without using real funds. Vite production builds include only `index.html` and its assets, excluding fixtures.

All anonymous WoC reads share a three-requests-per-second scheduler with bounded safe-read retries and `Retry-After` handling. No API key is bundled. Wallet retained evidence does not remove the current canonical-root and actual spend-status dependency on WoC. If WoC is unavailable, the app reports an incomplete check instead of treating coins as lost or spendable.

## Release and recovery

Production is frontend-only CARS project `1133dd7636b44d50134df01fd7fe5ec1`, configuration `1` in `deployment-info.json`:

```sh
npm ci
npx cars doctor 1
npm run build
npm run deploy
```

The root uses current CARS CLI. Releases require operator-owned Evans safety gates, isolated canary rendering/drain qualification, continuous probes of custom and generated domains, exact deployed-asset verification, and two Ready serving endpoints on distinct nodes. `ops/canary.Dockerfile` supports a Linux/amd64 remote qualification image of the same frontend source; it adds no application backend. Deployment records, images, routing, release credentials and rollback evidence belong in network-ops.

After publishing addresses, rollback must preserve this wallet record format, expiration blocks and access to all saved key IDs. Do not roll back to the old single-address frontend. Retain the accepted compatible frontend image and use forward repair or a compatible image rollback; never delete wallet recovery outputs or resume expired-address discovery.
