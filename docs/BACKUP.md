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

Channel databases are not in it: they are large, and channels are what
[channel backup](CHANNEL-BACKUP.md) restores. Restoring the archive onto a
fresh box recreates the records, the seeds, the API tokens and the app
defaults, and starts nothing. Each wallet then boots exactly as an imported
seed does, syncing from the chain and running whatever channel backup it was
configured for.

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
does not.

Keep the file off this Umbrel, and the passphrase somewhere else again:
nothing here can recover it. The archive holds every seed on the box, so a
weak passphrase is the security of every wallet in it.
