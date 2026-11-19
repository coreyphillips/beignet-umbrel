'use strict';

/**
 * Telling an asset channel from a bitcoin one.
 *
 * A channel that carries a Taproot Asset is listed by the daemon on GET
 * /channels beside the bitcoin channels, marked `auxiliary: true`. No other
 * channel carries that key. The sats in it are there to carry the asset:
 * they cannot be sent or received as bitcoin, lent to a sibling for offline
 * receives, spliced, or moved to a new primary node, and closing one is the
 * owner's call on the Channels tab, where it is listed by the assets host.
 *
 * So whatever the manager does with a wallet's bitcoin channels starts from
 * bitcoinChannels(), and an asset channel is never picked up by accident.
 */

/** Whether a GET /channels row is an asset channel. */
function isAssetChannel(channel) {
	return !!channel && channel.auxiliary === true;
}

/** The bitcoin channels of a GET /channels answer. Anything that is not a list is handed back as it came. */
function bitcoinChannels(channels) {
	return Array.isArray(channels) ? channels.filter((c) => !isAssetChannel(c)) : channels;
}

module.exports = { isAssetChannel, bitcoinChannels };
