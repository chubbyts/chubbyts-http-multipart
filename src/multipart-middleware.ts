import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import type { Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';

/**
 * The attribute containing the temporary directory of the request, only a file within it got written by the middleware.
 */
export const multipartTemporaryPathAttribute = 'multipartTemporaryPath';

// fieldNameSize and headerPairs do not get thrown, busboy does not truncate the names nor report the header pairs
type MultipartLimit = 'fileSize' | 'files' | 'fields' | 'fieldSize' | 'parts';

export type MultipartLimitError = Error & {
  readonly code: 'MULTIPART_LIMIT';
  readonly limit: MultipartLimit;
};

export type MultipartFile = {
  readonly path: string;
  readonly filename: string | undefined;
  readonly mimeType: string;
};

const createLimitError = (limit: MultipartLimit): MultipartLimitError =>
  // oxlint-disable-next-line functional/immutable-data
  Object.assign(new Error(`Multipart: limit of ${limit} reached`), { code: 'MULTIPART_LIMIT' as const, limit });

export const isMultipartLimitError = (error: unknown): error is MultipartLimitError =>
  error instanceof Error && 'code' in error && error.code === 'MULTIPART_LIMIT';

/**
 * Returns the file of a value of the new body, or undefined if the value is not a file written by the middleware for
 * this request (e.g. a field sent by the client mimicking a file).
 */
export const parseMultipartFile = (request: ServerRequest, value: unknown): MultipartFile | undefined => {
  const temporaryPath = request.attributes[multipartTemporaryPathAttribute];

  if (typeof temporaryPath !== 'string' || typeof value !== 'string' || !value.startsWith(`${temporaryPath}/`)) {
    return undefined;
  }

  // the filename can contain anything, the mime type (type/subtype) cannot contain a semicolon
  const match = /^([0-9a-f]{32})(?:; filename=(.*))?; mimeType=([^;]*)$/s.exec(value.slice(temporaryPath.length + 1));

  if (!match) {
    return undefined;
  }

  const [, name, filename, mimeType] = match as unknown as [string, string, string | undefined, string];

  return { path: `${temporaryPath}/${name}`, filename, mimeType };
};

const createParser = (contentType: string, limits: busboy.Limits | undefined): busboy.Busboy | null => {
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    return null;
  }

  try {
    // busboy reads the content-type header only and throws on a malformed one (e.g. without boundary), the names and
    // filenames are utf-8 (RFC 7578) instead of the latin1 default of busboy
    return busboy({ headers: { 'content-type': contentType }, limits, defParamCharset: 'utf8' });
  } catch {
    return null;
  }
};

const encodePair = (name: string, value: string): string => `${encodeURIComponent(name)}=${encodeURIComponent(value)}&`;

const waitForDrainOrClose = (stream: PassThrough): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };

    stream.on('drain', done);
    stream.on('close', done);
  });

export const createMultipartMiddleware = (
  serverRequestHelpers: ServerRequestHelpers,
  limits: busboy.Limits | undefined = undefined,
): Middleware => {
  return async (request: ServerRequest, handler: Handler): Promise<Response> => {
    const multipartStream = createParser(serverRequestHelpers.getHeaderLine(request, 'content-type'), limits);
    if (multipartStream === null) {
      return handler(request);
    }

    // a unique directory per request, accessible by the owner only (mode 0o700)
    const temporaryPath = await mkdtemp(`${tmpdir()}/multipart-`);

    const fileFinishedPromises: Array<Promise<unknown>> = [];

    // a destroyed new body (failure, limit, or nobody reading it anymore) stops writing anything: the request body gets
    // still parsed until its end (so a response can be sent), the temporary directory gets removed afterwards
    const newBody = new PassThrough();

    const fail = (error: Error) => newBody.destroy(error);

    // the error is kept by the new body and gets thrown while iterating it, even if nobody is iterating it yet
    newBody.on('error', () => undefined);

    const fileDiscards: Array<() => void> = [];

    // stop writing the files as soon as the new body gets destroyed, discarding a finished file does nothing
    newBody.once('close', () => fileDiscards.forEach((discard) => discard()));

    const writeFile = (readableFile: Readable, temporaryFilePath: string): Promise<unknown> => {
      const writeStream = createWriteStream(temporaryFilePath, { mode: 0o600 });

      // busboy only continues parsing, if the file gets consumed till its end
      const discard = () => {
        readableFile.resume();
        writeStream.destroy();
      };

      // oxlint-disable-next-line functional/immutable-data
      fileDiscards.push(discard);

      readableFile.pipe(writeStream);

      // a failing file (e.g. an aborted request) or a failing write rejects, a failed write needs the file discarded
      return Promise.all([finished(readableFile), finished(writeStream)]).finally(discard);
    };

    multipartStream.on('file', (name, readableFile, { filename, mimeType }) => {
      if (newBody.destroyed) {
        readableFile.resume();

        return;
      }

      readableFile.once('limit', () => fail(createLimitError('fileSize')));

      const temporaryFilePath = `${temporaryPath}/${randomBytes(16).toString('hex')}`;

      const fileFinishedPromise = writeFile(readableFile, temporaryFilePath);

      // a failing write gets thrown immediately, the cleanup happens at the end of the parsing
      fileFinishedPromise.catch(fail);

      // oxlint-disable-next-line functional/immutable-data
      fileFinishedPromises.push(fileFinishedPromise);

      const value =
        filename === undefined
          ? `${temporaryFilePath}; mimeType=${mimeType}`
          : `${temporaryFilePath}; filename=${filename}; mimeType=${mimeType}`;

      newBody.write(encodePair(name, value));
    });

    // busboy does not truncate the names of a multipart body, the fieldNameSize limit gets not applied
    multipartStream.on('field', (name, value, { valueTruncated }) => {
      if (valueTruncated) {
        fail(createLimitError('fieldSize'));
      } else {
        newBody.write(encodePair(name, value));
      }
    });

    multipartStream.on('filesLimit', () => fail(createLimitError('files')));
    multipartStream.on('fieldsLimit', () => fail(createLimitError('fields')));
    multipartStream.on('partsLimit', () => fail(createLimitError('parts')));

    const removeTemporaryPath = () => rm(temporaryPath, { recursive: true }).catch(() => undefined);

    const parse = async () => {
      try {
        await pipeline(
          Readable.from(request.body),
          // the request body gets read only as fast as the new body gets read
          async function* (source: AsyncIterable<Uint8Array>) {
            for await (const chunk of source) {
              yield chunk;

              if (newBody.writableNeedDrain) {
                await waitForDrainOrClose(newBody);
              }
            }
          },
          multipartStream,
        );
      } catch (error) {
        // a failing body or a malformed multipart body gets thrown while iterating the new body
        fail(error as Error);
      }

      await Promise.allSettled(fileFinishedPromises);

      if (newBody.destroyed || fileFinishedPromises.length === 0) {
        // the files never got passed completely to the application (or there are none), so they get removed here
        await removeTemporaryPath();
      }

      newBody.end();
    };

    // parse never rejects, its errors are passed to the new body
    void parse();

    try {
      return await handler(
        serverRequestHelpers.withBody(
          serverRequestHelpers.withAttribute(
            serverRequestHelpers.withoutHeader(
              serverRequestHelpers.withHeader(request, 'content-type', 'application/x-www-form-urlencoded'),
              'content-length',
            ),
            multipartTemporaryPathAttribute,
            temporaryPath,
          ),
          newBody,
        ),
      );
    } finally {
      // the handler is done without reading the whole new body, so the files will never be used
      if (!newBody.writableEnded) {
        newBody.destroy();
      } else if (!newBody.readableEnded) {
        // the parsing is done and kept the files, the new body stays readable (e.g. for a response streaming it)
        void removeTemporaryPath();
      }
    }
  };
};
