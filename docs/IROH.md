# Phone link over Iroh

With Beignet 0.26.0 or newer, create or edit a Lightning wallet and enable **Phone link over Iroh (experimental)** beneath Network. It adds an Iroh listener alongside the wallet's existing Tor, Clearnet or Hybrid mode. Existing wallets default to off, and on-chain-only wallets cannot enable it.

Open Overview, choose **Iroh phone link**, and scan the QR in Chicory's primary-node settings, or copy the connection URI. It includes the Lightning public key, stable per-wallet Iroh endpoint ID and the current relay hint. The listener runs even when Lightning gossip announcements are off. The public key still authenticates the BOLT 8 session; the Iroh address is never put in Lightning gossip.

The phone and relay can see the Umbrel's IP address, even in Tor mode. Use this for a node you control, or turn on [Relay only](#relay-only) so that only the relay can. Other Lightning peers continue to follow the selected network mode. Iroh uses outbound UDP for direct connections and a relay when a direct path is unavailable, with no router port forwarding required for pairing.

## Relay only

With Beignet 0.39.0 or newer, the **Iroh phone link** on Overview has a **Relay only** checkbox under the QR code. Turn it on before handing the link to anyone but yourself. Every connection made through the link then stays on the relay, so whoever holds the link cannot learn the Umbrel's IP address from it. Changing it restarts the wallet, and a dialog says so first.

What it does not do:

- The relay's operator still sees the Umbrel's IP address. With the default relays that is n0. With custom relays it is whoever runs them.
- It does not take an address back. A phone that connected before keeps the address it learned until its app is restarted.
- It does not hide what the wallet publishes elsewhere. A wallet that announces a public address is listed under the same node id the link carries, and the card warns when that is the case. Tor mode, or announcing off, keeps the link private.

How it behaves:

- The link comes up about 12 seconds later after each restart. The engine watches the endpoint that long before it accepts anyone, to check that no address of the Umbrel is offered.
- If the router opens a port for the link (UPnP, NAT-PMP or PCP), the engine closes the Iroh listener instead of offering that address, and the card shows the reason. Other ways in keep working.
- The checkbox shows the mode the engine reports in brackets. `loopback-pin` is what the bundled Iroh library allows today.
- A payment took about 80 ms longer through the relay than over a direct path in the engine's test run.
- The setting is kept when Iroh is switched off and on again, and in backups. On an engine older than 0.39.0 a wallet set to relay only gets no Iroh listener at all, instead of one that offers direct connections.

Advanced settings accept comma-separated HTTP or HTTPS relay URLs. Blank uses n0's public relays. The defaults also contact n0 discovery, which sees the Umbrel's IP and publishes its signed endpoint record. Custom URLs replace the default relays and disable n0 discovery; share the URI containing the relay hint with your phone. The app does not run a relay container. Hosting a relay yourself needs a reachable server and its own network configuration.

Peers shows the selected direct or relay path and RTT when the engine can report them. If the connection string is unavailable, the pairing card shows the listener error or asks you to wait for startup.

The endpoint ID derives from the wallet seed and survives restarts and restores. Backups preserve the opt-in and custom relay settings. Keep the Tor URI as an optional fallback for the same node key when pairing in Chicory.

Release procedure is unchanged: build and publish an app image before updating the Umbrel manifest and compose digest. This integration pins the next image build to Beignet 0.26.0.

Hardware qualification to perform with this experimental release: container outbound UDP, relay-only pairing, payments after network outages, and identity stability across app restarts and updates.
