---
applyTo: "**/*.axaml"
---

When editing AXAML files:

- Use compiled bindings and declare `x:DataType` when there is a data context.
- Every new control a user can interact with needs `Name` and `AutomationProperties.AutomationId`.
- Reuse theme resources with `DynamicResource`. Do not hard-code colors.
- Wire events to a code-behind handler with the `On` prefix, for example `OnGreetClicked`.
