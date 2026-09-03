# Third-Party Direct Funding of Lightning Channels

Status: DRAFT / PROPOSAL (revision 2, incorporating external review)

This document proposes a protocol by which an unrelated payer's on-chain
payment becomes the recipient's Lightning channel funding transaction
directly. The payer's coin moves exactly once, into a channel output the
recipient controls, with no intermediate deposit transaction and no
custodial hop.

The proposal is structured as a CORE SPECIFICATION that is deliberately
confirmation-gated and minimal, TRANSPORT PROFILES that carry it, and
EXTENSIONS that are explicitly out of the core: splice-in funding,
delegated zero-confirmation, and non-Lightning rendezvous.

Venue: this should first be circulated as an RFC to the Lightning
development mailing list, then submitted as a bLIP once at least one
independent implementation (or a serious commitment to one) exists. It
rides only odd, ignorable message types and a BIP 21 parameter that
unaware wallets skip, so it requires nothing from non-participants; the
bLIP track fits until near-universal support is the goal. It is not
proposed as a BIP: its interoperability surface is Lightning behavior.

## Table of Contents

Part 1: Core specification
1. [Motivation](#motivation)
2. [Overview](#overview)
3. [The payment request envelope](#the-payment-request-envelope)
4. [Frame encryption](#frame-encryption)
5. [The funding protocol](#the-funding-protocol)
6. [Transaction verification invariants](#transaction-verification-invariants)
7. [State machines and recovery](#state-machines-and-recovery)
8. [Delivery semantics and resource protection](#delivery-semantics-and-resource-protection)
9. [Security considerations](#security-considerations)

Part 2: Transport profiles
10. [Direct peer profile](#direct-peer-profile)
11. [Onion message profile](#onion-message-profile)
12. [Blind relay profile](#blind-relay-profile)

Part 3: Extensions
13. [Extension: splice-in funding](#extension-splice-in-funding)
14. [Extension: delegated zero-confirmation](#extension-delegated-zero-confirmation)
15. [Extension: non-Lightning rendezvous](#extension-non-lightning-rendezvous)

16. [Rationale](#rationale)
17. [Reference implementation](#reference-implementation)

# Part 1: Core specification

## Motivation

A Lightning-first wallet wants every incoming payment to land as Lightning
channel balance. Today an on-chain payment to such a wallet requires two
transactions: the payer's payment to an address, then the receiver's sweep
of that deposit into a channel open or splice. The second transaction
costs fees and confirmation time, and between the two the funds sit idle.

Dual-funded channel establishment (BOLT 2 interactive transaction
construction) already allows a funding transaction to spend inputs
contributed by more than one party, and its design accommodates inputs
whose witnesses arrive late. This proposal extends that capability to a
party who is not a channel member at all: the PAYER. The payer contributes
the input, verifies in the exact transaction it signs that its coin funds
a channel output attested by the receiver's node key, and signs only that
transaction.

What the core protocol guarantees, stated precisely: the chain
transaction atomically moves the payer's input into a receiver-attested
channel funding output, and by BOLT 2 ordering the receiver holds an
enforceable commitment allocating its channel balance before the
transaction can broadcast. It does NOT by itself guarantee the channel
becomes operational without a force close, and the core protocol treats
nothing as spendable before confirmation.

The receiver hands out one request string that degrades gracefully: any
wallet can pay the plain BIP 21 address it contains, while a
protocol-aware payer upgrades the same string to direct funding.

## Overview

```
  Payer                      Receiver                       LSP
    |  funding_offer            |                             |
    |-------------------------->|  validate, reserve, ack     |
    |<---- funding_offer_ack ---|                             |
    |                           |  open_channel2 with the     |
    |                           |  payer's input (external)   |
    |                           |---- interactive tx -------->|
    |                           |<--- commitment_signed ----->|
    |<--- funding_sign_request--|  negotiated raw tx          |
    |  verify + sign            |                             |
    |----- funding_witness ---->|  merge, tx_signatures       |
    |                           |  broadcast: ONE chain tx    |
    |<--- funding_receipt ------|  preimage + full tx         |
```

The receiver's channel counterparty (its LSP) participates only in
standard dual-funding negotiation. In the CORE protocol the funding is
confirmation-gated for all parties, so the counterparty carries no
unconfirmed-input risk and needs no knowledge of the input's true owner.
Any relaxation of that statement lives in the delegated zero-confirmation
extension, which requires the counterparty's explicit consent.

## The payment request envelope

The receiver mints one signed request per expected payment and embeds it
in a BIP 21 URI parameter (`bgnq` in the reference implementation).

### Contents

| Field              | Size     | Description                                  |
|--------------------|----------|----------------------------------------------|
| `version`          | u8       | Envelope version (3)                         |
| `request_id`       | 16 bytes | Unique per request                           |
| `chain_hash`       | 32 bytes | BOLT chain_hash of the intended chain        |
| `receiver_node_id` | 33 bytes | The node the payment is for                  |
| `expires_at`       | u48      | Expiry, milliseconds since epoch             |
| `flags`            | u8       | Bit 0: `amount_sat` present                  |
| `amount_sat`       | u64      | Optional fixed amount                        |
| `receipt_hash`     | 32 bytes | SHA256 of a preimage held by the receiver    |
| `encryption_key`   | 33 bytes | Per-request secp256k1 public key, compressed |
| `num_transports`   | u8       | Count of transport descriptors               |
| `transports`       | variable | Length-prefixed descriptors, defined below   |
| `signature`        | 65 bytes | Compact recoverable signature, defined below |

The envelope is this binary structure, base64url. A final specification
SHOULD express the envelope and all protocol messages as canonical
Lightning TLV streams with the usual unknown-even/unknown-odd semantics;
the fixed layout here is the reference implementation's rev-2 encoding
and already carries the property that matters most for evolution: every
transport descriptor is length-prefixed and therefore skippable by a
decoder that does not know its type.

`chain_hash` binds the request to one chain. A node key reused across
mainnet, testnet, signet, and regtest cannot have a request replayed onto
the wrong chain; the payer MUST refuse a request whose chain_hash is not
the chain it would pay on.

### The signature, exactly

The signed message is the ASCII string:

```
"beignet-df-req:v3:" || base64url(envelope bytes with signature omitted)
```

The signature scheme is the de facto Lightning message-signing standard:

```
digest    = SHA256(SHA256("Lightning Signed Message:" || message))
signature = compact recoverable ECDSA over secp256k1: [header || r || s]
            header = 27 + 4 + recovery_id (the LND/CLN zbase32 scheme's
            byte layout, carried here as the raw 65 bytes)
```

Verifiers MUST recover the public key from the signature and digest and
REQUIRE it to equal `receiver_node_id`. There is no separate pubkey field
to confuse with the recovered one.

The payer, on receiving a request, MUST verify the envelope BEFORE any
network activity: malformed, expired, wrong-chain, invalid-signature, and
wrong-signer envelopes all die on the payer's device with the reason.

### Transport descriptors

```
transport_descriptor = u8 type || u16 value_length || value
```

Unknown types MUST be skipped using `value_length`. Types 1 to 3 are
defined in the transport profiles; type 4 is reserved for the
non-Lightning rendezvous extension.

Descriptors appear in the receiver's preference order. The payer MUST try
them in that order and MUST NOT fall through to a later transport after
any protocol frame has been exchanged on an earlier one; only
connection-establishment failures fall through.

### Request lifecycle requirements

The receiver:

- MUST generate a fresh `request_id`, receipt preimage, and encryption
  keypair per request; none may be reused across requests.
- MUST retire a request when its preimage is revealed or it expires.
- SHOULD persist outstanding request state (including transport secrets)
  so a restart does not invalidate requests already handed out.

## Frame encryption

Every protocol frame in both directions is sealed to the request. The
primitive set is deliberately limited to what Lightning implementations
already carry: secp256k1 ECDH, HKDF-SHA256, ChaCha20-Poly1305.

```
shared    = ECDH(payer_ephemeral_secp256k1, request_encryption_key)
            (BOLT 8 style: SHA256 of the compressed shared point)
send_key  = HKDF-SHA256(shared, salt=request_id,
                        info="beignet-df:v3:sender-to-receiver", 32)
recv_key  = HKDF-SHA256(shared, salt=request_id,
                        info="beignet-df:v3:receiver-to-sender", 32)
```

Frames are ChaCha20-Poly1305 with a 96-bit random nonce per frame and
associated data `request_id || subtype` (u16 big endian). The first payer
frame carries `request_id` and the payer's ephemeral public key in the
clear alongside the ciphertext; every subsequent frame in either
direction is nonce and ciphertext only.

Requirements:

- Each direction MUST use its own key. A frame reflected back at its
  author MUST fail authentication.
- A retransmitted logical frame MUST be re-sealed under a fresh nonce, so
  no nonce ever carries two plaintexts. Persisted request state stores
  keys, never nonce counters, so restart cannot cause reuse.
- The receiver MUST silently drop any offer sealed to a request it did
  not mint. No error reply: an unanswered probe reveals nothing.
- The node identity key MUST NOT be used for encryption. It signs the
  envelope and the funding attestation; the per-request key does all
  sealing.

## The funding protocol

Six messages. In the reference implementation they ride one odd custom
message type (44069) with u16 subtypes; a final specification would
assign odd TLV-based message types. BOLT 1 requires unknown odd types to
be ignored, so non-participating nodes are unaffected.

### `funding_offer` (subtype 16), payer to receiver

| Field              | Description                                         |
|--------------------|-----------------------------------------------------|
| `offer_id`         | First 16 bytes of SHA256(txid:vout:amount)          |
| `amount_sat`       | The amount being paid                               |
| `txid`, `vout`     | The offered UTXO's outpoint                         |
| `value_sat`        | The UTXO's value                                    |
| `sequence`         | The exact input sequence the payer will sign with   |
| `change_script`    | Script for the payer's change                       |
| `max_total_fee_sat`| The payer's fee ceiling for this funding            |
| `ownership`        | Proof of control of the UTXO, defined below         |
| `receipt_hash`     | From the envelope; REQUIRED                         |

`offer_id` is a hash of the offer's identity, so the same logical payment
retries under the same id while any change of coin or amount is a new
offer. (An earlier revision derived the id from a string prefix that
truncated before the amount; implementations are warned.)

The ownership proof, exactly: a signature over

```
digest = SHA256("lfbw-direct-funding-offer:" || offer_id || ":" || txid
                || ":" || vout || ":" || amount_sat)
```

(fields as ASCII, colon-separated) by the key controlling the UTXO's
script. For P2WPKH: an ECDSA signature
verifying against the pubkey whose HASH160 is the witness program. For
P2TR key path: a Schnorr signature verifying against the output key. A
final specification MAY adopt BIP 322 wholesale for arbitrary scripts;
the restricted forms above cover the common cases with less machinery.

Offers name only an outpoint. Receivers that can resolve arbitrary
transactions (txindex, Electrum-style backends) MUST verify the previous
output from their own chain source. Receivers that cannot MAY request the
previous transaction from the payer with an optional
`funding_prevtx` exchange, and MUST then verify that its txid matches the
offered outpoint and its output matches the claimed value; sender-supplied
bytes are never trusted beyond their self-consistency with the txid.

### `funding_offer_ack` (17), receiver to payer

`offer_id`, `accepted`, optional `reason`. A decline is terminal for the
offer.

### `funding_sign_request` (18), receiver to payer

Sent only after the interactive transaction is fully negotiated AND the
commitment_signed exchange with the channel counterparty has completed,
per BOLT 2 ordering. Contains:

| Field                 | Description                                      |
|-----------------------|--------------------------------------------------|
| `offer_id`            | Echoed                                           |
| `raw_tx`              | The fully negotiated funding transaction         |
| `prevouts`            | Script and value for every input                 |
| `shared_input_index`  | Splice extension only                            |
| `attestation`         | See below                                        |

Size bounds: the funding transaction MUST have at most 16 inputs and 8
outputs, and the encoded message MUST fit the transport's large frame
form (32768-byte onion routing info in the onion profile). Receivers
constructing larger transactions MUST NOT use this protocol for them.
These bounds are deliberately far below BOLT 2's 252-input ceiling; a
future extension may define authenticated fragmentation if a need
appears.

The attestation is a signature by the receiver's NODE key (same
Lightning message-signing scheme as the envelope signature) over the
ASCII string:

```
"lfbw-direct-funding-attest:" || offer_id || ":" || SHA256(raw_tx)
    || ":" || funding_output_index || ":" || local_funding_pubkey
```

Hashing the transaction rather than embedding it keeps the signed string
fixed-size; the payer recomputes the hash from the raw transaction it
was handed and verifies against that.

It is the bridge between the payment request and the chain transaction:
the node id the request named vouches for exactly this output in exactly
this transaction.

### `funding_witness` (19), payer to receiver

`offer_id` and the witness stack for the payer's input, sent only after
every verification invariant in the next section holds. The receiver
merges it, completes `tx_signatures`, and broadcasts.

### `funding_abort` (20), either direction

Terminal, with a reason. MUST NOT be sent by the payer after
`funding_witness`.

### `funding_receipt` (21), receiver to payer

| Field           | Description                                          |
|-----------------|------------------------------------------------------|
| `offer_id`      | Echoed                                               |
| `preimage`      | Preimage of the envelope's `receipt_hash`            |
| `funding_txid`  | The broadcast transaction id                         |
| `raw_tx`        | The COMPLETE signed transaction, when available      |

Revealed only after broadcast. The receiver SHOULD include the complete
broadcastable transaction so the payer can rebroadcast independently; the
payer's recovery position must not depend on the receiver staying online.

The preimage is a cryptographic acknowledgment, not an enforcement
mechanism: only the wallet that minted the request can reveal it, so
possessing it alongside the confirmed transaction and the attestation
gives the payer a complete self-contained proof of delivery to the
intended receiver.

## Transaction verification invariants

The payer MUST verify, in the exact bytes it is asked to sign:

1. INPUT. Its offered input is spent exactly once, at the committed
   `sequence`, and no other input in the transaction is controlled by
   the payer.
2. SHAPE. `version == 2`; `locktime < 500000000` (height-based only);
   input and output counts within the size bounds above.
3. CHANGE AND FEE. Define:

   ```
   payer_cost = payer_input_value - sum(outputs paying payer's change_script)
   ```

   Require `payer_cost >= amount_sat` and
   `payer_cost - amount_sat <= max_total_fee_sat`. The payer's cost above
   the amount is its fee contribution, and it is bounded by the ceiling
   the payer itself declared in the offer. (Dust rule: when the honest
   change would be below the dust limit, the payer accepts its absence;
   the ceiling still bounds the total.)
4. FUNDING OUTPUT. The output at `funding_output_index` is the 2-of-2
   witness script built from the attested funding pubkeys and holds at
   least `amount_sat`.
5. ATTESTATION. The attestation signature recovers to the
   `receiver_node_id` the payment request named. Any other signer is a
   hard failure.
6. PREVOUTS. For Taproot inputs, EVERY supplied prevout matches the
   payer's own chain source (BIP 341 commits to all input amounts and
   scripts, so every prevout is signing input, not metadata). A lying
   prevout can only produce an invalid signature (denial of service, not
   theft), and this check fails it closed and early.
7. AMOUNT. When the envelope fixed an amount, the offer and the funding
   output honor it.

Implementations SHOULD additionally bound total transaction weight and
feerate (`max_feerate_per_kw`) when their fee estimation is reliable
enough to set one.

## State machines and recovery

### Payer states

```
CREATED
  └─ funding_offer sent ─► OFFERED
        ├─ declined / expired ────────────────► ABORTED (fallback allowed)
        └─ sign request verified,
           witness sent ─► SIGNED_PENDING
                ├─ tx seen in mempool ─► MEMPOOL_SEEN ─► CONFIRMED
                ├─ conflicting spend of our input confirms ─► FAILED
                └─ operator cancellation spend confirms ────► FAILED
```

Requirements after `funding_witness` (the SIGNED_PENDING states):

- The payer MUST NOT surface a transport or protocol failure as a
  payment failure. The funding may already be broadcast; an error would
  invite a second payment. Every post-witness problem resolves to
  success-with-caveats.
- Automatic fallback to a plain address payment MUST occur only in
  CREATED or OFFERED. The reference implementation enforces this as an
  API invariant: its send call can only reject before the witness leaves
  the device.
- The payer MUST persist the request, the attestation, the negotiated
  transaction, and its own witness, and SHOULD persist the complete
  signed transaction from the receipt when it arrives.
- The payer MUST exclude the offered UTXO from its own coin selection
  (the reference implementation freezes it at witness release), so its
  own wallet cannot accidentally conflict-spend a pending funding.
- The payer SHOULD monitor the offered outpoint and the expected funding
  txid, and MAY rebroadcast the complete transaction.
- The payer MAY construct an explicit CANCELLATION spend of its own
  input after a policy deadline. Cancellation is a deliberate,
  user-visible act; it is never automatic, and the payment is FAILED
  only when the cancellation or another conflict CONFIRMS.

### Receiver funding watch

Once `tx_signatures` has been exchanged, the receiver MUST retain
everything needed to enforce the channel until one of:

1. the funding transaction confirms;
2. a conflicting transaction spending a funding input confirms;
3. some other event makes the funding permanently impossible.

Mempool absence is NOT such an event. A transaction can be evicted,
dropped locally, held by the other party, rebroadcast, and mined later.
The safe transition on disappearance is QUARANTINE, not deletion:

```
funding absent from mempool and chain (debounced)
        ↓
mark channel unusable, alarm, retain all state and watches
        ↓
 ┌──────────────┴──────────────────┐
 tx reappears / confirms      conflicting spend confirms
        ↓                            ↓
 lift quarantine                permanently abandon
```

(An earlier revision of the reference implementation voided the channel
on disappearance; it now quarantines, keeps every key and commitment,
and lifts the quarantine automatically when the transaction returns.)

## Delivery semantics and resource protection

Transports range from reliable (TCP peer connection) to fire-and-forget
(onion messages, which any hop may drop). The protocol therefore targets
AT-LEAST-ONCE DELIVERY with EXACTLY-ONCE EFFECTS:

- The receiver MUST record every response per `offer_id` and replay the
  recorded responses, verbatim, when a duplicate offer (same id, same
  content hash) arrives, up to and including the receipt. It MUST NOT
  begin a second channel session for a duplicate.
- The receiver MUST reject an `offer_id` reused with different content.
- Terminal offer records (tombstones) MUST survive as long as the
  request they belong to can still be paid, releasing only the expensive
  session resources. Releasing the concurrency slot is immediate;
  forgetting the offer is not.
- The payer SHOULD re-send an unanswered `funding_offer` on a timer and
  MAY re-run an entire failed send; idempotence makes both harmless.

Resource protection at the receiver, all before expensive channel work:

- Offers without a valid, outstanding `receipt_hash` are declined
  outright: sessions exist only for requests this receiver minted.
- MINIMUM AMOUNT: offers below the receiver's configured floor are
  declined. The floor is operator policy with a hard protocol minimum
  well above dust (the reference implementation clamps at 5000 sat and
  defaults to that clamp, the most permissive safe setting; operators
  raise it to price sessions higher).
- ONE OUTPOINT, ONE SESSION: an outpoint funds at most one in-flight
  session, and keeps a cooldown reservation after failure.
- ONE ACTIVE OFFER PER REQUEST, and a bounded attempt count per request
  lifetime (reference: 3), so one UTXO owner cannot grief sequential
  sessions against a request indefinitely.
- A global cap on concurrent in-flight sessions; completed and failed
  sessions release their slot immediately (the tombstone remains).
- Checking the outpoint is UNSPENT is RECOMMENDED where the chain source
  allows it cheaply; without it, a spent coin burns one capped slot
  until its session times out, nothing more.

## Security considerations

- REQUEST SUBSTITUTION. Nothing can bind the STRING the payer first
  obtains. If an attacker controls the web page, QR, or chat that
  carries the request, the payer pays the attacker's own request. This
  is BIP 21's trust model, unchanged.
- CHAIN CONFUSION. `chain_hash` closes cross-network replay for reused
  node keys.
- PATH_ID PRIVACY (onion profile). The blinded path's path_id is a
  per-request secret the payer never sees; any payer-visible value would
  let a request holder mint routes that pass the issued-path check.
- RBF. The payer commits to a non-replaceable sequence and the receiver
  observes it in the negotiated transaction, but sequence-based
  signaling is not consensus-enforced. This is exactly why the core is
  confirmation-gated.
- NONCE DISCIPLINE. Directional keys plus fresh nonces on
  retransmission; keys persisted, counters never.
- DENIAL OF SERVICE. Ownership proofs price nothing by themselves (one
  UTXO signs for arbitrarily many offers at zero cost). The reservation,
  per-request attempt caps, minimum amount, and session cap are what
  make the attack cost real, distinct coins.
- PREVOUT LIES. Denial of service only; closed by invariant 6.
- METADATA. Each transport profile states what its intermediaries learn.
  The onion profile is preferred precisely because it minimizes this.

# Part 2: Transport profiles

## Direct peer profile

Descriptor type 1: `u8 host_len || host || u16 port`.

Frames ride an ordinary authenticated Lightning peer connection as
custom messages. Simplest to implement; the receiver learns the payer's
node id and network address. A direct connection AUTHENTICATES the
payer; it does not make the payer trusted (see the zero-conf extension).

## Onion message profile

Descriptor type 2: `u8 host_len || host || u16 port || 33B intro_node_id
|| 33B path_key || u8 num_hops || hops(33B blinded_id || u16 len ||
encrypted_data)`.

The preferred standardized transport. The receiver mints a blinded path
`[intro, receiver]` per request (the introduction node is a peer it
already maintains a connection to, typically its LSP) and signs the path
into the envelope.

- The final hop's encrypted `path_id` MUST be a per-request secret
  appearing nowhere in the envelope.
- The receiver MUST accept a frame only when delivery surfaces a
  path_id matching an outstanding request AND the sealed frame names the
  same request.
- The payer MUST include its own blinded reply path `[intro, payer]` on
  every frame; the receiver answers over it and never learns the payer's
  node id.
- Frames exceeding the standard 1300-byte onion use the BOLT 4 large
  form (32768 bytes); exactly two sizes, so length leaks at most one
  bit.
- Delivery is unreliable by specification; the idempotence rules above
  are what make it dependable.

## Blind relay profile

Descriptor type 3: `33B relay_node_id || u8 host_len || host || u16 port`.

A fallback for payers that cannot construct onion messages. The payer
wraps each sealed frame in `{to, subtype, payload}` addressed to the
receiver's node id; a relay with both parties connected forwards it as
`{from, subtype, payload}`, stamping `from` from its own authenticated
connection.

- The relay MUST stamp `from` itself and ignore sender-supplied values.
- Frames already carrying `from` MUST NOT be re-forwarded (no loops).
- Relaying MUST be operator opt-in, and the relay SHOULD NOT log
  per-frame endpoint pairs.
- When an onion descriptor names the same node as intro, the relay
  descriptor SHOULD be omitted; the payer synthesizes it.

# Part 3: Extensions

## Extension: splice-in funding

When the receiver already has a channel with its counterparty, the offer
is serviced as a splice-in: the funding transaction spends the old
channel outpoint plus the payer's input into the grown channel. One
transaction, one channel, no channel-count growth.

Additional payer verification: the `shared_input_index` input IS the
attested old funding (same 2-of-2 script), and the new funding output
holds at least the old channel value plus `amount_sat` minus the fee
contribution.

Splices inherit everything from the core, including confirmation gating:
the spliced balance is treated per BOLT 2 splice semantics and the
payer's contribution is not usable before confirmation unless the
delegated zero-conf extension applies. Splicing is an extension rather
than core because it adds quiescence, pending-commitment multiplicity,
reconnection recovery, and HTLC interaction, and interoperability should
be proven on the simpler new-channel flow first.

## Extension: delegated zero-confirmation

The core is confirmed-only. This extension exists because the review of
revision 1 identified a real delegation-of-risk flaw: the receiver
trusting the payer does not entitle the receiver to impose that trust on
its channel counterparty, who is the party actually exposed if an
unconfirmed third-party input is double-spent out from under a channel
it is forwarding on.

Requirements:

- Zero-conf activation of a direct-funded channel or splice MUST NOT
  occur unless the channel counterparty has explicitly negotiated
  support for DELEGATED EXTERNAL-INPUT ZERO-CONF (a feature bit or LSP
  policy extension) and thereby accepted the receiver's payer
  classification.
- Even then, the receiver MUST extend zero-conf treatment only to PAYERS
  in its explicit trusted set (pairing). Authentication is not pairing;
  a relay's identity stamp is not pairing.
- The single-operator deployment (one operator runs payer, receiver, and
  LSP, as in the reference implementation's node-manager) satisfies both
  conditions trivially and is the intended first user of this extension.

## Extension: non-Lightning rendezvous

Descriptor type 4 is reserved for discovery fallbacks outside the
Lightning network (the reference implementation uses a DHT rendezvous
with per-request identities and topics). Outside the normative surface
of this proposal: a payer and receiver who can already reach each other
over Lightning infrastructure should never need it, and its properties
are documented with the reference implementation.

## Rationale

WHY NOT LSPS2 / JIT CHANNELS? LSPS2 has the LSP fund a channel and
forward an HTLC; the LSP fronts the capital and prices it. Here the
payer's own coin IS the capital, the LSP fronts nothing on the funding,
and there is no HTLC to intercept. The constructions are complementary:
LSPS2 answers "how do I receive over Lightning with no channel"; this
answers "how does an on-chain payment become channel balance in one
transaction".

WHY NOT AN HTLC/PTLC CONSTRUCTION? An HTLC adds timeout paths and
requires routability to a channel that does not exist yet. Payment and
delivery being the same transaction is strictly stronger: there is no
state in which the payer paid and the receiver did not receive.

WHY A PER-REQUEST ENCRYPTION KEY? Key separation (the identity key never
decrypts attacker-chosen ciphertext), per-request forward secrecy, and
transport independence of the sealed frames.

WHY CONFIRMED-ONLY CORE? Every zero-conf relaxation transfers
double-spend risk to a party that must consent to it. Confirmation
gating makes the core safe under the normal Bitcoin confirmation model
with no consent machinery at all; the machinery lives in one extension.

## Reference implementation

The beignet wallet engine implements the full core, all three transport
profiles, and all three extensions on regtest: envelope v3 with chain
binding, directional ChaCha20-Poly1305 sealing, idempotent offers with
replay tombstones, per-request and per-outpoint throttles, the payer
invariants including all-prevout verification and post-witness UTXO
freezing, receipts carrying the complete signed transaction, quarantine
semantics for missing fundings, and the pairing-gated zero-conf and
splice extensions in a single-operator node manager. Companion
operational documentation lives in DIRECT-FUNDING.md alongside this
draft.
