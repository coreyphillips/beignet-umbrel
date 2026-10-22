# Sourced by umbrelOS for this app, and for any app that declares
# beignet-rbitcoin as a dependency (umbrelOS sources an app's own exports
# plus those of its transitive dependencies). beignet-wallet declares no
# dependency, so it reaches the node by the pinned container name below
# instead; these are for this app's own compose file and for apps that do
# declare it.
export APP_RBITCOIN_NODE_HOST="beignet-rbitcoin_node_1"
export APP_RBITCOIN_NODE_PORT="50001"
# The host port the compose file publishes Electrum on for the home network.
# 50001 (Electrs), 50002 (Fulcrum) and 50003 (ElectrumX) are taken by the
# official apps.
export APP_RBITCOIN_PUBLIC_PORT="50011"
