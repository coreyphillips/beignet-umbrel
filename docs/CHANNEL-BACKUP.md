# Channel backup

A seed alone recovers on-chain funds; channels restored from a seed close and
their funds come back on-chain over time. Each Lightning wallet chooses how
much more it keeps, in its create form or Edit dialog, through beignet's
Recovery Protocol:

- **Seed only**: the default. Nothing beyond the seed.
- **Checkpoints via peer storage**: an encrypted channel checkpoint rides with
  the peers that offer storage, no setup. Import the seed with peer storage,
  reconnect to those peers, and the wallet offers the newest checkpoint they
  return: resume the channels (they come back held until each peer confirms
  them) or recover the funds on-chain. Answer the import form's one question
  (the previous device is stopped) and the engine applies the checkpoint by
  itself. Nothing fences the old device in this mode.
- **Guardians (async)** and **Guardians (strict quorum)**: three guardian
  servers, set once in Settings, hold an encrypted journal of channel state.
  Importing the seed elsewhere with the same guardians restores the channels
  and resumes them instead of closing. Strict quorum makes every channel step
  wait for two of the three guardians, so a restore is exact and the old
  device is fenced off; async never makes a payment wait, and a step mid-flight
  at the moment of loss closes safely instead.

The Overview tab's Node status card states the tier; the wallet header only
speaks up when something is wrong (guardians unreachable, another device took
over, restore required).

## Guardians

A guardian is either a small always-on service speaking the guardian protocol
(`<64-hex x-only pubkey>@<http(s) URL>`) or, since beignet 0.12, any beignet
node that serves as one. Paste that node's Lightning address
(`<node id>@host:port`) into a guardian slot in Settings and it resolves to an
entry of the form `<64-hex pubkey>@bolt8://<node id>@host:port`, reached over a
dedicated Lightning-transport session at the node's own address, over Tor when
that address is an onion.

Settings keeps however many you have entered so far, so a set can be collected
one node at a time; a wallet needs all three before it can turn a guardian mode
on. Three independent operators is the point: a wallet on this same Umbrel
protects against nothing this Umbrel can suffer, so pair with other Umbrels.

Two rules are enforced before a daemon is started, because the engine enforces
them by refusing to start: a wallet keeps the guardian set it registered with
until it rotates that set (below), and a wallet that has used strict quorum
cannot move to a weaker setting.

## Rotating guardians

Since beignet 0.13, a running wallet in a guardian mode can replace one
guardian or all three without stopping. The Edit dialog has three slots
prefilled with the current set, taking a guardian entry or a beignet node's
Lightning address, and a "Rotate guardians and retire the old set" button. The
daemon registers with the new set under its current lease, copies the journal
across while the channels keep running, switches over, and retires the old set
for good.

A previous device still running on the old set stops itself the moment it
sees the new one, and a seed restore that is handed the old set follows the
rotation to the live one on its own. A rotation the daemon cannot finish (a new
guardian unreachable, a journal moving faster than the copy) is refused before
anything changes.

## Serving as a guardian

Any Lightning wallet here can tick "Serve as a guardian for other beignet
nodes" (create form or Edit). Its daemon then hosts the reference guardian at
its Lightning address: other beignet wallets pin it as one of their three, and
store an encrypted journal of their channel state that this node cannot read.
The Overview tab gains a card with the sets held, the bytes stored, the open
sessions and the address to hand out (the Tor address, so nobody needs to
forward a port).

Quotas bound what a stranger can store and refuse new writes rather than
delete, because pruning a namespace would wedge that stranger's node for good.
A serving wallet keeps answering guardian traffic even while its own channel
backup is waiting for its guardians to confirm it, so a group of Umbrels
guarding each other can all restart at once. Serving is open to any beignet
node, by design; there is no token in this app yet.

## Restoring from guardians

Set the same three guardians in Settings, then import the seed with a guardian
mode. If the guardians hold channel state for that seed, the daemon boots
holding for a restore and the wallet page offers it: restoring takes the
channels over (the previous device, if still running, is fenced off),
downloads and verifies the journal, rebuilds the state and starts the node.

The page then follows each channel as it reconciles with its peer, and never
calls the restore complete while one is still doing so. A channel the peer
proves stale, or whose state cannot be proven current, closes safely and its
funds return on-chain; the page says so rather than reporting an error. A plain
import (no guardians, or none holding the seed) works as it always has.
