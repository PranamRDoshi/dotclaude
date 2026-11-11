---
name: write-spec
description: Write technical and non-technical spec documents for features and requirements. Use when user says "write a spec", "create a spec", "spec this feature", "write spec", "technical spec", "requirement spec", "feature spec", "design doc", or "/write-spec". Generates markdown spec files with mermaid diagrams, grounded in the codebase but language/tech-stack agnostic. Target audience is AI agents who will use specs for implementation planning.
---

# Write Spec

Generate structured, high-quality technical and non-technical specification documents for features and requirements.

## Core Principles

1. **Never assume.** Read the codebase to understand existing architecture. Clarify ALL critical decisions, confusions, and contradictions with the user BEFORE writing the spec. Do not proceed with ambiguity.
2. **Mermaid over prose.** Use mermaid diagrams (flowcharts, sequence diagrams, ER diagrams, C4, state diagrams) wherever a visual would replace or significantly shorten a textual explanation. Every major section that describes flow, architecture, data relationships, or state transitions should have a diagram.
3. **Agnostic but grounded.** The spec must be grounded in the codebase context (existing patterns, boundaries, constraints) but must NOT contain implementation code snippets, be tied to a specific language/framework, or depend on current implementation details. Describe WHAT and WHY, not HOW in code.
4. **Agent-readable.** The primary consumers are AI agents building implementation plans. Be precise, unambiguous, and structured. Avoid vague language. Every requirement should be concrete enough for an agent to act on without further clarification.

## Workflow

### Phase 1: Understand the Request

1. Read the user's initial prompt carefully. The user will specify their preferred workflow style (e.g., ask questions first, generate draft immediately, guided step-by-step, etc.). **Follow whatever workflow the user requests.**
2. If the user does not specify a workflow, default to: ask clarifying questions first, then generate.

### Phase 2: Gather Context

1. **Read the codebase.** Use Glob, Grep, and Read tools to understand:
   - Project structure and organization patterns
   - Existing architecture (services, modules, layers)
   - Relevant existing implementations that the feature touches
   - Data models and storage patterns
   - API patterns and conventions
   - Testing patterns
2. **Identify unknowns.** List anything that is unclear, contradictory, or requires a decision from the user.
3. **Clarify with the user.** Present ALL unknowns, critical decisions, and contradictions to the user in a single organized batch. Group them by category (scope, architecture, data, behavior, edge cases). Do NOT proceed to writing until all critical items are resolved.
   - For non-critical items, propose a reasonable default and ask the user to confirm or override.

### Phase 3: Determine Spec Structure

Evaluate the complexity of the feature:

- **Simple/small feature:** Single spec file (e.g., `feature-name-spec.md`)
- **Large/complex feature:** Create a dedicated folder under the specs directory with:
  - A main spec file that serves as the entry point with links to sub-specs
  - Individual sub-spec files for each major component/concern
  - Name the folder descriptively (e.g., `payment-gateway-redesign/`)

### Phase 4: Determine Output Location

Search for an existing specs directory in the working directory:

```
Look for (in this priority order):
1. specs/
2. docs/
3. documentation/
```

- If found, write specs under the first match.
- If none found, create a `specs/` folder in the working directory root.

### Phase 5: Determine Document Type

Ask the user (if not already specified) which document type(s) to generate:

- **Technical spec** - for engineering teams and implementation agents
- **Non-technical spec** - for product, stakeholder, and planning context
- **Both** - generate both as separate files

### Phase 6: Write the Spec

Consult the templates in `references/` for the appropriate document type:

- For technical specs: see `references/technical-spec-template.md`
- For non-technical specs: see `references/non-technical-spec-template.md`
- For detailed rules on writing style and conventions: see `references/guidelines.md`

**Key rules while writing:**

1. Every architecture, flow, data relationship, or state transition section MUST include a mermaid diagram.
2. No code snippets. Describe behavior, contracts, and constraints in plain language and diagrams.
3. Use precise, unambiguous language. Define terms on first use if they are domain-specific.
4. Cross-reference related sections using markdown links.
5. For multi-file specs, the main file must have a clear table of contents linking to all sub-specs.
6. Each requirement/acceptance criterion should be testable and verifiable by an agent.

### Phase 7: Review and Iterate

After generating the spec:

1. Present a summary of what was written and where files were placed.
2. Ask the user if they want to review, revise, or expand any section.
3. Iterate until the user is satisfied.

## File Naming Conventions

- Use kebab-case for all file and folder names
- Technical specs: `{feature-name}-technical-spec.md`
- Non-technical specs: `{feature-name}-product-spec.md`
- Multi-file main spec: `README.md` (inside the feature folder)
- Sub-specs: `{concern-name}.md` (e.g., `data-model.md`, `api-design.md`, `security.md`)

## Examples

### Example 1: Simple feature

User says: "Write a spec for adding rate limiting to our API gateway"

1. Read codebase to understand current API gateway setup
2. Clarify: per-user vs global limits? response codes? header conventions?
3. Write single file: `specs/api-rate-limiting-technical-spec.md`

### Example 2: Complex feature

User says: "Write a spec for migrating our monolith auth system to a standalone microservice"

1. Read codebase extensively (auth module, all consumers, data models, session handling)
2. Clarify many decisions (migration strategy, backward compat, timeline phases)
3. Create folder structure:
   ```
   specs/auth-service-migration/
   ├── README.md                    # Main spec with overview + links
   ├── architecture.md              # Service architecture + boundaries
   ├── data-migration.md            # Data model changes + migration plan
   ├── api-contracts.md             # API design + consumer migration
   ├── security.md                  # Auth flows, token handling, encryption
   ├── rollout-plan.md              # Phased rollout strategy
   └── open-questions.md            # Unresolved items for future discussion
   ```
