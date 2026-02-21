# Engine Versioning & User Experience

## Architecture

```
Metaglass App
├── EngineManager (orchestrates engines)
├── Engines/
│   ├── MinimalEngine    (bundled, default)
│   ├── MetaglassEngine  (uses @metaglass/aios)
│   └── [Future engines] (plugins or packages)
```

## User Experience

### Selecting an Engine

Users choose engines via **Settings > Assistant > Engine**:

| Engine | Description | Use Case |
|--------|-------------|----------|
| Minimal | Fast, simple responses | Quick Q&A, basic tasks |
| Metaglass (AIOS) | Full agent capabilities | Complex multi-step tasks |

### What Users See

```
┌─────────────────────────────────────┐
│ Assistant Engine                    │
├─────────────────────────────────────┤
│ ○ Minimal Engine (Recommended)      │
│   Fast responses, basic tools       │
│                                     │
│ ● Metaglass Engine                  │
│   Full agent with planning, memory  │
│   Version: 1.2.0                    │
└─────────────────────────────────────┘
```

## Distribution Models

### 1. Bundled Engines (Current)

Engines ship with Metaglass. Updates come with app updates.

```
metaglass@1.5.0
└── @metaglass/aios@1.2.0 (bundled)
```

**User action:** Update Metaglass app → gets new engine version

### 2. Independent Engine Updates (Future)

Engines as separate packages, updated independently.

```json
// User's engine preferences (stored in app)
{
  "activeEngine": "metaglass",
  "engines": {
    "metaglass": { "version": "1.2.0", "autoUpdate": true }
  }
}
```

**User action:** Check for engine updates in Settings

### 3. Plugin Engines (Future)

Third-party engines installable from marketplace.

```
┌─────────────────────────────────────┐
│ Engine Marketplace                  │
├─────────────────────────────────────┤
│ 🔥 Research Assistant Engine        │
│    Optimized for academic research  │
│    ★★★★☆ (42 reviews)               │
│    [Install]                        │
└─────────────────────────────────────┘
```

## Version Management

### Compatibility Matrix

| Metaglass | Min AIOS | Max AIOS |
|-----------|----------|----------|
| 1.0.x     | 1.0.0    | 1.x.x    |
| 1.1.x     | 1.1.0    | 1.x.x    |
| 2.0.x     | 2.0.0    | 2.x.x    |

### Upgrade Flow

```
1. User opens Settings
2. Sees "Engine update available: 1.2.0 → 1.3.0"
3. Views changelog (new features, fixes)
4. Clicks "Update"
5. Engine hot-reloads (no app restart needed)
```

### Rollback

If issues occur:
```
Settings > Engine > Version History > Rollback to 1.2.0
```

## Technical Implementation

### Engine Interface

All engines implement the same interface:

```typescript
interface Engine {
  id: string;
  name: string;
  version: string;

  run(params: EngineRunParams): Promise<EngineResult>;
  stop(): void;
  getCapabilities(): EngineCapabilities;
}
```

### Hot-Swapping

```typescript
// User switches engine in settings
engineManager.setActiveEngine('metaglass');

// Next conversation uses new engine
// No restart required
```

### Feature Detection

```typescript
const caps = engine.getCapabilities();

if (caps.supportsPlanning) {
  showPlanningUI();
}
if (caps.supportsMemory) {
  showMemoryPanel();
}
```

## Summary

| Phase | Distribution | User Action |
|-------|--------------|-------------|
| Now | Bundled with app | Update app |
| Next | Check for updates | Click "Update Engine" |
| Future | Marketplace | Browse & install |
