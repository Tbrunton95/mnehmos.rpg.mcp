import { Server, connect, createServer, type AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listenWithIpv4Fallback } from '../../../src/server/transport/listen';
import { startHttpServerTransport } from '../../../src/server/transport/http';
import { WebSocketServerTransport } from '../../../src/server/transport/websocket';
import { TCPServerTransport } from '../../../src/server/transport/tcp';

const realListen = Server.prototype.listen;

/**
 * Makes every bind to `host` fail the way Linux fails it on a host with no IPv6
 * stack (asynchronously, with an errno code), whatever this machine really has.
 * Every other bind goes through untouched. http.Server inherits this listen, so
 * it covers all three network transports.
 */
function failBindsTo(host: string, code = 'EAFNOSUPPORT') {
    return vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: any[]) {
        if (args[1] === host) {
            const error = Object.assign(
                new Error(`listen ${code}: simulated ${host}:${args[0]}`),
                { code, syscall: 'listen', address: host, port: args[0] }
            );
            process.nextTick(() => this.emit('error', error));
            return this;
        }
        return realListen.apply(this, args as Parameters<Server['listen']>);
    });
}

function close(server: Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

describe('listenWithIpv4Fallback', () => {
    let server: Server;
    let stderr: ReturnType<typeof vi.spyOn>;
    let stdout: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        server = createServer();
        stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        if (server.listening) await close(server);
    });

    it('binds 0.0.0.0 when the host cannot open an IPv6 socket for "::"', async () => {
        failBindsTo('::');

        const bound = await listenWithIpv4Fallback(server, 0, '::', '[Test]');

        expect(bound).toBe('0.0.0.0');
        expect(server.address()).toMatchObject({ address: '0.0.0.0', family: 'IPv4' });
        // stderr only: stdout is the stdio transport's JSON-RPC stream.
        expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/\[Test\].*EAFNOSUPPORT.*0\.0\.0\.0/));
        expect(stdout).not.toHaveBeenCalled();
    });

    it('leaves a "::" bind that succeeds alone', async () => {
        // Stand-in for a working IPv6 stack that does not need this host to have
        // one: the '::' bind succeeds (on loopback, which is all this checks).
        const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: any[]) {
            return realListen.call(this, args[0], args[1] === '::' ? '127.0.0.1' : args[1]);
        });

        const bound = await listenWithIpv4Fallback(server, 0, '::', '[Test]');

        expect(bound).toBe('::');
        expect(listen).toHaveBeenCalledTimes(1);
        expect(stderr).not.toHaveBeenCalled();
    });

    it('never rewrites an explicit address, even an IPv6 one', async () => {
        const listen = failBindsTo('::1');

        await expect(listenWithIpv4Fallback(server, 0, '::1', '[Test]'))
            .rejects.toMatchObject({ code: 'EAFNOSUPPORT' });
        expect(listen).toHaveBeenCalledTimes(1);
        expect(server.listening).toBe(false);
    });

    it('does not paper over other bind failures on "::"', async () => {
        const listen = failBindsTo('::', 'EADDRINUSE');

        await expect(listenWithIpv4Fallback(server, 0, '::', '[Test]'))
            .rejects.toMatchObject({ code: 'EADDRINUSE' });
        expect(listen).toHaveBeenCalledTimes(1);
        expect(server.listening).toBe(false);
    });
});

describe('network transports on a host without IPv6', () => {
    beforeEach(() => {
        failBindsTo('::');
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('HTTP falls back from its "::" default and serves on IPv4', async () => {
        const server = await startHttpServerTransport(
            () => new McpServer({ name: 'test', version: '0.0.0' }),
            0,
            { authToken: 'service-token', tenantSecret: 'tenant-secret' }
        );
        try {
            const { address, port } = server.address() as AddressInfo;
            expect(address).toBe('0.0.0.0');
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            expect(response.status).toBe(200);
        } finally {
            await close(server);
        }
    });

    it('WebSocket falls back from its "::" default without reporting a transport error', async () => {
        const PORT = 3012;
        const transport = new WebSocketServerTransport(PORT);
        const onerror = vi.fn();
        transport.onerror = onerror;
        await transport.start();

        const client = new WebSocket(`ws://127.0.0.1:${PORT}`);
        try {
            await new Promise<void>((resolve, reject) => {
                client.once('open', () => resolve());
                client.once('error', reject);
            });
            expect(onerror).not.toHaveBeenCalled();
        } finally {
            client.close();
            await transport.close();
        }
    });

    it('TCP falls back when asked for "::"', async () => {
        const PORT = 3013;
        const transport = new TCPServerTransport(PORT, { host: '::' });
        await transport.start();

        const socket = connect(PORT, '127.0.0.1');
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('error', reject);
            });
        } finally {
            socket.destroy();
            await transport.close();
        }
    });
});
