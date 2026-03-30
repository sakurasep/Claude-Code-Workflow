---
title: Architecture Constraints
readMode: optional
priority: medium
category: general
scope: project
dimension: specs
keywords: [architecture, constraint, schema, compatibility, portability, design, arch]
---

# Architecture Constraints

## Schema Evolution

- [compatibility] When enhancing existing schemas, use optional fields and additionalProperties rather than creating new schemas. Avoid breaking changes.
- [portability] Use relative paths for cross-artifact navigation to ensure portability across different environments and installations.

## Skill Design

- [decision:skills] All skills must follow Completion Status Protocol (DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT) defined in SKILL-DESIGN-SPEC.md sections 13-14. New skills created via skill-generator auto-include the protocol reference. (2026-03-29)
- [decision:hooks] Hook safety guardrails use TypeScript HookTemplate pattern (not standalone bash scripts) for integration with CCW hook endpoint system. Templates: careful-destructive-guard, freeze-edit-boundary. (2026-03-29)
