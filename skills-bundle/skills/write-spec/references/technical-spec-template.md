# Technical Spec Template

Use this template when generating technical specification documents. Adapt sections based on feature complexity - omit sections that are genuinely not applicable, but err on the side of including them.

---

## Template Structure

```markdown
# {Feature Name} - Technical Specification

**Status:** Draft | In Review | Approved | Superseded
**Author:** {user or team}
**Created:** {date}
**Last Updated:** {date}

---

## 1. Overview

A concise 2-4 sentence summary of what this feature is and why it exists. Must answer:
- What problem does this solve?
- What is the high-level approach?
- What is the expected outcome?

## 2. Goals and Non-Goals

### Goals
- Bulleted list of what this spec aims to achieve
- Each goal should be measurable or verifiable

### Non-Goals
- Explicit list of what this spec does NOT cover
- Prevents scope creep and sets clear boundaries

## 3. Background and Context

Brief context that an agent or engineer would need to understand the problem space:
- Current state of the system (reference specific modules/services found in codebase)
- Why the current state is insufficient
- Any prior art or previous attempts

Include a mermaid diagram of the current state if it involves system interactions:

~~~mermaid
graph TD
    A[Component A] --> B[Component B]
    B --> C[Component C]
~~~

## 4. Architecture

### High-Level Design

Describe the proposed architecture at a system/service level.

MUST include a mermaid diagram showing:
- Components/services involved
- Data flow between them
- External dependencies

~~~mermaid
graph TD
    A[Service A] -->|request| B[New Service]
    B -->|query| C[Database]
    B -->|publish| D[Message Queue]
~~~

### Component Breakdown

For each new or modified component:

#### {Component Name}
- **Responsibility:** What it does (single-sentence)
- **Inputs:** What it receives
- **Outputs:** What it produces
- **Dependencies:** What it depends on
- **Constraints:** Performance, availability, or other requirements

## 5. API Design

For each new or modified API endpoint/interface:

### {Endpoint/Interface Name}
- **Purpose:** What it does
- **Consumer(s):** Who calls it
- **Request contract:** Describe the shape of input (fields, types, constraints, required vs optional)
- **Response contract:** Describe the shape of output (fields, types)
- **Error scenarios:** List each error case with expected behavior
- **Idempotency:** Whether the operation is idempotent and how
- **Rate limits / quotas:** If applicable

If there are multiple endpoints with interactions, include a sequence diagram:

~~~mermaid
sequenceDiagram
    participant Client
    participant Service
    participant Database
    Client->>Service: Request
    Service->>Database: Query
    Database-->>Service: Result
    Service-->>Client: Response
~~~

## 6. Data Model

Describe new or modified data entities.

MUST include an ER diagram for any data model changes:

~~~mermaid
erDiagram
    ENTITY_A ||--o{ ENTITY_B : "has many"
    ENTITY_A {
        string id PK
        string name
        datetime created_at
    }
    ENTITY_B {
        string id PK
        string entity_a_id FK
        string value
    }
~~~

For each entity:
- **Fields:** Name, type, constraints (required, unique, indexed, default)
- **Relationships:** How it relates to other entities
- **Lifecycle:** How records are created, updated, archived/deleted
- **Migration considerations:** If modifying existing data, describe backward compatibility

## 7. Error Handling

### Error Categories
List each category of error the system can encounter:

| Error Category | Trigger Condition | Expected Behavior | Recovery Strategy |
|---|---|---|---|
| {Category} | {When it happens} | {What the system does} | {How it recovers} |

### Failure Modes
Describe what happens when dependencies fail:
- **{Dependency} unavailable:** Behavior, fallback, retry policy
- **Partial failures:** How consistency is maintained

Include a state diagram for complex error/retry flows:

~~~mermaid
stateDiagram-v2
    [*] --> Processing
    Processing --> Success
    Processing --> Failed
    Failed --> Retrying
    Retrying --> Processing
    Retrying --> DeadLetter
~~~

## 8. Security Considerations

- **Authentication:** How callers are authenticated
- **Authorization:** What permissions are required, how they are enforced
- **Data sensitivity:** What sensitive data is handled, how it is protected (at rest, in transit)
- **Input validation:** What inputs are validated and how
- **Audit logging:** What actions are logged for audit purposes
- **Threat model:** Key threats considered and mitigations

## 9. Testing Strategy

### Test Categories

| Category | What is Tested | Scope |
|---|---|---|
| Unit | Individual component logic | Isolated, mocked dependencies |
| Integration | Component interactions | Real dependencies, controlled environment |
| E2E | Full user/caller workflow | Production-like environment |

### Key Test Scenarios
- List the critical scenarios that MUST be tested
- Include both happy paths and edge cases
- Each scenario should map to a goal or requirement from Section 2

### Performance / Load Testing
- Expected throughput
- Latency requirements (p50, p95, p99)
- Load testing approach

## 10. Rollout Plan

### Phases

Describe the rollout strategy (feature flags, canary, blue-green, phased percentage, etc.):

~~~mermaid
graph LR
    A[Phase 1: Internal] --> B[Phase 2: Canary 5%]
    B --> C[Phase 3: 50%]
    C --> D[Phase 4: GA 100%]
~~~

For each phase:
- **Scope:** What percentage/segment of users or traffic
- **Duration:** How long before progressing
- **Success criteria:** Metrics that must be met to proceed
- **Rollback trigger:** Conditions that trigger a rollback

### Monitoring and Observability
- Key metrics to track
- Alerts to set up
- Dashboard requirements
- Log entries that should be emitted

### Rollback Plan
- Steps to rollback
- Data implications of rollback
- Expected time to rollback

## 11. Dependencies and Risks

### Dependencies
| Dependency | Type | Owner | Risk if Delayed |
|---|---|---|---|
| {Dependency} | {Blocking/Non-blocking} | {Team/Person} | {Impact} |

### Risks
| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| {Risk} | {Low/Med/High} | {Low/Med/High} | {Strategy} |

## 12. Open Questions

Items that remain unresolved and need future discussion:

| # | Question | Context | Proposed Default | Owner |
|---|---|---|---|---|
| 1 | {Question} | {Why it matters} | {Suggested answer if any} | {Who decides} |

## 13. References

- Links to related specs, design docs, ADRs, external documentation
- Links to relevant code modules (as relative paths from repo root)
```

---

## Section Applicability Guide

Not every spec needs every section. Use this guide:

| Section | Always Include | Include If Applicable |
|---|---|---|
| Overview | Yes | - |
| Goals / Non-Goals | Yes | - |
| Background | Yes | - |
| Architecture | Yes | - |
| API Design | - | New/modified APIs exist |
| Data Model | - | New/modified data entities exist |
| Error Handling | Yes | - |
| Security | Yes | - |
| Testing Strategy | Yes | - |
| Rollout Plan | - | Feature needs phased release |
| Dependencies & Risks | Yes | - |
| Open Questions | Yes | - |
| References | Yes | - |

## Diagram Requirements

Every technical spec MUST include at minimum:
1. **Architecture diagram** (system/component level) in Section 4
2. **Data model diagram** (ER diagram) if Section 6 applies

Additionally, USE mermaid diagrams in any section where:
- There is a flow with 3+ steps
- There are state transitions
- There are interactions between 3+ components
- A textual description would exceed 10 lines and a diagram would be clearer
