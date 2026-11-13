/**
 * Host half of the price window badge.
 *
 * The badge is browser copy only: the client half computes the DeepSeek pricing
 * window (peak / off-peak) locally and renders it in the sidebar footer next to
 * the balance badge. The host entry exists so the Loader has a row to mount and
 * the client module system has a package to publish a bundle for.
 */

/** Loader display name. */
export const name = 'price-window'

/** No host service or configuration is required. */
export function apply() {}
