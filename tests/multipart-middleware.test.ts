import * as nodeFs from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import { existsSync, readFileSync, statSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import type { PassThrough } from 'node:stream';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import { parse } from 'qs';
import {
  createResponseFactory,
  createServerRequestFactory,
  createStreamFactory,
} from '@chubbyts/chubbyts-http/message-factory';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Body, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import {
  createMultipartMiddleware,
  isMultipartLimitError,
  multipartTemporaryPathAttribute,
  parseMultipartFile,
} from '../src/multipart-middleware.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof nodeFs>()),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof nodeFsPromises>()),
}));

// @chubbyts/chubbyts-http is used as implementation of the types

const serverRequestFactory = createServerRequestFactory();
const serverRequestHelpers = createServerRequestHelpers();
const responseFactory = createResponseFactory();
const streamFactory = createStreamFactory();

const redImagePath = process.cwd() + '/tests/resources/red.png';
const greenImagePath = process.cwd() + '/tests/resources/green.png';
const blueImagePath = process.cwd() + '/tests/resources/blue.png';

// the temporary directory of a request within the tmpdir of the system (e.g. /tmp/multipart-XXXXXX)
const temporaryPathPattern = `${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/multipart-[^/]{6}`;

const sha1 = (input: string | Buffer) => createHash('sha1').update(input).digest('hex');

const createFormData = (): FormData => {
  const formData = new FormData();
  formData.append('id', '123e4567-e89b-12d3-a456-426655440000');
  formData.append('name', 'John Doe');
  formData.append(
    'address',
    JSON.stringify(
      {
        street: '3, Garden St',
        city: 'Hillsbery, UT',
      },
      null,
      2,
    ),
  );

  formData.append('red', new Blob([readFileSync(redImagePath)], { type: 'image/png' }), basename(redImagePath));
  formData.append('green', new Blob([readFileSync(greenImagePath)], { type: 'image/png' }), basename(greenImagePath));
  formData.append('blue', new Blob([readFileSync(blueImagePath)], { type: 'image/png' }), basename(blueImagePath));

  return formData;
};

const createRequest = (contentType: string | undefined, body: Body): ServerRequest => {
  const request = serverRequestHelpers.withBody(serverRequestFactory('POST', 'https://example.com'), body);

  return contentType ? serverRequestHelpers.withHeader(request, 'content-type', contentType) : request;
};

// the multipart encoding of the fetch api gets used to create the body and its content-type (with the boundary)
const createMultipartRequest = (formData: FormData): ServerRequest => {
  const { headers, body } = new Response(formData);

  return createRequest(headers.get('content-type') as string, body as ReadableStream<Uint8Array>);
};

// the temporary directories created by the middleware (other test files run in parallel within the same tmpdir)
const mkdtempSpy = vi.spyOn(nodeFsPromises, 'mkdtemp');

const listTemporaryPaths = async (): Promise<Array<string>> => {
  const temporaryPaths = await Promise.all(mkdtempSpy.mock.results.map(({ value }) => value as Promise<string>));

  return temporaryPaths.filter((temporaryPath) => existsSync(temporaryPath));
};

beforeEach(() => {
  mkdtempSpy.mockClear();
});

afterEach(async () => {
  await Promise.all(
    (await listTemporaryPaths()).map((temporaryPath) => fs.rm(temporaryPath, { force: true, recursive: true })),
  );
});

describe('createMultipartMiddleware', () => {
  test('without content-type', async () => {
    const request = createRequest(undefined, streamFactory('somebody'));
    const response = responseFactory(200);

    const [handler, handlerMocks] = useFunctionMock<Handler>([
      {
        parameters: [request],
        return: Promise.resolve(response),
      },
    ]);

    const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

    expect(await multipartMiddleware(request, handler)).toBe(response);

    expect(handlerMocks).toHaveLength(0);
  });

  test('without multipart/form-data', async () => {
    const request = createRequest('application/x-www-form-urlencoded', streamFactory('somebody'));
    const response = responseFactory(200);

    const [handler, handlerMocks] = useFunctionMock<Handler>([
      {
        parameters: [request],
        return: Promise.resolve(response),
      },
    ]);

    const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

    expect(await multipartMiddleware(request, handler)).toBe(response);

    expect(handlerMocks).toHaveLength(0);
  });

  test('without multipart/form-data but with boundary', async () => {
    const request = createRequest(
      'application/x-www-form-urlencoded; boundary=----test-boundary',
      streamFactory('somebody'),
    );
    const response = responseFactory(200);

    const [handler, handlerMocks] = useFunctionMock<Handler>([
      {
        parameters: [request],
        return: Promise.resolve(response),
      },
    ]);

    const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

    expect(await multipartMiddleware(request, handler)).toBe(response);

    expect(handlerMocks).toHaveLength(0);
  });

  test('with multipart/form-data but without boundary', async () => {
    const request = createRequest('multipart/form-data', streamFactory('somebody'));
    const response = responseFactory(200);

    const [handler, handlerMocks] = useFunctionMock<Handler>([
      {
        parameters: [request],
        return: Promise.resolve(response),
      },
    ]);

    const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

    expect(await multipartMiddleware(request, handler)).toBe(response);

    expect(handlerMocks).toHaveLength(0);
  });

  test.each([
    ['multipart/form-data; charset=utf-8'],
    ['text/x-multipart/form-data; boundary=----test-boundary'],
    ['multipart/form-data-thingy; boundary=----test-boundary'],
    ['application/x-www-form-urlencoded; charset="multipart/form-data;"'],
  ])('with an unsupported content-type: %s', async (contentType) => {
    const request = createRequest(contentType, streamFactory('somebody'));
    const response = responseFactory(200);

    const [handler, handlerMocks] = useFunctionMock<Handler>([
      {
        parameters: [request],
        return: Promise.resolve(response),
      },
    ]);

    const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

    expect(await multipartMiddleware(request, handler)).toBe(response);

    expect(handlerMocks).toHaveLength(0);

    expect(mkdtempSpy).not.toHaveBeenCalled();
  });

  describe('with multipart/form-data', () => {
    test('successful', async () => {
      // the content-length of the multipart body does not match the new body
      const request = serverRequestHelpers.withHeader(
        createMultipartRequest(createFormData()),
        'content-length',
        '1234',
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            expect(givenRequest.headers).toMatchInlineSnapshot(`
              {
                "content-type": [
                  "application/x-www-form-urlencoded",
                ],
              }
            `);

            const data = parse(await text(givenRequest.body));

            const redImagePattern = new RegExp(
              `^(${temporaryPathPattern}/[0-9a-f]{32}); filename=red.png; mimeType=image/png$`,
            );
            const greenImagePattern = new RegExp(
              `^(${temporaryPathPattern}/[0-9a-f]{32}); filename=green.png; mimeType=image/png$`,
            );
            const blueImagePattern = new RegExp(
              `^(${temporaryPathPattern}/[0-9a-f]{32}); filename=blue.png; mimeType=image/png$`,
            );

            expect(data).toEqual({
              id: '123e4567-e89b-12d3-a456-426655440000',
              name: 'John Doe',
              address: '{\r\n  "street": "3, Garden St",\r\n  "city": "Hillsbery, UT"\r\n}',
              red: expect.stringMatching(redImagePattern),
              green: expect.stringMatching(greenImagePattern),
              blue: expect.stringMatching(blueImagePattern),
            });

            const temporaryRedImagePath = (data['red'] as string).match(redImagePattern)?.[1] as string;
            const temporaryGreenImagePath = (data['green'] as string).match(greenImagePattern)?.[1] as string;
            const temporaryBlueImagePath = (data['blue'] as string).match(blueImagePattern)?.[1] as string;

            expect(sha1(readFileSync(temporaryRedImagePath))).toBe(sha1(readFileSync(redImagePath)));
            expect(sha1(readFileSync(temporaryGreenImagePath))).toBe(sha1(readFileSync(greenImagePath)));
            expect(sha1(readFileSync(temporaryBlueImagePath))).toBe(sha1(readFileSync(blueImagePath)));

            expect(givenRequest.attributes).toEqual({ multipartTemporaryPath: dirname(temporaryRedImagePath) });

            expect(parseMultipartFile(givenRequest, data['red'])).toEqual({
              path: temporaryRedImagePath,
              filename: 'red.png',
              mimeType: 'image/png',
            });
            expect(parseMultipartFile(givenRequest, data['id'])).toBeUndefined();

            // accessible by the owner only
            expect(statSync(temporaryRedImagePath).mode & 0o777).toBe(0o600);
            expect(statSync(dirname(temporaryRedImagePath)).mode & 0o777).toBe(0o700);

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
    });

    // the fields come before the files, no file gets written after reaching a limit
    test.each([
      [{ files: 1 }, 'files', 1],
      [{ fileSize: 10 }, 'fileSize', 1],
      [{ fields: 1 }, 'fields', 0],
      [{ fieldSize: 5 }, 'fieldSize', 0],
      [{ parts: 1 }, 'parts', 0],
    ] as const)('with limits %o', async (limits, limit, writtenFiles) => {
      const createWriteStreamSpy = vi.spyOn(nodeFs, 'createWriteStream');

      const request = createMultipartRequest(createFormData());

      const response = responseFactory(413);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            const error = await text(givenRequest.body).catch((e: unknown) => e);

            expect(isMultipartLimitError(error)).toBe(true);
            expect(error).toMatchObject({
              message: `Multipart: limit of ${limit} reached`,
              code: 'MULTIPART_LIMIT',
              limit,
            });

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers, limits);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      // the files written before reaching the limit got removed
      await vi.waitFor(async () => expect(await listTemporaryPaths()).toEqual([]));

      expect(createWriteStreamSpy).toHaveBeenCalledTimes(writtenFiles);

      createWriteStreamSpy.mockRestore();
    });

    test('without reading the body', async () => {
      const createWriteStreamSpy = vi.spyOn(nodeFs, 'createWriteStream');

      const { promise: bodyReleased, resolve: releaseBody } = Promise.withResolvers<undefined>();
      const bodyFinished = vi.fn();

      // e.g. a request which gets rejected by the handler (unauthorized) while a file gets uploaded
      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        Readable.from(
          (async function* () {
            yield Buffer.from(
              '------test-boundary\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\n' +
                'Content-Type: text/plain\r\n\r\npartial content',
            );
            await bodyReleased;
            yield Buffer.from(
              ' rest of the content\r\n------test-boundary\r\n' +
                'Content-Disposition: form-data; name="other"; filename="other.txt"\r\n' +
                'Content-Type: text/plain\r\n\r\ncontent\r\n------test-boundary\r\n' +
                'Content-Disposition: form-data; name="id"\r\n\r\n123\r\n------test-boundary--\r\n',
            );
            bodyFinished();
          })(),
        ),
      );

      const response = responseFactory(401);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async () => {
            await vi.waitFor(() => expect(createWriteStreamSpy).toHaveBeenCalledTimes(1));

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      // the file in progress stops getting written before the rest of the body arrives
      const writeStream = createWriteStreamSpy.mock.results[0]?.value as nodeFs.WriteStream;
      await vi.waitFor(() => expect(writeStream.destroyed).toBe(true));

      releaseBody(undefined);

      // the request body gets still read till its end (no aborted connection), no other file gets written and the
      // temporary directory gets removed
      await vi.waitFor(async () => {
        expect(bodyFinished).toHaveBeenCalledTimes(1);
        expect(await listTemporaryPaths()).toEqual([]);
      });

      expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);

      createWriteStreamSpy.mockRestore();
    });

    test('without reading the body while waiting for the body to be read', async () => {
      const bodyFinished = vi.fn();

      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        Readable.from(
          (async function* () {
            for (const i of Array.from({ length: 100 }, (_, index) => index)) {
              yield Buffer.from(
                `------test-boundary\r\nContent-Disposition: form-data; name="field${i}"\r\n\r\n${'x'.repeat(64 * 1024)}\r\n`,
              );
            }
            yield Buffer.from('------test-boundary--\r\n');
            bodyFinished();
          })(),
        ),
      );

      const response = responseFactory(401);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async () => {
            // the parsing waits for the new body to be read
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(bodyFinished).not.toHaveBeenCalled();

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers, { fieldSize: 128 * 1024 });

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      await vi.waitFor(async () => {
        expect(bodyFinished).toHaveBeenCalledTimes(1);
        expect(await listTemporaryPaths()).toEqual([]);
      });
    });

    test('with the body read after the handler', async () => {
      const formData = new FormData();
      formData.append('file', new Blob(['content'], { type: 'text/plain' }), 'file.txt');

      const request = createMultipartRequest(formData);

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            // the parsing finishes before the handler: the body stays usable, e.g. for a response streaming it
            await vi.waitFor(() => expect((givenRequest.body as PassThrough).writableEnded).toBe(true));

            expect(await listTemporaryPaths()).toHaveLength(1);

            return { ...response, body: givenRequest.body };
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      const givenResponse = await multipartMiddleware(request, handler);

      expect(handlerMocks).toHaveLength(0);

      // the files are not used by the handler, so they got removed
      await vi.waitFor(async () => expect(await listTemporaryPaths()).toEqual([]));

      expect(parse(await text(givenResponse.body))).toEqual({
        file: expect.stringMatching(
          new RegExp(`^${temporaryPathPattern}/[0-9a-f]{32}; filename=file.txt; mimeType=text/plain$`),
        ),
      });
    });

    test('with the body read before the handler is done', async () => {
      const formData = new FormData();
      formData.append('file', new Blob(['content'], { type: 'text/plain' }), 'file.txt');

      const request = createMultipartRequest(formData);

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            await text(givenRequest.body);

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      // the files got passed to the application, removing them is up to it
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(await listTemporaryPaths()).toHaveLength(1);
    });

    test('with failing handler', async () => {
      const formData = new FormData();
      formData.append('file', new Blob(['content'], { type: 'text/plain' }), 'file.txt');

      const request = createMultipartRequest(formData);

      const error = new Error('Failing handler');

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async () => {
            throw error;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      await expect(multipartMiddleware(request, handler)).rejects.toBe(error);

      expect(handlerMocks).toHaveLength(0);

      await vi.waitFor(async () => expect(await listTemporaryPaths()).toEqual([]));
    });

    test('with a slowly read body', async () => {
      const fieldCount = 200;
      const fieldValue = 'x'.repeat(64 * 1024);

      const readChunks = vi.fn();

      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        Readable.from(
          (async function* () {
            for (const i of Array.from({ length: fieldCount }, (_, index) => index)) {
              readChunks();
              yield Buffer.from(
                `------test-boundary\r\nContent-Disposition: form-data; name="field${i}"\r\n\r\n${fieldValue}\r\n`,
              );
            }
            yield Buffer.from('------test-boundary--\r\n');
          })(),
        ),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            await new Promise((resolve) => setTimeout(resolve, 50));

            // the request body does not get read further than the new body gets read
            expect(readChunks.mock.calls.length).toBeLessThan(fieldCount / 2);

            const data = parse(await text(givenRequest.body), { parameterLimit: fieldCount });

            expect(Object.keys(data)).toHaveLength(fieldCount);
            expect(data['field199']).toBe(fieldValue);

            // the listeners of each wait for the new body to be read got removed
            expect((givenRequest.body as Readable).listenerCount('drain')).toBe(0);
            expect((givenRequest.body as Readable).listenerCount('close')).toBeLessThan(10);

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers, { fieldSize: 128 * 1024 });

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
    });

    test('with whitespace within the content-type', async () => {
      const request = createRequest(
        'multipart/form-data ; boundary=----test-boundary',
        streamFactory(
          '------test-boundary\r\nContent-Disposition: form-data; name="id"\r\n\r\n123\r\n------test-boundary--\r\n',
        ),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            expect(await text(givenRequest.body)).toBe('id=123&');

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
    });

    test('with encoded names', async () => {
      const formData = new FormData();
      formData.append('a&b=c', 'd&e=f');
      formData.append('file&name', new Blob(['content'], { type: 'text/plain' }), 'file.txt');

      const request = createMultipartRequest(formData);

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            const data = parse(await text(givenRequest.body));

            expect(data).toEqual({
              'a&b=c': 'd&e=f',
              'file&name': expect.stringMatching(
                new RegExp(`^${temporaryPathPattern}/[0-9a-f]{32}; filename=file.txt; mimeType=text/plain$`),
              ),
            });

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
    });

    test('with utf-8 names', async () => {
      // the names and filenames get sent as utf-8 by the browsers (RFC 7578), without filename*=
      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        streamFactory(
          '------test-boundary\r\nContent-Disposition: form-data; name="straße"\r\n\r\nvalue\r\n' +
            '------test-boundary\r\nContent-Disposition: form-data; name="dätei"; filename="tëst ≈.txt"\r\n' +
            'Content-Type: text/plain\r\n\r\ncontent\r\n------test-boundary--\r\n',
        ),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            const data = parse(await text(givenRequest.body));

            expect(data).toEqual({ straße: 'value', dätei: expect.any(String) });

            expect(parseMultipartFile(givenRequest, data['dätei'])).toMatchObject({ filename: 'tëst ≈.txt' });

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
    });

    test('without filename', async () => {
      // busboy handles a part with content-type application/octet-stream as file, even without filename
      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        streamFactory(
          '------test-boundary\r\nContent-Disposition: form-data; name="file"\r\n' +
            'Content-Type: application/octet-stream\r\n\r\ncontent\r\n------test-boundary--\r\n',
        ),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            const data = parse(await text(givenRequest.body));

            expect(data).toEqual({
              file: expect.stringMatching(
                new RegExp(`^${temporaryPathPattern}/[0-9a-f]{32}; mimeType=application/octet-stream$`),
              ),
            });

            expect(readFileSync((data['file'] as string).split(';')[0] as string, 'utf-8')).toBe('content');

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
    });

    test('without files', async () => {
      const formData = new FormData();
      formData.append('id', '123e4567-e89b-12d3-a456-426655440000');

      const request = createMultipartRequest(formData);

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            expect(await text(givenRequest.body)).toBe('id=123e4567-e89b-12d3-a456-426655440000&');

            // the unused temporary directory got removed before the end of the body
            expect(await listTemporaryPaths()).toEqual([]);

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
    });

    test('with failing temporary file', async () => {
      const { createWriteStream } = await vi.importActual<typeof nodeFs>('node:fs');

      // a write into a missing directory fails like e.g. a full disk
      const createWriteStreamSpy = vi
        .spyOn(nodeFs, 'createWriteStream')
        .mockImplementationOnce((path) => createWriteStream(`${path}/missing/file`));

      const formData = new FormData();
      formData.append('file', new Blob(['content'], { type: 'text/plain' }), 'file.txt');

      const request = createMultipartRequest(formData);

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            await expect(text(givenRequest.body)).rejects.toThrow('ENOENT');

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);

      createWriteStreamSpy.mockRestore();

      await vi.waitFor(async () => expect(await listTemporaryPaths()).toEqual([]));
    });

    test('with malformed body', async () => {
      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        streamFactory('------test-boundary\r\nContent-Disposition: form-data; name="id"\r\n\r\n123'),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            await expect(text(givenRequest.body)).rejects.toThrow('Unexpected end of form');

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      await vi.waitFor(async () => expect(await listTemporaryPaths()).toEqual([]));
    });

    test('with malformed body read after the parsing', async () => {
      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        streamFactory('------test-boundary\r\nContent-Disposition: form-data; name="id"\r\n\r\n123'),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            // the error happens while nobody is reading the body, it gets thrown as soon as the body gets read
            await vi.waitFor(() => expect((givenRequest.body as PassThrough).destroyed).toBe(true));

            // the error does not get emitted unhandled (which would crash the process)
            expect((givenRequest.body as PassThrough).listenerCount('error')).toBe(1);

            await expect(text(givenRequest.body)).rejects.toThrow('Unexpected end of form');

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      await vi.waitFor(async () => expect(await listTemporaryPaths()).toEqual([]));
    });

    test('with failing body', async () => {
      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        Readable.from(
          (async function* () {
            yield Buffer.from('------test-boundary\r\n');
            throw new Error('Connection reset');
          })(),
        ),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            await expect(text(givenRequest.body)).rejects.toThrow('Connection reset');

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
    });
    test('with failing body while receiving a file', async () => {
      // e.g. a client which disconnects during the upload
      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        Readable.from(
          (async function* () {
            yield Buffer.from(
              '------test-boundary\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\n' +
                'Content-Type: text/plain\r\n\r\npartial content',
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error('Connection reset');
          })(),
        ),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            await expect(text(givenRequest.body)).rejects.toThrow('Connection reset');

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      // the partial file got removed
      await vi.waitFor(async () => expect(await listTemporaryPaths()).toEqual([]));
    });

    test('with failing temporary file while receiving the body', async () => {
      const { createWriteStream } = await vi.importActual<typeof nodeFs>('node:fs');

      // a write into a missing directory fails like e.g. a full disk
      const createWriteStreamSpy = vi
        .spyOn(nodeFs, 'createWriteStream')
        .mockImplementationOnce((path) => createWriteStream(`${path}/missing/file`));

      const bodyFinished = vi.fn();

      // the write fails long before the end of the body
      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        Readable.from(
          (async function* () {
            yield Buffer.from(
              '------test-boundary\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\n' +
                'Content-Type: text/plain\r\n\r\ncontent',
            );
            await new Promise((resolve) => setTimeout(resolve, 50));
            yield Buffer.from('\r\n------test-boundary--\r\n');
            bodyFinished();
          })(),
        ),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            await expect(text(givenRequest.body)).rejects.toThrow('ENOENT');

            // the error got thrown without waiting for the end of the body
            expect(bodyFinished).not.toHaveBeenCalled();

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);

      createWriteStreamSpy.mockRestore();

      await vi.waitFor(async () => expect(await listTemporaryPaths()).toEqual([]));
    });

    test('with failing cleanup', async () => {
      const rmSpy = vi.spyOn(nodeFsPromises, 'rm').mockRejectedValueOnce(new Error('EACCES'));

      const request = createRequest(
        'multipart/form-data; boundary=----test-boundary',
        streamFactory('------test-boundary\r\nContent-Disposition: form-data; name="id"\r\n\r\n123'),
      );

      const response = responseFactory(200);

      const [handler, handlerMocks] = useFunctionMock<Handler>([
        {
          callback: async (givenRequest: ServerRequest) => {
            // the error of the cleanup gets ignored, the error of the parsing gets thrown
            await expect(text(givenRequest.body)).rejects.toThrow('Unexpected end of form');

            return response;
          },
        },
      ]);

      const multipartMiddleware = createMultipartMiddleware(serverRequestHelpers);

      expect(await multipartMiddleware(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);

      await vi.waitFor(() => expect(rmSpy).toHaveBeenCalledTimes(1));

      rmSpy.mockRestore();
    });
  });
});

describe('isMultipartLimitError', () => {
  test.each([
    [new Error('Multipart: limit of files reached')],
    [new Error('other', { cause: 'MULTIPART_LIMIT' })],
    // oxlint-disable-next-line functional/immutable-data
    [Object.assign(new Error('other'), { code: 'OTHER' })],
    [{ code: 'MULTIPART_LIMIT' }],
    ['MULTIPART_LIMIT'],
    [undefined],
  ])('without limit error: %o', (error) => {
    expect(isMultipartLimitError(error)).toBe(false);
  });
});

describe('parseMultipartFile', () => {
  const temporaryPath = '/tmp/multipart-AbC123';
  const fileName = '0123456789abcdef0123456789abcdef';

  const request = serverRequestHelpers.withAttribute(
    serverRequestFactory('POST', 'https://example.com'),
    multipartTemporaryPathAttribute,
    temporaryPath,
  );

  test('with filename', () => {
    expect(parseMultipartFile(request, `${temporaryPath}/${fileName}; filename=red.png; mimeType=image/png`)).toEqual({
      path: `${temporaryPath}/${fileName}`,
      filename: 'red.png',
      mimeType: 'image/png',
    });
  });

  test('with filename containing the separators', () => {
    expect(
      parseMultipartFile(
        request,
        `${temporaryPath}/${fileName}; filename=a; mimeType=image/png;\nb.txt; mimeType=text/plain`,
      ),
    ).toEqual({
      path: `${temporaryPath}/${fileName}`,
      filename: 'a; mimeType=image/png;\nb.txt',
      mimeType: 'text/plain',
    });
  });

  test('without filename', () => {
    expect(parseMultipartFile(request, `${temporaryPath}/${fileName}; mimeType=application/octet-stream`)).toEqual({
      path: `${temporaryPath}/${fileName}`,
      filename: undefined,
      mimeType: 'application/octet-stream',
    });
  });

  test.each([
    [
      'without attribute',
      serverRequestFactory('POST', 'https://example.com'),
      `${temporaryPath}/${fileName}; mimeType=text/plain`,
    ],
    [
      'without attribute but with a matching value',
      serverRequestFactory('POST', 'https://example.com'),
      `undefined/${fileName}; mimeType=text/plain`,
    ],
    ['with non string value', request, ['array']],
    ['with a path outside the temporary directory', request, '/etc/passwd; filename=red.png; mimeType=image/png'],
    ['with a path of another temporary directory', request, `/tmp/multipart-XyZ789/${fileName}; mimeType=text/plain`],
    ['with a path within a prefixed directory', request, `${temporaryPath}x/${fileName}; mimeType=text/plain`],
    ['with path traversal', request, `${temporaryPath}/../../etc/passwd; mimeType=text/plain`],
    ['with a too long file name', request, `${temporaryPath}/${fileName}0; mimeType=text/plain`],
    ['without mime type', request, `${temporaryPath}/${fileName}; filename=red.png`],
    [
      'with a mime type containing a semicolon',
      request,
      `${temporaryPath}/${fileName}; mimeType=text/plain; charset=utf-8`,
    ],
    ['with a suffix', request, `${temporaryPath}/${fileName}x; mimeType=text/plain`],
  ])('%s', (_, givenRequest, value) => {
    expect(parseMultipartFile(givenRequest, value)).toBeUndefined();
  });
});
