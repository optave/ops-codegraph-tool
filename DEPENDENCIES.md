# Dependencies

```
@optave/codegraph@2.0.0 H:\Vscode\codegraph
├─┬ @huggingface/transformers@3.8.1
│ ├── @huggingface/jinja@0.5.5
│ ├─┬ onnxruntime-node@1.21.0
│ │ ├─┬ global-agent@3.0.0
│ │ │ ├── boolean@3.2.0
│ │ │ ├── es6-error@4.1.1
│ │ │ ├─┬ matcher@3.0.0
│ │ │ │ └── escape-string-regexp@4.0.0
│ │ │ ├─┬ roarr@2.15.4
│ │ │ │ ├── boolean@3.2.0 deduped
│ │ │ │ ├── detect-node@2.1.0
│ │ │ │ ├─┬ globalthis@1.0.4
│ │ │ │ │ ├─┬ define-properties@1.2.1
│ │ │ │ │ │ ├─┬ define-data-property@1.1.4
│ │ │ │ │ │ │ ├── es-define-property@1.0.1 deduped
│ │ │ │ │ │ │ ├── es-errors@1.3.0 deduped
│ │ │ │ │ │ │ └── gopd@1.2.0 deduped
│ │ │ │ │ │ ├─┬ has-property-descriptors@1.0.2
│ │ │ │ │ │ │ └── es-define-property@1.0.1 deduped
│ │ │ │ │ │ └── object-keys@1.1.1
│ │ │ │ │ └── gopd@1.2.0
│ │ │ │ ├── json-stringify-safe@5.0.1
│ │ │ │ ├── semver-compare@1.0.0
│ │ │ │ └── sprintf-js@1.1.3
│ │ │ ├── semver@7.7.4 deduped
│ │ │ └─┬ serialize-error@7.0.1
│ │ │   └── type-fest@0.13.1
│ │ ├── onnxruntime-common@1.21.0
│ │ └─┬ tar@7.5.9
│ │   ├─┬ @isaacs/fs-minipass@4.0.1
│ │   │ └── minipass@7.1.3 deduped
│ │   ├── chownr@3.0.0
│ │   ├── minipass@7.1.3
│ │   ├─┬ minizlib@3.1.0
│ │   │ └── minipass@7.1.3 deduped
│ │   └── yallist@5.0.0
│ ├─┬ onnxruntime-web@1.22.0-dev.20250409-89f8206ba4
│ │ ├── flatbuffers@25.9.23
│ │ ├── guid-typescript@1.0.9
│ │ ├── long@5.3.2
│ │ ├── onnxruntime-common@1.22.0-dev.20250409-89f8206ba4
│ │ ├── platform@1.3.6
│ │ └─┬ protobufjs@7.5.4
│ │   ├── @protobufjs/aspromise@1.1.2
│ │   ├── @protobufjs/base64@1.1.2
│ │   ├── @protobufjs/codegen@2.0.4
│ │   ├── @protobufjs/eventemitter@1.1.0
│ │   ├─┬ @protobufjs/fetch@1.1.0
│ │   │ ├── @protobufjs/aspromise@1.1.2 deduped
│ │   │ └── @protobufjs/inquire@1.1.0 deduped
│ │   ├── @protobufjs/float@1.0.2
│ │   ├── @protobufjs/inquire@1.1.0
│ │   ├── @protobufjs/path@1.1.2
│ │   ├── @protobufjs/pool@1.1.0
│ │   ├── @protobufjs/utf8@1.1.0
│ │   ├─┬ @types/node@25.3.0
│ │   │ └── undici-types@7.18.2
│ │   └── long@5.3.2 deduped
│ └─┬ sharp@0.34.5
│   ├── @img/colour@1.0.0
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-darwin-arm64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-darwin-x64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-darwin-arm64@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-darwin-x64@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-linux-arm@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-linux-arm64@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-linux-ppc64@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-linux-riscv64@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-linux-s390x@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-linux-x64@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-linuxmusl-arm64@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-libvips-linuxmusl-x64@1.2.4
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-linux-arm@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-linux-arm64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-linux-ppc64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-linux-riscv64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-linux-s390x@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-linux-x64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-linuxmusl-arm64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-linuxmusl-x64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-wasm32@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-win32-arm64@0.34.5
│   ├── UNMET OPTIONAL DEPENDENCY @img/sharp-win32-ia32@0.34.5
│   ├── @img/sharp-win32-x64@0.34.5
│   ├── detect-libc@2.1.2
│   └── semver@7.7.4
├─┬ @modelcontextprotocol/sdk@1.26.0
│ ├── UNMET OPTIONAL DEPENDENCY @cfworker/json-schema@^4.1.1
│ ├─┬ @hono/node-server@1.19.9
│ │ └── hono@4.12.0 deduped
│ ├─┬ ajv-formats@3.0.1
│ │ └── ajv@8.18.0 deduped
│ ├─┬ ajv@8.18.0
│ │ ├── fast-deep-equal@3.1.3
│ │ ├── fast-uri@3.1.0
│ │ ├── json-schema-traverse@1.0.0
│ │ └── require-from-string@2.0.2
│ ├── content-type@1.0.5
│ ├─┬ cors@2.8.6
│ │ ├── object-assign@4.1.1
│ │ └── vary@1.1.2
│ ├─┬ cross-spawn@7.0.6
│ │ ├── path-key@3.1.1
│ │ ├─┬ shebang-command@2.0.0
│ │ │ └── shebang-regex@3.0.0
│ │ └─┬ which@2.0.2
│ │   └── isexe@2.0.0
│ ├── eventsource-parser@3.0.6
│ ├─┬ eventsource@3.0.7
│ │ └── eventsource-parser@3.0.6 deduped
│ ├─┬ express-rate-limit@8.2.1
│ │ ├── express@5.2.1 deduped
│ │ └── ip-address@10.0.1
│ ├─┬ express@5.2.1
│ │ ├─┬ accepts@2.0.0
│ │ │ ├── mime-types@3.0.2 deduped
│ │ │ └── negotiator@1.0.0
│ │ ├─┬ body-parser@2.2.2
│ │ │ ├── bytes@3.1.2 deduped
│ │ │ ├── content-type@1.0.5 deduped
│ │ │ ├── debug@4.4.3 deduped
│ │ │ ├── http-errors@2.0.1 deduped
│ │ │ ├── iconv-lite@0.7.2 deduped
│ │ │ ├── on-finished@2.4.1 deduped
│ │ │ ├── qs@6.15.0 deduped
│ │ │ ├── raw-body@3.0.2 deduped
│ │ │ └── type-is@2.0.1 deduped
│ │ ├── content-disposition@1.0.1
│ │ ├── content-type@1.0.5 deduped
│ │ ├── cookie-signature@1.2.2
│ │ ├── cookie@0.7.2
│ │ ├─┬ debug@4.4.3
│ │ │ └── ms@2.1.3
│ │ ├── depd@2.0.0
│ │ ├── encodeurl@2.0.0
│ │ ├── escape-html@1.0.3
│ │ ├── etag@1.8.1
│ │ ├─┬ finalhandler@2.1.1
│ │ │ ├── debug@4.4.3 deduped
│ │ │ ├── encodeurl@2.0.0 deduped
│ │ │ ├── escape-html@1.0.3 deduped
│ │ │ ├── on-finished@2.4.1 deduped
│ │ │ ├── parseurl@1.3.3 deduped
│ │ │ └── statuses@2.0.2 deduped
│ │ ├── fresh@2.0.0
│ │ ├─┬ http-errors@2.0.1
│ │ │ ├── depd@2.0.0 deduped
│ │ │ ├── inherits@2.0.4
│ │ │ ├── setprototypeof@1.2.0
│ │ │ ├── statuses@2.0.2 deduped
│ │ │ └── toidentifier@1.0.1
│ │ ├── merge-descriptors@2.0.0
│ │ ├─┬ mime-types@3.0.2
│ │ │ └── mime-db@1.54.0
│ │ ├─┬ on-finished@2.4.1
│ │ │ └── ee-first@1.1.1
│ │ ├─┬ once@1.4.0
│ │ │ └── wrappy@1.0.2
│ │ ├── parseurl@1.3.3
│ │ ├─┬ proxy-addr@2.0.7
│ │ │ ├── forwarded@0.2.0
│ │ │ └── ipaddr.js@1.9.1
│ │ ├─┬ qs@6.15.0
│ │ │ └─┬ side-channel@1.1.0
│ │ │   ├── es-errors@1.3.0
│ │ │   ├── object-inspect@1.13.4
│ │ │   ├─┬ side-channel-list@1.0.0
│ │ │   │ ├── es-errors@1.3.0 deduped
│ │ │   │ └── object-inspect@1.13.4 deduped
│ │ │   ├─┬ side-channel-map@1.0.1
│ │ │   │ ├─┬ call-bound@1.0.4
│ │ │   │ │ ├─┬ call-bind-apply-helpers@1.0.2
│ │ │   │ │ │ ├── es-errors@1.3.0 deduped
│ │ │   │ │ │ └── function-bind@1.1.2 deduped
│ │ │   │ │ └── get-intrinsic@1.3.0 deduped
│ │ │   │ ├── es-errors@1.3.0 deduped
│ │ │   │ ├─┬ get-intrinsic@1.3.0
│ │ │   │ │ ├── call-bind-apply-helpers@1.0.2 deduped
│ │ │   │ │ ├── es-define-property@1.0.1
│ │ │   │ │ ├── es-errors@1.3.0 deduped
│ │ │   │ │ ├─┬ es-object-atoms@1.1.1
│ │ │   │ │ │ └── es-errors@1.3.0 deduped
│ │ │   │ │ ├── function-bind@1.1.2
│ │ │   │ │ ├─┬ get-proto@1.0.1
│ │ │   │ │ │ ├─┬ dunder-proto@1.0.1
│ │ │   │ │ │ │ ├── call-bind-apply-helpers@1.0.2 deduped
│ │ │   │ │ │ │ ├── es-errors@1.3.0 deduped
│ │ │   │ │ │ │ └── gopd@1.2.0 deduped
│ │ │   │ │ │ └── es-object-atoms@1.1.1 deduped
│ │ │   │ │ ├── gopd@1.2.0 deduped
│ │ │   │ │ ├── has-symbols@1.1.0
│ │ │   │ │ ├─┬ hasown@2.0.2
│ │ │   │ │ │ └── function-bind@1.1.2 deduped
│ │ │   │ │ └── math-intrinsics@1.1.0
│ │ │   │ └── object-inspect@1.13.4 deduped
│ │ │   └─┬ side-channel-weakmap@1.0.2
│ │ │     ├── call-bound@1.0.4 deduped
│ │ │     ├── es-errors@1.3.0 deduped
│ │ │     ├── get-intrinsic@1.3.0 deduped
│ │ │     ├── object-inspect@1.13.4 deduped
│ │ │     └── side-channel-map@1.0.1 deduped
│ │ ├── range-parser@1.2.1
│ │ ├─┬ router@2.2.0
│ │ │ ├── debug@4.4.3 deduped
│ │ │ ├── depd@2.0.0 deduped
│ │ │ ├── is-promise@4.0.0
│ │ │ ├── parseurl@1.3.3 deduped
│ │ │ └── path-to-regexp@8.3.0
│ │ ├─┬ send@1.2.1
│ │ │ ├── debug@4.4.3 deduped
│ │ │ ├── encodeurl@2.0.0 deduped
│ │ │ ├── escape-html@1.0.3 deduped
│ │ │ ├── etag@1.8.1 deduped
│ │ │ ├── fresh@2.0.0 deduped
│ │ │ ├── http-errors@2.0.1 deduped
│ │ │ ├── mime-types@3.0.2 deduped
│ │ │ ├── ms@2.1.3 deduped
│ │ │ ├── on-finished@2.4.1 deduped
│ │ │ ├── range-parser@1.2.1 deduped
│ │ │ └── statuses@2.0.2 deduped
│ │ ├─┬ serve-static@2.2.1
│ │ │ ├── encodeurl@2.0.0 deduped
│ │ │ ├── escape-html@1.0.3 deduped
│ │ │ ├── parseurl@1.3.3 deduped
│ │ │ └── send@1.2.1 deduped
│ │ ├── statuses@2.0.2
│ │ ├─┬ type-is@2.0.1
│ │ │ ├── content-type@1.0.5 deduped
│ │ │ ├── media-typer@1.1.0
│ │ │ └── mime-types@3.0.2 deduped
│ │ └── vary@1.1.2 deduped
│ ├── hono@4.12.0
│ ├── jose@6.1.3
│ ├── json-schema-typed@8.0.2
│ ├── pkce-challenge@5.0.1
│ ├─┬ raw-body@3.0.2
│ │ ├── bytes@3.1.2
│ │ ├── http-errors@2.0.1 deduped
│ │ ├─┬ iconv-lite@0.7.2
│ │ │ └── safer-buffer@2.1.2
│ │ └── unpipe@1.0.0
│ ├─┬ zod-to-json-schema@3.25.1
│ │ └── zod@4.3.6 deduped
│ └── zod@4.3.6
├── UNMET OPTIONAL DEPENDENCY @optave/codegraph-darwin-arm64@2.0.0
├── UNMET OPTIONAL DEPENDENCY @optave/codegraph-darwin-x64@2.0.0
├── UNMET OPTIONAL DEPENDENCY @optave/codegraph-linux-x64-gnu@2.0.0
├── UNMET OPTIONAL DEPENDENCY @optave/codegraph-win32-x64-msvc@2.0.0
├─┬ better-sqlite3@12.6.2
│ ├─┬ bindings@1.5.0
│ │ └── file-uri-to-path@1.0.0
│ └─┬ prebuild-install@7.1.3
│   ├── detect-libc@2.1.2 deduped
│   ├── expand-template@2.0.3
│   ├── github-from-package@0.0.0
│   ├── minimist@1.2.8
│   ├── mkdirp-classic@0.5.3
│   ├── napi-build-utils@2.0.0
│   ├─┬ node-abi@3.87.0
│   │ └── semver@7.7.4 deduped
│   ├─┬ pump@3.0.3
│   │ ├─┬ end-of-stream@1.4.5
│   │ │ └── once@1.4.0 deduped
│   │ └── once@1.4.0 deduped
│   ├─┬ rc@1.2.8
│   │ ├── deep-extend@0.6.0
│   │ ├── ini@1.3.8
│   │ ├── minimist@1.2.8 deduped
│   │ └── strip-json-comments@2.0.1
│   ├─┬ simple-get@4.0.1
│   │ ├─┬ decompress-response@6.0.0
│   │ │ └── mimic-response@3.1.0
│   │ ├── once@1.4.0 deduped
│   │ └── simple-concat@1.0.1
│   ├─┬ tar-fs@2.1.4
│   │ ├── chownr@1.1.4
│   │ ├── mkdirp-classic@0.5.3 deduped
│   │ ├── pump@3.0.3 deduped
│   │ └─┬ tar-stream@2.2.0
│   │   ├─┬ bl@4.1.0
│   │   │ ├─┬ buffer@5.7.1
│   │   │ │ ├── base64-js@1.5.1
│   │   │ │ └── ieee754@1.2.1
│   │   │ ├── inherits@2.0.4 deduped
│   │   │ └── readable-stream@3.6.2 deduped
│   │   ├── end-of-stream@1.4.5 deduped
│   │   ├── fs-constants@1.0.0
│   │   ├── inherits@2.0.4 deduped
│   │   └─┬ readable-stream@3.6.2
│   │     ├── inherits@2.0.4 deduped
│   │     ├─┬ string_decoder@1.3.0
│   │     │ └── safe-buffer@5.2.1 deduped
│   │     └── util-deprecate@1.0.2
│   └─┬ tunnel-agent@0.6.0
│     └── safe-buffer@5.2.1
├── commander@14.0.3
└── web-tree-sitter@0.26.5

```
