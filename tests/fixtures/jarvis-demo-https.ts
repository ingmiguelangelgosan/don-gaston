import { createServer } from 'node:https';
import type { DemoCertificates } from './jarvis-demo-certificates.ts';

export interface DemoHttpReply {
  readonly status: number;
  readonly body: unknown;
}
export type DemoHandler = (
  body: Uint8Array,
  authorization: string | undefined,
) => DemoHttpReply;
export interface DemoHttpsOptions {
  readonly afterHandle?: (reply: DemoHttpReply) => 'drop' | undefined;
  readonly transformReply?: (reply: DemoHttpReply) => {
    status: number;
    body: string;
    headers?: Record<string, string>;
  };
}

/** Test-only listener: exact IPv4 loopback, OS-assigned port, explicit close. */
export async function startDemoHttps(
  certificates: DemoCertificates,
  handler: DemoHandler,
  options: DemoHttpsOptions = {},
) {
  const server = createServer(
    {
      key: certificates.key,
      cert: certificates.certificate,
      minVersion: 'TLSv1.2',
      maxHeaderSize: 8192,
    },
    (request, response) => {
      const reject = (status: number) => {
        response.writeHead(status, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        response.end(
          JSON.stringify({
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Invalid transport request.',
              retryable: false,
            },
          }),
        );
        request.resume();
      };
      if (request.method !== 'POST' || request.url !== '/v1/execute') {
        reject(404);
        return;
      }
      const names = request.rawHeaders
        .filter((_value, index) => index % 2 === 0)
        .map((value) => value.toLowerCase());
      if (
        names.filter((value) => value === 'authorization').length > 1 ||
        request.headers['content-encoding'] !== undefined ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
          request.headers['content-type'] ?? '',
        )
      ) {
        reject(415);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0,
        rejected = false;
      request.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > 65536) {
          rejected = true;
          reject(413);
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (rejected) return;
        try {
          const reply = handler(
            Buffer.concat(chunks),
            request.headers.authorization,
          );
          if (options.afterHandle?.(reply) === 'drop') {
            response.destroy();
            return;
          }
          const changed = options.transformReply?.(reply);
          response.writeHead(changed?.status ?? reply.status, {
            'Content-Type': 'application/json',
            Connection: 'close',
            ...changed?.headers,
          });
          response.end(changed?.body ?? JSON.stringify(reply.body));
        } catch {
          // A thrown callback may follow a financial commit: never claim rollback.
          response.destroy();
        }
      });
      request.on('error', () => response.destroy());
    },
  );
  server.headersTimeout = 3000;
  server.requestTimeout = 3000;
  server.timeout = 3000;
  server.maxHeadersCount = 30;
  server.on('tlsClientError', () => {
    /* Expected for synthetic invalid-CA tests. */
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic listener did not bind loopback');
  return {
    port: address.port,
    host: address.address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
