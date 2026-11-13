# Phone link over Iroh

With Beignet 0.26.0 or newer, create or edit a Lightning wallet and enable **Phone link over Iroh (experimental)** beneath Network. It adds an Iroh listener alongside the wallet's existing Tor, Clearnet or Hybrid mode. Existing wallets default to off, and on-chain-only wallets cannot enable it.

Open Overview, choose **Iroh phone link**, and scan the QR in Chicory's primary-node settings, or copy the connection URI. It includes the Lightning public key, stable per-wallet Iroh endpoint ID and the current relay hint. The listener runs even when Lightning gossip announcements are off. The public key still authenticates the BOLT 8 session; the Iroh address is never put in Lightning gossip.

The phone and relay can see the Umbrel's IP address, even in Tor mode. Use this for a node you control, or turn on [Relay only](#relay-only) so that only the relay can. Other Lightning peers continue to follow the selected network mode. Iroh uses outbound UDP for direct connections and a relay when a direct path is unavailable, with no router port forwarding required for pairing.

## Relay only

With Beignet 0.39.0 or newer, the **Iroh phone link** on Overview has a **Relay only** checkbox under the QR code. Turn it on before handing the link to anyone but yourself. Every connection made through the link then stays on the relay, so whoever holds the link cannot learn the Umbrel's IP address from it. Changing it restarts the wallet, and a dialog says so first.

What it does not do:

- The relay's operator still sees the Umbrel's IP address. With the default relays that is n0. With custom relays it is whoever runs them. The relay hint in the link names the relay the Umbrel uses, and n0's relays are regional, so the link also shows roughly which part of the world the Umbrel is in.
- It does not take an address back. A phone that connected before keeps the address it learned until its app is restarted.
- It does not hide what the wallet publishes elsewhere. The link carries the wallet's Lightning node id. A wallet that announces a public address is listed under that id, and once it has a public channel it sends the announcement to every peer that connects, the ones on the link included. The card warns when that is the case. An id that was announced with a public address in the past stays in the history explorers keep, and turning announcing off does not remove it: use a fresh wallet for a link you post.
- It does not close the wallet's Lightning port. The app publishes that port on the Umbrel in every network mode, Tor included (19101 and up), and a Lightning node answers anyone who knows its node id, which the link gives them. If the port can be reached from the internet, through a router forward or over IPv6, whoever holds the link can scan for it and find the Umbrel. Leave the port unforwarded for a wallet whose link you hand out.
- It covers the Iroh link, not the wallet's other connections. In Clearnet and Hybrid mode the wallet dials directly the peers you connect it to and the peers it saved before Relay only was turned on, and each of them sees the Umbrel's IP address. The card warns in those two modes. An address a peer names for itself is dialed through Tor or not at all once Relay only is on, and Tor mode sends every peer through Tor.
- It does not follow the seed. The link is derived from the wallet's seed, and Relay only is a setting of this wallet on this Umbrel, kept in its backups. The same seed restored somewhere else, or a wallet created again from it without the backup, brings the same link up with Relay only off.

Before you hand the link out:

1. Turn Relay only on first, and wait for the card to show the link again with the mode in brackets beside the checkbox.
2. For a link you post publicly, put the wallet in Tor mode, with announcing off or only the Tor address announced.
3. Use a wallet whose node id was never announced with a public address. Search the id on a Lightning explorer if you are not sure.
4. Check that the wallet's public port cannot be reached from outside your network: from a phone on mobile data, `nc -vz <your public IP> <port>` should fail.
5. Pair a phone that is on another network and open Peers: its path should read relay.
6. Decide whether n0 seeing the address is acceptable, or set a relay you run under Advanced Iroh settings.

How it behaves:

- The link comes up about 12 seconds later after each restart. The engine watches the endpoint that long before it accepts anyone, to check that no address of the Umbrel is offered.
- The bundled Iroh library asks the router for a port mapping (UPnP, NAT-PMP or PCP) and cannot be told not to. If a router grants one, the engine closes the Iroh listener and the card shows the reason. Other ways in keep working. A mapping first granted while a phone is connected can reach that phone in the moment before the listener closes. The app runs on a bridged container network, where no router answers the request, so this is not expected on an Umbrel.
- The checkbox shows the mode the engine reports in brackets. `loopback-pin` is what the bundled Iroh library allows today, and it is best effort for the reason above.
- A payment took about 80 ms longer through the relay than over a direct path in the engine's test run.
- The setting is kept when Iroh is switched off and on again, and in backups. On an engine older than 0.39.0 a wallet set to relay only gets no Iroh listener at all, instead of one that offers direct connections.

Advanced settings accept comma-separated HTTP or HTTPS relay URLs. Blank uses n0's public relays. The defaults also contact n0 discovery, which sees the Umbrel's IP and publishes its signed endpoint record. Custom URLs replace the default relays and disable n0 discovery; share the URI containing the relay hint with your phone. The app does not run a relay container. Hosting a relay yourself needs a reachable server and its own network configuration.

Peers shows the selected direct or relay path and RTT when the engine can report them. If the connection string is unavailable, the pairing card shows the listener error or asks you to wait for startup.

The endpoint ID derives from the wallet seed and survives restarts and restores. Backups preserve the opt-in and custom relay settings. Keep the Tor URI as an optional fallback for the same node key when pairing in Chicory.

Release procedure is unchanged: build and publish an app image before updating the Umbrel manifest and compose digest. This integration pins the next image build to Beignet 0.26.0.

Hardware qualification to perform with this experimental release: container outbound UDP, relay-only pairing, payments after network outages, and identity stability across app restarts and updates.
