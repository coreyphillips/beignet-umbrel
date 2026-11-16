# Backing up the box

A seed phrase recovers coins. It does not recover a wallet: not its name,
network or Electrum server, not its Tor settings, not its API token, not its
channel backup mode or the three guardians it is pinned to, not the
lightning-first link to its primary node, and not what it serves for other
nodes (liquidity provider, swaps, guardian, offline-receive roles).
**Settings, Back up all wallets** writes all of that, for every wallet at
once, into one file encrypted with a passphrase you type twice (scrypt and
AES-256-GCM, no key material anywhere but in that passphrase). The archive
names the app and engine version it came from.

It also carries each wallet's **Taproot Assets**, as the file the wallet's
assets host keeps up to date (`wallets/<id>/assets/backup.json`: the asset
records, their proofs and the key counters, never a private key). Assets are
the one thing here a seed cannot find again by itself, because a proof exists
nowhere on chain. See [ASSETS.md](ASSETS.md#backup-and-recovery).

Channel databases are not in it: they are large, and channels are what
[channel backup](CHANNEL-BACKUP.md) restores. Restoring the archive onto a
fresh box recreates the records, the seeds, the API tokens and the app
defaults, and starts nothing. Each wallet then boots exactly as an imported
seed does, syncing from the chain and running whatever channel backup it was
configured for. A wallet whose archive held assets imports them on that first
start, checks each one against the chain, and shows them again.

## Restoring

From the empty first-run screen or from Settings, pick the file and type the
passphrase. The archive is opened and its contents listed before anything is
written: which wallets it holds, which are already on this box, and which of
them run a node this box already runs. That last one has to be confirmed,
because two records on one seed both believe they own its channels, and that
is how channel funds are lost.

## Knowing when to back up again

Settings' Backup section shows when the box was last backed up, how many
wallets have been created or edited since, and where each wallet stands
against the last archive (backed up, changed since, or never backed up). Only
edits that change what an archive holds count; starting and stopping a wallet
does not. Creating, receiving, sending or burning an asset does count: the
wallet reads as changed since, and the archive written before it no longer
holds what the wallet holds.

An archive never fails over assets, so a box is never left without a backup
of its seeds. Two things can keep a wallet's assets out of one, and Settings
names the wallet either way until an archive does hold them:

- **Its assets file was not there to copy.** The wallet holds assets and its
  assets host has not written the file, which happens when the host is not
  running. Start the wallet and back up again.
- **Its assets file is too large.** An archive comes back to this app as one
  request of at most 64 MB, so one that would be larger is not written: the
  largest assets files are left out until it fits (about 35 MB of them across
  the box). A wallet holds that much only with a great many assets or large
  metadata. Its assets file is still on the box, at
  `wallets/<id>/assets/backup.json` under the app's data directory, and can be
  copied from there.

Keep the file off this Umbrel, and the passphrase somewhere else again:
nothing here can recover it. The archive holds every seed on the box, so a
weak passphrase is the security of every wallet in it.
