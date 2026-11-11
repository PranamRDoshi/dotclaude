# Spec Writing Guidelines

Detailed rules and conventions for writing spec documents with this skill.

---

## 1. The No-Assumption Rule

This is the most critical rule. Violations lead to specs that mislead agents into wrong implementations.

### What counts as an assumption:
- Deciding on a specific approach when multiple valid options exist
- Inferring user intent without evidence from the codebase or explicit confirmation
- Choosing scope boundaries without user input
- Picking one design over another without discussing trade-offs

### What to do instead:
1. **Read the code first.** Use Glob, Grep, and Read to find existing patterns, conventions, and constraints before asking the user anything.
2. **Batch your questions.** Collect all unknowns and present them together, organized by category:
   - **Scope:** What's in, what's out
   - **Architecture:** Design choices, component boundaries
   - **Data:** Models, storage, migrations
   - **Behavior:** Edge cases, error handling, fallbacks
   - **Constraints:** Performance, security, compliance
3. **Flag contradictions explicitly.** If the user's request contradicts existing codebase patterns or earlier statements, call it out clearly and ask which direction to take.
4. **Propose defaults for minor decisions.** Not everything needs a question. For minor choices, propose a sensible default and let the user override if needed. Example: "I'll use kebab-case for the folder name unless you prefer otherwise."

### Examples:

**Bad:** "The service will use PostgreSQL for storage."
(Why? Maybe the codebase uses MongoDB. Maybe the user hasn't decided.)

**Good:** "Storage solution: TBD - see Open Questions #3. The existing codebase uses PostgreSQL for service X and MongoDB for service Y. Recommend discussing which is appropriate for this use case."

**Bad:** "Authentication will use JWT tokens."
(Maybe the codebase uses sessions. Maybe the user wants API keys.)

**Good:** "Authentication mechanism must be determined. Current system uses session-based auth (see `src/middleware/auth.js`). Options to discuss: extend existing session system, introduce JWT, or use API keys."

---

## 2. Output Location Rules

### Detection logic (in order):
1. Check if `specs/` exists in working directory root
2. Check if `docs/` exists in working directory root
3. Check if `documentation/` exists in working directory root
4. If none found, create `specs/` in working directory root

### Placement rules:
- **Simple feature (single file):** Place directly in the detected/created folder
- **Complex feature (multi-file):** Create a sub-folder inside the detected/created folder
  - The sub-folder name should be descriptive and kebab-cased
  - The main entry file inside the sub-folder must be `README.md`

### What makes a feature "complex" (multi-file)?
A feature should use multi-file structure when ANY of:
- It spans 3+ distinct system components or services
- It requires both a technical and non-technical spec
- Any single spec file would exceed ~500 lines
- It involves a migration or phased rollout with distinct phases
- The user explicitly asks for a structured breakdown

---

## 3. Mermaid Diagram Guidelines

### When to use diagrams:
- **Always:** Architecture overview, data model relationships, rollout phases
- **When it replaces 10+ lines of text:** Flows, sequences, state transitions
- **When showing relationships:** Between components, services, entities, or teams
- **For decision trees:** Complex conditional logic or branching paths

### Preferred diagram types by context:

| Context | Diagram Type | Mermaid Syntax |
|---|---|---|
| System/component architecture | Flowchart or C4 | `graph TD` or `C4Context` |
| Request/response flows | Sequence diagram | `sequenceDiagram` |
| Data models | ER diagram | `erDiagram` |
| State machines / lifecycle | State diagram | `stateDiagram-v2` |
| User journeys | Journey | `journey` |
| Timelines / schedules | Gantt | `gantt` |
| Process flows | Flowchart | `graph TD` or `graph LR` |
| Risk matrices | Quadrant chart | `quadrantChart` |
| Feature prioritization | Quadrant chart | `quadrantChart` |

### Diagram quality rules:
1. Every node must have a meaningful label (no "A", "B", "C" without context)
2. Edge labels should describe the relationship or data flowing between nodes
3. Keep diagrams focused - split into multiple diagrams rather than one cluttered one
4. Use subgraphs to group related components
5. Direction should follow reading order (top-to-bottom for hierarchies, left-to-right for flows)

---

## 4. Language and Code Agnosticism

### Rules:
1. **No code snippets.** Never include implementation code (no functions, classes, SQL, config files, etc.)
2. **No language-specific terms as requirements.** Say "a persistent background process" not "a daemon written in Go". Say "a mapping of key to value" not "a Python dictionary".
3. **Describe contracts, not implementations.** Say "accepts a JSON payload with fields X, Y, Z" not "use Express.js body parser to parse..."
4. **Reference codebase patterns without coupling to them.** Say "follows the existing repository pattern seen in `src/repos/`" not "extend the BaseRepository class".

### What IS allowed:
- Referencing file paths and module names in the existing codebase for context
- Describing data types generically (string, integer, boolean, timestamp, etc.)
- Mentioning protocol-level details (HTTP, gRPC, WebSocket, etc.)
- Naming patterns (repository pattern, event sourcing, CQRS, etc.) without prescribing language-specific implementations

---

## 5. Agent-Readability Standards

Since the primary consumers are AI agents building implementation plans:

### Structure requirements:
1. **Use headers liberally.** Every distinct topic gets its own header (H2 or H3).
2. **Use tables for structured data.** When listing 3+ items with shared attributes, use a table.
3. **Use checklists for acceptance criteria.** Always `- [ ]` format.
4. **Number requirements.** When a section has requirements that might be referenced, number them.
5. **Use bold for key terms.** Bold the first occurrence of important domain terms.

### Precision requirements:
1. **Quantify when possible.** "Low latency" is vague. "p99 latency under 200ms" is precise.
2. **Define enums explicitly.** If a field can be one of several values, list all values.
3. **Specify boundaries.** "Supports many users" is vague. "Must support up to 10,000 concurrent users" is precise.
4. **Describe error behavior explicitly.** For every operation, what happens on failure must be stated.

### Avoid:
- Subjective adjectives: "intuitive", "user-friendly", "robust", "scalable" (without quantification)
- Passive voice that hides the actor: "the data is processed" (by what?)
- Ambiguous pronouns: "it should handle this" (what is "it"? what is "this"?)
- Weasel words: "should generally", "in most cases", "typically" (be definitive)

---

## 6. Cross-Referencing and Linking

### Within a single file:
- Use markdown anchor links: `[see Error Handling](#8-error-handling)`
- Reference section numbers: "As described in Section 4..."

### Within a multi-file spec:
- Use relative markdown links: `[see Data Model](./data-model.md)`
- The main README.md must link to every sub-file
- Sub-files should link back to README.md and to related sub-files

### To the codebase:
- Reference paths relative to repo root: "see `src/services/auth/`"
- Reference specific files when relevant: "the current implementation in `src/middleware/rateLimit.ts`"
- Do NOT link to specific line numbers (they change)

---

## 7. Multi-File Spec Structure Rules

When creating a multi-file spec:

### The README.md (main file) must contain:
1. Feature name and status header
2. A 1-paragraph executive summary
3. A table of contents linking to all sub-files with brief descriptions
4. A high-level architecture diagram showing how the sub-spec topics relate
5. A consolidated Open Questions section (or link to a dedicated one)

### Sub-file rules:
1. Each sub-file is self-contained enough to be useful alone
2. Each sub-file starts with a 1-2 sentence summary of what it covers
3. Each sub-file links back to the README.md at the top
4. Sub-files cross-reference each other where dependencies exist

### Recommended sub-file breakdown for complex features:

| Sub-file | Covers |
|---|---|
| `architecture.md` | System design, component boundaries, diagrams |
| `data-model.md` | Entities, relationships, ER diagrams, migrations |
| `api-contracts.md` | Endpoint specs, request/response shapes, errors |
| `security.md` | Auth, authz, encryption, audit, threat model |
| `rollout-plan.md` | Phases, feature flags, monitoring, rollback |
| `testing-strategy.md` | Test plan, scenarios, performance requirements |
| `open-questions.md` | Unresolved decisions and discussion items |

Only create sub-files that are relevant. A feature that doesn't involve API changes doesn't need `api-contracts.md`.
