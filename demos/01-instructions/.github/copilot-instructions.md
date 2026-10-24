# Repository instructions

This repository contains Copilot.Avalonia: it runs a real Avalonia app inside a browser canvas so that a person or an agent can use it.

## How to work here

- The sample app is in `src/SampleApp`. The canvas host is in `src/Copilot.Avalonia.AppHost`.
- Before you consider a task done, build: `dotnet build src/SampleApp/SampleApp.csproj`.
- If you change the host, also run: `dotnet test src/Copilot.Avalonia.Tests/Copilot.Avalonia.Tests.csproj`.
- To see the app in canvas mode: `dotnet run --project src/SampleApp --launch-profile Canvas`.
- `UseCopilotAvalonia()` always goes after `UsePlatformDetect()`.

## UI conventions

- Every interactive control has `Name` and `AutomationProperties.AutomationId` with the same value.
- The identifier is PascalCase and ends with the control type: `GreetButton`, `NameBox`, `PriorityCombo`, `DarkModeToggle`.
- Never change an existing AutomationId: tests and agents depend on it.
- Visible text in the app is in English. In the chat, reply in the language the user writes in.
