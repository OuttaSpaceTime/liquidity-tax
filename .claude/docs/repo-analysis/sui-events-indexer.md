# sui-events-indexer

**Location:** ~/Code/Misc/defi-tracker/onchain/sui-events-indexer
**Language:** TypeScript
**License:** MIT (per package.json; no LICENSE file)
**Maintenance:** Last commit 2025-01-29 ("Naming conventions #3"). Small project, 3 PRs total. Low but functional.

## Purpose
A CLI tool that generates a complete event indexing solution for any Sui Move package. Given a package ID, it:
1. Fetches the package's disassembled bytecode via Sui RPC
2. Finds all `event::emit<T>` calls in the bytecode
3. Resolves the event struct definitions (including cross-package dependencies)
4. Generates TypeScript interfaces (DTOs) for each event type
5. Generates a Prisma schema for database persistence
6. Scaffolds a complete indexing project with event handlers, Express API, and cursor-based polling

npm package: `sui-events-indexer` (v1.0.1, installable globally).

## Architecture
```
src/
  index.ts                        # CLI entry (Commander), orchestrates generation
  services/
    suiClient.ts                  # Sui RPC wrapper (getNormalizedMoveModulesByPackage, getPackageBytecode)
    eventExtractor.ts             # Finds event::emit<T> in bytecode, resolves struct dependencies
    dtoGenerator.ts               # Converts Move structs to TypeScript interfaces
    projectGenerator.ts           # Scaffolds full indexer project (handlers, indexer, API, docker)
  utils/
    typeMapper.ts                 # Move type -> TypeScript type mapping
    prismaSchemaGenerator.ts      # Generates Prisma schema from TypeScript DTOs
    naming.ts                     # snake_case -> camelCase utilities
    fileSystem.ts                 # File I/O helpers

Generated project structure:
  types/          # TypeScript interfaces for each event
  handlers/       # Per-module event handlers with Prisma persistence
  indexer/        # Event polling loop with cursor management
  prisma/         # Schema and migrations
  server.ts       # Express REST API for querying indexed events
  config.ts       # Package ID, network, polling interval
```

## Concrete value for our decoder

**The most directly useful tool for Sui.** The pipeline it implements -- package ID to bytecode disassembly to event type extraction to TypeScript DTOs -- is exactly the right approach for bootstrapping our protocol handlers.

Concrete wins:
- **Run it against Turbos, Navi, and Suilend package IDs** to auto-generate TypeScript type definitions for all their events. This saves significant manual work reverse-engineering event schemas.
- **Event extraction from bytecode** (`eventExtractor.ts`): The regex `event::emit<([\w_]+)>` on disassembled bytecode is the canonical way to discover which events a Sui package emits. No need to read Move source.
- **Cross-package dependency resolution**: When an event struct references types from other packages, it follows `use` statements and resolves them. Essential for complex protocols.
- **Prisma schema generation**: Auto-generates database tables matching event structures. Our SQLite schema could start from this.
- **Cursor-based event polling pattern** (in generated code): Shows the `queryEvents` -> `nextCursor` -> `saveLatestCursor` pattern for reliable event consumption.

Limitations:
- **Forward-looking only.** The generated indexer polls for new events, not historical backfill. For tax decoding we need to walk historical events from a wallet's first transaction.
- **No semantic interpretation.** Generated handlers are stubs (`// TODO: handle EventType`). The hard part -- mapping events to tax-relevant actions -- is still on us.
- **Type mapping is basic.** Complex Move types (generics, nested structs with type parameters) may not map correctly.

**Can import as npm dep:** The generated output is more useful than the tool itself for our purposes. Run it once per protocol to bootstrap type definitions.

## Integration sketch
Install globally (`npm i -g sui-events-indexer`), then run `sui-events-indexer generate -p <PACKAGE_ID> --name <protocol> --network mainnet` for each target protocol. Harvest the generated `types/` directory for event type definitions. Adapt the generated Prisma schema as a starting point for our SQLite schema. Extract the event polling pattern from `indexer/event-indexer.ts` but replace it with historical cursor walking (start from genesis or first relevant tx). Replace the stub handlers with our semantic tax-action mappers.

## Gaps
- No historical backfill -- only forward polling
- Stub handlers -- semantic interpretation is entirely on us
- No wallet-scoped querying (it indexes ALL events for a package, not per-wallet)
- No support for filtering by obligation/position ID
- Generated code uses PostgreSQL/Prisma -- we'd adapt to SQLite
- May fail on very complex generic types in event structs

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 3/5 | Generated types and schema are directly usable; polling pattern is extractable |
| Architectural inspiration | 5/5 | Bytecode -> event extraction -> DTO generation is exactly our bootstrap path |
| Domain fit | 4/5 | Built for Sui event indexing, which is the core of our decoder |
| Maintenance health | 2/5 | Small project, 3 commits, but functional and correct |
| **Overall** | **4/5** | **Best tool in this batch. Run it to bootstrap type defs for all three protocols.** |

## Top 3-5 files to read
- `/home/felix/Code/Misc/defi-tracker/onchain/sui-events-indexer/src/services/eventExtractor.ts` -- Core: bytecode parsing, event type extraction, dependency resolution
- `/home/felix/Code/Misc/defi-tracker/onchain/sui-events-indexer/src/services/dtoGenerator.ts` -- Move struct to TypeScript interface generation
- `/home/felix/Code/Misc/defi-tracker/onchain/sui-events-indexer/src/index.ts` -- CLI orchestration, shows the full generation pipeline
- `/home/felix/Code/Misc/defi-tracker/onchain/sui-events-indexer/src/services/projectGenerator.ts` -- Generated indexer code (event polling pattern, cursor management)
- `/home/felix/Code/Misc/defi-tracker/onchain/sui-events-indexer/src/utils/prismaSchemaGenerator.ts` -- Prisma schema from event types
