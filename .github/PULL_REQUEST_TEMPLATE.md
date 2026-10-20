<!-- Write the pull request title and entire description in English. Do not include internal repository links, internal pull request references, or other non-public information. -->

## Problem and behavior

Describe the trigger, resulting behavior and compatibility impact.

## Validation

List checks actually run and their results, including omissions and reasons. For concurrency changes, cover waits, cancellation, failure and cleanup.

## Documentation

Link updated Chinese and English contracts, examples or guides, or explain why documentation is unaffected.

## UI design evidence

For user-visible GUI changes, follow the [design delivery criteria](../clients/gui/design-system/governance.md#完成条件). Include:

- User intent, interaction families and applicable rules.
- Reused production components and their owners.
- Exceptions with scope, rationale and evidence, or explicitly none.
- States and theme/font/window conditions actually checked; skipped checks and reasons.
- Reviewable evidence references and remaining gaps; distinguish preview, source Electron and package validation.

Reuse the existing page contract or report where applicable. For changes without GUI impact, state not applicable. Passing static checks does not constitute visual approval.

## Generalization evidence

For agent behavior changes, describe the problem class, causal evidence, shared repair boundary and valid counterexamples. Disclose changes to prompts, tools, defaults, budgets, adapters or continuation; exclude task identity and hidden grading information from product decisions.

Distinguish contract checks, development comparisons and unseen source-separated confirmation. Report regressions and missing evidence, and state whether default promotion is supported. Correctness fixes may rely on invariants and focused regressions without claiming task-level gains. For changes without agent behavior effects, briefly explain why this section does not apply.

For policy comparisons, link the preregistered plan and report suites, independent source groups, domains, distinct tasks, repetitions per arm, uncertainty intervals and stopping rules. Meet the [evaluation workload floors](../docs/benchmarks/methodology.en.md#repetitions-coverage-and-evidence-size); exploratory or incomplete coverage cannot promote a default. State planned versus completed attempts and the limits of any superiority claim.
