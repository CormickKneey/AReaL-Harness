[中文](README.md) | **English**

# @areal/ui

Foundations, React components and component contracts for the AReaL GUI. A private workspace package, not published to npm. Consumers declare `"@areal/ui": "workspace:*"` and build this package first (GUI scripts already chain it).

## Usage

For an ordinary page, read this page, the [Token entry](token-reference.md), and the contracts beside the selected components. Select existing components for the user action, then bind host-owned values and permitted actions. Start settings groups with SettingsSection, SettingsGroupCard, and SettingsRow; approval cards with DecisionCard; local feedback with FeedbackNotice. A contract's related links are optional references.

```tsx
import { Button, Select, Tooltip } from "@areal/ui";          // stable entry
import { SettingsRow } from "@areal/ui/compositions";       // Base-admitted composition
import { ComposerActionButton } from "@areal/ui/experimental"; // experimental API
```

The host uses React 19, Base UI and Tailwind 4. Import `@areal/ui/styles.css` (foundations and core component styles) and `@areal/ui/themes.css` (default light/dark palette) after Tailwind. Domain compositions import their own styles: `conversation.css`, `settings.css`, `workbench.css`, `worktree.css`, `notifications.css`.

| Looking for | Where |
| --- | --- |
| Common variable names and purposes | [Token entry](token-reference.md) (generated); use the [full reference](src/generated/tokens.md) for values |
| Which components exist and which entry exports them | build output `dist/components.json`, `dist/llms.txt`, or the design site `design-system.html?ui-library` |
| When to use a component, its states, keyboard and rules | the Markdown contract next to the component |
| System changes, admission, evidence and rule ownership | [Maintainer entry](../../design-system/README.md#开工顺序) |
| Layer and maturity rules | [Components](../../../../design/components/README.md#分层) |

## Layers and maturity

`src/components` (core) holds general controls; `src/settings`, `src/conversation`, `src/workbench` and `src/worktree` hold domain compositions. Core cannot import other layers, and no component may import the renderer, Core, Node or Electron.

A core component used by three or more production files is assessed for the stable entry `@areal/ui`. Admitted package compositions use `@areal/ui/compositions`; other members use `@areal/ui/experimental`. Base `frozen-beta` freezes a finite GUI slice and does not promote public API stability. Component contracts separately own entries, API status and exports. The GUI registry owns admission. `dist/components.json` lists the current members.

Each production experimental import records its file, symbol, owner and exit condition in [experimental-allowlist.json](experimental-allowlist.json). Checks reject unlisted imports and stale allowances; design previews are excluded from production consumers. The former `wip` entry and deep source imports are disabled. The SettingsSelect contract uses `experimentalExports` to identify auxiliary symbols that still use the experimental entry.

## Changing the system

1. Edit foundation values and palette formulas in [tokens.json](tokens.json). [src/theme.ts](src/theme.ts) retains the public API and WCAG algorithm; the generator emits the palette implementation. Update a component's Markdown contract together with its implementation.
2. Run `pnpm --filter @areal/ui generate`, then `build` and `check`. Generated files live in `src/generated`; do not edit them by hand.
3. From `clients/gui`, run `node scripts/design-system-audit.mjs` and `pnpm typecheck`, then verify the affected screens.

The host (renderer) keeps user preferences, business state, localization and execution wiring; see [D-004](../../../../design/decisions/004-local-ui-package.md).

## Shared contracts

These clauses replace identical paragraphs previously repeated across component contracts. A clause applies only when the component links its ID. Component-specific behavior stays beside the component.

[R-UI-COMMON-001](README.md#共同合同): Names, values, descriptions and feedback come from the host. Long labels and 18px text must not displace the actual actions.

[R-UI-COMMON-002](README.md#共同合同): Preserve native, Base UI and cmdk keyboard behavior and refs. The host labels the actual input or trigger. Disabled state is not conveyed by color alone.

[R-UI-COMMON-003](README.md#共同合同): Import from `@areal/ui` and use `styles.css`. The original renderer path forwards to the same implementation. The package does not import Intl, services, credentials or storage. This does not promote API stability or Base admission.

[R-UI-COMMON-004](README.md#共同合同): Import from `@areal/ui/experimental` and use `styles.css`. The original renderer path forwards to the same implementation. The package does not import Intl, services, credentials or storage. This does not promote API stability or Base admission.

[R-UI-COMMON-005](README.md#共同合同): Cover default state, growing content, host-provided disabled or busy state, both themes and text sizes. Display updates preserve identity and reading state.

[R-UI-COMMON-006](README.md#共同合同): Names, reasons and results come from host facts. Unconfirmed results cannot appear successful. A transient notification does not replace the original result or recovery actions.

[R-UI-COMMON-007](README.md#共同合同): Preserve labels, ARIA, refs and keyboard access on the actual controls. Content remains readable at 18px and in narrow windows. Rewrapping must not lose focus.

[R-UI-COMMON-008](README.md#共同合同): The package does not depend on renderer, Intl, Store, Core or Electron. Original paths only forward or inject host data. The API remains experimental and does not become stable automatically.

[R-UI-COMMON-009](README.md#共同合同): Cover default state, growing content, focus, unavailable state and host-provided busy, failed or unconfirmed state. The same object retains identity and reading state.

[R-UI-COMMON-010](README.md#共同合同): Preserve the existing implementation, native semantics and interaction flow. Read only props and browser layout. Do not request Core or access saved configuration.

[R-UI-COMMON-011](README.md#共同合同): The host projects names, labels, descriptions and results. Visual state cannot establish that an operation has completed.

[R-UI-COMMON-012](README.md#共同合同): Preserve refs, ARIA, keyboard behavior, focus and reduced motion. Actions remain reachable with larger text and narrow containers.

[R-UI-COMMON-013](README.md#共同合同): Original renderer paths retain localization, preferences and business adapters. The package owns only UI. Experimental exports do not establish stable APIs, complete product capability or package acceptance.

[R-UI-COMMON-014](README.md#共同合同): Preserve the existing implementation and keyboard, focus and scrolling semantics. Renderer adapters provide localization, preferences and permitted actions. The UI package only presents content and manages local interaction.

[R-UI-COMMON-015](README.md#共同合同): The package does not depend on renderer, Intl, Store, Core or Electron. Original paths only forward or inject host data. The API remains experimental; Base admission does not promote API stability automatically.
