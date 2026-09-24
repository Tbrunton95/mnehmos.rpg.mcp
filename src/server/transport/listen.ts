import type { Server } from 'node:net';

const IPV6_WILDCARD = '::';
const IPV4_WILDCARD = '0.0.0.0';

/**
 * True when `error` is a bind to the '::' wildcard failing because the host has
 * no IPv6 stack at all: IPv4-only containers, gVisor sandboxes, kernels booted
 * with ipv6.disable=1. The socket cannot even be created, so the failure says
 * nothing about the port or the address, only the family.
 *
 * Only the wildcard qualifies. An explicit address ('::1', a specific
 * interface) is a request for that address, and binding something else instead
 * would be a surprise, not a fallback.
 */
export function isIpv6Unavailable(host: string, error: unknown): boolean {
    return host === IPV6_WILDCARD &&
        (error as NodeJS.ErrnoException | null)?.code === 'EAFNOSUPPORT';
}

function listenOnce(server: Server, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(port, host);
    });
}

/**
 * Binds `server` to `host:port` and resolves with the host actually bound.
 *
 * '::' is the right default for a server meant to be reachable from anywhere:
 * Node binds it dual-stack, and Railway's private network is IPv6-only. On a
 * host that has no IPv6, though, that bind fails outright. '0.0.0.0' is the same
 * "every interface" intent within the only family such a host has, so bind that
 * instead of crashing. When IPv6 works, this is a plain listen and nothing else.
 */
export async function listenWithIpv4Fallback(
    server: Server,
    port: number,
    host: string,
    label: string
): Promise<string> {
    try {
        await listenOnce(server, port, host);
        return host;
    } catch (error) {
        if (!isIpv6Unavailable(host, error)) throw error;
        // stderr, never stdout: stdout carries the stdio transport's JSON-RPC.
        console.error(
            `${label} IPv6 unavailable on this host (EAFNOSUPPORT binding ${host}); ` +
            `binding ${IPV4_WILDCARD} instead`
        );
        await listenOnce(server, port, IPV4_WILDCARD);
        return IPV4_WILDCARD;
    }
}
