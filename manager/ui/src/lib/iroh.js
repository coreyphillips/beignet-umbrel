/** Shared create/import/edit request shape. Hidden relay text never blocks disabling. */
export function irohBody(enabled, relayText) {
 if (!enabled) return { enabled: false };
 const relays = relayText.split(',').map((value) => value.trim()).filter(Boolean);
 return { enabled: true, relays: relays.length ? relays : null };
}
