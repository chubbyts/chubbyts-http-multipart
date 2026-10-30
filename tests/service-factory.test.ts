import { text } from 'node:stream/consumers';
import { describe, expect, test } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import { useObjectMock } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import type { Container } from '@chubbyts/chubbyts-dic-types/dist/container';
import type { ConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createContainerByConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createResponseFactory, createServerRequestFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';
import type { MultipartConfig } from '../src/service-factory.js';
import { multipartMiddlewareServiceFactory } from '../src/service-factory.js';

// createMultipartMiddleware returns an opaque closure, so the wiring gets proven by exercising the created middleware
// against a multipart request: the configured limits decide whether the two fields reach the handler or the body throws a
// limit error, @chubbyts/chubbyts-http is used as implementation

const serverRequestFactory = createServerRequestFactory();
const serverRequestHelpers = createServerRequestHelpers();
const responseFactory = createResponseFactory();

const createMultipartRequest = (): ServerRequest => {
  const formData = new FormData();
  formData.append('first', 'one');
  formData.append('second', 'two');

  // the multipart encoding of the fetch api gets used to create the body and its content-type (with the boundary)
  const { headers, body } = new globalThis.Response(formData);

  return serverRequestHelpers.withBody(
    serverRequestHelpers.withHeader(
      serverRequestFactory('POST', 'https://example.com/resource'),
      'content-type',
      headers.get('content-type') as string,
    ),
    body as ReadableStream<Uint8Array>,
  );
};

const expectBody = async (middleware: Middleware, expectedBody: string | Error) => {
  const [handler, handlerMocks] = useFunctionMock<Handler>([
    {
      callback: async (request: ServerRequest): Promise<Response> => {
        expect(serverRequestHelpers.getHeaderLine(request, 'content-type')).toBe('application/x-www-form-urlencoded');

        if (expectedBody instanceof Error) {
          await expect(text(request.body)).rejects.toThrow(expectedBody.message);
        } else {
          expect(await text(request.body)).toBe(expectedBody);
        }

        return responseFactory(204);
      },
    },
  ]);

  const response = await middleware(createMultipartRequest(), handler);

  expect(response.status).toBe(204);

  expect(handlerMocks).toHaveLength(0);
};

describe('multipartMiddlewareServiceFactory', () => {
  test('without config', async () => {
    const [container, containerMocks] = useObjectMock<Container>([
      { name: 'get', parameters: ['config'], return: {} },
      { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
    ]);

    const service = multipartMiddlewareServiceFactory()(container);

    await expectBody(service, 'first=one&second=two&');

    expect(containerMocks).toHaveLength(0);
  });

  test('without name', async () => {
    const multipartConfig: MultipartConfig = { limits: { fields: 1 } };

    const [container, containerMocks] = useObjectMock<Container>([
      { name: 'get', parameters: ['config'], return: { chubbyts: { multipart: multipartConfig } } },
      { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
    ]);

    const service = multipartMiddlewareServiceFactory()(container);

    // the configured limits get passed through: the second field exceeds them
    await expectBody(service, new Error('Multipart: limit of fields reached'));

    expect(containerMocks).toHaveLength(0);
  });

  test('with name', async () => {
    const [container, containerMocks] = useObjectMock<Container>([
      {
        name: 'get',
        parameters: ['config'],
        return: {
          chubbyts: {
            multipart: {
              api: { limits: { fields: 1 } },
              admin: { limits: { fields: 2 } },
            },
          },
        },
      },
      { name: 'get', parameters: ['serverRequestHelpers'], return: serverRequestHelpers },
    ]);

    await expectBody(
      multipartMiddlewareServiceFactory('api')(container),
      new Error('Multipart: limit of fields reached'),
    );

    expect(containerMocks).toHaveLength(0);
  });

  test('with chubbyts-dic-config container', async () => {
    const container = createContainerByConfigFactory({
      chubbyts: {
        multipart: {
          limits: { fields: 1 },
        } satisfies MultipartConfig,
      },
      dependencies: {
        factories: new Map<string, ConfigFactory>([
          ['serverRequestHelpers', () => createServerRequestHelpers()],
          ['multipartMiddleware', multipartMiddlewareServiceFactory()],
        ]),
      },
    })();

    await expectBody(container.get<Middleware>('multipartMiddleware'), new Error('Multipart: limit of fields reached'));
  });
});
