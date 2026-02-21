# @metaglass/aios Distribution Guide

## Package Overview

```
@metaglass/aios
├── dist/
│   ├── index.js      # CommonJS build
│   ├── index.mjs     # ESM build
│   └── index.d.ts    # TypeScript declarations
└── src/              # Source (not distributed)
```

## Build

```bash
npm run build    # Builds CJS + ESM + types via tsup
npm test         # Runs 451 tests via Vitest
```

Output: ~158KB bundled, tree-shakeable ESM.

## Installation

### Development (npm link)

```bash
# In metaglass-aios/
npm link

# In consuming project/
npm link @metaglass/aios
```

### Production (npm registry)

```bash
# Publish to npm (when ready)
npm publish --access public

# In consuming project
npm install @metaglass/aios
```

## Integration

### 1. Import Types & Classes

```typescript
import {
  ConversationEngine,
  TodoManager,
  AIOSService,
  createAIOSService,
  setProviders,
  setBackend,
  setFilesystem,
} from '@metaglass/aios';
```

### 2. Configure Platform Adapters

The package uses dependency injection for platform-specific functionality:

```typescript
// Backend (Tauri invoke abstraction)
setBackend({
  invoke: async (cmd, args) => invoke(cmd, args),
});

// Filesystem (Tauri fs abstraction)
setFilesystem({
  writeTextFile,
  readTextFile,
  mkdir,
  exists,
});

// Providers (LLM, tools, UI)
setProviders({
  createLLMProvider: () => new MyLLMProvider(),
  createToolProvider: () => new MyToolProvider(),
  getUserInterface: () => myUserInterface,
  getEventEmitter: () => myEventEmitter,
});
```

### 3. Use the Service

```typescript
const service = createAIOSService({ maxTurns: 50 });
const result = await service.execute('Create a new note');
```

## Platform Support

| Platform | Backend | Filesystem |
|----------|---------|------------|
| Tauri    | `@tauri-apps/api/core` | `@tauri-apps/plugin-fs` |
| Node.js  | Custom implementation | `fs/promises` |
| Browser  | Stub (no-op) | Memory filesystem |

## Versioning

- Follows semver
- Breaking changes = major version bump
- Metaglass pins to specific version in package.json
