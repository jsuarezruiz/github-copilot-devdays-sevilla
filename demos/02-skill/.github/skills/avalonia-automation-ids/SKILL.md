---
name: avalonia-automation-ids
description: Audits and fixes the AutomationIds in the AXAML views of an Avalonia app. Use it when asked to prepare a screen for UI tests, or so that an agent can drive it by control name.
---

# AutomationId audit for Avalonia

Follow these steps in order and never skip the final check.

1. Find the views: look for `*.axaml` files in the given folder, skipping `bin` and `obj`.
2. Inventory the interactive controls: `Button`, `RepeatButton`, `ToggleButton`, `TextBox`, `ComboBox`, `CheckBox`, `RadioButton`, `Slider`, `ToggleSwitch`, `ListBox` and `MenuItem`.
3. For each control, note whether it has `AutomationProperties.AutomationId`. If the `find_missing_automation_ids` tool is available, use it instead of searching by hand.
4. Present a table with: file, line, type, visible text and proposed identifier.
5. Propose PascalCase identifiers with the type as a suffix: `ExitMenu`, `SaveButton`, `SearchBox`. Never reuse an existing identifier.
6. Ask for confirmation before editing. When editing, add `Name` and `AutomationProperties.AutomationId` with the same value.
7. Verify: build the project and check that no interactive control is left without an identifier.

## What not to do

- Do not rename identifiers that already exist.
- Do not add identifiers to decorative controls such as `TextBlock`, `Border` or `Separator` unless the user asks for it.
