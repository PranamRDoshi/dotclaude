# Non-Technical (Product) Spec Template

Use this template when generating non-technical / product specification documents. This document targets product owners, stakeholders, and AI agents that need to understand the WHAT and WHY without implementation details.

---

## Template Structure

```markdown
# {Feature Name} - Product Specification

**Status:** Draft | In Review | Approved | Superseded
**Author:** {user or team}
**Created:** {date}
**Last Updated:** {date}

---

## 1. Problem Statement

Clearly articulate the problem being solved:
- **Who** is affected?
- **What** is the current pain point or gap?
- **Why** does it matter now?
- **What happens** if we don't solve this?

Keep this to 3-6 sentences. Be specific, not generic.

## 2. Proposed Solution

A concise description of what we are building, written in plain language:
- What the feature does from the user/system perspective
- How it fits into the broader product/platform

Include a high-level flow diagram showing the user/system journey:

~~~mermaid
graph TD
    A[Trigger/Entry Point] --> B[Step 1]
    B --> C{Decision Point}
    C -->|Path A| D[Outcome A]
    C -->|Path B| E[Outcome B]
~~~

## 3. User Stories

Structured user stories in standard format:

### Story 1: {Title}
**As a** {role/persona},
**I want to** {action/capability},
**So that** {benefit/outcome}.

**Acceptance Criteria:**
- [ ] {Criterion 1 - specific, testable}
- [ ] {Criterion 2}
- [ ] {Criterion 3}

### Story 2: {Title}
(Repeat for each distinct user story)

---

**Story Map (if 4+ stories):**

~~~mermaid
graph LR
    subgraph "Epic: {Feature Name}"
        subgraph "Must Have"
            S1[Story 1]
            S2[Story 2]
        end
        subgraph "Should Have"
            S3[Story 3]
        end
        subgraph "Nice to Have"
            S4[Story 4]
        end
    end
~~~

## 4. Success Metrics

How we measure whether this feature is successful:

| Metric | Current Baseline | Target | Measurement Method |
|---|---|---|---|
| {Metric name} | {Current value or "N/A"} | {Target value} | {How it's measured} |

### Leading Indicators
- Metrics observable shortly after launch that signal directional success

### Lagging Indicators
- Metrics that confirm long-term success over weeks/months

## 5. Scope

### In Scope
- Bulleted list of what IS included in this effort
- Be specific enough that an agent can verify inclusion

### Out of Scope
- Bulleted list of what is explicitly NOT included
- Note if any out-of-scope items are planned for future iterations

### Assumptions
- List any assumptions being made about the environment, users, or dependencies
- Each assumption should be something that, if false, would change the spec

## 6. User Journey

Describe the end-to-end experience:

~~~mermaid
journey
    title {Feature} User Journey
    section Discovery
      User encounters trigger: 3: User
    section Engagement
      User takes action: 4: User, System
    section Completion
      User sees outcome: 5: User
~~~

For each step in the journey:
- **Step:** What happens
- **Actor:** Who/what performs it
- **Input:** What information or action is needed
- **Output:** What the user sees or what changes
- **Edge cases:** Unusual situations at this step

## 7. Acceptance Criteria (Feature-Level)

Top-level acceptance criteria that apply to the feature as a whole (beyond individual stories):

- [ ] {Criterion 1}
- [ ] {Criterion 2}
- [ ] {Criterion 3}

Each criterion must be:
- **Specific:** No ambiguity in what "done" means
- **Testable:** An agent or QA can verify it with a clear yes/no
- **Independent:** Does not depend on subjective judgment

## 8. Timeline and Milestones

~~~mermaid
gantt
    title {Feature Name} Timeline
    dateFormat YYYY-MM-DD
    section Phase 1
    Milestone 1    :m1, 2024-01-01, 14d
    section Phase 2
    Milestone 2    :m2, after m1, 14d
~~~

| Milestone | Description | Target Date | Dependencies |
|---|---|---|---|
| {Milestone} | {What's delivered} | {Date or "TBD"} | {What it depends on} |

Note: If dates are unknown, describe phases in relative terms (e.g., "Phase 2 starts after Phase 1 sign-off").

## 9. Dependencies

| Dependency | Description | Type | Owner | Status |
|---|---|---|---|---|
| {Name} | {What it is} | {Blocking / Non-blocking} | {Team} | {Ready / Pending / At Risk} |

## 10. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| {Risk description} | {Low/Med/High} | {Low/Med/High} | {How we reduce the risk} |

Include a risk matrix diagram if there are 5+ risks:

~~~mermaid
quadrantChart
    title Risk Assessment
    x-axis Low Likelihood --> High Likelihood
    y-axis Low Impact --> High Impact
    quadrant-1 Monitor
    quadrant-2 Mitigate Urgently
    quadrant-3 Accept
    quadrant-4 Plan Mitigation
~~~

## 11. Open Questions

| # | Question | Context | Proposed Answer | Decision Owner |
|---|---|---|---|---|
| 1 | {Question} | {Why it matters} | {Suggestion if any} | {Who decides} |

## 12. References

- Related product specs or PRDs
- Market research or competitive analysis links
- Design mockups or prototypes
- Related technical specs (link to companion tech spec if one exists)
```

---

## Section Applicability Guide

| Section | Always Include | Include If Applicable |
|---|---|---|
| Problem Statement | Yes | - |
| Proposed Solution | Yes | - |
| User Stories | Yes | - |
| Success Metrics | Yes | - |
| Scope | Yes | - |
| User Journey | - | User-facing features |
| Acceptance Criteria | Yes | - |
| Timeline | - | Dates/phases are known or estimated |
| Dependencies | Yes | - |
| Risks | Yes | - |
| Open Questions | Yes | - |
| References | Yes | - |

## Diagram Requirements

Every product spec MUST include at minimum:
1. **Solution flow diagram** in Section 2
2. **User journey diagram** in Section 6 (if user-facing)

Use mermaid diagrams liberally whenever they replace or shorten text by more than 5 lines.
