import { request as httpsRequest } from 'node:https';
import {
  parseWireJson,
  validateResult,
  statusFor,
} from '../../src/interfaces/jarvis-demo-contract.ts';
import type { Request } from '../../src/interfaces/jarvis-demo-contract.ts';

interface ClientOptions {
  readonly port: number;
  readonly ca: string;
  readonly token?: string;
  readonly servername?: string;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
}

/** No URL routing, redirect following or retries: only the test's loopback port. */
export function rawDemoRequest(
  options: ClientOptions,
  body: string | Uint8Array,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bytes =
      typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        port: options.port,
        servername: options.servername ?? 'don-gaston.test',
        ca: options.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        method: options.method ?? 'POST',
        path: options.path ?? '/v1/execute',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bytes.length,
          ...(options.token === undefined
            ? {}
            : { Authorization: `Bearer ${options.token}` }),
          ...options.headers,
        },
      },
      (response) => {
        const contentType = response.headers['content-type'];
        if (
          ((response.statusCode ?? 0) >= 300 &&
            (response.statusCode ?? 0) < 400) ||
          response.headers['content-encoding'] !== undefined ||
          typeof contentType !== 'string' ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)
        ) {
          response.resume();
          reject(new Error('INVALID_RESPONSE'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) {
            response.destroy(new Error('INVALID_RESPONSE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.concat(chunks),
            );
            resolve({
              status: response.statusCode ?? 0,
              body: parseWireJson(text),
            });
          } catch {
            reject(new Error('INVALID_RESPONSE'));
          }
        });
      },
    );
    request.setTimeout(5000, () =>
      request.destroy(new Error('SYNTHETIC_TIMEOUT')),
    );
    request.on('error', reject);
    request.end(bytes);
  });
}

export async function demoExecute(options: ClientOptions, request: Request) {
  const response = await rawDemoRequest(options, JSON.stringify(request));
  const result = validateResult(response.body, request);
  if (
    response.status !==
    (result.status === 'completed' ? 200 : statusFor(result.error.code))
  )
    throw new Error('INVALID_RESPONSE');
  return result;
}
