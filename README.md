# chubbyts-http-multipart

[![CI](https://github.com/chubbyts/chubbyts-http-multipart/actions/workflows/ci.yml/badge.svg)](https://github.com/chubbyts/chubbyts-http-multipart/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/chubbyts/chubbyts-http-multipart/badge.svg?branch=master)](https://coveralls.io/github/chubbyts/chubbyts-http-multipart?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fchubbyts%2Fchubbyts-http-multipart%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/chubbyts/chubbyts-http-multipart/master)
[![npm-version](https://img.shields.io/npm/v/@chubbyts/chubbyts-http-multipart.svg)](https://www.npmjs.com/package/@chubbyts/chubbyts-http-multipart)

[![bugs](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=bugs)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)
[![code_smells](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=code_smells)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)
[![coverage](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=coverage)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)
[![duplicated_lines_density](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=duplicated_lines_density)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)
[![ncloc](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=ncloc)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)
[![sqale_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=sqale_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)
[![alert_status](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=alert_status)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)
[![reliability_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=reliability_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)
[![security_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-multipart&metric=security_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-multipart)

## Description

A minimal multipart middleware for [@chubbyts/chubbyts-http-types][2].

It works with any implementation of the types (e.g. [@chubbyts/chubbyts-http][7]): the request header gets read and
the request gets changed through the injected helpers only.

## Requirements

 * node: 22
 * [@chubbyts/chubbyts-dic-config-factory][6]: ^1.0.1
 * [@chubbyts/chubbyts-dic-types][4]: ^2.3.1
 * [@chubbyts/chubbyts-http-types][2]: ^4.0.0
 * [busboy][3]: ^1.6.0

## Installation

Through [NPM](https://www.npmjs.com) as [@chubbyts/chubbyts-http-multipart][1].

```sh
npm i @chubbyts/chubbyts-http-multipart@^3.0.0
```

## Usage

```ts
import { text } from 'node:stream/consumers';
import { createResponseFactory, createServerRequestFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import {
  createMultipartMiddleware,
  isMultipartLimitError,
  parseMultipartFile,
} from '@chubbyts/chubbyts-http-multipart/multipart-middleware';

const serverRequestFactory = createServerRequestFactory();
const serverRequestHelpers = createServerRequestHelpers();
const responseFactory = createResponseFactory();

const multipartMiddleware = createMultipartMiddleware(
  serverRequestHelpers,
  { fileSize: 10 * 1024 * 1024, files: 5 }, // (see the `limits` of busboy)
);

// if the original content-type of the request was multipart/form-data, the content-type is now
// application/x-www-form-urlencoded and the body got replaced
const handler: Handler = async (request) => {
  try {
    const data = new URLSearchParams(await text(request.body));

    // undefined, if the value is not a file written by the middleware for this request
    const avatar = parseMultipartFile(request, data.get('avatar'));
    // { path: '/tmp/multipart-XXXXXX/...', filename: 'avatar.png', mimeType: 'image/png' }

    return responseFactory(200);
  } catch (error) {
    return responseFactory(isMultipartLimitError(error) ? 413 : 400);
  }
};

(async () => {
  const serverRequest = serverRequestFactory('POST', 'https://example.com/');
  const response = await multipartMiddleware(serverRequest, handler);
})();
```

Only a request with a `multipart/form-data` content-type including a `boundary` gets handled, any other request gets
passed to the handler as it is. The `content-length` header of a handled request gets removed, as it does not match the
new body.

The files get written into a temporary directory per request (`<tmpdir>/multipart-XXXXXX/...`), accessible by the
owner only. A file is complete as soon as the new body ended, so read the whole body before using a file, removing the
files is up to the application then. The names and filenames are read as UTF-8 (RFC 7578). A file without filename (e.g. a part with content-type
`application/octet-stream`) gets passed without `filename=`.

**Use `parseMultipartFile` for the values of files**: a client can send a field whose value looks like a file (e.g.
`/etc/passwd; filename=avatar.png; mimeType=image/png`), only a file within the temporary directory of the request (the
attribute `multipartTemporaryPath`) got written by the middleware. It reads the filename correctly, even if it contains
`; mimeType=`.

**Configure the limits**, there are none by default (beside the `fieldSize` of 1 MiB of busboy). Reaching a limit gets
thrown as `MultipartLimitError` (`code: 'MULTIPART_LIMIT'`, `limit: 'fileSize' | 'files' | 'fields' | 'fieldSize' |
'parts'`, see `isMultipartLimitError`) while iterating the new body, nothing gets truncated or dropped silently. The
`fieldNameSize` limit does not apply, busboy does not truncate the names of a multipart body.

A malformed multipart body, a failing request body or a failing write of a file gets thrown while iterating the new
body as well (also if the new body gets read after the error happened). On any error, and if the handler is done
(returned or thrown) before the new body got read till its end, no further file gets written and the temporary directory
including the files written so far gets removed by the middleware. The rest of the request body gets still read (and
discarded), so the response can be sent. The fields get read only as fast as the new body gets read, the content of a
file gets written as fast as it arrives (even if nobody reads the new body yet), so limit it by `fileSize` and `files`.

### Example

#### Input

```
----------------------------394107496171408467161617
Content-Disposition: form-data; name="id"

123e4567-e89b-12d3-a456-426655440000
----------------------------394107496171408467161617
Content-Disposition: form-data; name="name"

John Doe
----------------------------394107496171408467161617
Content-Disposition: form-data; name="address"
Content-Type: application/json

{
  "street": "3, Garden St",
  "city": "Hillsbery, UT"
}
----------------------------394107496171408467161617
Content-Disposition: form-data; name="red"; filename="red.png"
Content-Type: image/png

<binary>
----------------------------394107496171408467161617
Content-Disposition: form-data; name="green"; filename="green.png"
Content-Type: image/png

<binary>
----------------------------394107496171408467161617
Content-Disposition: form-data; name="blue"; filename="blue.png"
Content-Type: image/png

<binary>
----------------------------394107496171408467161617--
```

#### Output

*Optimized for human readability*

```
id=123e4567-e89b-12d3-a456-426655440000&
name=John Doe&
address={\r\n  "street": "3, Garden St",\r\n  "city": "Hillsbery, UT"\r\n}&
red=/tmp/multipart-XXXXXX/...; filename=red.png; mimeType=image/png&
green=/tmp/multipart-XXXXXX/...; filename=green.png; mimeType=image/png&
blue=/tmp/multipart-XXXXXX/...; filename=blue.png; mimeType=image/png&
```

### Service factory (chubbyts-dic-config)

The package ships a service factory (an abstract factory built on [chubbyts-dic-config-factory][6]) for a [chubbyts-dic-config][5] (or any [chubbyts-dic-types][4] compatible) container within `@chubbyts/chubbyts-http-multipart/service-factory`, configured through `config.chubbyts.multipart` (optional, see the `limits` of [busboy][3]). The implementation of the types gets read from the service `serverRequestHelpers`, which has to be registered:

```ts
import type { ConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createContainerByConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { MultipartConfig } from '@chubbyts/chubbyts-http-multipart/service-factory';
import { multipartMiddlewareServiceFactory } from '@chubbyts/chubbyts-http-multipart/service-factory';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';

const container = createContainerByConfigFactory({
  chubbyts: {
    multipart: {
      // limits: { fileSize: 10 * 1024 * 1024, files: 5 },
    } satisfies MultipartConfig,
  },
  dependencies: {
    factories: new Map<string, ConfigFactory>([
      ['serverRequestHelpers', () => createServerRequestHelpers()],
      ['multipartMiddleware', multipartMiddlewareServiceFactory()],
    ]),
  },
})();

const multipartMiddleware = container.get<Middleware>('multipartMiddleware');
```

#### With names

To use different limits for different parts of an api, the factory can be registered multiple times with a name: the config is then read from `config.chubbyts.multipart.<name>`.

```ts
const container = createContainerByConfigFactory({
  chubbyts: {
    multipart: {
      api: { limits: { fileSize: 1024 * 1024 } },
      admin: { limits: { fileSize: 100 * 1024 * 1024 } },
    } satisfies Record<string, MultipartConfig>,
  },
  dependencies: {
    factories: new Map<string, ConfigFactory>([
      // serverRequestHelpers like above
      ['multipartMiddlewareapi', multipartMiddlewareServiceFactory('api')],
      ['multipartMiddlewareadmin', multipartMiddlewareServiceFactory('admin')],
    ]),
  },
})();

const apiMultipartMiddleware = container.get<Middleware>('multipartMiddlewareapi');
const adminMultipartMiddleware = container.get<Middleware>('multipartMiddlewareadmin');
```

## Copyright

2026 Dominik Zogg

[1]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-multipart
[2]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-types
[3]: https://www.npmjs.com/package/busboy
[4]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-types
[5]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-config
[6]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-config-factory
[7]: https://www.npmjs.com/package/@chubbyts/chubbyts-http
