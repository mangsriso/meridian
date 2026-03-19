# Changelog

## [1.1.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.2...v1.1.0) (2026-03-19)


### Features

* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/opencode-claude-max-proxy/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))


### Bug Fixes

* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/opencode-claude-max-proxy/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/opencode-claude-max-proxy/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/opencode-claude-max-proxy/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/opencode-claude-max-proxy/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))

## [1.0.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.1...v1.0.2) (2026-01-26)


### Bug Fixes

* remove bun install from publish job ([966b2ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd36411193af22e779638232427dd8c49f8926e0))

## [1.0.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.0...v1.0.1) (2026-01-26)


### Bug Fixes

* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/opencode-claude-max-proxy/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))

## 1.0.0 (2026-01-26)


### Features

* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/opencode-claude-max-proxy/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))


### Bug Fixes

* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/opencode-claude-max-proxy/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/opencode-claude-max-proxy/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/opencode-claude-max-proxy/issues/1)
